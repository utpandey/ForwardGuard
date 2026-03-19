/**
 * content/TooltipUI.tsx — Tooltip UI components for the ForwardGuard extension.
 *
 * Renders verdict tooltips directly into WhatsApp Web's DOM. Uses HTML string
 * generation (not React rendering) because we're injecting into a third-party
 * page and need maximum compatibility with WhatsApp's existing DOM/styles.
 *
 * Exports:
 * - TOOLTIP_STYLES: CSS string injected once into document.head
 * - renderLoading(): loading state HTML
 * - renderError(message): error state HTML
 * - renderResult(data): full verdict result HTML
 */

import type { VerifyResponse } from "../api/verify";

// ─── CSS Styles ─────────────────────────────────────────────────────────────

/**
 * All tooltip styles as a single CSS string.
 * Injected once into document.head via a <style> tag.
 *
 * Why inline styles in a <style> tag (not external CSS):
 * - Chrome extensions can't easily load CSS into the host page
 * - WhatsApp's styles won't conflict because we use the .fg- prefix
 * - Single injection point — easy to audit and maintain
 */
export const TOOLTIP_STYLES = `
/* ─── Base Tooltip ─────────────────────────────────────────── */
.fg-tooltip {
  position: absolute;
  z-index: 9999;
  width: 340px;
  max-width: 90vw;
  background: #ffffff;
  border-radius: 12px;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.18), 0 2px 8px rgba(0, 0, 0, 0.08);
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  font-size: 13px;
  color: #1a1a1a;
  animation: fg-fade-in 0.2s ease-out;
  overflow: hidden;
}

/* ─── Header ───────────────────────────────────────────────── */
.fg-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 14px;
  border-bottom: 1px solid #e8e8e8;
  background: #fafafa;
}

.fg-brand {
  font-weight: 700;
  font-size: 12px;
  color: #555;
  letter-spacing: 0.3px;
}

.fg-confidence {
  font-size: 11px;
  color: #888;
  margin-left: auto;
  margin-right: 4px;
}

/* ─── Verdict Badges ───────────────────────────────────────── */
.fg-badge {
  display: inline-block;
  padding: 2px 10px;
  border-radius: 8px;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.5px;
  text-transform: uppercase;
}

.fg-badge-TRUE {
  background: #d4edda;
  color: #155724;
}

.fg-badge-FALSE {
  background: #f8d7da;
  color: #721c24;
}

.fg-badge-UNKNOWN {
  background: #fff3cd;
  color: #856404;
}

.fg-badge-SCAM {
  background: #f5c6cb;
  color: #491217;
}

/* ─── Close Button ─────────────────────────────────────────── */
.fg-close {
  background: none;
  border: none;
  font-size: 16px;
  cursor: pointer;
  color: #999;
  padding: 0 2px;
  line-height: 1;
  margin-left: 4px;
}

.fg-close:hover {
  color: #333;
}

/* ─── Body ─────────────────────────────────────────────────── */
.fg-body {
  padding: 12px 14px;
}

.fg-explanation {
  line-height: 1.5;
  color: #333;
  margin: 0;
}

/* ─── Sources ──────────────────────────────────────────────── */
.fg-sources {
  padding: 0 14px 10px;
  border-top: 1px solid #f0f0f0;
  margin-top: 0;
}

.fg-sources-title {
  font-size: 11px;
  font-weight: 600;
  color: #888;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  margin: 8px 0 6px;
}

.fg-source-item {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  margin-bottom: 6px;
}

.fg-cred-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
  margin-top: 5px;
}

.fg-cred-high { background: #28a745; }
.fg-cred-medium { background: #fd7e14; }
.fg-cred-low { background: #dc3545; }

.fg-source-link {
  color: #0075e8;
  text-decoration: none;
  font-size: 12px;
  line-height: 1.4;
  word-break: break-word;
}

.fg-source-link:hover {
  text-decoration: underline;
}

/* ─── Footer (Tools) ──────────────────────────────────────── */
.fg-footer {
  padding: 8px 14px;
  border-top: 1px solid #f0f0f0;
  display: flex;
  align-items: center;
  gap: 4px;
  flex-wrap: wrap;
}

.fg-footer-label {
  font-size: 10px;
  color: #aaa;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.3px;
}

.fg-tool-chip {
  display: inline-block;
  padding: 1px 6px;
  background: #eef2ff;
  color: #4a5aba;
  border-radius: 6px;
  font-size: 10px;
  font-weight: 500;
}

/* ─── Loading State ────────────────────────────────────────── */
.fg-loading {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 16px;
}

.fg-spinner {
  width: 20px;
  height: 20px;
  border: 2.5px solid #e0e0e0;
  border-top-color: #0075e8;
  border-radius: 50%;
  animation: fg-spin 0.8s linear infinite;
}

.fg-loading-text {
  color: #666;
  font-size: 13px;
}

/* ─── Error State ──────────────────────────────────────────── */
.fg-error-header {
  background: #f8d7da;
  color: #721c24;
  padding: 10px 14px;
  font-weight: 600;
  font-size: 12px;
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.fg-error-body {
  padding: 12px 14px;
  color: #555;
  line-height: 1.5;
}

/* ─── Animations ───────────────────────────────────────────── */
@keyframes fg-fade-in {
  from { opacity: 0; transform: translateY(4px); }
  to { opacity: 1; transform: translateY(0); }
}

@keyframes fg-spin {
  to { transform: rotate(360deg); }
}

/* ─── Follow-Up Q&A ───────────────────────────────────────── */
.fg-followup {
  padding: 10px 14px;
  border-top: 1px solid #f0f0f0;
}

.fg-followup-label {
  font-size: 11px;
  font-weight: 600;
  color: #888;
  text-transform: uppercase;
  letter-spacing: 0.3px;
  margin-bottom: 6px;
}

.fg-followup-input-row {
  display: flex;
  gap: 6px;
}

.fg-followup-input {
  flex: 1;
  border: 1px solid #ddd;
  border-radius: 8px;
  padding: 6px 10px;
  font-size: 12px;
  font-family: inherit;
  color: #333;
  outline: none;
  transition: border-color 0.15s;
}

.fg-followup-input:focus {
  border-color: #0075e8;
}

.fg-followup-input::placeholder {
  color: #aaa;
}

.fg-followup-send {
  background: #0075e8;
  color: white;
  border: none;
  border-radius: 8px;
  padding: 6px 12px;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  font-family: inherit;
  white-space: nowrap;
}

.fg-followup-send:hover {
  background: #005bb5;
}

.fg-followup-send:disabled {
  background: #b0b0b0;
  cursor: not-allowed;
}

.fg-followup-answers {
  margin-top: 8px;
}

.fg-followup-qa {
  margin-bottom: 8px;
  padding: 8px;
  background: #f8f9fa;
  border-radius: 8px;
}

.fg-followup-question {
  font-size: 11px;
  font-weight: 600;
  color: #555;
  margin-bottom: 4px;
}

.fg-followup-answer {
  font-size: 12px;
  color: #333;
  line-height: 1.5;
}

.fg-followup-loading {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 8px;
  font-size: 12px;
  color: #666;
}

.fg-followup-loading .fg-spinner {
  width: 14px;
  height: 14px;
}

.fg-followup-error {
  margin-top: 6px;
  font-size: 11px;
  color: #dc3545;
}
`;

// ─── HTML Renderers ─────────────────────────────────────────────────────────

/**
 * Format a tool name for display.
 * claim_extractor → "Claim Extractor", web_search → "Web Search", etc.
 */
function formatToolName(tool: string): string {
  return tool
    .split("_")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

/** Escape HTML to prevent XSS when rendering user-controlled strings */
function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

/** Render the loading state tooltip */
export function renderLoading(): string {
  return `
    <div class="fg-loading">
      <div class="fg-spinner"></div>
      <span class="fg-loading-text">Verifying with AI agent\u2026</span>
      <button class="fg-close" data-fg-close>\u00d7</button>
    </div>
  `;
}

/** Render the error state tooltip */
export function renderError(message: string): string {
  return `
    <div class="fg-error-header">
      <span>Verification Error</span>
      <button class="fg-close" data-fg-close>\u00d7</button>
    </div>
    <div class="fg-error-body">${escapeHtml(message)}</div>
  `;
}

/** Render the full verdict result tooltip */
export function renderResult(data: VerifyResponse): string {
  const confidencePercent = Math.round(data.confidence * 100);

  // Sources section (max 3 to keep tooltip compact)
  const sourcesHtml = data.sources.length > 0
    ? `
      <div class="fg-sources">
        <div class="fg-sources-title">Sources</div>
        ${data.sources
          .slice(0, 3)
          .map(
            (s) => `
          <div class="fg-source-item">
            <span class="fg-cred-dot fg-cred-${s.credibility}"></span>
            <a class="fg-source-link" href="${escapeHtml(s.url)}" data-fg-link title="${escapeHtml(s.snippet)}">${escapeHtml(s.title)}</a>
          </div>
        `
          )
          .join("")}
      </div>
    `
    : "";

  // Tool chips in footer
  const toolsHtml = data.toolsUsed.length > 0
    ? `
      <div class="fg-footer">
        <span class="fg-footer-label">Checked via:</span>
        ${data.toolsUsed.map((t) => `<span class="fg-tool-chip">${escapeHtml(formatToolName(t))}</span>`).join("")}
      </div>
    `
    : "";

  return `
    <div class="fg-header">
      <span class="fg-brand">ForwardGuard</span>
      <span class="fg-badge fg-badge-${data.verdict}">${data.verdict}</span>
      <span class="fg-confidence">${confidencePercent}% confidence</span>
      <button class="fg-close" data-fg-close>\u00d7</button>
    </div>
    <div class="fg-body">
      <p class="fg-explanation">${escapeHtml(data.explanation)}</p>
    </div>
    ${sourcesHtml}
    ${toolsHtml}
  `;
}

/** Render the follow-up question input area */
export function renderFollowUpInput(): string {
  return `
    <div class="fg-followup">
      <div class="fg-followup-label">Ask a follow-up</div>
      <div class="fg-followup-input-row">
        <input
          type="text"
          class="fg-followup-input"
          data-fg-followup-input
          placeholder="e.g. Which sources are most reliable?"
          maxlength="500"
        />
        <button class="fg-followup-send" data-fg-followup-send>Ask</button>
      </div>
      <div class="fg-followup-answers" data-fg-followup-answers></div>
    </div>
  `;
}

/** Render a follow-up Q&A pair */
export function renderFollowUpAnswer(question: string, answer: string): string {
  return `
    <div class="fg-followup-qa">
      <div class="fg-followup-question">Q: ${escapeHtml(question)}</div>
      <div class="fg-followup-answer">${escapeHtml(answer)}</div>
    </div>
  `;
}
