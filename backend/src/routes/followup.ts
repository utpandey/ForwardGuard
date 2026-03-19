/**
 * routes/followup.ts — POST /api/v1/followup route handler.
 *
 * Handles follow-up questions about a previous verification verdict.
 * The user asks a question, and we answer it in the context of the
 * verdict that was just produced.
 */

import { randomUUID } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { z, ZodError } from "zod";
import { createRequestLogger } from "../middleware/logger.js";
import {
  checkRateLimit,
  RateLimitError,
} from "../middleware/guardrails.js";
import type { FollowUpResponse, ErrorResponse } from "../types/index.js";

const anthropic = new Anthropic();

// ─── Validation Schema ───────────────────────────────────────────────────────

const FollowUpRequestSchema = z.object({
  question: z
    .string()
    .trim()
    .min(5, "Question must be at least 5 characters")
    .max(500, "Question must not exceed 500 characters"),
  verdictContext: z.object({
    verdict: z.string(),
    confidence: z.number(),
    explanation: z.string(),
    claims: z.array(
      z.object({
        id: z.string(),
        text: z.string(),
        type: z.string(),
      })
    ),
    sources: z.array(
      z.object({
        title: z.string(),
        url: z.string(),
        snippet: z.string(),
        credibility: z.string(),
      })
    ),
    reasoning: z.string(),
  }),
});

// ─── Helper ──────────────────────────────────────────────────────────────────

function errorResponse(
  requestId: string,
  error: string,
  code: string
): ErrorResponse {
  return {
    requestId,
    error,
    code,
    timestamp: new Date().toISOString(),
  };
}

// ─── Route Registration ──────────────────────────────────────────────────────

export async function followUpRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.post(
    "/api/v1/followup",
    async (
      req: FastifyRequest<{ Body: unknown }>,
      reply: FastifyReply
    ): Promise<FollowUpResponse | ErrorResponse> => {
      const requestId = randomUUID();
      const log = createRequestLogger(requestId, {
        route: "POST /api/v1/followup",
        ip: req.ip,
      });

      try {
        // Rate limiting
        try {
          checkRateLimit(req.ip);
        } catch (err) {
          if (err instanceof RateLimitError) {
            log.warn({ retryAfterMs: err.retryAfterMs }, "Rate limit exceeded");
            reply.status(429);
            return errorResponse(requestId, err.message, "RATE_LIMITED");
          }
          throw err;
        }

        // Validate input
        let validated;
        try {
          validated = FollowUpRequestSchema.parse(req.body);
        } catch (err) {
          if (err instanceof ZodError) {
            const messages = err.errors.map((e) => `${e.path.join(".")}: ${e.message}`);
            log.warn({ validationErrors: messages }, "Follow-up validation failed");
            reply.status(400);
            return errorResponse(
              requestId,
              `Validation error: ${messages.join(", ")}`,
              "VALIDATION_ERROR"
            );
          }
          throw err;
        }

        const { question, verdictContext } = validated;

        log.info(
          { questionLength: question.length, verdict: verdictContext.verdict },
          "Processing follow-up question"
        );

        // Build context summary for the LLM
        const claimsSummary = verdictContext.claims
          .map((c) => `- [${c.id}] ${c.text}`)
          .join("\n");

        const sourcesSummary = verdictContext.sources
          .slice(0, 5)
          .map((s) => `- ${s.title} (${s.url}) [${s.credibility}]`)
          .join("\n");

        const systemPrompt = `You are ForwardGuard, an AI fact-checking assistant. You just verified a forwarded message and produced the following verdict:

Verdict: ${verdictContext.verdict}
Confidence: ${Math.round(verdictContext.confidence * 100)}%
Explanation: ${verdictContext.explanation}

Claims analyzed:
${claimsSummary || "No specific claims extracted."}

Sources consulted:
${sourcesSummary || "No external sources found."}

Reasoning: ${verdictContext.reasoning}

The user is now asking a follow-up question about this verification. Answer based on the verification you performed. Be helpful, concise, and honest. If you don't know the answer or it's outside the scope of your verification, say so. Keep your answer to 2-4 sentences.`;

        // Make a single Claude call
        const response = await anthropic.messages.create({
          model: "claude-sonnet-4-6",
          max_tokens: 512,
          temperature: 0,
          system: systemPrompt,
          messages: [{ role: "user", content: question }],
        });

        const textBlock = response.content.find((b) => b.type === "text");
        const answer = textBlock?.text ?? "I was unable to generate an answer. Please try again.";

        log.info(
          { answerLength: answer.length },
          "Follow-up question answered"
        );

        const followUpResponse: FollowUpResponse = {
          requestId,
          answer,
          timestamp: new Date().toISOString(),
        };

        return followUpResponse;
      } catch (err) {
        log.error(
          { error: err instanceof Error ? err.message : String(err) },
          "Unhandled error in followup route"
        );
        reply.status(500);
        return errorResponse(
          requestId,
          "An internal error occurred. Please try again.",
          "INTERNAL_ERROR"
        );
      }
    }
  );
}
