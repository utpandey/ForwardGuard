/**
 * tools/scamDetector.ts — LLM-powered scam and manipulation pattern detector.
 *
 * Uses Claude to analyze messages for social engineering tactics, replacing
 * the original regex-based approach. The LLM can detect nuanced manipulation
 * patterns that regex cannot — contextual urgency, implicit threats,
 * sophisticated phishing, and culturally-specific scam patterns.
 *
 * Why LLM over regex: Scam messages constantly evolve. Regex patterns miss
 * paraphrased tactics, multilingual scams, and novel social engineering.
 * Claude can understand intent and context, not just keyword patterns.
 *
 * Exports both the DynamicStructuredTool (for backward compatibility with
 * the single-agent architecture) and a direct function (for the multi-agent
 * pipeline orchestrator).
 */

import Anthropic from "@anthropic-ai/sdk";
import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import type { DetectedPattern, ScamDetectorResult } from "../../types/index.js";
import { logger } from "../../middleware/logger.js";
import type { Logger } from "../../middleware/logger.js";

const anthropic = new Anthropic();

const SCAM_DETECTOR_PROMPT = `You are an expert in social engineering, online scams, and manipulation tactics.

Analyze the following message for manipulation and scam patterns. Check for ALL of the following:

1. **Urgency/Time Pressure**: Demands to act within a time limit, "last chance", "expiring soon"
2. **Fear Tactics**: Threats of account closure, legal action, harm if not forwarded
3. **Authority Exploitation**: False attribution to government, doctors, celebrities, organizations
4. **Chain Letter Pressure**: Demands to forward/share with specific numbers of people
5. **Financial Scams**: Fake prizes, lottery wins, free money, investment schemes
6. **Phishing**: Suspicious links, requests for personal info, fake login pages
7. **Health Misinformation**: Miracle cures, dangerous medical advice
8. **Religious/Emotional Manipulation**: Using faith, guilt, or emotional pressure to spread
9. **Too Good To Be True**: Unrealistic promises, free items, guaranteed returns
10. **Identity Deception**: Impersonating known brands, officials, or trusted entities

For each detected pattern, assign severity:
- "high": Strong standalone indicator of scam/manipulation
- "medium": Suspicious but could appear in legitimate messages

Return ONLY valid JSON:
{
  "isScam": <boolean>,
  "detectedPatterns": [
    { "pattern": "<tactic name>", "severity": "high|medium", "description": "<specific finding in this message>" }
  ],
  "overallSeverity": "high|medium|low|none",
  "summary": "<2-3 sentence summary of findings>"
}

Decision rule:
- isScam=true if any high-severity pattern found OR 2+ medium-severity patterns
- overallSeverity: "high" if any high pattern, "medium" if 2+ medium, "low" if 1 medium, "none" if clean`;

/**
 * Core scam detection logic using Claude.
 * Used by both the tool wrapper and the direct function export.
 */
async function detectScamPatterns(
  message: string,
  log: { info: (...args: unknown[]) => void; warn: (...args: unknown[]) => void; error: (...args: unknown[]) => void }
): Promise<ScamDetectorResult> {
  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 1024,
    temperature: 0,
    system: SCAM_DETECTOR_PROMPT,
    messages: [{ role: "user", content: message }],
  });

  const textBlock = response.content.find((b) => b.type === "text");
  const rawOutput = textBlock?.text ?? "{}";

  // Parse the LLM response
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(rawOutput) as Record<string, unknown>;
  } catch {
    // Try extracting from markdown code block
    const match = rawOutput.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (match) {
      parsed = JSON.parse(match[1]) as Record<string, unknown>;
    } else {
      const objMatch = rawOutput.match(/\{[\s\S]*"isScam"[\s\S]*\}/);
      if (objMatch) {
        parsed = JSON.parse(objMatch[0]) as Record<string, unknown>;
      } else {
        log.warn("Could not parse scam detector output, defaulting to safe result");
        return {
          isScam: false,
          detectedPatterns: [],
          overallSeverity: "none",
          summary: "Analysis could not be completed.",
        };
      }
    }
  }

  const detectedPatterns: DetectedPattern[] = Array.isArray(parsed.detectedPatterns)
    ? (parsed.detectedPatterns as Array<Record<string, string>>).map((p) => ({
        pattern: p.pattern ?? "unknown",
        severity: (p.severity === "high" ? "high" : "medium") as "high" | "medium",
        description: p.description ?? "",
      }))
    : [];

  return {
    isScam: !!parsed.isScam,
    detectedPatterns,
    overallSeverity: (parsed.overallSeverity as ScamDetectorResult["overallSeverity"]) ?? "none",
    summary: (parsed.summary as string) ?? "No summary available.",
  };
}

// ─── LangChain Tool (backward compatibility) ─────────────────────────────────

/**
 * LangChain DynamicStructuredTool wrapper for the scam detector.
 * Kept for backward compatibility with the single-agent architecture.
 */
export const scamDetectorTool = new DynamicStructuredTool({
  name: "scam_detector",
  description:
    "Detect manipulation and social engineering patterns in a message using AI analysis. " +
    "Identifies urgency pressure, chain letters, financial threats, prize scams, " +
    "phishing links, health misinformation, false authority claims, religious " +
    "manipulation, and more. Call this if the message contains suspicious language.",
  schema: z.object({
    message: z
      .string()
      .describe("The full message text to scan for scam patterns"),
  }),
  func: async ({ message }): Promise<string> => {
    const startTime = Date.now();
    const log = logger.child({ tool: "scam_detector" });

    log.info({ messageLength: message.length }, "Invoking scam_detector (LLM-based)");

    try {
      const result = await detectScamPatterns(message, log);

      const durationMs = Date.now() - startTime;
      log.info(
        {
          isScam: result.isScam,
          patternCount: result.detectedPatterns.length,
          overallSeverity: result.overallSeverity,
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

// ─── Direct Function Export (for multi-agent pipeline) ───────────────────────

/**
 * Run the LLM-based scam detector directly (not as a LangChain tool).
 * Used by the orchestrator in the multi-agent pipeline.
 */
export async function runLLMScamDetector(
  message: string,
  log: Logger
): Promise<ScamDetectorResult> {
  const scamLog = log.child({ tool: "scam_detector_llm" });
  const startTime = Date.now();

  scamLog.info({ messageLength: message.length }, "Running LLM scam detector");

  try {
    const result = await detectScamPatterns(message, scamLog);

    const durationMs = Date.now() - startTime;
    scamLog.info(
      {
        isScam: result.isScam,
        patternCount: result.detectedPatterns.length,
        durationMs,
      },
      "LLM scam detector completed"
    );

    return result;
  } catch (error) {
    const durationMs = Date.now() - startTime;
    scamLog.error(
      { error: error instanceof Error ? error.message : String(error), durationMs },
      "LLM scam detector failed"
    );
    return {
      isScam: false,
      detectedPatterns: [],
      overallSeverity: "none",
      summary: "Scam detection failed due to an error.",
    };
  }
}
