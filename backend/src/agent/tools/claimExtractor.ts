/**
 * tools/claimExtractor.ts — Claim extraction tool for the ForwardGuard agent.
 *
 * Decomposes a multi-claim message into individual verifiable assertions.
 * Uses a direct Anthropic SDK call (not LangChain) for precise control over
 * the extraction prompt and parsing logic.
 *
 * Why a separate tool (not inline in the agent): Single responsibility.
 * Independently testable. Makes all downstream tool calls precise —
 * each claim gets its own web search and fact-check query.
 */

import Anthropic from "@anthropic-ai/sdk";
import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import type { Claim, ClaimType } from "../../types/index.js";
import { CLAIM_EXTRACTOR_PROMPT } from "../prompts.js";
import { logger } from "../../middleware/logger.js";

const anthropic = new Anthropic();

/**
 * Classify a claim's type using keyword heuristics.
 *
 * Why heuristics not LLM: fast, deterministic, zero cost.
 * The classification doesn't need to be perfect — it's metadata
 * for the UI and downstream tools, not a critical decision.
 */
function classifyClaimType(text: string): ClaimType {
  const lower = text.toLowerCase();

  if (/%|\bmillion\b|\bbillion\b|\bthousand\b|\b\d+\s*(percent|%)/.test(lower)) {
    return "statistical";
  }
  if (/\b(said|stated|confirmed|announced|declared|claimed|reported)\b/.test(lower)) {
    return "quote";
  }
  if (/\b(causes?|leads?\s+to|results?\s+in|because|due\s+to|effect\s+of)\b/.test(lower)) {
    return "causal";
  }
  return "factual";
}

/**
 * Parse the LLM's numbered list output into structured claims.
 * Handles edge cases: empty output, "NO_CLAIMS", malformed lines.
 */
function parseClaims(output: string): Claim[] {
  if (!output || output.trim() === "NO_CLAIMS") {
    return [];
  }

  const lines = output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^\d+\.\s+/.test(line)); // Only numbered lines

  return lines.map((line, index) => {
    const text = line.replace(/^\d+\.\s+/, "").trim();
    return {
      id: `c${index + 1}`,
      text,
      type: classifyClaimType(text),
    };
  });
}

/**
 * LangChain tool wrapper for the claim extractor.
 * The agent calls this tool to decompose messages into individual claims.
 */
export const claimExtractorTool = new DynamicStructuredTool({
  name: "claim_extractor",
  description:
    "Extract individual verifiable factual claims from a message. " +
    "Call this FIRST to decompose a multi-claim message into discrete assertions " +
    "that can each be independently verified.",
  schema: z.object({
    message: z.string().describe("The full message text to extract claims from"),
  }),
  func: async ({ message }): Promise<string> => {
    const startTime = Date.now();
    const log = logger.child({ tool: "claim_extractor" });

    log.info({ messageLength: message.length }, "Invoking claim_extractor");

    try {
      // Direct Anthropic SDK call — not via LangChain.
      // Why: claim extraction is a simple, focused task that benefits from
      // a dedicated system prompt, not the agent's full system prompt.
      const response = await anthropic.messages.create({
        model: "claude-sonnet-4-6",
        max_tokens: 1024,
        temperature: 0, // Deterministic — same message should always extract same claims
        system: CLAIM_EXTRACTOR_PROMPT,
        messages: [{ role: "user", content: message }],
      });

      const textBlock = response.content.find((block) => block.type === "text");
      const rawOutput = textBlock?.text ?? "";
      const claims = parseClaims(rawOutput);

      const durationMs = Date.now() - startTime;
      log.info(
        { claimCount: claims.length, durationMs },
        "claim_extractor completed"
      );

      // Return as JSON string — LangChain tools must return strings
      return JSON.stringify({ claims });
    } catch (error) {
      const durationMs = Date.now() - startTime;
      log.error(
        { error: error instanceof Error ? error.message : String(error), durationMs },
        "claim_extractor failed"
      );
      // Return a safe fallback instead of throwing — let the agent handle gracefully
      return JSON.stringify({ claims: [], error: "Failed to extract claims" });
    }
  },
});
