/**
 * routes/verify.ts — POST /api/v1/verify route handler.
 *
 * This is the main entry point for verification requests. It orchestrates
 * the full request lifecycle: requestId generation → rate limiting → validation
 * → input guardrails → agent execution → output guardrails → response.
 *
 * Every step is logged with the requestId for end-to-end tracing.
 * Errors are never exposed raw — always wrapped in a clean ErrorResponse.
 */

import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { ZodError } from "zod";
import { createRequestLogger } from "../middleware/logger.js";
import {
  checkRateLimit,
  VerifyRequestSchema,
  runInputGuardrails,
  runOutputGuardrails,
  RateLimitError,
  ContentBlockedError,
  OutputGuardrailError,
} from "../middleware/guardrails.js";
import { verify } from "../agent/agent.js";
import type { VerifyResponse, ErrorResponse } from "../types/index.js";

/**
 * Build a consistent error response shape.
 * Why a helper: ensures every error path returns the same structure,
 * making client-side error handling predictable.
 */
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

/**
 * Register the /api/v1/verify route as a Fastify plugin.
 *
 * Why plugin pattern: Fastify's encapsulation model. Routes are registered
 * as plugins so they can be tested independently and don't pollute the
 * global server scope.
 */
export async function verifyRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.post(
    "/api/v1/verify",
    async (
      req: FastifyRequest<{ Body: unknown }>,
      reply: FastifyReply
    ): Promise<VerifyResponse | ErrorResponse> => {
      // Step 1: Generate a unique request ID for tracing
      const requestId = randomUUID();

      // Step 2: Create a scoped logger — every log line includes this requestId
      const log = createRequestLogger(requestId, {
        route: "POST /api/v1/verify",
        ip: req.ip,
      });

      try {
        // Step 3: Rate limiting — prevent abuse
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

        // Step 4: Zod schema validation — enforce request shape
        let validated;
        try {
          validated = VerifyRequestSchema.parse(req.body);
        } catch (err) {
          if (err instanceof ZodError) {
            const messages = err.errors.map((e) => `${e.path.join(".")}: ${e.message}`);
            log.warn({ validationErrors: messages }, "Request validation failed");
            reply.status(400);
            return errorResponse(
              requestId,
              `Validation error: ${messages.join(", ")}`,
              "VALIDATION_ERROR"
            );
          }
          throw err;
        }

        const { message, context, language, imageBase64, pdfText } = validated;

        // Step 5: Input content guardrails — block dangerous patterns
        try {
          runInputGuardrails(message, log, !!imageBase64 || !!pdfText);
        } catch (err) {
          if (err instanceof ContentBlockedError) {
            reply.status(422);
            return errorResponse(requestId, err.message, "CONTENT_BLOCKED");
          }
          throw err;
        }

        // Step 6: Start verification
        log.info(
          { messageLength: message.length, hasContext: !!context, language },
          "Starting verification"
        );
        const startTime = Date.now();

        // Step 7: Run the agent
        const agentResult = await verify(
          { message, context, language, imageBase64, pdfText },
          requestId,
          log
        );

        // Step 8: Output guardrails — validate agent response
        try {
          runOutputGuardrails(agentResult.explanation, log);
        } catch (err) {
          if (err instanceof OutputGuardrailError) {
            reply.status(500);
            return errorResponse(requestId, err.message, "AGENT_ERROR");
          }
          throw err;
        }

        // Step 9: Calculate processing time
        const processingTimeMs = Date.now() - startTime;

        // Step 10: Log the verdict
        log.info(
          {
            verdict: agentResult.verdict,
            confidence: agentResult.confidence,
            processingTimeMs,
            toolsUsed: agentResult.toolsUsed,
            claimCount: agentResult.claims.length,
            sourceCount: agentResult.sources.length,
          },
          "Verification complete"
        );

        // Step 11: Return the full response
        const response: VerifyResponse = {
          requestId,
          verdict: agentResult.verdict,
          confidence: agentResult.confidence,
          explanation: agentResult.explanation,
          claims: agentResult.claims,
          sources: agentResult.sources,
          toolsUsed: agentResult.toolsUsed,
          reasoning: agentResult.reasoning,
          processingTimeMs,
          timestamp: new Date().toISOString(),
        };

        return response;
      } catch (err) {
        // Global catch — never let raw errors reach the user
        log.error(
          { error: err instanceof Error ? err.message : String(err) },
          "Unhandled error in verify route"
        );
        reply.status(500);
        return errorResponse(
          requestId,
          "An internal error occurred during verification. Please try again.",
          "INTERNAL_ERROR"
        );
      }
    }
  );
}
