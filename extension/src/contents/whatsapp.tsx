/**
 * content/index.tsx — Plasmo content script injected into WhatsApp Web.
 *
 * Observes the DOM for message containers and injects "Verify" buttons.
 * Handles the full verification lifecycle: button click → loading state →
 * API call → tooltip display with verdict.
 *
 * Why MutationObserver: WhatsApp Web is a single-page app that dynamically
 * loads messages. We can't just query once on page load — we need to
 * continuously watch for new messages appearing in the DOM.
 *
 * Why inline styles for the button: WhatsApp's CSS can't override inline
 * styles, making the button resilient to WhatsApp UI updates.
 */

import type { PlasmoCSConfig } from "plasmo"
import { verifyMessage } from "../api/verify"
import type { VerifyResponse } from "../api/verify"
import { TOOLTIP_STYLES, renderLoading, renderError, renderResult } from "./TooltipUI"

// ─── Plasmo Content Script Configuration ────────────────────────────────────

export const config: PlasmoCSConfig = {
  matches: ["https://web.whatsapp.com/*"],
  // Why document_idle: WhatsApp needs to fully load its SPA shell before
  // we start injecting. Running at document_start would find no messages.
  run_at: "document_idle",
}

// ─── State ──────────────────────────────────────────────────────────────────

/** Track the currently active tooltip so we can close it before opening a new one */
let activeTooltip: HTMLElement | null = null

// ─── Style Injection ────────────────────────────────────────────────────────

/** Inject tooltip CSS into document.head once. Idempotent. */
function injectStyles(): void {
  if (document.getElementById("fg-styles")) return
  const style = document.createElement("style")
  style.id = "fg-styles"
  style.textContent = TOOLTIP_STYLES
  document.head.appendChild(style)
}

// ─── Button Creation ────────────────────────────────────────────────────────

/** Create a styled "Verify" button with inline styles for resilience */
function createVerifyButton(): HTMLButtonElement {
  const btn = document.createElement("button")
  btn.textContent = "\u2713 Verify"
  // Inline styles — WhatsApp's CSS can't override these
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

/** Close the currently active tooltip */
function closeActiveTooltip(): void {
  if (activeTooltip) {
    activeTooltip.remove()
    activeTooltip = null
  }
}

/**
 * Show a tooltip anchored to a wrapper element.
 * Automatically positions below or above based on viewport space.
 */
function showTooltip(anchor: HTMLElement, html: string): HTMLElement {
  closeActiveTooltip()

  const tooltip = document.createElement("div")
  tooltip.className = "fg-tooltip"
  tooltip.innerHTML = html

  // Position below the button by default, flip above if near viewport bottom
  const rect = anchor.getBoundingClientRect()
  const flipAbove = window.innerHeight - rect.bottom < 300

  tooltip.style.position = "absolute"
  tooltip.style.left = "0"
  if (flipAbove) {
    tooltip.style.bottom = "100%"
    tooltip.style.marginBottom = "4px"
  } else {
    tooltip.style.top = "100%"
    tooltip.style.marginTop = "4px"
  }

  anchor.appendChild(tooltip)
  activeTooltip = tooltip

  // Wire up close button(s)
  tooltip.querySelectorAll("[data-fg-close]").forEach((closeBtn) => {
    closeBtn.addEventListener("click", (e) => {
      e.stopPropagation()
      closeActiveTooltip()
    })
  })

  return tooltip
}

// ─── Verification Handler ───────────────────────────────────────────────────

/**
 * Handle a Verify button click.
 * Shows loading → calls API → shows result or error.
 */
async function handleVerifyClick(
  btn: HTMLButtonElement,
  messageText: string
): Promise<void> {
  const wrapper = btn.parentElement!

  // Toggle behavior: if tooltip already open on this button, close it
  if (activeTooltip && wrapper.contains(activeTooltip)) {
    closeActiveTooltip()
    return
  }

  // Show loading state immediately — don't make user wait for API response
  showTooltip(wrapper, renderLoading())

  const result = await verifyMessage(messageText)

  if (!result.ok) {
    showTooltip(wrapper, renderError(result.error))
    return
  }

  const tooltip = showTooltip(wrapper, renderResult(result.data))

  // Wire up source links to open in new tab
  tooltip.querySelectorAll("a[data-fg-link]").forEach((link) => {
    link.addEventListener("click", (e) => {
      e.preventDefault()
      e.stopPropagation()
      window.open((link as HTMLAnchorElement).href, "_blank")
    })
  })
}

// ─── Message Processing ─────────────────────────────────────────────────────

/**
 * Process a single message container: extract text and inject Verify button.
 * Idempotent — skips containers that have already been processed.
 */
function processMessageContainer(container: Element): void {
  // Skip if already processed — don't double-inject
  if (container.getAttribute("data-fg") === "true") return
  container.setAttribute("data-fg", "true")

  // Extract message text from WhatsApp's DOM structure
  const textEl = container.querySelector(".selectable-text.copyable-text")
  if (!textEl) return

  const text = textEl.textContent?.trim() || ""
  // Skip very short messages — not worth verifying ("ok", "hi", etc.)
  if (text.length < 5) return

  // Find the message meta area (timestamp row) to append our button
  const meta = container.querySelector('[data-testid="msg-meta"]')
  if (!meta) return

  // Create a wrapper for positioning the tooltip relative to the button
  const wrapper = document.createElement("span")
  wrapper.style.position = "relative"
  wrapper.style.display = "inline-block"

  const btn = createVerifyButton()
  btn.addEventListener("click", (e) => {
    e.stopPropagation()
    handleVerifyClick(btn, text)
  })

  wrapper.appendChild(btn)
  meta.appendChild(wrapper)
}

/** Scan all existing message containers on the page */
function scanForMessages(): void {
  const containers = document.querySelectorAll('[data-testid="msg-container"]')
  containers.forEach(processMessageContainer)
}

// ─── Initialization ─────────────────────────────────────────────────────────

function init(): void {
  injectStyles()

  // Process messages already on the page
  scanForMessages()

  // Watch for new messages — WhatsApp dynamically loads them as user scrolls
  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (!(node instanceof HTMLElement)) continue

        // Check if the added node itself is a message container
        if (node.matches?.('[data-testid="msg-container"]')) {
          processMessageContainer(node)
        }

        // Check descendants — WhatsApp may add wrapper elements containing messages
        node
          .querySelectorAll?.('[data-testid="msg-container"]')
          ?.forEach(processMessageContainer)
      }
    }
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
