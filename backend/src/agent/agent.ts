/**
 * agent/agent.ts — The core verification agent for ForwardGuard.
 *
 * Orchestrates multi-tool reasoning using LangChain's AgentExecutor with
 * the ReAct (Reason + Act) pattern. The agent loops through tool calls
 * until it has enough evidence to produce a structured verdict.
 *
 * Why LangChain AgentExecutor over a custom loop:
 * - Built-in ReAct pattern with proper stop conditions
 * - Tool calling protocol handled automatically
 * - Intermediate step logging for observability
 * - Max iteration cap to prevent runaway loops
 */

import { ChatAnthropic } from "@langchain/anthropic";
import { createToolCallingAgent, AgentExecutor } from "langchain/agents";
import { ChatPromptTemplate, MessagesPlaceholder, SystemMessagePromptTemplate, HumanMessagePromptTemplate } from "@langchain/core/prompts";
import type { VerifyRequest, AgentVerdict, Claim, Source } from "../types/index.js";
import type { Logger } from "../middleware/logger.js";
import { SYSTEM_PROMPT } from "./prompts.js";
import { claimExtractorTool } from "./tools/claimExtractor.js";
import { webSearchTool } from "./tools/webSearch.js";
import { factCheckTool } from "./tools/factCheck.js";
import { scamDetectorTool } from "./tools/scamDetector.js";

// ─── Agent Setup ────────────────────────────────────────────────────────────

const tools = [claimExtractorTool, webSearchTool, factCheckTool, scamDetectorTool];

/**
 * Claude Sonnet as the agent LLM.
 *
 * Temperature 0: fact-checking is not creative — we want deterministic,
 * reproducible verdicts for the same input. This is critical for user trust.
 */
const llm = new ChatAnthropic({
  model: "claude-sonnet-4-6",
  temperature: 0,
  maxTokens: 4096,
  // Override top_p via invocationKwargs — LangChain defaults top_p to -1,
  // but newer Claude models reject temperature + top_p together.
  invocationKwargs: { top_p: undefined, top_k: undefined },
});

/**
 * Prompt template with system message and agent scratchpad.
 * The scratchpad holds the agent's intermediate reasoning steps.
 */
// Why SystemMessagePromptTemplate.fromTemplate is not used: SYSTEM_PROMPT contains
// literal JSON curly braces that LangChain's f-string parser would choke on.
// Using fromMessages with a pre-constructed template avoids this.
const escapedSystemPrompt = SYSTEM_PROMPT.replace(/\{/g, "{{").replace(/\}/g, "}}");
const prompt = ChatPromptTemplate.fromMessages([
  ["system", escapedSystemPrompt],
  ["human", "{input}"],
  new MessagesPlaceholder("agent_scratchpad"),
]);

// Create the tool-calling agent
const agent = createToolCallingAgent({ llm, tools, prompt });

/**
 * AgentExecutor wraps the agent with iteration control and tool execution.
 *
 * maxIterations: 8 — hard cap to prevent runaway loops. In practice,
 * most verifications complete in 4-6 iterations (claim extraction +
 * 1-2 searches per claim + synthesis).
 *
 * returnIntermediateSteps: true — exposes every Thought → Action → Observation
 * for full observability and debugging.
 */
const executor = new AgentExecutor({
  agent,
  tools,
  maxIterations: 8,
  returnIntermediateSteps: true,
  verbose: false, // We handle our own logging below
});

// ─── Verdict Parsing ────────────────────────────────────────────────────────

/** Default fallback verdict when agent output can't be parsed */
const FALLBACK_VERDICT: AgentVerdict = {
  verdict: "UNKNOWN",
  confidence: 0.3,
  explanation:
    "The verification agent was unable to produce a clear verdict. " +
    "This may be due to an ambiguous claim or temporary service issue.",
  claims: [],
  sources: [],
  toolsUsed: [],
  reasoning: "Agent output could not be parsed into a structured verdict.",
};

/**
 * Parse the agent's output into a structured verdict.
 *
 * The agent is instructed to return JSON, but LLMs can be unpredictable.
 * We try multiple parsing strategies before falling back to a safe default.
 */
function parseAgentOutput(output: string, toolsUsed: string[]): AgentVerdict {
  try {
    // Strategy 1: Direct JSON parse (agent followed instructions perfectly)
    const parsed = JSON.parse(output);
    return {
      verdict: parsed.verdict ?? "UNKNOWN",
      confidence: typeof parsed.confidence === "number" ? parsed.confidence : 0.5,
      explanation: parsed.explanation ?? "No explanation provided.",
      claims: Array.isArray(parsed.claims) ? parsed.claims as Claim[] : [],
      sources: Array.isArray(parsed.sources) ? parsed.sources as Source[] : [],
      toolsUsed,
      reasoning: parsed.reasoning ?? "No reasoning provided.",
    };
  } catch {
    // Strategy 2: Extract JSON from markdown code block (agent wrapped in ```json)
    const jsonMatch = output.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[1]);
        return {
          verdict: parsed.verdict ?? "UNKNOWN",
          confidence: typeof parsed.confidence === "number" ? parsed.confidence : 0.5,
          explanation: parsed.explanation ?? "No explanation provided.",
          claims: Array.isArray(parsed.claims) ? parsed.claims as Claim[] : [],
          sources: Array.isArray(parsed.sources) ? parsed.sources as Source[] : [],
          toolsUsed,
          reasoning: parsed.reasoning ?? "No reasoning provided.",
        };
      } catch {
        // Fall through to fallback
      }
    }

    // Strategy 3: Try to find any JSON object in the output
    const objectMatch = output.match(/\{[\s\S]*"verdict"[\s\S]*\}/);
    if (objectMatch) {
      try {
        const parsed = JSON.parse(objectMatch[0]);
        return {
          verdict: parsed.verdict ?? "UNKNOWN",
          confidence: typeof parsed.confidence === "number" ? parsed.confidence : 0.5,
          explanation: parsed.explanation ?? "No explanation provided.",
          claims: Array.isArray(parsed.claims) ? parsed.claims as Claim[] : [],
          sources: Array.isArray(parsed.sources) ? parsed.sources as Source[] : [],
          toolsUsed,
          reasoning: parsed.reasoning ?? "No reasoning provided.",
        };
      } catch {
        // Fall through to fallback
      }
    }

    // All parsing strategies failed — return safe fallback
    return { ...FALLBACK_VERDICT, toolsUsed };
  }
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Run the verification agent on a message.
 *
 * @param request - The verification request (message, context, language)
 * @param requestId - UUID for log correlation
 * @param log - Scoped Pino logger with requestId bound
 * @returns Structured verdict (without requestId, timing — route handler adds those)
 */
export async function verify(
  request: VerifyRequest,
  requestId: string,
  log: Logger
): Promise<AgentVerdict> {
  log.info({ messageLength: request.message.length }, "Agent starting verification");

  try {
    // Build the agent input — include context if provided
    let input = `Verify this message:\n\n"${request.message}"`;
    if (request.context) {
      input += `\n\nAdditional context: ${request.context}`;
    }
    if (request.language && request.language !== "en") {
      input += `\n\nNote: The message is in language code "${request.language}".`;
    }

    const result = await executor.invoke({ input });

    // Extract which tools were actually called from intermediate steps
    const intermediateSteps = result.intermediateSteps as Array<{
      action: { tool: string };
      observation: string;
    }>;

    const toolsUsed = [
      ...new Set(intermediateSteps.map((step) => step.action.tool)),
    ];

    // Log each intermediate step for observability
    for (const [index, step] of intermediateSteps.entries()) {
      log.info(
        {
          step: index + 1,
          tool: step.action.tool,
          observationLength: step.observation.length,
        },
        `Agent step ${index + 1}: ${step.action.tool}`
      );
    }

    // Parse the agent's final output.
    // LangChain may return the output as a string, a content block array, or
    // an Anthropic-style message. We normalize to a plain text string.
    const rawOutput = result.output;
    let agentOutput: string;

    if (Array.isArray(rawOutput)) {
      // Content block array: [{ type: "text", text: "..." }, ...]
      agentOutput = rawOutput
        .filter((block: Record<string, unknown>) => block.type === "text")
        .map((block: Record<string, unknown>) => String(block.text ?? ""))
        .join("\n");
    } else if (typeof rawOutput === "string") {
      // Check if the string is a serialized content block array
      try {
        const parsed = JSON.parse(rawOutput);
        if (Array.isArray(parsed) && parsed[0]?.type === "text") {
          agentOutput = parsed
            .filter((block: Record<string, unknown>) => block.type === "text")
            .map((block: Record<string, unknown>) => String(block.text ?? ""))
            .join("\n");
        } else {
          agentOutput = rawOutput;
        }
      } catch {
        agentOutput = rawOutput;
      }
    } else {
      agentOutput = JSON.stringify(rawOutput);
    }
    log.info({ outputType: typeof rawOutput, isArray: Array.isArray(rawOutput), agentOutputLength: agentOutput.length, agentOutputPreview: agentOutput.slice(0, 300) }, "Raw agent output");
    const verdict = parseAgentOutput(agentOutput, toolsUsed);

    log.info(
      {
        verdict: verdict.verdict,
        confidence: verdict.confidence,
        toolsUsed: verdict.toolsUsed,
        totalSteps: intermediateSteps.length,
      },
      "Agent completed verification"
    );

    return verdict;
  } catch (error) {
    log.error(
      { error: error instanceof Error ? error.message : String(error) },
      "Agent verification failed"
    );

    // Return a safe fallback — never let agent errors propagate as raw errors
    return {
      ...FALLBACK_VERDICT,
      reasoning: `Agent error: ${error instanceof Error ? error.message : "Unknown error"}`,
    };
  }
}
