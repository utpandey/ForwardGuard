/**
 * rag/vectorStore.ts — RAG (Retrieval-Augmented Generation) pipeline for ForwardGuard.
 *
 * Implements a keyword-overlap similarity search over a curated misinformation
 * database. When a new claim comes in, we tokenize it and compute Jaccard
 * similarity against each entry's keywords to find the most relevant matches.
 *
 * Architecture pattern: This demonstrates the RAG retrieval step. In production,
 * this would use a proper vector store (Pinecone, Weaviate) with neural embeddings.
 * For the hackathon, keyword-based retrieval is fast, requires no external API,
 * and still demonstrates the retrieval-augmented generation pattern.
 */

import { MISINFO_DATABASE, type MisinfoEntry } from "./misinfoDb.js";
import { logger } from "../../middleware/logger.js";

/**
 * Tokenize a string into lowercase keywords, stripping punctuation.
 * Removes common stop words to improve match quality.
 */
const STOP_WORDS = new Set([
  "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
  "have", "has", "had", "do", "does", "did", "will", "would", "shall",
  "should", "may", "might", "can", "could", "to", "of", "in", "for",
  "on", "with", "at", "by", "from", "this", "that", "it", "its",
  "and", "or", "but", "not", "no", "if", "so", "as", "than",
]);

function tokenize(text: string): Set<string> {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 1 && !STOP_WORDS.has(w));
  return new Set(words);
}

/**
 * Compute Jaccard similarity between two sets of tokens.
 * Returns a value between 0 (no overlap) and 1 (identical).
 */
function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  let intersection = 0;
  for (const token of a) {
    if (b.has(token)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

export interface RAGSearchResult {
  entry: MisinfoEntry;
  similarity: number;
}

/**
 * Search the misinformation database for claims similar to the query.
 *
 * @param query - The claim text to search for
 * @param topK - Maximum number of results to return (default: 3)
 * @param threshold - Minimum similarity score to include (default: 0.15)
 * @returns Array of matching entries sorted by similarity (descending)
 */
export function searchMisinfoDatabase(
  query: string,
  topK: number = 3,
  threshold: number = 0.15
): RAGSearchResult[] {
  const log = logger.child({ module: "rag_vector_store" });
  const queryTokens = tokenize(query);

  log.info(
    { query: query.slice(0, 100), tokenCount: queryTokens.size },
    "RAG search initiated"
  );

  const results: RAGSearchResult[] = [];

  for (const entry of MISINFO_DATABASE) {
    // Build the entry's token set from keywords + claim text
    const entryTokens = new Set<string>([
      ...entry.keywords,
      ...tokenize(entry.claim),
    ]);

    const similarity = jaccardSimilarity(queryTokens, entryTokens);

    if (similarity >= threshold) {
      results.push({ entry, similarity });
    }
  }

  // Sort by similarity descending, take topK
  results.sort((a, b) => b.similarity - a.similarity);
  const topResults = results.slice(0, topK);

  log.info(
    {
      totalMatches: results.length,
      returned: topResults.length,
      topSimilarity: topResults[0]?.similarity ?? 0,
    },
    "RAG search completed"
  );

  return topResults;
}
