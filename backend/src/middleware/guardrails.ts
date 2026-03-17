/**
 * middleware/guardrails.ts — Input and output guardrails for the ForwardGuard API.
 *
 * Defence-in-depth strategy:
 * 1. Rate limiting — prevent abuse (in-memory, production should use Redis)
 * 2. Schema validation — enforce request shape with Zod
 * 3. Content filtering — block prompt injection and dangerously short messages
 * 4. Output validation — never return empty or garbage explanations to users
 */

import { z } from "zod";
import type { Logger } from "./logger.js";

// ─── Rate Limiting ──────────────────────────────────────────────────────────

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

/**
 * In-memory rate limit store.
 * Production: use Redis sliding window for distributed rate limiting.
 * In-memory is sufficient for single-server deployment.
 */
const rateLimitStore = new Map<string, RateLimitEntry>();

const RATE_LIMIT_MAX = 10; // requests per window
const RATE_LIMIT_WINDOW_MS = 60_000; // 60 seconds

// Clean up expired entries every 60 seconds to prevent memory leaks
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of rateLimitStore) {
    if (entry.resetAt <= now) {
      rateLimitStore.delete(ip);
    }
  }
}, RATE_LIMIT_WINDOW_MS);

/**
 * Check if an IP has exceeded the rate limit.
 * Returns true if the request is allowed, throws if rate limited.
 */
export function checkRateLimit(ip: string): void {
  const now = Date.now();
  const entry = rateLimitStore.get(ip);

  if (!entry || entry.resetAt <= now) {
    // First request or window expired — start fresh
    rateLimitStore.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return;
  }

  entry.count++;

  if (entry.count > RATE_LIMIT_MAX) {
    const retryAfterMs = entry.resetAt - now;
    throw new RateLimitError(
      `Rate limit exceeded. Try again in ${Math.ceil(retryAfterMs / 1000)} seconds.`,
      retryAfterMs
    );
  }
}

export class RateLimitError extends Error {
  public retryAfterMs: number;
  constructor(message: string, retryAfterMs: number) {
    super(message);
    this.name = "RateLimitError";
    this.retryAfterMs = retryAfterMs;
  }
}

// ─── Zod Schema Validation ──────────────────────────────────────────────────

/**
 * Request body schema with strict validation.
 * Why Zod over manual validation: type inference, composable, detailed error messages.
 */
export const VerifyRequestSchema = z.object({
  message: z
    .string()
    .trim()
    .max(2000, "Message must not exceed 2000 characters")
    .default(""),
  context: z
    .string()
    .max(500, "Context must not exceed 500 characters")
    .optional(),
  language: z
    .string()
    .length(2, "Language must be a 2-character ISO 639-1 code")
    .default("en")
    .optional(),
  imageBase64: z
    .string()
    .max(10_000_000, "Image must not exceed ~7.5MB encoded")
    .optional(),
  pdfText: z
    .string()
    .max(10_000, "PDF text must not exceed 10000 characters")
    .optional(),
}).refine(
  (data) => data.message.length >= 5 || !!data.imageBase64 || !!data.pdfText,
  { message: "Either message (min 5 chars), an image, or PDF text is required" }
);

export type ValidatedVerifyRequest = z.infer<typeof VerifyRequestSchema>;

// ─── Input Content Guardrails ───────────────────────────────────────────────

/**
 * Patterns that indicate prompt injection or system prompt extraction attempts.
 * Why regex not LLM: deterministic, fast, auditable, no false negatives from model confusion.
 */
const BLOCKED_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  {
    pattern: /ignore\s+(all\s+)?(previous|prior|above)\s+(instructions|prompts)/i,
    reason: "Prompt injection attempt: instruction override",
  },
  {
    pattern: /system\s*prompt|you\s+are\s+now|act\s+as\s+a/i,
    reason: "Prompt injection attempt: role manipulation",
  },
  {
    pattern: /reveal\s+(your|the)\s+(system|initial|original)\s*(prompt|instructions)/i,
    reason: "Prompt injection attempt: system prompt extraction",
  },
  {
    pattern: /\bDAN\b.*\bjailbreak/i,
    reason: "Prompt injection attempt: jailbreak",
  },
];

export class ContentBlockedError extends Error {
  public reason: string;
  constructor(message: string, reason: string) {
    super(message);
    this.name = "ContentBlockedError";
    this.reason = reason;
  }
}

/**
 * Run input guardrails on the message text.
 * Checks for prompt injection patterns and minimum word count.
 */
export function runInputGuardrails(message: string, log: Logger, hasImage?: boolean): void {
  // Check word count — messages under 3 words are not meaningful to verify
  // Skip this check if an image is attached (image is the content)
  const wordCount = message.trim().split(/\s+/).length;
  if (wordCount < 3 && !hasImage) {
    log.warn({ wordCount }, "Message too short for verification");
    throw new ContentBlockedError(
      "Message is too short to verify. Please provide a complete claim or statement.",
      "Message must contain at least 3 words"
    );
  }

  // Check for prompt injection patterns
  for (const { pattern, reason } of BLOCKED_PATTERNS) {
    if (pattern.test(message)) {
      log.warn({ reason }, "Input blocked by content filter");
      throw new ContentBlockedError(
        "This message cannot be processed by our verification system.",
        reason
      );
    }
  }
}

// ─── Output Guardrails ──────────────────────────────────────────────────────

export class OutputGuardrailError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OutputGuardrailError";
  }
}

/**
 * Validate the agent's output before returning to the user.
 * Never expose raw or empty LLM output — always return something meaningful.
 */
export function runOutputGuardrails(explanation: string, log: Logger): void {
  if (!explanation || explanation.trim().length < 10) {
    log.error(
      { explanationLength: explanation?.length ?? 0 },
      "Agent produced empty or insufficient explanation"
    );
    throw new OutputGuardrailError(
      "The verification agent failed to produce a valid explanation. Please try again."
    );
  }
}
