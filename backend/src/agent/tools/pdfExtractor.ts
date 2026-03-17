/**
 * tools/pdfExtractor.ts — LLM-powered PDF content analyzer for ForwardGuard.
 *
 * Uses Claude to analyze extracted PDF text and identify key claims, statistics,
 * and assertions that should be fact-checked. This demonstrates LLM usage for
 * document understanding — breaking down unstructured PDF content into
 * structured, verifiable claims.
 *
 * Why LLM over regex: PDF content is unstructured and varies wildly in format.
 * Claude can understand context, separate claims from boilerplate, and identify
 * the most important assertions regardless of document structure.
 */

import Anthropic from "@anthropic-ai/sdk";
import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import { logger } from "../../middleware/logger.js";

const anthropic = new Anthropic();

const PDF_ANALYSIS_PROMPT = `You are an expert document analyst specializing in fact-checking.

Analyze the following PDF document content and extract:
1. **Key Claims**: Specific factual assertions that can be verified
2. **Statistics**: Any numbers, percentages, or quantitative claims
3. **Assertions**: Opinions or conclusions presented as fact
4. **Summary**: A brief summary of what the document is about

Focus on claims that are most likely to be forwarded as misinformation.
Ignore boilerplate, headers, footers, and formatting artifacts.

Return ONLY valid JSON:
{
  "claims": [
    { "text": "<the claim>", "type": "factual|statistical|quote|causal|other" }
  ],
  "statistics": [
    { "text": "<the statistic>", "context": "<surrounding context>" }
  ],
  "assertions": [
    { "text": "<the assertion>" }
  ],
  "summary": "<2-3 sentence summary of the document>"
}`;

/**
 * Core PDF analysis logic using Claude.
 */
async function analyzePdfContent(
  pdfText: string,
  log: { info: (...args: unknown[]) => void; warn: (...args: unknown[]) => void; error: (...args: unknown[]) => void }
): Promise<{
  claims: Array<{ text: string; type: string }>;
  statistics: Array<{ text: string; context: string }>;
  assertions: Array<{ text: string }>;
  summary: string;
}> {
  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 2048,
    temperature: 0,
    system: PDF_ANALYSIS_PROMPT,
    messages: [{ role: "user", content: pdfText }],
  });

  const textBlock = response.content.find((b) => b.type === "text");
  const rawOutput = textBlock?.text ?? "{}";

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(rawOutput) as Record<string, unknown>;
  } catch {
    // Try extracting from markdown code block
    const match = rawOutput.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (match) {
      parsed = JSON.parse(match[1]) as Record<string, unknown>;
    } else {
      const objMatch = rawOutput.match(/\{[\s\S]*"claims"[\s\S]*\}/);
      if (objMatch) {
        parsed = JSON.parse(objMatch[0]) as Record<string, unknown>;
      } else {
        log.warn("Could not parse PDF extractor output, defaulting to empty result");
        return {
          claims: [],
          statistics: [],
          assertions: [],
          summary: "PDF analysis could not be completed.",
        };
      }
    }
  }

  return {
    claims: Array.isArray(parsed.claims)
      ? (parsed.claims as Array<Record<string, string>>).map((c) => ({
          text: c.text ?? "",
          type: c.type ?? "other",
        }))
      : [],
    statistics: Array.isArray(parsed.statistics)
      ? (parsed.statistics as Array<Record<string, string>>).map((s) => ({
          text: s.text ?? "",
          context: s.context ?? "",
        }))
      : [],
    assertions: Array.isArray(parsed.assertions)
      ? (parsed.assertions as Array<Record<string, string>>).map((a) => ({
          text: a.text ?? "",
        }))
      : [],
    summary: (parsed.summary as string) ?? "No summary available.",
  };
}

// ─── LangChain Tool ──────────────────────────────────────────────────────────

/**
 * LangChain DynamicStructuredTool for PDF content extraction and analysis.
 * Analyzes PDF text content using Claude to extract verifiable claims,
 * statistics, and assertions for fact-checking.
 */
export const pdfExtractorTool = new DynamicStructuredTool({
  name: "pdf_extractor",
  description:
    "Analyze PDF document text content to extract key claims, statistics, and assertions " +
    "for fact-checking. Use this when a message contains PDF document content that needs " +
    "to be broken down into verifiable claims.",
  schema: z.object({
    pdfText: z
      .string()
      .describe("The extracted text content from the PDF document"),
  }),
  func: async ({ pdfText }): Promise<string> => {
    const startTime = Date.now();
    const log = logger.child({ tool: "pdf_extractor" });

    log.info({ pdfTextLength: pdfText.length }, "Invoking pdf_extractor (LLM-based)");

    try {
      const result = await analyzePdfContent(pdfText, log);

      const durationMs = Date.now() - startTime;
      log.info(
        {
          claimCount: result.claims.length,
          statisticCount: result.statistics.length,
          assertionCount: result.assertions.length,
          durationMs,
        },
        "pdf_extractor completed"
      );

      return JSON.stringify(result);
    } catch (error) {
      const durationMs = Date.now() - startTime;
      log.error(
        { error: error instanceof Error ? error.message : String(error), durationMs },
        "pdf_extractor failed"
      );
      return JSON.stringify({
        claims: [],
        statistics: [],
        assertions: [],
        summary: "PDF extraction failed",
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
  },
});

// ─── Direct Function Export (for multi-agent pipeline) ───────────────────────

/**
 * Run the LLM-based PDF extractor directly (not as a LangChain tool).
 * Used by the orchestrator in the multi-agent pipeline.
 */
export async function runPdfExtractor(
  pdfText: string,
  log: { info: (...args: unknown[]) => void; warn: (...args: unknown[]) => void; error: (...args: unknown[]) => void }
): Promise<{
  claims: Array<{ text: string; type: string }>;
  statistics: Array<{ text: string; context: string }>;
  assertions: Array<{ text: string }>;
  summary: string;
}> {
  const pdfLog = logger.child({ tool: "pdf_extractor" });
  const startTime = Date.now();

  pdfLog.info({ pdfTextLength: pdfText.length }, "Running PDF extractor");

  try {
    const result = await analyzePdfContent(pdfText, pdfLog);

    const durationMs = Date.now() - startTime;
    pdfLog.info(
      {
        claimCount: result.claims.length,
        statisticCount: result.statistics.length,
        durationMs,
      },
      "PDF extractor completed"
    );

    return result;
  } catch (error) {
    const durationMs = Date.now() - startTime;
    pdfLog.error(
      { error: error instanceof Error ? error.message : String(error), durationMs },
      "PDF extractor failed"
    );
    return {
      claims: [],
      statistics: [],
      assertions: [],
      summary: "PDF extraction failed due to an error.",
    };
  }
}
