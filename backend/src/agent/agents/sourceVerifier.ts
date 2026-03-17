/**
 * agents/sourceVerifier.ts — Source Verifier sub-agent for the multi-agent pipeline.
 *
 * Responsible for searching the web, querying fact-check databases, and
 * analyzing source credibility for each extracted claim.
 *
 * Role in the pipeline: Step 2 — gather evidence for each claim.
 */

import Anthropic from "@anthropic-ai/sdk";
import type { Claim, Source } from "../../types/index.js";
import type { Logger } from "../../middleware/logger.js";

const anthropic = new Anthropic();

// ─── Domain Credibility (reused from webSearch) ──────────────────────────────

const HIGH_CREDIBILITY_DOMAINS = new Set([
  "who.int", "cdc.gov", "nih.gov", "gov.uk", "reuters.com", "apnews.com",
  "bbc.com", "nature.com", "snopes.com", "politifact.com", "factcheck.org",
]);

const LOW_CREDIBILITY_DOMAINS = new Set([
  "infowars.com", "naturalnews.com", "beforeitsnews.com", "worldnewsdailyreport.com",
]);

type Credibility = "high" | "medium" | "low";

function scoreDomainCredibility(url: string): Credibility {
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

// ─── Tavily API ──────────────────────────────────────────────────────────────

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

const FACT_CHECK_DOMAINS = [
  "snopes.com", "politifact.com", "factcheck.org", "reuters.com",
  "apnews.com", "fullfact.org", "afp.com", "poynter.org", "who.int",
];

const EXCLUDED_DOMAINS = ["infowars.com", "naturalnews.com", "beforeitsnews.com"];

async function searchWeb(query: string, log: Logger): Promise<{ answer: string; sources: Source[] }> {
  const tavilyApiKey = process.env.TAVILY_API_KEY;
  if (!tavilyApiKey) {
    log.warn("TAVILY_API_KEY not configured, skipping web search");
    return { answer: "Web search unavailable", sources: [] };
  }

  try {
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
    const sources: Source[] = (data.results || []).map((r) => ({
      title: r.title,
      url: r.url,
      snippet: r.content.slice(0, 300),
      credibility: scoreDomainCredibility(r.url),
    }));

    return { answer: data.answer ?? "No synthesized answer", sources };
  } catch (error) {
    log.error({ error: error instanceof Error ? error.message : String(error) }, "Web search failed");
    return { answer: "Web search failed", sources: [] };
  }
}

async function searchFactCheckDBs(claim: string, log: Logger): Promise<{ summary: string; sources: Source[] }> {
  const tavilyApiKey = process.env.TAVILY_API_KEY;
  if (!tavilyApiKey) {
    log.warn("TAVILY_API_KEY not configured, skipping fact-check search");
    return { summary: "Fact-check search unavailable", sources: [] };
  }

  try {
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
    const sources: Source[] = (data.results || []).map((r) => ({
      title: r.title,
      url: r.url,
      snippet: r.content.slice(0, 300),
      credibility: "high" as const,
    }));

    return { summary: data.answer ?? "No fact-check summary available", sources };
  } catch (error) {
    log.error({ error: error instanceof Error ? error.message : String(error) }, "Fact-check search failed");
    return { summary: "Fact-check search failed", sources: [] };
  }
}

// ─── Source Credibility Analysis ─────────────────────────────────────────────

const SOURCE_CREDIBILITY_PROMPT = `You are an expert media literacy analyst. Given a URL and content snippet, evaluate source credibility on a scale of 0.0 to 1.0.

Consider: domain reputation, writing quality, bias indicators, journalistic standards.

Return ONLY a JSON object: {"score": <float>, "tier": "high|medium|low", "note": "<brief reason>"}`;

async function analyzeSourceCredibility(
  url: string,
  snippet: string,
  log: Logger
): Promise<{ score: number; tier: string; note: string }> {
  try {
    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 256,
      temperature: 0,
      system: SOURCE_CREDIBILITY_PROMPT,
      messages: [{ role: "user", content: `URL: ${url}\nSnippet: ${snippet.slice(0, 300)}` }],
    });

    const textBlock = response.content.find((b) => b.type === "text");
    const raw = textBlock?.text ?? "{}";
    try {
      return JSON.parse(raw) as { score: number; tier: string; note: string };
    } catch {
      const match = raw.match(/\{[\s\S]*\}/);
      if (match) return JSON.parse(match[0]) as { score: number; tier: string; note: string };
      return { score: 0.5, tier: "medium", note: "Could not parse credibility analysis" };
    }
  } catch (error) {
    log.error({ error: error instanceof Error ? error.message : String(error) }, "Source credibility analysis failed");
    return { score: 0.5, tier: "medium", note: "Analysis failed" };
  }
}

// ─── Public Interface ────────────────────────────────────────────────────────

export interface ClaimEvidence {
  claim: Claim;
  webAnswer: string;
  factCheckSummary: string;
  sources: Source[];
  credibilityAnalysis: Array<{ url: string; score: number; tier: string; note: string }>;
}

/**
 * Run the Source Verifier sub-agent for a set of claims.
 *
 * For each claim:
 * 1. Search the web for evidence
 * 2. Query fact-check databases
 * 3. Analyze credibility of top sources
 *
 * @param claims - Array of claims to verify
 * @param log - Scoped logger
 * @returns Evidence gathered for each claim
 */
export async function runSourceVerifier(
  claims: Claim[],
  log: Logger
): Promise<ClaimEvidence[]> {
  const agentLog = log.child({ agent: "source_verifier" });
  agentLog.info({ claimCount: claims.length }, "Source Verifier starting");

  const startTime = Date.now();
  const evidence: ClaimEvidence[] = [];

  for (const claim of claims) {
    agentLog.info({ claimId: claim.id, claimText: claim.text.slice(0, 80) }, "Verifying claim");

    // Run web search and fact-check in parallel for each claim
    const [webResult, factCheckResult] = await Promise.all([
      searchWeb(claim.text, agentLog),
      searchFactCheckDBs(claim.text, agentLog),
    ]);

    // Combine and deduplicate sources
    const allSources = [...webResult.sources, ...factCheckResult.sources];
    const seenUrls = new Set<string>();
    const uniqueSources = allSources.filter((s) => {
      if (seenUrls.has(s.url)) return false;
      seenUrls.add(s.url);
      return true;
    });

    // Analyze credibility of top sources (limit to 3 to control API costs)
    const topSources = uniqueSources.slice(0, 3);
    const credibilityResults = await Promise.all(
      topSources.map((s) => analyzeSourceCredibility(s.url, s.snippet, agentLog))
    );

    const credibilityAnalysis = topSources.map((s, i) => ({
      url: s.url,
      ...credibilityResults[i],
    }));

    evidence.push({
      claim,
      webAnswer: webResult.answer,
      factCheckSummary: factCheckResult.summary,
      sources: uniqueSources,
      credibilityAnalysis,
    });
  }

  const durationMs = Date.now() - startTime;
  agentLog.info(
    {
      claimCount: claims.length,
      totalSources: evidence.reduce((n, e) => n + e.sources.length, 0),
      durationMs,
    },
    "Source Verifier completed"
  );

  return evidence;
}
