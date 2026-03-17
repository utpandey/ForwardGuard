/**
 * agents/verdictSynthesizer.ts — Verdict Synthesizer sub-agent for the multi-agent pipeline.
 *
 * Takes all extracted claims, gathered evidence, RAG matches, and scam analysis,
 * then produces a final structured verdict using Claude.
 *
 * Role in the pipeline: Step 3 (final) — synthesize everything into a verdict.
 */

import Anthropic from "@anthropic-ai/sdk";
import type { AgentVerdict, Claim, Source } from "../../types/index.js";
import type { ClaimEvidence } from "./sourceVerifier.js";
import type { RAGSearchResult } from "../rag/vectorStore.js";
import type { ScamDetectorResult } from "../../types/index.js";
import type { Logger } from "../../middleware/logger.js";

const anthropic = new Anthropic();

const VERDICT_SYNTHESIZER_PROMPT = `You are the Verdict Synthesizer, the final decision-maker in the ForwardGuard fact-checking system.

You receive:
1. Extracted claims from the Claim Analyst
2. Evidence gathered by the Source Verifier (web search results, fact-check database results, source credibility analyses)
3. RAG matches from the known misinformation database
4. Scam detection analysis

Your job is to synthesize ALL evidence and produce a single, authoritative verdict.

## Verdict Rules

- TRUE: Multiple independent credible sources confirm the claim(s).
- FALSE: Credible sources directly contradict or have debunked the claim(s). RAG matches to known hoaxes are strong evidence for FALSE.
- UNKNOWN: Insufficient evidence either way, or topic is genuinely contested.
- SCAM: Message contains clear manipulation patterns (urgency, threats, chain-letter pressure, phishing).

## Confidence Guidelines

- 0.90-1.00: Multiple high-credibility independent sources agree, or exact match in known misinformation DB
- 0.70-0.89: Strong evidence with minor ambiguity
- 0.50-0.69: Mixed or limited evidence
- Below 0.50: Return UNKNOWN regardless of lean

## Output

Return ONLY valid JSON — no markdown, no prose wrapping:
{
  "verdict": "TRUE|FALSE|UNKNOWN|SCAM",
  "confidence": <float 0.0-1.0>,
  "explanation": "<2-4 plain English sentences for a non-expert>",
  "reasoning": "<your full step-by-step chain of thought>",
  "claims": [{ "id": "c1", "text": "...", "type": "factual|statistical|quote|causal|other" }],
  "sources": [{ "title": "...", "url": "...", "snippet": "...", "credibility": "high|medium|low" }]
}`;

/**
 * Build the evidence summary for the synthesizer.
 */
function buildEvidenceSummary(
  claims: Claim[],
  evidence: ClaimEvidence[],
  ragMatches: RAGSearchResult[],
  scamResult: ScamDetectorResult | null
): string {
  const parts: string[] = [];

  // Claims
  parts.push("## Extracted Claims");
  for (const claim of claims) {
    parts.push(`- [${claim.id}] (${claim.type}): ${claim.text}`);
  }

  // RAG matches
  if (ragMatches.length > 0) {
    parts.push("\n## Known Misinformation Database Matches (RAG)");
    for (const match of ragMatches) {
      parts.push(
        `- MATCH (similarity: ${Math.round(match.similarity * 100)}%): "${match.entry.claim}"` +
        `\n  Verdict: ${match.entry.verdict}` +
        `\n  Debunking: ${match.entry.debunking}` +
        `\n  Source: ${match.entry.source}`
      );
    }
  }

  // Evidence per claim
  parts.push("\n## Evidence from Source Verifier");
  for (const ev of evidence) {
    parts.push(`\n### Claim ${ev.claim.id}: "${ev.claim.text}"`);
    parts.push(`Web search answer: ${ev.webAnswer}`);
    parts.push(`Fact-check summary: ${ev.factCheckSummary}`);

    if (ev.sources.length > 0) {
      parts.push("Sources found:");
      for (const src of ev.sources.slice(0, 5)) {
        parts.push(`  - [${src.credibility}] ${src.title} (${src.url}): ${src.snippet.slice(0, 150)}`);
      }
    }

    if (ev.credibilityAnalysis.length > 0) {
      parts.push("Source credibility analysis:");
      for (const ca of ev.credibilityAnalysis) {
        parts.push(`  - ${ca.url}: score=${ca.score}, tier=${ca.tier}, note=${ca.note}`);
      }
    }
  }

  // Scam detection
  if (scamResult) {
    parts.push("\n## Scam Detection Analysis");
    parts.push(`Is scam: ${scamResult.isScam}`);
    parts.push(`Severity: ${scamResult.overallSeverity}`);
    parts.push(`Summary: ${scamResult.summary}`);
    if (scamResult.detectedPatterns.length > 0) {
      parts.push("Patterns detected:");
      for (const p of scamResult.detectedPatterns) {
        parts.push(`  - [${p.severity}] ${p.description}`);
      }
    }
  }

  return parts.join("\n");
}

/**
 * Run the Verdict Synthesizer sub-agent.
 *
 * @param claims - Extracted claims from Claim Analyst
 * @param evidence - Evidence from Source Verifier
 * @param ragMatches - RAG database matches
 * @param scamResult - Scam detection results (null if not run)
 * @param toolsUsed - List of tools/agents used in the pipeline
 * @param log - Scoped logger
 * @returns Final structured AgentVerdict
 */
export async function runVerdictSynthesizer(
  claims: Claim[],
  evidence: ClaimEvidence[],
  ragMatches: RAGSearchResult[],
  scamResult: ScamDetectorResult | null,
  toolsUsed: string[],
  log: Logger
): Promise<AgentVerdict> {
  const agentLog = log.child({ agent: "verdict_synthesizer" });
  agentLog.info(
    {
      claimCount: claims.length,
      evidenceCount: evidence.length,
      ragMatchCount: ragMatches.length,
      hasScamResult: !!scamResult,
    },
    "Verdict Synthesizer starting"
  );

  const startTime = Date.now();

  const evidenceSummary = buildEvidenceSummary(claims, evidence, ragMatches, scamResult);

  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 2048,
    temperature: 0,
    system: VERDICT_SYNTHESIZER_PROMPT,
    messages: [
      {
        role: "user",
        content: `Synthesize a verdict from the following evidence:\n\n${evidenceSummary}`,
      },
    ],
  });

  const textBlock = response.content.find((b) => b.type === "text");
  const rawOutput = textBlock?.text ?? "{}";

  // Parse the verdict
  let verdict: AgentVerdict;
  try {
    const parsed = parseVerdictJson(rawOutput);
    verdict = {
      verdict: (parsed.verdict as string as AgentVerdict["verdict"]) ?? "UNKNOWN",
      confidence: typeof parsed.confidence === "number" ? parsed.confidence : 0.5,
      explanation: (parsed.explanation as string) ?? "No explanation provided.",
      claims: Array.isArray(parsed.claims) ? (parsed.claims as Claim[]) : claims,
      sources: Array.isArray(parsed.sources) ? (parsed.sources as Source[]) : [],
      toolsUsed,
      reasoning: (parsed.reasoning as string) ?? "No reasoning provided.",
    };
  } catch {
    agentLog.warn("Failed to parse verdict synthesizer output, using fallback");
    verdict = {
      verdict: "UNKNOWN",
      confidence: 0.3,
      explanation: "The verification system was unable to produce a clear verdict.",
      claims,
      sources: [],
      toolsUsed,
      reasoning: `Raw synthesizer output: ${rawOutput.slice(0, 500)}`,
    };
  }

  const durationMs = Date.now() - startTime;
  agentLog.info(
    { verdict: verdict.verdict, confidence: verdict.confidence, durationMs },
    "Verdict Synthesizer completed"
  );

  return verdict;
}

/**
 * Parse JSON from the synthesizer output, trying multiple strategies.
 */
function parseVerdictJson(output: string): Record<string, unknown> {
  // Strategy 1: direct parse
  try {
    return JSON.parse(output) as Record<string, unknown>;
  } catch { /* continue */ }

  // Strategy 2: extract from markdown code block
  const codeBlockMatch = output.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlockMatch) {
    try {
      return JSON.parse(codeBlockMatch[1]) as Record<string, unknown>;
    } catch { /* continue */ }
  }

  // Strategy 3: find any JSON object with "verdict" key
  const objectMatch = output.match(/\{[\s\S]*"verdict"[\s\S]*\}/);
  if (objectMatch) {
    try {
      return JSON.parse(objectMatch[0]) as Record<string, unknown>;
    } catch { /* continue */ }
  }

  throw new Error("Could not parse verdict JSON");
}
