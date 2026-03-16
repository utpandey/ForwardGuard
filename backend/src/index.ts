/**
 * index.ts — Fastify server entry point for the ForwardGuard backend.
 *
 * Responsibilities:
 * - Environment validation (fail fast if API keys missing)
 * - CORS configuration (locked to extension + localhost)
 * - Request/response lifecycle logging
 * - Global error handling (no raw errors to clients)
 * - Health check endpoint
 * - Route registration
 */

import "dotenv/config";
import Fastify from "fastify";
import cors from "@fastify/cors";
import { logger } from "./middleware/logger.js";
import { verifyRoutes } from "./routes/verify.js";

// ─── Environment Validation ─────────────────────────────────────────────────
// Fail fast — never run silently with missing credentials.
// Better to crash on startup than to return confusing errors on first request.

if (!process.env.ANTHROPIC_API_KEY) {
  logger.fatal("ANTHROPIC_API_KEY is required. Get one at https://console.anthropic.com");
  process.exit(1);
}

if (!process.env.TAVILY_API_KEY) {
  logger.fatal("TAVILY_API_KEY is required. Get one at https://tavily.com");
  process.exit(1);
}

// ─── Server Setup ───────────────────────────────────────────────────────────

const fastify = Fastify({
  // Use our custom Pino logger instance for consistent formatting
  logger: false, // We handle logging ourselves via middleware/logger.ts
});

// ─── CORS ───────────────────────────────────────────────────────────────────
// Only allow requests from the Chrome extension and localhost development.
// Why not "*": security — the backend should only serve our extension, not any webpage.

await fastify.register(cors, {
  origin: (origin, cb) => {
    // Allow requests with no origin (curl, Postman, server-to-server)
    if (!origin) {
      cb(null, true);
      return;
    }
    // Allow Chrome extension origins (chrome-extension://...)
    if (origin.startsWith("chrome-extension://")) {
      cb(null, true);
      return;
    }
    // Allow localhost development
    if (origin.includes("localhost") || origin.includes("127.0.0.1")) {
      cb(null, true);
      return;
    }
    cb(new Error("Not allowed by CORS"), false);
  },
  methods: ["GET", "POST"],
});

// ─── Request/Response Lifecycle Logging ─────────────────────────────────────

fastify.addHook("onRequest", async (req) => {
  logger.info(
    { method: req.method, url: req.url, ip: req.ip },
    "Incoming request"
  );
});

fastify.addHook("onResponse", async (req, reply) => {
  logger.info(
    {
      method: req.method,
      url: req.url,
      statusCode: reply.statusCode,
      durationMs: Math.round(reply.elapsedTime),
    },
    "Request completed"
  );
});

// ─── Global Error Handler ───────────────────────────────────────────────────
// Never expose raw error details to API clients.

fastify.setErrorHandler(async (error, req, reply) => {
  logger.error(
    {
      error: error.message,
      statusCode: error.statusCode,
      url: req.url,
      method: req.method,
    },
    "Unhandled server error"
  );

  const statusCode = error.statusCode ?? 500;
  reply.status(statusCode).send({
    requestId: "unknown",
    error:
      statusCode >= 500
        ? "An internal server error occurred. Please try again."
        : error.message,
    code: statusCode >= 500 ? "INTERNAL_ERROR" : "REQUEST_ERROR",
    timestamp: new Date().toISOString(),
  });
});

// ─── Routes ─────────────────────────────────────────────────────────────────

// Health check — lets the extension detect if backend is running
fastify.get("/api/v1/health", async () => {
  return {
    status: "ok",
    service: "forwardguard",
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  };
});

// Verification endpoint
await fastify.register(verifyRoutes);

// ─── Start Server ───────────────────────────────────────────────────────────

const port = parseInt(process.env.PORT ?? "3001", 10);
const host = process.env.HOST ?? "0.0.0.0";

try {
  await fastify.listen({ port, host });
  logger.info(
    { port, host, nodeEnv: process.env.NODE_ENV ?? "development" },
    `ForwardGuard backend listening on http://${host}:${port}`
  );
} catch (err) {
  logger.fatal({ error: err instanceof Error ? err.message : String(err) }, "Failed to start server");
  process.exit(1);
}
