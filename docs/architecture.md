# ForwardGuard v2 — System Architecture

## Overview

ForwardGuard is a multi-agent AI system that verifies claims in WhatsApp messages. It connects a Chrome extension (injected into WhatsApp Web) to an AI-powered verification backend with **8 LLM touchpoints**, RAG-based misinformation retrieval, multi-modal vision support, and PDF document analysis.

## Architecture Diagram

```
┌──────────────────────────────────────────────────────────────────┐
│  BROWSER LAYER (Chrome Extension - Plasmo)                       │
│                                                                  │
│  ┌─────────────┐  ┌──────────────┐  ┌────────────┐  ┌────────┐ │
│  │  WhatsApp    │  │   Image      │  │    PDF     │  │Tooltip │ │
│  │  Content     │  │   Extractor  │  │  Detector  │  │   UI   │ │
│  │  Script      │  │  (Canvas→B64)│  │            │  │        │ │
│  └──────┬───────┘  └──────────────┘  └────────────┘  └────────┘ │
│         │                                                        │
│         ▼                                                        │
│  ┌──────────────────────────────────────────────────────────────┐│
│  │  API Client (verify.ts) — POST /verify {msg, img?, pdf?}    ││
│  └──────────────────────────┬───────────────────────────────────┘│
└─────────────────────────────┼────────────────────────────────────┘
                              │
                              ▼
┌──────────────────────────────────────────────────────────────────┐
│  API LAYER (Fastify)                                             │
│  ┌──────┐  ┌───────────┐  ┌──────────────┐  ┌────────────────┐ │
│  │ CORS │→ │ Rate Limit │→ │ Zod Validate │→ │ Content Filter │ │
│  └──────┘  └───────────┘  └──────────────┘  └───────┬────────┘ │
└──────────────────────────────────────────────────────┼──────────┘
                                                       │
                              ▼                        │
┌──────────────────────────────────────────────────────────────────┐
│  MULTI-AGENT LAYER (LangChain + Claude Sonnet 4)                │
│                                                                  │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │  ORCHESTRATOR AGENT                                        │  │
│  │  Coordinates pipeline: Analyze → Verify → Synthesize       │  │
│  └──┬────────────────────────┬────────────────────┬───────────┘  │
│     │                        │                    │              │
│     ▼                        ▼                    ▼              │
│  ┌──────────────┐  ┌──────────────────┐  ┌───────────────────┐  │
│  │ CLAIM ANALYST│  │ SOURCE VERIFIER  │  │ VERDICT SYNTH     │  │
│  │ AGENT        │  │ AGENT            │  │ AGENT             │  │
│  │              │  │                  │  │                   │  │
│  │ • Vision     │  │ • Web Search     │  │ • Evidence Fusion │  │
│  │ • PDF Parse  │  │ • Fact-Check DB  │  │ • Confidence Cal. │  │
│  │ • RAG Search │  │ • Source Cred.   │  │ • JSON Output     │  │
│  │ • Claim Ext. │  │ • LLM Scam Det. │  │                   │  │
│  └──────────────┘  └──────────────────┘  └───────────────────┘  │
└──────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌──────────────────────────────────────────────────────────────────┐
│  TOOLS & DATA LAYER                                              │
│                                                                  │
│  ┌───────────────┐  ┌───────────────┐  ┌──────────────────────┐ │
│  │ Web Search    │  │ Fact-Check DB │  │ RAG Pipeline         │ │
│  │ (Tavily)      │  │ (Tavily filt.)│  │ ┌──────────────────┐ │ │
│  └───────────────┘  └───────────────┘  │ │ Vector Store     │ │ │
│                                        │ │ (Jaccard Sim.)   │ │ │
│  ┌───────────────┐  ┌───────────────┐  │ ├──────────────────┤ │ │
│  │ LLM Scam      │  │ Source Cred.  │  │ │ Misinfo KB       │ │ │
│  │ Detector      │  │ Analyzer      │  │ │ (20+ hoaxes)     │ │ │
│  │ (Claude)      │  │ (Claude)      │  │ └──────────────────┘ │ │
│  └───────────────┘  └───────────────┘  └──────────────────────┘ │
│                                                                  │
│  ┌───────────────┐  ┌───────────────┐  ┌──────────────────────┐ │
│  │ PDF Extractor │  │ Claude Vision │  │ Claim Extractor      │ │
│  │ (Claude LLM)  │  │ (Image→Text)  │  │ (Claude LLM)        │ │
│  └───────────────┘  └───────────────┘  └──────────────────────┘ │
└──────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌──────────────────────────────────────────────────────────────────┐
│  EXTERNAL APIs                                                   │
│  ┌─────────────────────┐  ┌─────────────────────────────────┐   │
│  │ Anthropic API       │  │ Tavily Search API               │   │
│  │ Claude Sonnet 4     │  │ Web + Domain Filtering          │   │
│  │ (8 LLM touchpoints) │  │                                 │   │
│  └─────────────────────┘  └─────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────────┘
```

## LLM Touchpoints (8 total)

| # | Component | LLM Usage | Model |
|---|-----------|-----------|-------|
| 1 | Orchestrator Agent | Pipeline coordination & routing | Claude Sonnet 4 |
| 2 | Claim Analyst Agent | Claim extraction from text | Claude Sonnet 4 |
| 3 | Claim Analyst Agent | Vision analysis (images) | Claude Sonnet 4 (Vision) |
| 4 | Source Verifier Agent | Source credibility analysis | Claude Sonnet 4 |
| 5 | LLM Scam Detector | Manipulation psychology analysis | Claude Sonnet 4 |
| 6 | PDF Extractor | Document understanding & claim extraction | Claude Sonnet 4 |
| 7 | RAG Pipeline | Semantic matching against known misinformation | Keyword + Jaccard similarity |
| 8 | Verdict Synthesizer | Evidence fusion & confidence calibration | Claude Sonnet 4 |

## Layer Descriptions

### Browser Layer
The Chrome extension (built with Plasmo) injects into WhatsApp Web's DOM. A MutationObserver watches for new messages and adds "Verify" buttons. Supports three verification modes:
- **Text**: Extract message text and verify claims
- **Image**: Extract images via Canvas API, encode as base64, send for vision analysis
- **PDF**: Detect PDF attachments, extract preview metadata, send for LLM document analysis

### Backend API Layer
Fastify handles HTTP with built-in Pino logging. Every request gets a UUID (`requestId`) that flows through all log lines for end-to-end tracing. CORS allows extension and WhatsApp Web origins. Body limit set to 10MB for image payloads.

### Guardrails Layer
Defence-in-depth: rate limiting prevents abuse, Zod validates input shape (text, image, PDF), content filters block prompt injection attempts. On the output side, we validate the agent's response before returning it to the user — never exposing raw LLM output.

### Multi-Agent Layer
Three specialized agents coordinated by an orchestrator in a sequential pipeline:

1. **Claim Analyst Agent**: Extracts verifiable claims using Claude vision (for images) and text analysis. Runs RAG search against known misinformation database. Handles PDF document parsing.

2. **Source Verifier Agent**: For each claim, runs parallel web searches and fact-check database queries. Uses LLM to analyze source credibility (domain reputation, writing quality, bias indicators). Runs LLM-based scam detection for manipulation pattern analysis.

3. **Verdict Synthesizer Agent**: Fuses all evidence — claims, sources, RAG matches, scam analysis — into a structured verdict with confidence calibration and step-by-step reasoning.

### Tools & Data Layer
Seven specialized tools, each with a single responsibility:
- **claim_extractor**: Direct Anthropic SDK call with vision support for claim decomposition
- **web_search**: Tavily advanced search with credibility scoring
- **fact_check_db**: Tavily filtered to trusted fact-checking domains only
- **scam_detector**: LLM-powered manipulation psychology analysis (replaces regex)
- **source_credibility**: LLM-powered domain/content credibility evaluation
- **pdf_extractor**: LLM-powered document understanding and claim extraction
- **rag_misinfo_search**: Semantic search against curated misinformation knowledge base (20+ known hoaxes)

### External APIs
- **Anthropic**: Powers all 7 LLM touchpoints (agent reasoning, vision, scam detection, credibility analysis, PDF parsing, claim extraction, verdict synthesis)
- **Tavily**: Purpose-built search API for LLM agents with clean snippet extraction and domain filtering
