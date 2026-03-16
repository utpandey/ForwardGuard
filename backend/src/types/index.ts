/**
 * types/index.ts — Shared TypeScript type definitions for the ForwardGuard backend.
 *
 * All types are defined here to ensure consistency between the agent, tools,
 * routes, and middleware. This is the single source of truth for data shapes.
 */

// ─── Verdict Types ──────────────────────────────────────────────────────────

/** The four possible verdicts the agent can return */
export type Verdict = "TRUE" | "FALSE" | "UNKNOWN" | "SCAM";

/** Claim type heuristics — determines how the claim was classified */
export type ClaimType = "factual" | "statistical" | "quote" | "causal" | "other";

/** Source credibility rating based on domain reputation */
export type Credibility = "high" | "medium" | "low";

// ─── Request / Response ─────────────────────────────────────────────────────

export interface VerifyRequest {
  message: string;
  context?: string;
  language?: string;
}

export interface Claim {
  id: string;
  text: string;
  type: ClaimType;
}

export interface Source {
  title: string;
  url: string;
  snippet: string;
  credibility: Credibility;
}

export interface VerifyResponse {
  requestId: string;
  verdict: Verdict;
  confidence: number;
  explanation: string;
  claims: Claim[];
  sources: Source[];
  toolsUsed: string[];
  reasoning: string;
  processingTimeMs: number;
  timestamp: string;
}

export interface ErrorResponse {
  requestId: string;
  error: string;
  code: string;
  timestamp: string;
}

// ─── Tool Result Types ──────────────────────────────────────────────────────

export interface ClaimExtractorResult {
  claims: Claim[];
}

export interface WebSearchResult {
  query: string;
  answer: string;
  sources: Source[];
  totalResults: number;
}

export interface FactCheckEntry {
  organization: string;
  title: string;
  url: string;
  verdict?: string;
  snippet: string;
}

export interface FactCheckResult {
  summary: string;
  results: FactCheckEntry[];
}

export interface DetectedPattern {
  pattern: string;
  severity: "high" | "medium";
  description: string;
}

export interface ScamDetectorResult {
  isScam: boolean;
  detectedPatterns: DetectedPattern[];
  overallSeverity: "high" | "medium" | "low" | "none";
  summary: string;
}

// ─── Agent Internal Types ───────────────────────────────────────────────────

/** The shape the agent must return after synthesis — route handler adds requestId, timing, etc. */
export interface AgentVerdict {
  verdict: Verdict;
  confidence: number;
  explanation: string;
  claims: Claim[];
  sources: Source[];
  toolsUsed: string[];
  reasoning: string;
}
