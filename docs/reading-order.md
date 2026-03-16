# ForwardGuard — Reading Order

A guided sequence to understand the entire project. Each file builds on the previous one.

---

## Phase 1: Big Picture (start here)

| # | File | What you'll learn |
|---|------|-------------------|
| 1 | `README.md` | Project overview, architecture diagram, how it all fits together |
| 2 | `docs/architecture.md` | Layered system design — browser → API → agent → tools → external APIs |
| 3 | `docs/sequence-diagram.md` | Full request lifecycle from button click to tooltip display |
| 4 | `docs/agent-flow.md` | How the ReAct reasoning loop works, decision points, tool call patterns |
| 5 | `docs/api-spec.md` | API contract — request/response shapes, error codes, curl examples |
| 6 | `docs/requirements.md` | Feature checklist — use this to track what's done |

---

## Phase 2: Backend — Data Layer (types and config)

| # | File | What you'll learn |
|---|------|-------------------|
| 7 | `backend/package.json` | Dependencies and why each one was chosen |
| 8 | `backend/tsconfig.json` | TypeScript strict mode config |
| 9 | `backend/.env.example` | Required environment variables |
| 10 | `backend/src/types/index.ts` | **All shared types** — Verdict, Claim, Source, VerifyRequest/Response, tool result shapes. Read this before any code. |

---

## Phase 3: Backend — Middleware (the guardrails)

| # | File | What you'll learn |
|---|------|-------------------|
| 11 | `backend/src/middleware/logger.ts` | Pino logger setup, `createRequestLogger()` for requestId tracing |
| 12 | `backend/src/middleware/guardrails.ts` | Rate limiting, Zod validation, content filtering, output validation |

---

## Phase 4: Backend — The Agent Brain

| # | File | What you'll learn |
|---|------|-------------------|
| 13 | `backend/src/agent/prompts.ts` | System prompt and claim extractor prompt — the "instructions" the AI follows |
| 14 | `backend/src/agent/tools/claimExtractor.ts` | Tool 1: Direct Anthropic SDK call to decompose messages into claims |
| 15 | `backend/src/agent/tools/webSearch.ts` | Tool 2: Tavily web search with domain credibility scoring |
| 16 | `backend/src/agent/tools/factCheck.ts` | Tool 3: Tavily filtered to fact-checking orgs, auto-verdict detection |
| 17 | `backend/src/agent/tools/scamDetector.ts` | Tool 4: Regex-based scam pattern matching (10 patterns, HIGH/MEDIUM) |
| 18 | `backend/src/agent/agent.ts` | **The core** — LangChain AgentExecutor, ReAct loop, JSON parsing with fallbacks |

---

## Phase 5: Backend — Wiring It Together

| # | File | What you'll learn |
|---|------|-------------------|
| 19 | `backend/src/routes/verify.ts` | Route handler — the 11-step request lifecycle (rate limit → validate → agent → respond) |
| 20 | `backend/src/index.ts` | Server entry point — env validation, CORS, hooks, health check, startup |

---

## Phase 6: Chrome Extension

| # | File | What you'll learn |
|---|------|-------------------|
| 21 | `extension/package.json` | Plasmo setup, manifest permissions |
| 22 | `extension/src/api/verify.ts` | HTTP client — timeout handling, error normalization, type-safe responses |
| 23 | `extension/src/content/TooltipUI.tsx` | Tooltip styles + HTML renderers — loading, error, and result states |
| 24 | `extension/src/content/index.tsx` | Content script — MutationObserver, button injection, verify click handler |

---

## Quick Reference: Key Concepts by File

| Concept | Where to find it |
|---------|-----------------|
| ReAct agent pattern | `agent/agent.ts` |
| Tool calling with LangChain | `agent/tools/*.ts` + `agent/agent.ts` |
| Direct Anthropic SDK usage | `agent/tools/claimExtractor.ts` |
| Tavily search integration | `agent/tools/webSearch.ts` + `agent/tools/factCheck.ts` |
| Zod validation | `middleware/guardrails.ts` |
| Rate limiting | `middleware/guardrails.ts` |
| Structured logging | `middleware/logger.ts` |
| Request tracing (requestId) | `routes/verify.ts` → `middleware/logger.ts` |
| CORS configuration | `src/index.ts` |
| DOM injection (WhatsApp) | `content/index.tsx` |
| Tooltip rendering | `content/TooltipUI.tsx` |
