/**
 * tools/scamDetector.ts — Scam and manipulation pattern detector for ForwardGuard.
 *
 * Uses deterministic regex patterns to detect social engineering tactics common
 * in viral misinformation and scam messages.
 *
 * Why regex not LLM: deterministic (same input always gives same output),
 * never hallucinates, fully auditable, and new patterns can be added without
 * redeploying or re-prompting the agent. This is critical for a tool that
 * makes security-sensitive decisions.
 */

import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import type { DetectedPattern, ScamDetectorResult } from "../../types/index.js";
import { logger } from "../../middleware/logger.js";

// ─── Pattern Definitions ────────────────────────────────────────────────────

interface PatternDef {
  pattern: RegExp;
  severity: "high" | "medium";
  description: string;
}

/**
 * All scam detection patterns, organized by severity.
 *
 * HIGH severity: strong standalone indicators of scam/manipulation.
 * MEDIUM severity: suspicious but may appear in legitimate messages.
 * Decision rule: isScam if highCount >= 1 OR medCount >= 2
 */
const SCAM_PATTERNS: PatternDef[] = [
  // ─── HIGH SEVERITY ──────────────────────────────────────────────────
  {
    pattern: /forward.{0,30}(within|in)\s*\d+\s*(hours?|days?|minutes?)/i,
    severity: "high",
    description: "Urgency pressure — time-limited forwarding demand",
  },
  {
    pattern: /share (this|with) (everyone|all your|your) (contacts|friends|family)/i,
    severity: "high",
    description: "Chain letter — classic forwarding chain",
  },
  {
    pattern: /(bank account|account|wallet).{0,30}(freeze|block|suspend|close)/i,
    severity: "high",
    description: "Financial threat — account freeze threat",
  },
  {
    pattern: /(win|won|winner|lottery|prize|reward).{0,40}(claim|collect|register)/i,
    severity: "high",
    description: "Prize scam — false prize/lottery",
  },
  {
    pattern: /click\s+(this\s+)?link.{0,30}(free|claim|win|verify)/i,
    severity: "high",
    description: "Phishing link — suspicious link with incentive",
  },
  {
    pattern: /(cure|cures|heals|treats).{0,30}(cancer|diabetes|covid|aids|hiv)/i,
    severity: "high",
    description: "Health misinformation — miracle cure claim",
  },

  // ─── MEDIUM SEVERITY ────────────────────────────────────────────────
  {
    pattern: /(govt?\.?|government|ministry|prime minister|president).{0,30}(confirm|announce|reveal|warn)/i,
    severity: "medium",
    description: "False authority — unverified government attribution",
  },
  {
    pattern: /(doctors?|scientists?|experts?).{0,30}(in|from|at)\s+[A-Z][a-z]+.{0,20}(confirm|prove|discover)/i,
    severity: "medium",
    description: "False scientific claim — vague expert attribution",
  },
  {
    pattern: /(god|allah|jesus|bhagwan).{0,50}(bless|punish|curse).{0,30}(share|forward)/i,
    severity: "medium",
    description: "Religious manipulation — religious fear/reward pressure",
  },
  {
    pattern: /ignore (this|at your).{0,20}(risk|peril|loss)/i,
    severity: "medium",
    description: "Fear tactics — consequence threat for ignoring",
  },
];

// ─── Tool Definition ────────────────────────────────────────────────────────

export const scamDetectorTool = new DynamicStructuredTool({
  name: "scam_detector",
  description:
    "Detect manipulation and social engineering patterns in a message. " +
    "Checks for urgency pressure, chain letters, financial threats, prize scams, " +
    "phishing links, health misinformation, false authority claims, and religious " +
    "manipulation. Call this if the message contains suspicious language patterns.",
  schema: z.object({
    message: z
      .string()
      .describe("The full message text to scan for scam patterns"),
  }),
  func: async ({ message }): Promise<string> => {
    const startTime = Date.now();
    const log = logger.child({ tool: "scam_detector" });

    log.info({ messageLength: message.length }, "Invoking scam_detector");

    try {
      const detectedPatterns: DetectedPattern[] = [];
      let highCount = 0;
      let medCount = 0;

      for (const { pattern, severity, description } of SCAM_PATTERNS) {
        if (pattern.test(message)) {
          detectedPatterns.push({
            pattern: pattern.source, // Store the regex source for auditability
            severity,
            description,
          });

          if (severity === "high") highCount++;
          else medCount++;
        }
      }

      // Decision rule: one high-severity match OR two medium-severity matches
      const isScam = highCount >= 1 || medCount >= 2;

      // Determine overall severity for the UI badge
      let overallSeverity: ScamDetectorResult["overallSeverity"];
      if (highCount > 0) overallSeverity = "high";
      else if (medCount >= 2) overallSeverity = "medium";
      else if (medCount === 1) overallSeverity = "low";
      else overallSeverity = "none";

      // Build a human-readable summary
      const summary =
        detectedPatterns.length === 0
          ? "No scam or manipulation patterns detected."
          : `Detected ${detectedPatterns.length} suspicious pattern(s): ${detectedPatterns.map((p) => p.description).join("; ")}.`;

      const result: ScamDetectorResult = {
        isScam,
        detectedPatterns,
        overallSeverity,
        summary,
      };

      const durationMs = Date.now() - startTime;
      log.info(
        {
          isScam,
          highCount,
          medCount,
          patternCount: detectedPatterns.length,
          durationMs,
        },
        "scam_detector completed"
      );

      return JSON.stringify(result);
    } catch (error) {
      const durationMs = Date.now() - startTime;
      log.error(
        { error: error instanceof Error ? error.message : String(error), durationMs },
        "scam_detector failed"
      );
      return JSON.stringify({
        isScam: false,
        detectedPatterns: [],
        overallSeverity: "none",
        summary: "Scam detection failed",
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
  },
});
