/**
 * api/verify.ts — HTTP client for the ForwardGuard backend API.
 *
 * Handles all communication between the Chrome extension and the verification
 * backend. Includes timeout handling, error normalization, and type-safe responses.
 *
 * Why a dedicated client module: encapsulates all network logic, timeout handling,
 * and error normalization in one place. The content script stays clean.
 */

// ─── Types (mirroring backend response shape) ───────────────────────────────

export interface Claim {
  id: string;
  text: string;
  type: "factual" | "statistical" | "quote" | "causal" | "other";
}

export interface Source {
  title: string;
  url: string;
  snippet: string;
  credibility: "high" | "medium" | "low";
}

export interface VerifyResponse {
  requestId: string;
  verdict: "TRUE" | "FALSE" | "UNKNOWN" | "SCAM";
  confidence: number;
  explanation: string;
  claims: Claim[];
  sources: Source[];
  toolsUsed: string[];
  reasoning: string;
  processingTimeMs: number;
  timestamp: string;
}

export type VerifyResult =
  | { ok: true; data: VerifyResponse }
  | { ok: false; error: string; code?: string };

// ─── Configuration ──────────────────────────────────────────────────────────

/**
 * Backend URL from Plasmo environment variable, with localhost fallback.
 * Why env var: allows configuring for different environments without code changes.
 */
const BACKEND_URL =
  process.env.PLASMO_PUBLIC_BACKEND_URL || "http://localhost:3001/api/v1";

// ─── API Client ─────────────────────────────────────────────────────────────

/**
 * Send a message to the ForwardGuard backend for verification.
 *
 * @param message - The message text to verify (5-2000 chars)
 * @param context - Optional surrounding conversation context
 * @returns A discriminated union: { ok: true, data } or { ok: false, error }
 */
export async function verifyMessage(
  message: string,
  context?: string,
  imageBase64?: string,
  pdfText?: string
): Promise<VerifyResult> {
  try {
    const timeout = imageBase64 || pdfText ? 90_000 : 60_000;
    const response = await fetch(`${BACKEND_URL}/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message, context, imageBase64, pdfText }),
      signal: AbortSignal.timeout(timeout),
    });

    const data = await response.json();

    if (!response.ok) {
      return {
        ok: false,
        error: data.error || `Verification failed (${response.status})`,
        code: data.code,
      };
    }

    return { ok: true, data: data as VerifyResponse };
  } catch (err) {
    // Differentiate timeout from network errors for better UX messaging
    if (err instanceof DOMException && err.name === "TimeoutError") {
      return {
        ok: false,
        error: "Request timed out. The AI agent may be processing a complex claim. Please try again.",
        code: "TIMEOUT",
      };
    }
    if (err instanceof TypeError) {
      // TypeError is thrown for network failures (DNS, connection refused, etc.)
      return {
        ok: false,
        error: "Cannot connect to ForwardGuard backend. Is it running on localhost:3001?",
        code: "NETWORK_ERROR",
      };
    }
    return {
      ok: false,
      error: "An unexpected error occurred. Please try again.",
      code: "UNKNOWN",
    };
  }
}
