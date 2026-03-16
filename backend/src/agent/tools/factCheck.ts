/**
 * tools/factCheck.ts — Fact-checking database search tool for the ForwardGuard agent.
 *
 * Queries dedicated fact-checking organizations via Tavily's domain-filtered search.
 * Every result from this tool is inherently high-credibility because the search
 * is restricted to trusted fact-checking domains only.
 *
 * Why separate from web_search: signal-to-noise is much higher. A general web
 * search may return social media posts or blog opinions. This tool guarantees
 * results from professional fact-checkers (Snopes, PolitiFact, Reuters, etc.).
 */

import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import type { FactCheckEntry } from "../../types/index.js";
import { logger } from "../../middleware/logger.js";

// ─── Trusted Fact-Checking Domains ──────────────────────────────────────────

const FACT_CHECK_DOMAINS = [
  "snopes.com",
  "politifact.com",
  "factcheck.org",
  "reuters.com",
  "apnews.com",
  "fullfact.org",
  "afp.com",
  "poynter.org",
  "who.int",
];

// ─── Verdict Auto-Detection ─────────────────────────────────────────────────

/**
 * Attempt to extract a verdict from the fact-checker's snippet.
 *
 * Why auto-detect: saves the agent a reasoning step. If Snopes says "FALSE",
 * we can surface that directly. The agent still makes the final call, but
 * this provides a strong signal.
 */
function detectVerdictFromSnippet(snippet: string): string | undefined {
  const lower = snippet.toLowerCase();

  if (/\b(false|debunked|misleading|fake|fabricated|hoax)\b/.test(lower)) {
    return "FALSE";
  }
  if (/\b(true|accurate|confirmed|correct|verified)\b/.test(lower)) {
    return "TRUE";
  }
  if (/\b(unproven|unverified|no evidence|inconclusive|mixture)\b/.test(lower)) {
    return "UNKNOWN";
  }

  return undefined; // No clear verdict detected
}

/**
 * Extract the organization name from a URL's domain.
 */
function extractOrganization(url: string): string {
  try {
    const hostname = new URL(url).hostname.replace(/^www\./, "");
    const domainMap: Record<string, string> = {
      "snopes.com": "Snopes",
      "politifact.com": "PolitiFact",
      "factcheck.org": "FactCheck.org",
      "reuters.com": "Reuters",
      "apnews.com": "AP News",
      "fullfact.org": "Full Fact",
      "afp.com": "AFP",
      "poynter.org": "Poynter",
      "who.int": "WHO",
    };
    return domainMap[hostname] ?? hostname;
  } catch {
    return "Unknown";
  }
}

// ─── Tavily API Types ───────────────────────────────────────────────────────

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

// ─── Tool Definition ────────────────────────────────────────────────────────

export const factCheckTool = new DynamicStructuredTool({
  name: "fact_check_db",
  description:
    "Search dedicated fact-checking organizations (Snopes, PolitiFact, Reuters, " +
    "AP News, etc.) for existing verdicts on a claim. Every result from this tool " +
    "is from a trusted fact-checking source. Use after web_search for authoritative verification.",
  schema: z.object({
    claim: z
      .string()
      .describe("The specific claim to look up in fact-checking databases"),
  }),
  func: async ({ claim }): Promise<string> => {
    const startTime = Date.now();
    const log = logger.child({ tool: "fact_check_db" });

    log.info({ claim }, "Invoking fact_check_db");

    try {
      const tavilyApiKey = process.env.TAVILY_API_KEY;
      if (!tavilyApiKey) {
        throw new Error("TAVILY_API_KEY is not configured");
      }

      // Prefix query with "fact check:" to bias results toward verification articles
      const query = `fact check: ${claim}`;

      const response = await fetch("https://api.tavily.com/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          api_key: tavilyApiKey,
          query,
          search_depth: "advanced",
          max_results: 5,
          include_answer: true,
          include_domains: FACT_CHECK_DOMAINS, // Only search trusted fact-checkers
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Tavily API error (${response.status}): ${errorText}`);
      }

      const data = (await response.json()) as TavilyResponse;

      const results: FactCheckEntry[] = (data.results || []).map((result) => ({
        organization: extractOrganization(result.url),
        title: result.title,
        url: result.url,
        verdict: detectVerdictFromSnippet(result.content),
        snippet: result.content.slice(0, 300),
      }));

      const factCheckResult = {
        summary: data.answer ?? "No fact-check summary available",
        results,
      };

      const durationMs = Date.now() - startTime;
      log.info(
        {
          claim,
          resultCount: results.length,
          verdictsFound: results.filter((r) => r.verdict).length,
          durationMs,
        },
        "fact_check_db completed"
      );

      return JSON.stringify(factCheckResult);
    } catch (error) {
      const durationMs = Date.now() - startTime;
      log.error(
        { error: error instanceof Error ? error.message : String(error), claim, durationMs },
        "fact_check_db failed"
      );
      return JSON.stringify({
        summary: "Fact-check search failed",
        results: [],
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
  },
});
