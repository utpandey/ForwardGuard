/**
 * agent/agent.ts — The core verification agent for ForwardGuard.
 *
 * Now uses a multi-agent orchestrator pattern instead of a single AgentExecutor.
 * The pipeline consists of three specialized sub-agents:
 * 1. Claim Analyst — extracts claims + RAG search against known misinformation
 * 2. Source Verifier — web search, fact-check DBs, source credibility analysis
 * 3. Verdict Synthesizer — produces the final structured verdict
 *
 * The verify() export signature is preserved so routes don't change.
 */

import type { VerifyRequest, AgentVerdict } from "../types/index.js";
import type { Logger } from "../middleware/logger.js";
import { runOrchestrator } from "./agents/orchestrator.js";

// ─── Request-Scoped Image Store ──────────────────────────────────────────
// Kept for backward compatibility with tools that import getCurrentRequestImage.
let _currentRequestImage: string | undefined;
export function getCurrentRequestImage(): string | undefined { return _currentRequestImage; }

// ─── Default Fallback Verdict ────────────────────────────────────────────

const FALLBACK_VERDICT: AgentVerdict = {
  verdict: "UNKNOWN",
  confidence: 0.3,
  explanation:
    "The verification agent was unable to produce a clear verdict. " +
    "This may be due to an ambiguous claim or temporary service issue.",
  claims: [],
  sources: [],
  toolsUsed: [],
  reasoning: "Agent output could not be parsed into a structured verdict.",
};

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Run the multi-agent verification pipeline on a message.
 *
 * @param request - The verification request (message, context, language)
 * @param requestId - UUID for log correlation
 * @param log - Scoped Pino logger with requestId bound
 * @returns Structured verdict (without requestId, timing — route handler adds those)
 */
export async function verify(
  request: VerifyRequest,
  requestId: string,
  log: Logger
): Promise<AgentVerdict> {
  log.info(
    { messageLength: request.message.length, hasImage: !!request.imageBase64 },
    "Multi-agent pipeline starting verification"
  );

  // Set request-scoped image for backward-compatible tool access
  _currentRequestImage = request.imageBase64;

  try {
    const verdict = await runOrchestrator(request, log);

    log.info(
      {
        verdict: verdict.verdict,
        confidence: verdict.confidence,
        toolsUsed: verdict.toolsUsed,
      },
      "Multi-agent pipeline completed verification"
    );

    _currentRequestImage = undefined;
    return verdict;
  } catch (error) {
    _currentRequestImage = undefined;
    log.error(
      { error: error instanceof Error ? error.message : String(error) },
      "Multi-agent pipeline verification failed"
    );

    return {
      ...FALLBACK_VERDICT,
      reasoning: `Pipeline error: ${error instanceof Error ? error.message : "Unknown error"}`,
    };
  }
}
