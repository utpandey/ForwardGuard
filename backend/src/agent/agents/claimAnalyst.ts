/**
 * agents/claimAnalyst.ts — Claim Analyst sub-agent for the multi-agent pipeline.
 *
 * Responsible for extracting discrete verifiable claims from user messages
 * and images. Uses the claim_extractor tool and RAG search to identify
 * known misinformation patterns early in the pipeline.
 *
 * Role in the pipeline: Step 1 — decompose the input into actionable claims.
 */

import Anthropic from "@anthropic-ai/sdk";
import type { Claim, ClaimType } from "../../types/index.js";
import type { Logger } from "../../middleware/logger.js";
import { CLAIM_EXTRACTOR_PROMPT } from "../prompts.js";
import { searchMisinfoDatabase, type RAGSearchResult } from "../rag/vectorStore.js";

const anthropic = new Anthropic();

const CLAIM_ANALYST_SYSTEM_PROMPT = `You are the Claim Analyst, a specialized sub-agent in the ForwardGuard fact-checking system.

Your SOLE job is to extract discrete, verifiable factual claims from a message (and/or image).
You do NOT verify claims — you only identify and extract them.

Rules:
- Extract each distinct factual assertion as a separate claim
- Ignore opinions, greetings, emotional language, and filler
- Preserve the original wording as closely as possible
- Include named entities, dates, quantities, and percentages
- If an image is present, describe visual content and extract claims from it
- Classify each claim as: factual, statistical, quote, causal, or other

Return ONLY a JSON array of claims in this format:
[{ "id": "c1", "text": "...", "type": "factual|statistical|quote|causal|other" }]

If no verifiable claims exist, return an empty array: []`;

/**
 * Classify a claim's type using keyword heuristics.
 */
function classifyClaimType(text: string): ClaimType {
  const lower = text.toLowerCase();
  if (/%|\bmillion\b|\bbillion\b|\bthousand\b|\b\d+\s*(percent|%)/.test(lower)) return "statistical";
  if (/\b(said|stated|confirmed|announced|declared|claimed|reported)\b/.test(lower)) return "quote";
  if (/\b(causes?|leads?\s+to|results?\s+in|because|due\s+to|effect\s+of)\b/.test(lower)) return "causal";
  return "factual";
}

/**
 * Parse claims from the LLM response, handling both JSON and numbered-list formats.
 */
function parseClaims(output: string): Claim[] {
  // Try JSON parse first
  try {
    const parsed = JSON.parse(output);
    if (Array.isArray(parsed)) {
      return parsed.map((c: { id?: string; text?: string; type?: string }, i: number) => ({
        id: c.id ?? `c${i + 1}`,
        text: c.text ?? "",
        type: (c.type as ClaimType) ?? classifyClaimType(c.text ?? ""),
      }));
    }
  } catch {
    // Try extracting JSON from markdown
    const jsonMatch = output.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[1]);
        if (Array.isArray(parsed)) {
          return parsed.map((c: { id?: string; text?: string; type?: string }, i: number) => ({
            id: c.id ?? `c${i + 1}`,
            text: c.text ?? "",
            type: (c.type as ClaimType) ?? classifyClaimType(c.text ?? ""),
          }));
        }
      } catch { /* fall through */ }
    }
  }

  // Fallback: numbered list parsing
  if (output.trim() === "NO_CLAIMS" || output.trim() === "[]") return [];

  const lines = output
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /^\d+\.\s+/.test(l));

  return lines.map((line, i) => {
    const text = line.replace(/^\d+\.\s+/, "").trim();
    return { id: `c${i + 1}`, text, type: classifyClaimType(text) };
  });
}

export interface ClaimAnalystResult {
  claims: Claim[];
  ragMatches: RAGSearchResult[];
}

/**
 * Run the Claim Analyst sub-agent.
 *
 * @param message - The user's message text
 * @param imageBase64 - Optional base64-encoded image
 * @param log - Scoped logger
 * @returns Extracted claims and any RAG matches found
 */
export async function runClaimAnalyst(
  message: string,
  imageBase64: string | undefined,
  log: Logger
): Promise<ClaimAnalystResult> {
  const agentLog = log.child({ agent: "claim_analyst" });
  agentLog.info({ messageLength: message.length, hasImage: !!imageBase64 }, "Claim Analyst starting");

  const startTime = Date.now();

  // Build multimodal content
  const userContent: Anthropic.MessageCreateParams["messages"][0]["content"] = [];

  if (imageBase64) {
    const match = imageBase64.match(/^data:image\/(png|jpeg|gif|webp);base64,(.+)$/s);
    if (match) {
      userContent.push({
        type: "image",
        source: {
          type: "base64",
          media_type: `image/${match[1]}` as "image/png" | "image/jpeg" | "image/gif" | "image/webp",
          data: match[2],
        },
      });
    }
    agentLog.info("Including image in claim analysis (vision mode)");
  }

  userContent.push({
    type: "text",
    text: message || "(no text — analyze the image)",
  });

  // Step 1: Extract claims via Claude
  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 1024,
    temperature: 0,
    system: CLAIM_ANALYST_SYSTEM_PROMPT,
    messages: [{ role: "user", content: userContent }],
  });

  const textBlock = response.content.find((block) => block.type === "text");
  const rawOutput = textBlock?.text ?? "[]";
  const claims = parseClaims(rawOutput);

  // Step 2: Run RAG search against known misinformation DB for each claim
  const allRagMatches: RAGSearchResult[] = [];
  for (const claim of claims) {
    const matches = searchMisinfoDatabase(claim.text);
    allRagMatches.push(...matches);
  }
  // Also search the full message
  const messageMatches = searchMisinfoDatabase(message);
  allRagMatches.push(...messageMatches);

  // Deduplicate RAG matches by entry ID
  const seenIds = new Set<string>();
  const uniqueRagMatches = allRagMatches.filter((m) => {
    if (seenIds.has(m.entry.id)) return false;
    seenIds.add(m.entry.id);
    return true;
  });

  const durationMs = Date.now() - startTime;
  agentLog.info(
    { claimCount: claims.length, ragMatches: uniqueRagMatches.length, durationMs },
    "Claim Analyst completed"
  );

  return { claims, ragMatches: uniqueRagMatches };
}
