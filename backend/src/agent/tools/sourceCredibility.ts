/**
 * tools/sourceCredibility.ts — LLM-powered source credibility analyzer.
 *
 * Uses Claude to evaluate the credibility of a source URL and its content.
 * Analyzes domain reputation, writing quality, bias indicators, and
 * cross-reference potential to produce a structured credibility assessment.
 *
 * Why LLM over heuristics: Source credibility is nuanced. A domain-list
 * approach misses new sources, satire sites, and context-dependent credibility.
 * Claude can evaluate writing quality, bias markers, and journalistic standards.
 */

import Anthropic from "@anthropic-ai/sdk";
import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import { logger } from "../../middleware/logger.js";

const anthropic = new Anthropic();

const SOURCE_CREDIBILITY_PROMPT = `You are an expert media literacy analyst. Evaluate the credibility of the given source.

Analyze the following dimensions:
1. **Domain Reputation**: Is this a well-known, established publication? Is it a government site, academic institution, or known fact-checker?
2. **Writing Quality**: Based on the snippet, does the writing follow journalistic standards? Are claims attributed? Is the tone neutral or sensationalized?
3. **Bias Indicators**: Does the snippet show signs of political bias, emotional manipulation, clickbait, or agenda-driven framing?
4. **Cross-Reference Potential**: Is this a primary source, or does it cite other sources? Could the claims be independently verified?

Return your analysis as JSON with this exact format:
{
  "credibilityScore": <float 0.0-1.0>,
  "tier": "high|medium|low",
  "domainAnalysis": "<1-2 sentences about the domain>",
  "contentAnalysis": "<1-2 sentences about the content quality>",
  "biasIndicators": ["<list of detected bias indicators, if any>"],
  "recommendation": "<1 sentence: how much weight to give this source>"
}`;

export interface SourceCredibilityResult {
  credibilityScore: number;
  tier: "high" | "medium" | "low";
  domainAnalysis: string;
  contentAnalysis: string;
  biasIndicators: string[];
  recommendation: string;
}

export const sourceCredibilityTool = new DynamicStructuredTool({
  name: "source_credibility",
  description:
    "Analyze the credibility of a source URL and its content snippet using AI. " +
    "Evaluates domain reputation, writing quality, bias indicators, and cross-reference potential. " +
    "Returns a credibility score (0-1) and detailed analysis. Use this to evaluate uncertain sources.",
  schema: z.object({
    url: z.string().describe("The URL of the source to evaluate"),
    snippet: z
      .string()
      .describe("A text snippet or excerpt from the source to analyze"),
  }),
  func: async ({ url, snippet }): Promise<string> => {
    const startTime = Date.now();
    const log = logger.child({ tool: "source_credibility" });

    log.info({ url }, "Invoking source_credibility");

    try {
      const response = await anthropic.messages.create({
        model: "claude-sonnet-4-6",
        max_tokens: 1024,
        temperature: 0,
        system: SOURCE_CREDIBILITY_PROMPT,
        messages: [
          {
            role: "user",
            content: `URL: ${url}\n\nContent snippet:\n${snippet.slice(0, 500)}`,
          },
        ],
      });

      const textBlock = response.content.find((block) => block.type === "text");
      const rawOutput = textBlock?.text ?? "{}";

      // Parse Claude's response
      let result: SourceCredibilityResult;
      try {
        const parsed = JSON.parse(rawOutput);
        result = {
          credibilityScore:
            typeof parsed.credibilityScore === "number"
              ? parsed.credibilityScore
              : 0.5,
          tier: parsed.tier ?? "medium",
          domainAnalysis: parsed.domainAnalysis ?? "Unable to analyze domain.",
          contentAnalysis:
            parsed.contentAnalysis ?? "Unable to analyze content.",
          biasIndicators: Array.isArray(parsed.biasIndicators)
            ? parsed.biasIndicators
            : [],
          recommendation: parsed.recommendation ?? "Treat with moderate caution.",
        };
      } catch {
        // If JSON parsing fails, extract from markdown
        const jsonMatch = rawOutput.match(/```(?:json)?\s*([\s\S]*?)```/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[1]);
          result = {
            credibilityScore:
              typeof parsed.credibilityScore === "number"
                ? parsed.credibilityScore
                : 0.5,
            tier: parsed.tier ?? "medium",
            domainAnalysis: parsed.domainAnalysis ?? "Unable to analyze domain.",
            contentAnalysis:
              parsed.contentAnalysis ?? "Unable to analyze content.",
            biasIndicators: Array.isArray(parsed.biasIndicators)
              ? parsed.biasIndicators
              : [],
            recommendation:
              parsed.recommendation ?? "Treat with moderate caution.",
          };
        } else {
          result = {
            credibilityScore: 0.5,
            tier: "medium",
            domainAnalysis: "Analysis could not be parsed.",
            contentAnalysis: rawOutput.slice(0, 200),
            biasIndicators: [],
            recommendation: "Unable to fully assess. Treat with caution.",
          };
        }
      }

      const durationMs = Date.now() - startTime;
      log.info(
        {
          url,
          credibilityScore: result.credibilityScore,
          tier: result.tier,
          durationMs,
        },
        "source_credibility completed"
      );

      return JSON.stringify(result);
    } catch (error) {
      const durationMs = Date.now() - startTime;
      log.error(
        {
          error: error instanceof Error ? error.message : String(error),
          url,
          durationMs,
        },
        "source_credibility failed"
      );
      return JSON.stringify({
        credibilityScore: 0.5,
        tier: "medium",
        domainAnalysis: "Analysis failed.",
        contentAnalysis: "Unable to analyze due to error.",
        biasIndicators: [],
        recommendation: "Could not assess credibility. Treat with caution.",
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
  },
});
