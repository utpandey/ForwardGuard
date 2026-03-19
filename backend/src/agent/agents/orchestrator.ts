/**
 * agents/orchestrator.ts — Smart LangChain AgentExecutor orchestrator for ForwardGuard.
 *
 * Replaces the hardcoded sequential pipeline with an intelligent agent that
 * decides which tools to call, in what order, based on the message content.
 *
 * Uses createToolCallingAgent + AgentExecutor from LangChain with Claude
 * as the backbone LLM. The agent has access to tools that wrap each sub-agent
 * and each standalone tool, and accumulates evidence in a shared PipelineState.
 */

import { ChatAnthropic } from "@langchain/anthropic";
import { createToolCallingAgent, AgentExecutor } from "langchain/agents";
import { DynamicStructuredTool } from "@langchain/core/tools";
import {
  ChatPromptTemplate,
  MessagesPlaceholder,
} from "@langchain/core/prompts";
import { z } from "zod";

import type {
  VerifyRequest,
  AgentVerdict,
  Claim,
  ScamDetectorResult,
} from "../../types/index.js";
import type { Logger } from "../../middleware/logger.js";
import type { ClaimEvidence } from "./sourceVerifier.js";
import type { RAGSearchResult } from "../rag/vectorStore.js";

import { runClaimAnalyst } from "./claimAnalyst.js";
import { runVerdictSynthesizer } from "./verdictSynthesizer.js";
import { runLLMScamDetector } from "../tools/scamDetector.js";
import { searchMisinfoDatabase } from "../rag/vectorStore.js";
import { ORCHESTRATOR_AGENT_PROMPT } from "../prompts.js";

// ─── Pipeline State ──────────────────────────────────────────────────────────

interface PipelineState {
  claims: Claim[];
  ragMatches: RAGSearchResult[];
  webEvidence: Array<{ query: string; answer: string; sources: unknown[] }>;
  factCheckEvidence: Array<{ claim: string; summary: string; results: unknown[] }>;
  scamAnalysis: ScamDetectorResult | null;
  credibilityAnalysis: Array<{ url: string; score: number; tier: string; note: string }>;
}

/** Default fallback verdict when the pipeline fails */
const FALLBACK_VERDICT: AgentVerdict = {
  verdict: "UNKNOWN",
  confidence: 0.3,
  explanation:
    "The verification system was unable to produce a clear verdict. " +
    "This may be due to an ambiguous claim or a temporary service issue.",
  claims: [],
  sources: [],
  toolsUsed: [],
  reasoning: "Multi-agent pipeline failed to produce a verdict.",
};

// ─── Tavily Helpers (shared by web search & fact check tools) ────────────────

interface TavilyResult {
  title: string;
  url: string;
  content: string;
  score: number;
}

interface TavilyResponse {
  answer?: string;
  results: TavilyResult[];
}

const EXCLUDED_DOMAINS = ["infowars.com", "naturalnews.com", "beforeitsnews.com"];

const FACT_CHECK_DOMAINS = [
  "snopes.com", "politifact.com", "factcheck.org", "reuters.com",
  "apnews.com", "fullfact.org", "afp.com", "poynter.org", "who.int",
];

const HIGH_CREDIBILITY_DOMAINS = new Set([
  "who.int", "cdc.gov", "nih.gov", "gov.uk", "reuters.com", "apnews.com",
  "bbc.com", "nature.com", "snopes.com", "politifact.com", "factcheck.org",
]);

const LOW_CREDIBILITY_DOMAINS = new Set([
  "infowars.com", "naturalnews.com", "beforeitsnews.com", "worldnewsdailyreport.com",
]);

function scoreDomainCredibility(url: string): "high" | "medium" | "low" {
  try {
    const hostname = new URL(url).hostname.replace(/^www\./, "");
    if (HIGH_CREDIBILITY_DOMAINS.has(hostname)) return "high";
    if (LOW_CREDIBILITY_DOMAINS.has(hostname)) return "low";
    for (const domain of HIGH_CREDIBILITY_DOMAINS) {
      if (hostname.endsWith(`.${domain}`)) return "high";
    }
    return "medium";
  } catch {
    return "medium";
  }
}

// ─── Tool Builders ───────────────────────────────────────────────────────────

/**
 * Build the set of tools the orchestrator agent can call.
 * Each tool wraps a sub-agent or standalone tool function and writes results
 * into the shared PipelineState.
 */
function buildOrchestratorTools(
  request: VerifyRequest,
  state: PipelineState,
  log: Logger
): DynamicStructuredTool[] {
  const toolsUsedSet = new Set<string>();

  // 1. analyze_claims — wraps Claim Analyst
  const analyzeClaimsTool = new DynamicStructuredTool({
    name: "analyze_claims",
    description:
      "Extract discrete verifiable claims from the message and search the known misinformation database (RAG). " +
      "MUST be called first. Returns extracted claims and any RAG matches to known hoaxes.",
    schema: z.object({
      message: z.string().describe("The message text to analyze for claims"),
    }),
    func: async ({ message }): Promise<string> => {
      const agentLog = log.child({ orchestratorTool: "analyze_claims" });
      agentLog.info("Orchestrator calling analyze_claims");
      toolsUsedSet.add("claim_analyst");
      toolsUsedSet.add("rag_misinfo_search");

      try {
        // Handle PDF text prepending
        let messageForAnalysis = message;
        if (request.pdfText) {
          messageForAnalysis = `[PDF Document Content]\n${request.pdfText}\n\n[User Message]\n${message}`;
          toolsUsedSet.add("pdf_parser");
        }

        const result = await runClaimAnalyst(
          messageForAnalysis,
          request.imageBase64,
          log
        );

        state.claims = result.claims;
        state.ragMatches = result.ragMatches;

        return JSON.stringify({
          claimsFound: result.claims.length,
          claims: result.claims,
          ragMatchesFound: result.ragMatches.length,
          ragMatches: result.ragMatches.map((m) => ({
            knownClaim: m.entry.claim,
            verdict: m.entry.verdict,
            debunking: m.entry.debunking,
            similarity: Math.round(m.similarity * 100),
          })),
          note: result.ragMatches.length > 0
            ? "Found matches in known misinformation database. These are strong evidence."
            : "No known hoax matches. Proceed with web search and fact-checking.",
        });
      } catch (error) {
        agentLog.error(
          { error: error instanceof Error ? error.message : String(error) },
          "analyze_claims failed"
        );
        return JSON.stringify({ claimsFound: 0, claims: [], ragMatchesFound: 0, ragMatches: [], error: "Failed to analyze claims" });
      }
    },
  });

  // 2. search_web — wraps web search via Tavily
  const searchWebTool = new DynamicStructuredTool({
    name: "search_web",
    description:
      "Search the live web for current credible sources about a specific claim. " +
      "Returns up to 5 results with snippets and credibility scores.",
    schema: z.object({
      query: z.string().describe("The search query — a specific factual claim to verify"),
    }),
    func: async ({ query }): Promise<string> => {
      const agentLog = log.child({ orchestratorTool: "search_web" });
      agentLog.info({ query }, "Orchestrator calling search_web");
      toolsUsedSet.add("web_search");

      try {
        const tavilyApiKey = process.env.TAVILY_API_KEY;
        if (!tavilyApiKey) {
          return JSON.stringify({ query, answer: "Web search unavailable", sources: [] });
        }

        const response = await fetch("https://api.tavily.com/search", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            api_key: tavilyApiKey,
            query,
            search_depth: "advanced",
            max_results: 5,
            include_answer: true,
            exclude_domains: EXCLUDED_DOMAINS,
          }),
        });

        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(`Tavily API error (${response.status}): ${errorText}`);
        }

        const data = (await response.json()) as TavilyResponse;
        const sources = (data.results || []).map((r) => ({
          title: r.title,
          url: r.url,
          snippet: r.content.slice(0, 300),
          credibility: scoreDomainCredibility(r.url),
        }));

        const result = {
          query,
          answer: data.answer ?? "No synthesized answer available",
          sources,
          totalResults: sources.length,
        };

        state.webEvidence.push({ query, answer: result.answer, sources });

        return JSON.stringify(result);
      } catch (error) {
        agentLog.error(
          { error: error instanceof Error ? error.message : String(error) },
          "search_web failed"
        );
        return JSON.stringify({ query, answer: "Web search failed", sources: [], error: String(error) });
      }
    },
  });

  // 3. check_factcheckers — wraps fact-check DB search
  const checkFactcheckersTool = new DynamicStructuredTool({
    name: "check_factcheckers",
    description:
      "Search dedicated fact-checking organizations (Snopes, PolitiFact, Reuters, AP News, etc.) " +
      "for existing verdicts on a claim. Every result is from a trusted fact-checking source.",
    schema: z.object({
      claim: z.string().describe("The specific claim to look up in fact-checking databases"),
    }),
    func: async ({ claim }): Promise<string> => {
      const agentLog = log.child({ orchestratorTool: "check_factcheckers" });
      agentLog.info({ claim }, "Orchestrator calling check_factcheckers");
      toolsUsedSet.add("fact_check_db");

      try {
        const tavilyApiKey = process.env.TAVILY_API_KEY;
        if (!tavilyApiKey) {
          return JSON.stringify({ summary: "Fact-check search unavailable", results: [] });
        }

        const response = await fetch("https://api.tavily.com/search", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            api_key: tavilyApiKey,
            query: `fact check: ${claim}`,
            search_depth: "advanced",
            max_results: 5,
            include_answer: true,
            include_domains: FACT_CHECK_DOMAINS,
          }),
        });

        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(`Tavily API error (${response.status}): ${errorText}`);
        }

        const data = (await response.json()) as TavilyResponse;
        const results = (data.results || []).map((r) => ({
          title: r.title,
          url: r.url,
          snippet: r.content.slice(0, 300),
          credibility: "high" as const,
        }));

        const factCheckResult = {
          summary: data.answer ?? "No fact-check summary available",
          results,
        };

        state.factCheckEvidence.push({ claim, summary: factCheckResult.summary, results });

        return JSON.stringify(factCheckResult);
      } catch (error) {
        agentLog.error(
          { error: error instanceof Error ? error.message : String(error) },
          "check_factcheckers failed"
        );
        return JSON.stringify({ summary: "Fact-check search failed", results: [], error: String(error) });
      }
    },
  });

  // 4. detect_scam — wraps LLM scam detector
  const detectScamTool = new DynamicStructuredTool({
    name: "detect_scam",
    description:
      "Analyze a message for manipulation and social engineering patterns. " +
      "Identifies urgency pressure, chain letters, financial threats, prize scams, " +
      "phishing links, health misinformation, and false authority claims. " +
      "Call this if the message contains suspicious language, urgency, or threats.",
    schema: z.object({
      message: z.string().describe("The full message text to scan for scam patterns"),
    }),
    func: async ({ message }): Promise<string> => {
      const agentLog = log.child({ orchestratorTool: "detect_scam" });
      agentLog.info("Orchestrator calling detect_scam");
      toolsUsedSet.add("scam_detector_llm");

      try {
        const result = await runLLMScamDetector(message, log);
        state.scamAnalysis = result;
        return JSON.stringify(result);
      } catch (error) {
        agentLog.error(
          { error: error instanceof Error ? error.message : String(error) },
          "detect_scam failed"
        );
        return JSON.stringify({
          isScam: false,
          detectedPatterns: [],
          overallSeverity: "none",
          summary: "Scam detection failed",
        });
      }
    },
  });

  // 5. analyze_credibility — wraps source credibility analyzer
  const analyzeCredibilityTool = new DynamicStructuredTool({
    name: "analyze_credibility",
    description:
      "Evaluate the credibility of a source URL and its content snippet using AI. " +
      "Returns a credibility score (0-1) and detailed analysis. " +
      "Use this to evaluate sources with uncertain credibility.",
    schema: z.object({
      url: z.string().describe("The URL of the source to evaluate"),
      snippet: z.string().describe("A text snippet from the source to analyze"),
    }),
    func: async ({ url, snippet }): Promise<string> => {
      const agentLog = log.child({ orchestratorTool: "analyze_credibility" });
      agentLog.info({ url }, "Orchestrator calling analyze_credibility");
      toolsUsedSet.add("source_credibility");

      try {
        const { default: Anthropic } = await import("@anthropic-ai/sdk");
        const anthropic = new Anthropic();

        const response = await anthropic.messages.create({
          model: "claude-sonnet-4-6",
          max_tokens: 256,
          temperature: 0,
          system: `You are an expert media literacy analyst. Given a URL and content snippet, evaluate source credibility on a scale of 0.0 to 1.0.

Consider: domain reputation, writing quality, bias indicators, journalistic standards.

Return ONLY a JSON object: {{"score": <float>, "tier": "high|medium|low", "note": "<brief reason>"}}`,
          messages: [{ role: "user", content: `URL: ${url}\nSnippet: ${snippet.slice(0, 300)}` }],
        });

        const textBlock = response.content.find((b) => b.type === "text");
        const raw = textBlock?.text ?? "{}";
        let parsed: { score: number; tier: string; note: string };
        try {
          parsed = JSON.parse(raw) as { score: number; tier: string; note: string };
        } catch {
          const match = raw.match(/\{[\s\S]*\}/);
          parsed = match
            ? (JSON.parse(match[0]) as { score: number; tier: string; note: string })
            : { score: 0.5, tier: "medium", note: "Could not parse" };
        }

        state.credibilityAnalysis.push({ url, ...parsed });
        return JSON.stringify(parsed);
      } catch (error) {
        agentLog.error(
          { error: error instanceof Error ? error.message : String(error) },
          "analyze_credibility failed"
        );
        return JSON.stringify({ score: 0.5, tier: "medium", note: "Analysis failed" });
      }
    },
  });

  // 6. search_misinfo_db — wraps RAG search directly
  const searchMisinfoDbTool = new DynamicStructuredTool({
    name: "search_misinfo_db",
    description:
      "Search the known misinformation database (RAG vector store) for claims similar to the query. " +
      "Returns matching hoaxes/debunked claims with their verdicts. " +
      "Use this to check if a specific claim matches a well-known hoax.",
    schema: z.object({
      claim: z.string().describe("The claim text to search for in the misinformation database"),
    }),
    func: async ({ claim }): Promise<string> => {
      const agentLog = log.child({ orchestratorTool: "search_misinfo_db" });
      agentLog.info({ claim: claim.slice(0, 100) }, "Orchestrator calling search_misinfo_db");
      toolsUsedSet.add("rag_misinfo_search");

      try {
        const results = searchMisinfoDatabase(claim);
        const matches = results.map((r) => ({
          knownClaim: r.entry.claim,
          verdict: r.entry.verdict,
          debunking: r.entry.debunking,
          source: r.entry.source,
          similarityScore: Math.round(r.similarity * 100) / 100,
        }));

        // Merge new RAG matches into state (dedup by claim text)
        const existingClaims = new Set(state.ragMatches.map((m) => m.entry.claim));
        for (const r of results) {
          if (!existingClaims.has(r.entry.claim)) {
            state.ragMatches.push(r);
            existingClaims.add(r.entry.claim);
          }
        }

        return JSON.stringify({
          query: claim,
          matchesFound: matches.length,
          matches,
          note: matches.length > 0
            ? "Found matches in known misinformation database. Use these as strong evidence."
            : "No matches found. Proceed with web search.",
        });
      } catch (error) {
        agentLog.error(
          { error: error instanceof Error ? error.message : String(error) },
          "search_misinfo_db failed"
        );
        return JSON.stringify({ query: claim, matchesFound: 0, matches: [], error: String(error) });
      }
    },
  });

  // 7. synthesize_verdict — wraps Verdict Synthesizer
  const synthesizeVerdictTool = new DynamicStructuredTool({
    name: "synthesize_verdict",
    description:
      "Produce the final structured verdict from ALL accumulated evidence. " +
      "MUST be called as the LAST tool. Reads all evidence gathered by previous tool calls " +
      "and synthesizes a final verdict. Pass a brief analysis summary.",
    schema: z.object({
      analysisSummary: z
        .string()
        .describe("A brief summary of your analysis and reasoning so far"),
    }),
    func: async ({ analysisSummary }): Promise<string> => {
      const agentLog = log.child({ orchestratorTool: "synthesize_verdict" });
      agentLog.info("Orchestrator calling synthesize_verdict");
      toolsUsedSet.add("verdict_synthesizer");

      try {
        // Build ClaimEvidence array from accumulated state
        const evidence: ClaimEvidence[] = state.claims.map((claim) => {
          // Find web evidence for this claim
          const relevantWeb = state.webEvidence.length > 0 ? state.webEvidence[0] : null;
          const relevantFactCheck = state.factCheckEvidence.length > 0 ? state.factCheckEvidence[0] : null;

          // Collect all sources from web evidence
          const allSources = [
            ...(relevantWeb?.sources || []).map((s: unknown) => {
              const src = s as { title: string; url: string; snippet: string; credibility: string };
              return {
                title: src.title,
                url: src.url,
                snippet: src.snippet,
                credibility: (src.credibility || "medium") as "high" | "medium" | "low",
              };
            }),
            ...(relevantFactCheck?.results || []).map((s: unknown) => {
              const src = s as { title: string; url: string; snippet: string; credibility: string };
              return {
                title: src.title,
                url: src.url,
                snippet: src.snippet || "",
                credibility: (src.credibility || "high") as "high" | "medium" | "low",
              };
            }),
          ];

          return {
            claim,
            webAnswer: relevantWeb?.answer || "No web search performed",
            factCheckSummary: relevantFactCheck?.summary || "No fact-check search performed",
            sources: allSources,
            credibilityAnalysis: state.credibilityAnalysis,
          };
        });

        const allToolsUsed = Array.from(toolsUsedSet);

        const verdict = await runVerdictSynthesizer(
          state.claims,
          evidence,
          state.ragMatches,
          state.scamAnalysis,
          allToolsUsed,
          log
        );

        return JSON.stringify(verdict);
      } catch (error) {
        agentLog.error(
          { error: error instanceof Error ? error.message : String(error) },
          "synthesize_verdict failed"
        );
        return JSON.stringify({
          ...FALLBACK_VERDICT,
          toolsUsed: Array.from(toolsUsedSet),
          reasoning: `Verdict synthesis failed: ${error instanceof Error ? error.message : "Unknown error"}. Analysis summary: ${analysisSummary}`,
        });
      }
    },
  });

  return [
    analyzeClaimsTool,
    searchWebTool,
    checkFactcheckersTool,
    detectScamTool,
    analyzeCredibilityTool,
    searchMisinfoDbTool,
    synthesizeVerdictTool,
  ];
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Run the smart multi-agent verification pipeline using LangChain AgentExecutor.
 *
 * @param request - The verification request
 * @param log - Scoped logger with requestId bound
 * @returns Structured verdict
 */
export async function runOrchestrator(
  request: VerifyRequest,
  log: Logger
): Promise<AgentVerdict> {
  const orchestratorLog = log.child({ agent: "orchestrator" });
  orchestratorLog.info(
    { messageLength: request.message.length, hasImage: !!request.imageBase64, hasPdf: !!request.pdfText },
    "Smart orchestrator pipeline starting"
  );

  const pipelineStart = Date.now();

  // Initialize shared pipeline state
  const state: PipelineState = {
    claims: [],
    ragMatches: [],
    webEvidence: [],
    factCheckEvidence: [],
    scamAnalysis: null,
    credibilityAnalysis: [],
  };

  try {
    // Build tools with access to shared state
    const tools = buildOrchestratorTools(request, state, log);

    // Initialize the LLM
    const llm = new ChatAnthropic({
      modelName: "claude-sonnet-4-6",
      temperature: 0,
      maxTokens: 4096,
    });

    // Build the prompt template — escape curly braces in system prompt
    const prompt = ChatPromptTemplate.fromMessages([
      ["system", ORCHESTRATOR_AGENT_PROMPT.replace(/\{/g, "{{").replace(/\}/g, "}}")],
      ["human", "{input}"],
      new MessagesPlaceholder("agent_scratchpad"),
    ]);

    // Create the tool-calling agent
    const agent = createToolCallingAgent({
      llm,
      tools,
      prompt,
    });

    // Create the executor with iteration limit
    const executor = new AgentExecutor({
      agent,
      tools,
      maxIterations: 10,
      returnIntermediateSteps: true,
      verbose: false,
    });

    // Build the input message for the agent
    let inputMessage = `Verify this forwarded message:\n\n${request.message}`;
    if (request.pdfText) {
      inputMessage = `Verify this forwarded message (includes PDF content):\n\n[PDF Document Content]\n${request.pdfText}\n\n[User Message]\n${request.message}`;
    }
    if (request.imageBase64) {
      inputMessage += "\n\n[Note: An image is attached to this message. The analyze_claims tool will process it.]";
    }
    if (request.context) {
      inputMessage += `\n\n[Conversation context: ${request.context}]`;
    }

    // Execute the agent
    const result = await executor.invoke({ input: inputMessage });

    // Extract tools used from intermediate steps
    const intermediateSteps = (result.intermediateSteps || []) as Array<{
      action: { tool: string };
    }>;
    const toolsUsed = intermediateSteps.map((step) => step.action.tool);

    orchestratorLog.info(
      {
        toolCalls: toolsUsed,
        stepCount: intermediateSteps.length,
      },
      "Agent completed execution"
    );

    // Parse the final output — should be the verdict JSON from synthesize_verdict
    const output = result.output as string;
    let verdict: AgentVerdict;

    try {
      verdict = JSON.parse(output) as AgentVerdict;
    } catch {
      // Try to extract JSON from the output
      const jsonMatch = output.match(/\{[\s\S]*"verdict"[\s\S]*\}/);
      if (jsonMatch) {
        try {
          verdict = JSON.parse(jsonMatch[0]) as AgentVerdict;
        } catch {
          orchestratorLog.warn("Could not parse agent output as verdict JSON, using fallback");
          verdict = {
            ...FALLBACK_VERDICT,
            toolsUsed,
            reasoning: `Agent output could not be parsed. Raw output: ${output.slice(0, 500)}`,
          };
        }
      } else {
        orchestratorLog.warn("No verdict JSON found in agent output, using fallback");
        verdict = {
          ...FALLBACK_VERDICT,
          toolsUsed,
          reasoning: `No verdict JSON in agent output. Raw output: ${output.slice(0, 500)}`,
        };
      }
    }

    // Ensure toolsUsed is populated
    if (!verdict.toolsUsed || verdict.toolsUsed.length === 0) {
      verdict.toolsUsed = toolsUsed;
    }

    const pipelineDuration = Date.now() - pipelineStart;
    orchestratorLog.info(
      {
        verdict: verdict.verdict,
        confidence: verdict.confidence,
        pipelineDurationMs: pipelineDuration,
        toolsUsed: verdict.toolsUsed,
      },
      "Smart orchestrator pipeline completed"
    );

    return verdict;
  } catch (error) {
    const pipelineDuration = Date.now() - pipelineStart;
    orchestratorLog.error(
      {
        error: error instanceof Error ? error.message : String(error),
        pipelineDurationMs: pipelineDuration,
      },
      "Smart orchestrator pipeline failed"
    );

    return {
      ...FALLBACK_VERDICT,
      toolsUsed: [],
      reasoning: `Pipeline error: ${error instanceof Error ? error.message : "Unknown error"}`,
    };
  }
}
