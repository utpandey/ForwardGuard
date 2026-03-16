# ForwardGuard — System Architecture

## Overview

ForwardGuard is a layered system that connects a Chrome extension (injected into WhatsApp Web) to an AI-powered verification backend. Each layer has a single responsibility, making the system testable, observable, and maintainable.

## Architecture Diagram

```mermaid
graph TD
    subgraph Browser["Browser Layer"]
        WA["WhatsApp Web<br/>(web.whatsapp.com)"]
        CS["Content Script<br/>(Plasmo / React)"]
        TT["Tooltip UI<br/>(Verdict Display)"]
    end

    subgraph API["Backend API Layer"]
        FASTIFY["Fastify Server<br/>Port 3001"]
        CORS["CORS Middleware<br/>chrome-extension:// + localhost"]
        LOG["Pino Logger<br/>Structured JSON + requestId"]
    end

    subgraph Guard["Guardrails Layer"]
        RL["Rate Limiter<br/>10 req/IP/min"]
        ZOD["Zod Validator<br/>Schema Enforcement"]
        CF["Content Filter<br/>Injection Protection"]
        OG["Output Guardrails<br/>Response Validation"]
    end

    subgraph Agent["Agent Layer"]
        EXEC["LangChain AgentExecutor<br/>ReAct Pattern"]
        LLM["Claude Sonnet<br/>claude-sonnet-4-5<br/>Temperature: 0"]
        PARSE["JSON Parser<br/>Structured Output"]
    end

    subgraph Tools["Tools Layer"]
        CE["claim_extractor<br/>Claim Decomposition<br/>(Direct Anthropic SDK)"]
        WS["web_search<br/>Live Web Search<br/>(Tavily API)"]
        FC["fact_check_db<br/>Fact-Check Orgs<br/>(Tavily Filtered)"]
        SD["scam_detector<br/>Pattern Matching<br/>(Regex Engine)"]
    end

    subgraph External["External APIs"]
        ANTHROPIC["Anthropic API<br/>claude-sonnet-4-5"]
        TAVILY["Tavily Search API<br/>Web + Domain Filtering"]
    end

    %% Request flow
    WA -->|"User clicks Verify"| CS
    CS -->|"POST /api/v1/verify<br/>{message, context?}"| FASTIFY
    FASTIFY --> CORS
    CORS --> LOG
    LOG --> RL
    RL --> ZOD
    ZOD --> CF
    CF -->|"Validated request"| EXEC

    %% Agent reasoning loop
    EXEC <-->|"Prompt + Tools"| LLM
    EXEC --> CE
    EXEC --> WS
    EXEC --> FC
    EXEC --> SD

    %% External API calls
    CE -->|"Direct SDK call"| ANTHROPIC
    WS -->|"search_depth: advanced"| TAVILY
    FC -->|"include_domains filter"| TAVILY

    %% Response flow
    EXEC -->|"Agent output"| PARSE
    PARSE --> OG
    OG -->|"VerifyResponse JSON"| FASTIFY
    FASTIFY -->|"200 + verdict"| CS
    CS --> TT
    TT -->|"Verdict + Sources + Confidence"| WA

    %% Styling
    classDef browser fill:#e3f2fd,stroke:#1976d2,stroke-width:2px
    classDef api fill:#f3e5f5,stroke:#7b1fa2,stroke-width:2px
    classDef guard fill:#fff3e0,stroke:#e65100,stroke-width:2px
    classDef agent fill:#e8f5e9,stroke:#2e7d32,stroke-width:2px
    classDef tools fill:#fce4ec,stroke:#c62828,stroke-width:2px
    classDef external fill:#f5f5f5,stroke:#616161,stroke-width:2px

    class WA,CS,TT browser
    class FASTIFY,CORS,LOG api
    class RL,ZOD,CF,OG guard
    class EXEC,LLM,PARSE agent
    class CE,WS,FC,SD tools
    class ANTHROPIC,TAVILY external
```

## Layer Descriptions

### Browser Layer
The Chrome extension (built with Plasmo) injects into WhatsApp Web's DOM. A MutationObserver watches for new messages and adds "Verify" buttons. When clicked, the extension calls the backend API and renders a tooltip with the verdict.

### Backend API Layer
Fastify handles HTTP with built-in Pino logging. Every request gets a UUID (`requestId`) that flows through all log lines for end-to-end tracing. CORS is locked to extension and localhost origins only.

### Guardrails Layer
Defence-in-depth: rate limiting prevents abuse, Zod validates input shape, content filters block prompt injection attempts. On the output side, we validate the agent's response before returning it to the user — never exposing raw LLM output.

### Agent Layer
LangChain's AgentExecutor implements the ReAct pattern: the agent reasons about what tool to call next, observes the result, and loops until it has enough evidence. Claude Sonnet at temperature 0 ensures deterministic, reproducible verdicts.

### Tools Layer
Four specialized tools, each with a single responsibility:
- **claim_extractor**: Uses a direct Anthropic SDK call (not LangChain) for precise claim decomposition
- **web_search**: Tavily advanced search with credibility scoring
- **fact_check_db**: Tavily filtered to trusted fact-checking domains only
- **scam_detector**: Deterministic regex patterns — no LLM hallucination risk

### External APIs
- **Anthropic**: Powers both the agent LLM and the claim extractor
- **Tavily**: Purpose-built search API for LLM agents with clean snippet extraction
