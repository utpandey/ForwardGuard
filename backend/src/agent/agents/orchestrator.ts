/**
 * agents/orchestrator.ts — Multi-agent orchestrator for ForwardGuard.
 *
 * Coordinates the three specialized sub-agents in a sequential pipeline:
 * 1. Claim Analyst — extracts claims + RAG search
 * 2. Source Verifier — gathers evidence for each claim
 * 3. Verdict Synthesizer — produces final structured verdict
 *
 * Also runs the LLM-based scam detector when the message contains
 * suspicious patterns.
 *
 * Why a sequential pipeline over complex routing: fact-checking has a natural
 * linear flow (extract → verify → synthesize). Each stage depends on the
 * previous stage's output. A simple pipeline is easier to debug, log, and
 * reason about than a graph-based agent router.
 */

import type { VerifyRequest, AgentVerdict, ScamDetectorResult } from "../../types/index.js";
import type { Logger } from "../../middleware/logger.js";
import { runClaimAnalyst } from "./claimAnalyst.js";
import { runSourceVerifier } from "./sourceVerifier.js";
import { runVerdictSynthesizer } from "./verdictSynthesizer.js";
import { runLLMScamDetector } from "../tools/scamDetector.js";

/** Default fallback verdict when the pipeline fails */
const FALLBACK_VERDICT: AgentVerdict = {
  verdict: "UNKNOWN",
  confidence: 0.3,
  explanation:
    "The verification system was unable to produce a clear verdict. " +
    "This may be due to an ambiguous claim or a temporary service issue.",
  claims: [],
  sources: [],
  toolsUsed: [],
  reasoning: "Multi-agent pipeline failed to produce a verdict.",
};

/**
 * Run the full multi-agent verification pipeline.
 *
 * @param request - The verification request
 * @param log - Scoped logger with requestId bound
 * @returns Structured verdict
 */
export async function runOrchestrator(
  request: VerifyRequest,
  log: Logger
): Promise<AgentVerdict> {
  const orchestratorLog = log.child({ agent: "orchestrator" });
  orchestratorLog.info(
    { messageLength: request.message.length, hasImage: !!request.imageBase64, hasPdf: !!request.pdfText },
    "Orchestrator pipeline starting"
  );

  const pipelineStart = Date.now();
  const toolsUsed: string[] = [];

  try {
    // ─── Stage 0 (optional): PDF Text Prepend ──────────────────────────
    let messageForAnalysis = request.message;
    if (request.pdfText) {
      orchestratorLog.info(
        { pdfTextLength: request.pdfText.length },
        "PDF text detected — prepending to message for analysis"
      );
      messageForAnalysis = `[PDF Document Content]\n${request.pdfText}\n\n[User Message]\n${request.message}`;
      toolsUsed.push("pdf_parser");
    }

    // ─── Stage 1: Claim Analyst ────────────────────────────────────────
    orchestratorLog.info("Stage 1: Running Claim Analyst");
    toolsUsed.push("claim_analyst", "rag_misinfo_search");

    const { claims, ragMatches } = await runClaimAnalyst(
      messageForAnalysis,
      request.imageBase64,
      log
    );

    if (claims.length === 0 && ragMatches.length === 0) {
      orchestratorLog.info("No claims extracted and no RAG matches — returning UNKNOWN");
      return {
        ...FALLBACK_VERDICT,
        toolsUsed,
        explanation: "No verifiable factual claims were found in this message.",
        reasoning: "The Claim Analyst could not extract any verifiable claims from the input.",
      };
    }

    // ─── Stage 1.5: Scam Detection (parallel with source verification) ─
    orchestratorLog.info("Stage 1.5: Running LLM Scam Detector");
    toolsUsed.push("scam_detector_llm");

    // Run scam detection — this uses the LLM-based detector
    let scamResult: ScamDetectorResult | null = null;
    const scamPromise = runLLMScamDetector(request.message, log).then((result) => {
      scamResult = result;
    });

    // ─── Stage 2: Source Verifier ──────────────────────────────────────
    orchestratorLog.info("Stage 2: Running Source Verifier");
    toolsUsed.push("web_search", "fact_check_db", "source_credibility");

    const [evidence] = await Promise.all([
      runSourceVerifier(claims, log),
      scamPromise, // Scam detection runs in parallel
    ]);

    // ─── Stage 3: Verdict Synthesizer ──────────────────────────────────
    orchestratorLog.info("Stage 3: Running Verdict Synthesizer");
    toolsUsed.push("verdict_synthesizer");

    const verdict = await runVerdictSynthesizer(
      claims,
      evidence,
      ragMatches,
      scamResult,
      toolsUsed,
      log
    );

    const pipelineDuration = Date.now() - pipelineStart;
    orchestratorLog.info(
      {
        verdict: verdict.verdict,
        confidence: verdict.confidence,
        pipelineDurationMs: pipelineDuration,
        toolsUsed,
      },
      "Orchestrator pipeline completed"
    );

    return verdict;
  } catch (error) {
    const pipelineDuration = Date.now() - pipelineStart;
    orchestratorLog.error(
      {
        error: error instanceof Error ? error.message : String(error),
        pipelineDurationMs: pipelineDuration,
      },
      "Orchestrator pipeline failed"
    );

    return {
      ...FALLBACK_VERDICT,
      toolsUsed,
      reasoning: `Pipeline error: ${error instanceof Error ? error.message : "Unknown error"}`,
    };
  }
}
