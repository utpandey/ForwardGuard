/**
 * content/whatsapp.ts — Plasmo content script injected into WhatsApp Web.
 *
 * Observes the DOM for message rows and injects "Verify" buttons.
 * Handles the full verification lifecycle: button click → loading state →
 * API call → tooltip display with verdict.
 *
 * WhatsApp Web (2025+) uses role="row" for message rows inside a role="grid"
 * message list. No data-testid or semantic class names are used.
 */

import type { PlasmoCSConfig } from "plasmo"
import { verifyMessage } from "../api/verify"
import { TOOLTIP_STYLES, renderLoading, renderError, renderResult } from "../lib/TooltipUI"

// ─── Plasmo Content Script Configuration ────────────────────────────────────

export const config: PlasmoCSConfig = {
  matches: ["https://web.whatsapp.com/*"],
  run_at: "document_idle",
}

// ─── State ──────────────────────────────────────────────────────────────────

let activeTooltip: HTMLElement | null = null

// ─── Style Injection ────────────────────────────────────────────────────────

function injectStyles(): void {
  if (document.getElementById("fg-styles")) return
  const style = document.createElement("style")
  style.id = "fg-styles"
  style.textContent = TOOLTIP_STYLES
  document.head.appendChild(style)
}

// ─── Button Creation ────────────────────────────────────────────────────────

function createVerifyButton(): HTMLButtonElement {
  const btn = document.createElement("button")
  btn.textContent = "\u2713 Verify"
  Object.assign(btn.style, {
    background: "#0075e8",
    color: "white",
    borderRadius: "10px",
    fontSize: "11px",
    padding: "2px 8px",
    marginLeft: "6px",
    cursor: "pointer",
    fontWeight: "600",
    border: "none",
    fontFamily: "inherit",
    lineHeight: "1.4",
    verticalAlign: "middle",
  })
  btn.setAttribute("data-fg-btn", "true")
  return btn
}

// ─── Tooltip Management ─────────────────────────────────────────────────────

function closeActiveTooltip(): void {
  if (activeTooltip) {
    activeTooltip.remove()
    activeTooltip = null
  }
}

function showTooltip(anchor: HTMLElement, html: string): HTMLElement {
  closeActiveTooltip()

  const tooltip = document.createElement("div")
  tooltip.className = "fg-tooltip"
  tooltip.innerHTML = html

  // Attach to body with fixed positioning to avoid clipping by message bubble overflow
  const rect = anchor.getBoundingClientRect()
  const flipAbove = window.innerHeight - rect.bottom < 350

  tooltip.style.position = "fixed"
  tooltip.style.zIndex = "99999"
  tooltip.style.left = `${Math.min(rect.left, window.innerWidth - 360)}px`

  if (flipAbove) {
    tooltip.style.bottom = `${window.innerHeight - rect.top + 4}px`
  } else {
    tooltip.style.top = `${rect.bottom + 4}px`
  }

  document.body.appendChild(tooltip)
  activeTooltip = tooltip

  tooltip.querySelectorAll("[data-fg-close]").forEach((closeBtn) => {
    closeBtn.addEventListener("click", (e) => {
      e.stopPropagation()
      closeActiveTooltip()
    })
  })

  return tooltip
}

// ─── Verification Handler ───────────────────────────────────────────────────

async function handleVerifyClick(
  btn: HTMLButtonElement,
  messageText: string,
  imageBase64?: string,
  pdfText?: string
): Promise<void> {
  const wrapper = btn.parentElement!

  if (activeTooltip && wrapper.contains(activeTooltip)) {
    closeActiveTooltip()
    return
  }

  showTooltip(wrapper, renderLoading())

  const result = await verifyMessage(messageText, undefined, imageBase64, pdfText)

  if (!result.ok) {
    showTooltip(wrapper, renderError(result.error))
    return
  }

  const tooltip = showTooltip(wrapper, renderResult(result.data))

  tooltip.querySelectorAll("a[data-fg-link]").forEach((link) => {
    link.addEventListener("click", (e) => {
      e.preventDefault()
      e.stopPropagation()
      window.open((link as HTMLAnchorElement).href, "_blank")
    })
  })
}

// ─── PDF Detection ──────────────────────────────────────────────────────────

/**
 * Extract PDF info from a message row.
 * WhatsApp Web shows PDF attachments as preview cards with a document icon
 * and a filename containing ".pdf". We extract whatever visible text is shown
 * in the preview card (title, page count, file size, etc.).
 *
 * @returns The extracted preview text or null if no PDF is detected
 */
function extractPdfInfo(row: Element): string | null {
  // Look for elements that indicate a PDF attachment
  // WhatsApp renders document attachments with the filename visible in a span
  const allText = row.textContent || ""

  // Quick check: does this row mention a .pdf file at all?
  if (!allText.toLowerCase().includes(".pdf")) return null

  // Look for the document preview card — typically a div containing the filename
  const spans = row.querySelectorAll("span")
  let pdfFileName = ""
  let pdfDetails = ""

  for (const span of spans) {
    if (span.closest("[data-fg-btn]") || span.closest(".fg-tooltip")) continue
    const text = span.textContent?.trim() || ""

    // Match filename with .pdf extension
    if (/\.pdf$/i.test(text)) {
      pdfFileName = text
      continue
    }

    // Capture document details (page count, file size like "3 pages - 245 KB")
    if (pdfFileName && /\d+\s*(pages?|KB|MB|bytes)/i.test(text)) {
      pdfDetails = text
    }
  }

  if (!pdfFileName) return null

  // Build the extracted text from whatever is visible in the preview
  const parts: string[] = [`PDF Document: ${pdfFileName}`]
  if (pdfDetails) parts.push(`Details: ${pdfDetails}`)

  // Also capture any surrounding message text as context
  const messageText = extractMessageText(row)
  if (messageText.length > 5) {
    parts.push(`Accompanying message: ${messageText}`)
  }

  return parts.join("\n")
}

// ─── Image Extraction ───────────────────────────────────────────────────────

/**
 * Extract an image from a message row and convert to base64 data URI.
 * WhatsApp renders images as <img> tags. We filter out small icons/emoji.
 */
async function extractMessageImage(row: Element): Promise<string | null> {
  const imgs = row.querySelectorAll("img")
  for (const img of imgs) {
    if (img.closest("[data-fg-btn]") || img.closest(".fg-tooltip")) continue
    // Skip small images (icons, emoji, avatars)
    if (img.naturalWidth < 100 || img.naturalHeight < 100) continue
    if (img.src.includes("emoji")) continue

    try {
      // Resize to max 1024px on longest side to keep payload reasonable
      const maxDim = 1024
      let w = img.naturalWidth
      let h = img.naturalHeight
      if (w > maxDim || h > maxDim) {
        const scale = maxDim / Math.max(w, h)
        w = Math.round(w * scale)
        h = Math.round(h * scale)
      }

      const canvas = document.createElement("canvas")
      canvas.width = w
      canvas.height = h
      const ctx = canvas.getContext("2d")!
      ctx.drawImage(img, 0, 0, w, h)
      return canvas.toDataURL("image/jpeg", 0.85)
    } catch {
      // CORS may block cross-origin images
      continue
    }
  }
  return null
}

// ─── Message Processing ─────────────────────────────────────────────────────

/**
 * Extract text content from a message row.
 * WhatsApp renders text in deeply nested spans. We find the longest
 * text block that isn't a timestamp or metadata.
 */
function extractMessageText(row: Element): string {
  const spans = row.querySelectorAll("span")
  let longestText = ""

  for (const span of spans) {
    if (span.closest("[data-fg-btn]") || span.closest(".fg-tooltip")) continue

    const text = span.textContent?.trim() || ""
    if (
      text.length > longestText.length &&
      text.length > 10 &&
      !/^\d{1,2}:\d{2}\s*(am|pm)?$/i.test(text)
    ) {
      longestText = text
    }
  }

  return longestText
}

/**
 * Process a single message row: extract text and inject Verify button.
 * Idempotent — skips rows that have already been processed.
 */
function processMessageRow(row: Element): void {
  if (row.getAttribute("data-fg") === "true") return
  row.setAttribute("data-fg", "true")

  // Skip system messages (pinned, joined, etc.)
  const rowText = row.textContent || ""
  if (/pinned a message|joined|changed|created|added|removed|left/i.test(rowText) && rowText.length < 100) return

  const text = extractMessageText(row)
  // Check if row has a PDF attachment
  const pdfInfo = extractPdfInfo(row)
  // Check if row has an image (large img element, not emoji/icon)
  const hasImage = !pdfInfo && Array.from(row.querySelectorAll("img")).some(
    img => img.naturalWidth >= 100 && img.naturalHeight >= 100 && !img.src.includes("emoji")
  )
  if (text.length < 5 && !hasImage && !pdfInfo) return

  // Find the message bubble — look for the deepest container with the message text
  // WhatsApp wraps messages in nested divs. We look for a div that contains
  // a span with the message text and append our button after it.
  const allSpans = row.querySelectorAll("span")
  let targetSpan: Element | null = null
  for (const span of allSpans) {
    if (span.textContent?.trim() === text) {
      targetSpan = span
      break
    }
    // Also match if the span contains the beginning of the text
    if (text.length > 50 && span.textContent && span.textContent.trim().length > 50 && text.startsWith(span.textContent.trim().substring(0, 50))) {
      targetSpan = span
    }
  }

  // Find a suitable parent to append the button
  const appendTarget = targetSpan?.parentElement || row.querySelector("div > div > div") || row
  if (!appendTarget) return

  const wrapper = document.createElement("span")
  wrapper.style.position = "relative"
  wrapper.style.display = "inline-block"

  const btn = createVerifyButton()
  if (pdfInfo) {
    btn.textContent = "\u2713 Verify PDF"
  } else if (hasImage) {
    btn.textContent = "\u2713 Verify Image"
  }
  btn.addEventListener("click", async (e) => {
    e.stopPropagation()
    e.preventDefault()
    if (pdfInfo) {
      // PDF verification — pass extracted preview text as pdfText
      handleVerifyClick(btn, text || "Verify this PDF document", undefined, pdfInfo)
    } else {
      // Extract image lazily on click to avoid overhead on page load
      const imageBase64 = hasImage ? await extractMessageImage(row) : null
      handleVerifyClick(btn, text, imageBase64 ?? undefined)
    }
  })

  wrapper.appendChild(btn)
  appendTarget.appendChild(wrapper)
}

/** Scan message rows only within the conversation panel (#main), not the sidebar */
function scanForMessages(): void {
  const main = document.getElementById("main")
  if (!main) {
    console.log("[FG] #main not found")
    return
  }

  const rows = main.querySelectorAll('[role="row"]')
  rows.forEach(processMessageRow)
}

// ─── Initialization ─────────────────────────────────────────────────────────

function init(): void {
  injectStyles()
  console.log("[FG] ForwardGuard content script loaded")

  // WhatsApp SPA needs time to render — scan after delay and on mutations
  setTimeout(() => {
    scanForMessages()
  }, 3000)

  // Watch for new messages via MutationObserver (debounced)
  let scanTimeout: ReturnType<typeof setTimeout> | null = null
  const observer = new MutationObserver(() => {
    if (scanTimeout) return
    scanTimeout = setTimeout(() => {
      scanForMessages()
      scanTimeout = null
    }, 500)
  })

  observer.observe(document.body, { childList: true, subtree: true })
}

// Close tooltip when clicking outside
document.addEventListener("click", (e) => {
  const target = e.target as Element
  if (
    activeTooltip &&
    !target.closest?.(".fg-tooltip") &&
    !target.closest?.("[data-fg-btn]")
  ) {
    closeActiveTooltip()
  }
})

// Start injection
init()
