# ForwardGuard

**Multi-Agent AI Fact-Checking System for WhatsApp Web**

Misinformation spreads faster than ever through private messaging. WhatsApp forwards reach millions before anyone checks if they're true. ForwardGuard tackles this by embedding an AI fact-checking system directly into WhatsApp Web — users click a "Verify" button next to any message and get an instant, sourced verdict.

ForwardGuard is a **multi-agent AI system** with **8 LLM touchpoints**, RAG-based misinformation retrieval, multi-modal vision support, and PDF document analysis. It uses three specialized AI agents (Claim Analyst, Source Verifier, Verdict Synthesizer) coordinated by an orchestrator to decompose claims, search the live web, query fact-checking databases, detect scam patterns, and synthesize evidence into a structured verdict.

## Key Features

- **Multi-Agent Architecture** — 3 specialized agents (Claim Analyst, Source Verifier, Verdict Synthesizer) coordinated by an orchestrator
- **8 LLM Touchpoints** — LLM deeply integrated across claim extraction, vision analysis, scam detection, source credibility, PDF parsing, RAG queries, and verdict synthesis
- **RAG Pipeline** — Vector store with 20+ known misinformation entries, semantic matching via Jaccard similarity
- **Multi-Modal Verification** — Text, images (Claude Vision), and PDF documents
- **LLM-Powered Scam Detection** — Analyzes manipulation psychology, urgency, fear, and social engineering (replaces basic regex)
- **LLM Source Credibility Analysis** — Evaluates domain reputation, writing quality, and bias indicators
- **PDF Document Verification** — Extracts and fact-checks claims from PDF attachments
- **Full Observability** — Structured JSON logging with request tracing, per-agent step logging
- **Defence-in-Depth Guardrails** — Rate limiting, Zod validation, prompt injection filtering, output validation

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│  BROWSER LAYER (Chrome Extension)                            │
│  WhatsApp Content Script → Image Extractor → PDF Detector    │
│  API Client (POST /verify {message, image?, pdf?})           │
└──────────────────────────┬───────────────────────────────────┘
                           │
┌──────────────────────────┼───────────────────────────────────┐
│  API LAYER (Fastify)     ▼                                   │
│  CORS → Rate Limit → Zod Validate → Content Filter           │
└──────────────────────────┬───────────────────────────────────┘
                           │
┌──────────────────────────┼───────────────────────────────────┐
│  MULTI-AGENT LAYER       ▼                                   │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │              ORCHESTRATOR AGENT                          │ │
│  └──┬──────────────────┬───────────────────────┬───────────┘ │
│     ▼                  ▼                       ▼             │
│  ┌──────────┐  ┌────────────────┐  ┌──────────────────────┐ │
│  │ CLAIM    │  │ SOURCE         │  │ VERDICT              │ │
│  │ ANALYST  │  │ VERIFIER       │  │ SYNTHESIZER          │ │
│  │ • Vision │  │ • Web Search   │  │ • Evidence Fusion    │ │
│  │ • PDF    │  │ • Fact-Check   │  │ • Confidence Cal.    │ │
│  │ • RAG    │  │ • Credibility  │  │ • JSON Output        │ │
│  └──────────┘  │ • Scam Detect  │  └──────────────────────┘ │
│                └────────────────┘                            │
└──────────────────────────┬───────────────────────────────────┘
                           │
┌──────────────────────────┼───────────────────────────────────┐
│  TOOLS & DATA LAYER      ▼                                   │
│  Web Search (Tavily) │ Fact-Check DB │ RAG Vector Store      │
│  LLM Scam Detector │ Source Credibility │ PDF Extractor      │
│  Claude Vision │ Claim Extractor │ Misinfo Knowledge Base    │
└──────────────────────────────────────────────────────────────┘
```

## LLM Touchpoints (8 total)

| # | Component | LLM Usage |
|---|-----------|-----------|
| 1 | Claim Analyst Agent | Claim extraction from text via Claude |
| 2 | Claim Analyst Agent | Vision analysis for images via Claude Vision |
| 3 | PDF Extractor | Document understanding & claim extraction |
| 4 | RAG Pipeline | Semantic matching against known misinformation |
| 5 | Source Verifier Agent | Source credibility analysis via Claude |
| 6 | LLM Scam Detector | Manipulation psychology analysis via Claude |
| 7 | Verdict Synthesizer | Evidence fusion & confidence calibration |
| 8 | Orchestrator | Pipeline coordination & routing |

## How It Works — The Multi-Agent Pipeline

1. **User clicks "Verify"** on any WhatsApp message (text, image, or PDF)
2. The extension extracts content (text, image as base64, or PDF metadata) and sends to backend
3. **Input guardrails** validate and sanitize the request
4. **Orchestrator Agent** coordinates the pipeline:
   - **Stage 1 — Claim Analyst**: Extracts claims using Claude (with Vision for images, PDF parsing for documents). Runs RAG search against known misinformation database.
   - **Stage 2 — Source Verifier**: For each claim, runs parallel web searches and fact-check DB queries. LLM analyzes source credibility. LLM detects scam/manipulation patterns.
   - **Stage 3 — Verdict Synthesizer**: Fuses all evidence into a structured verdict with confidence calibration and step-by-step reasoning.
5. **Output guardrails** validate the response
6. Tooltip displays: verdict, confidence, explanation, sources, and tools used

## Tech Stack

| Technology | Why |
|---|---|
| **Fastify** | Faster than Express, better TypeScript support, built-in Pino logging |
| **TypeScript (strict)** | Type safety across the entire codebase |
| **LangChain** | Agent orchestration framework, tool calling abstractions |
| **Claude Sonnet 4** | Best-in-class tool calling, vision, structured JSON output |
| **Tavily** | Purpose-built search API for LLM agents with domain filtering |
| **Pino** | Structured JSON logging with requestId correlation |
| **Zod** | Runtime input validation with type inference |
| **Plasmo** | Modern Chrome extension framework with hot reload |

## Project Structure

```
forwardguard/
├── README.md
├── docs/
│   ├── architecture.md          # System architecture diagram
│   ├── sequence-diagram.md      # Request lifecycle
│   ├── agent-flow.md            # Agent reasoning flow
│   ├── requirements.md          # Feature checklist
│   └── api-spec.md              # API contract
├── backend/
│   ├── src/
│   │   ├── index.ts             # Fastify server entry point
│   │   ├── types/index.ts       # All shared TypeScript types
│   │   ├── middleware/
│   │   │   ├── logger.ts        # Pino structured logger
│   │   │   └── guardrails.ts    # Input/output guardrails + rate limit
│   │   ├── agent/
│   │   │   ├── agent.ts         # Multi-agent pipeline entry point
│   │   │   ├── prompts.ts       # All LLM prompts (versioned)
│   │   │   ├── agents/
│   │   │   │   ├── orchestrator.ts      # Pipeline coordinator
│   │   │   │   ├── claimAnalyst.ts      # Claim extraction + Vision + RAG
│   │   │   │   ├── sourceVerifier.ts    # Web search + credibility analysis
│   │   │   │   └── verdictSynthesizer.ts # Evidence fusion + verdict
│   │   │   ├── rag/
│   │   │   │   ├── vectorStore.ts       # Jaccard similarity search
│   │   │   │   └── misinfoDb.ts         # 20+ known hoaxes seed data
│   │   │   └── tools/
│   │   │       ├── claimExtractor.ts    # LLM claim decomposition
│   │   │       ├── webSearch.ts         # Tavily web search
│   │   │       ├── factCheck.ts         # Tavily fact-check DB
│   │   │       ├── scamDetector.ts      # LLM scam detection
│   │   │       ├── sourceCredibility.ts # LLM source analysis
│   │   │       ├── pdfExtractor.ts      # LLM PDF parsing
│   │   │       └── ragSearch.ts         # RAG vector store search
│   │   └── routes/
│   │       └── verify.ts        # POST /api/v1/verify handler
│   ├── package.json
│   └── tsconfig.json
└── extension/
    ├── src/
    │   ├── contents/
    │   │   └── whatsapp.ts      # Content script (WhatsApp DOM injection)
    │   ├── lib/
    │   │   └── TooltipUI.ts     # Verdict tooltip renderer
    │   └── api/
    │       └── verify.ts        # HTTP client for backend
    ├── package.json
    └── tsconfig.json
```

## Setup Instructions

### Prerequisites

- Node.js 18+ and npm
- An [Anthropic API key](https://console.anthropic.com)
- A [Tavily API key](https://tavily.com) (free tier works)
- Google Chrome browser

### 1. Clone and Install

```bash
git clone git@github.com:utpandey/ForwardGuard.git
cd ForwardGuard

# Install backend dependencies
cd backend && npm install

# Install extension dependencies
cd ../extension && npm install
```

### 2. Configure API Keys

```bash
cp backend/.env.example backend/.env
# Edit backend/.env and add your ANTHROPIC_API_KEY and TAVILY_API_KEY
```

### 3. Run the Backend

```bash
cd backend
npm run dev
```

### 4. Load the Extension in Chrome

```bash
cd extension
npm run dev
```

1. Open Chrome → `chrome://extensions/`
2. Enable "Developer mode" (top right)
3. Click "Load unpacked"
4. Select `extension/build/chrome-mv3-dev`
5. Open [WhatsApp Web](https://web.whatsapp.com)
6. Click "Verify" on any message

### 5. Test with curl

```bash
# Health check
curl http://localhost:3001/api/v1/health

# Verify a text message
curl -X POST http://localhost:3001/api/v1/verify \
  -H "Content-Type: application/json" \
  -d '{"message": "NASA confirms Earth will experience 15 days of darkness in November 2024"}'
```

## Sample Verdict Output

```json
{
  "verdict": "FALSE",
  "confidence": 0.95,
  "explanation": "This claim about 15 days of darkness has been repeatedly debunked since 2015. NASA has never made such an announcement.",
  "claims": [{"id": "c1", "text": "NASA confirms 15 days of darkness", "type": "factual"}],
  "sources": [{"title": "Snopes: 15 Days of Darkness", "url": "https://snopes.com/...", "snippet": "Debunked...", "credibility": "high"}],
  "toolsUsed": ["claim_extractor", "rag_misinfo_search", "web_search", "fact_check_db", "source_credibility"],
  "reasoning": "Step 1: RAG matched known hoax '15 days of darkness'. Step 2: Web search confirmed debunking by multiple fact-checkers..."
}
```
