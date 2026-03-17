/**
 * tools/ragSearch.ts — RAG retrieval tool for the ForwardGuard agent.
 *
 * Queries the in-memory misinformation vector store to find known hoaxes
 * that match the user's claim. This provides instant results for well-known
 * misinformation without requiring external API calls.
 *
 * Architecture: This is the "Retrieval" step of Retrieval-Augmented Generation.
 * The retrieved context is then passed to the LLM for the "Generation" step
 * (verdict synthesis with retrieved evidence).
 */

import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import { searchMisinfoDatabase } from "../rag/vectorStore.js";
import { logger } from "../../middleware/logger.js";

export const ragSearchTool = new DynamicStructuredTool({
  name: "rag_misinfo_search",
  description:
    "Search the known misinformation database (RAG vector store) for claims similar to the query. " +
    "Returns matching hoaxes/debunked claims with their verdicts and debunking information. " +
    "Use this FIRST before web search to check if a claim matches a well-known hoax.",
  schema: z.object({
    claim: z
      .string()
      .describe("The claim text to search for in the misinformation database"),
  }),
  func: async ({ claim }): Promise<string> => {
    const startTime = Date.now();
    const log = logger.child({ tool: "rag_misinfo_search" });

    log.info({ claim: claim.slice(0, 100) }, "Invoking rag_misinfo_search");

    try {
      const results = searchMisinfoDatabase(claim);

      const matches = results.map((r) => ({
        knownClaim: r.entry.claim,
        verdict: r.entry.verdict,
        debunking: r.entry.debunking,
        source: r.entry.source,
        similarityScore: Math.round(r.similarity * 100) / 100,
      }));

      const result = {
        query: claim,
        matchesFound: matches.length,
        matches,
        note:
          matches.length > 0
            ? "Found matches in known misinformation database. Use these as strong evidence."
            : "No matches found in known misinformation database. Proceed with web search.",
      };

      const durationMs = Date.now() - startTime;
      log.info(
        { matchCount: matches.length, durationMs },
        "rag_misinfo_search completed"
      );

      return JSON.stringify(result);
    } catch (error) {
      const durationMs = Date.now() - startTime;
      log.error(
        { error: error instanceof Error ? error.message : String(error), durationMs },
        "rag_misinfo_search failed"
      );
      return JSON.stringify({
        query: claim,
        matchesFound: 0,
        matches: [],
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
  },
});
