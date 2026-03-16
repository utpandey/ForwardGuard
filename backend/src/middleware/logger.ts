/**
 * middleware/logger.ts — Structured logging for the ForwardGuard backend.
 *
 * Uses Pino for high-performance JSON logging. In development, pino-pretty
 * provides human-readable colorized output. In production, raw JSON is emitted
 * for ingestion by Datadog, CloudWatch, or similar observability platforms.
 *
 * Every log line carries a requestId for end-to-end trace correlation.
 */

import pino from "pino";

const isProduction = process.env.NODE_ENV === "production";

/**
 * Root logger instance.
 *
 * Why pino over winston: 5x faster, native Fastify integration, structured JSON
 * by default. In production we redact message content for user privacy.
 */
export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",

  // Redact message content in production to protect user privacy
  // In dev, we want to see the full message for debugging
  ...(isProduction && {
    redact: {
      paths: ["req.body.message", "message"],
      censor: "[REDACTED]",
    },
  }),

  transport: isProduction
    ? undefined // Raw JSON in production — queryable in log aggregators
    : {
        target: "pino-pretty",
        options: {
          colorize: true,
          translateTime: "SYS:HH:MM:ss.l",
          ignore: "pid,hostname",
        },
      },
});

/**
 * Create a child logger scoped to a specific request.
 * Every log line from this logger automatically includes the requestId,
 * enabling full request tracing across all tool calls and middleware.
 */
export function createRequestLogger(
  requestId: string,
  meta?: Record<string, unknown>
): pino.Logger {
  return logger.child({ requestId, ...meta });
}

export type Logger = pino.Logger;
