/**
 * tools/webSearch.ts — Live web search tool for the ForwardGuard agent.
 *
 * Searches the live web for current credible sources about a claim using
 * the Tavily Search API. Results are scored by domain credibility.
 *
 * Why Tavily over Google Custom Search: built specifically for LLM agents,
 * returns clean snippets (not raw HTML), has include_answer synthesis,
 * and a generous free tier.
 */

import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import type { Source, Credibility } from "../../types/index.js";
import { logger } from "../../middleware/logger.js";

// ─── Domain Credibility Scoring ─────────────────────────────────────────────

/**
 * High-credibility domains: established news agencies, government health bodies,
 * peer-reviewed journals, and dedicated fact-checking organizations.
 */
const HIGH_CREDIBILITY_DOMAINS = new Set([
  "who.int",
  "cdc.gov",
  "nih.gov",
  "gov.uk",
  "reuters.com",
  "apnews.com",
  "bbc.com",
  "nature.com",
  "snopes.com",
  "politifact.com",
  "factcheck.org",
]);

/**
 * Known misinformation sources. These are excluded from Tavily results
 * via exclude_domains, but we score them here as a safety net.
 */
const LOW_CREDIBILITY_DOMAINS = new Set([
  "infowars.com",
  "naturalnews.com",
  "beforeitsnews.com",
  "worldnewsdailyreport.com",
]);

/** Excluded from Tavily search entirely */
const EXCLUDED_DOMAINS = [
  "infowars.com",
  "naturalnews.com",
  "beforeitsnews.com",
];

/**
 * Score a URL's credibility based on its domain.
 * Why domain-based scoring: simple, fast, transparent. Users can see exactly
 * why a source was rated high/medium/low. No black-box LLM judgment.
 */
function scoreDomainCredibility(url: string): Credibility {
  try {
    const hostname = new URL(url).hostname.replace(/^www\./, "");
    if (HIGH_CREDIBILITY_DOMAINS.has(hostname)) return "high";
    if (LOW_CREDIBILITY_DOMAINS.has(hostname)) return "low";
    // Check if hostname ends with a high-credibility domain (e.g., news.bbc.com)
    for (const domain of HIGH_CREDIBILITY_DOMAINS) {
      if (hostname.endsWith(`.${domain}`)) return "high";
    }
    return "medium";
  } catch {
    return "medium"; // Malformed URL — default to medium
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

export const webSearchTool = new DynamicStructuredTool({
  name: "web_search",
  description:
    "Search the live web for current credible sources about a specific claim. " +
    "Returns up to 5 results with snippets and credibility scores. " +
    "Use this to find evidence supporting or contradicting a claim.",
  schema: z.object({
    query: z
      .string()
      .describe("The search query — should be a specific factual claim to verify"),
  }),
  func: async ({ query }): Promise<string> => {
    const startTime = Date.now();
    const log = logger.child({ tool: "web_search" });

    log.info({ query }, "Invoking web_search");

    try {
      const tavilyApiKey = process.env.TAVILY_API_KEY;
      if (!tavilyApiKey) {
        throw new Error("TAVILY_API_KEY is not configured");
      }

      const response = await fetch("https://api.tavily.com/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          api_key: tavilyApiKey,
          query,
          search_depth: "advanced", // More thorough than basic — worth the extra latency for fact-checking
          max_results: 5,
          include_answer: true, // Tavily synthesizes a short answer from results
          exclude_domains: EXCLUDED_DOMAINS,
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Tavily API error (${response.status}): ${errorText}`);
      }

      const data = (await response.json()) as TavilyResponse;

      const sources: Source[] = (data.results || []).map((result) => ({
        title: result.title,
        url: result.url,
        snippet: result.content.slice(0, 300), // Truncate to keep agent context manageable
        credibility: scoreDomainCredibility(result.url),
      }));

      const result = {
        query,
        answer: data.answer ?? "No synthesized answer available",
        sources,
        totalResults: sources.length,
      };

      const durationMs = Date.now() - startTime;
      log.info(
        { query, resultCount: sources.length, durationMs },
        "web_search completed"
      );

      return JSON.stringify(result);
    } catch (error) {
      const durationMs = Date.now() - startTime;
      log.error(
        { error: error instanceof Error ? error.message : String(error), query, durationMs },
        "web_search failed"
      );
      return JSON.stringify({
        query,
        answer: "Search failed",
        sources: [],
        totalResults: 0,
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
  },
});
