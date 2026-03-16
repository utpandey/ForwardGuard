# ForwardGuard — Request Lifecycle

## Full Sequence Diagram

```mermaid
sequenceDiagram
    actor User
    participant WA as WhatsApp Web
    participant EXT as Chrome Extension
    participant API as Fastify Backend
    participant GR as Guardrails
    participant AG as LangChain Agent
    participant CE as claim_extractor
    participant ANTH as Anthropic API
    participant WS as web_search
    participant TAV as Tavily API
    participant FC as fact_check_db
    participant SD as scam_detector
    participant LLM as Claude Sonnet

    User->>WA: Sees suspicious message
    User->>EXT: Clicks "✓ Verify" button

    Note over EXT: Show loading tooltip immediately

    EXT->>API: POST /api/v1/verify<br/>{ message, context?, language? }

    Note over API: Generate requestId (UUID)<br/>Create scoped Pino logger

    %% Input Guardrails
    API->>GR: checkRateLimit(req.ip)
    alt Rate limit exceeded
        GR-->>API: 429 RATE_LIMITED
        API-->>EXT: { error: "Rate limit exceeded" }
        EXT-->>User: Show error tooltip
    end

    API->>GR: VerifyRequestSchema.parse(body)
    alt Validation fails
        GR-->>API: 400 VALIDATION_ERROR
        API-->>EXT: { error: "Invalid input", details }
        EXT-->>User: Show error tooltip
    end

    API->>GR: runInputGuardrails(message)
    alt Content blocked
        GR-->>API: 422 CONTENT_BLOCKED
        API-->>EXT: { error: "Content blocked" }
        EXT-->>User: Show error tooltip
    end

    Note over API: log.info("Starting verification")

    %% Agent Execution
    API->>AG: verify(request, requestId, logger)

    Note over AG: ReAct Loop Begins<br/>Max 8 iterations

    %% Step 1: Claim Extraction
    AG->>CE: claim_extractor({ message })
    CE->>ANTH: Direct SDK call<br/>claude-sonnet-4-5<br/>System: "Extract verifiable claims"
    ANTH-->>CE: Numbered claim list
    CE-->>AG: { claims: [{ id, text, type }] }

    Note over AG: Thought: Found N claims.<br/>Need to verify each one.

    %% Step 2: Web Search (per claim)
    loop For each significant claim
        AG->>WS: web_search({ query: claim.text })
        WS->>TAV: POST /search<br/>{ query, search_depth: "advanced",<br/>max_results: 5, include_answer: true }
        TAV-->>WS: { results[], answer }
        Note over WS: Score domain credibility<br/>HIGH/MEDIUM/LOW
        WS-->>AG: { query, answer, sources[], totalResults }

        Note over AG: Thought: Evaluate evidence<br/>from web sources
    end

    %% Step 3: Fact-Check Database
    loop For each claim
        AG->>FC: fact_check_db({ claim: claim.text })
        FC->>TAV: POST /search<br/>{ query: "fact check: {claim}",<br/>include_domains: [snopes, politifact, ...] }
        TAV-->>FC: { results[] }
        Note over FC: Auto-detect verdict<br/>from snippet keywords
        FC-->>AG: { summary, results: [{ org, verdict?, snippet }] }

        Note over AG: Thought: Cross-reference<br/>with fact-checkers
    end

    %% Step 4: Scam Detection (conditional)
    opt Scam signals detected in message
        AG->>SD: scam_detector({ message })
        Note over SD: Run regex patterns<br/>6 HIGH + 4 MEDIUM severity
        SD-->>AG: { isScam, detectedPatterns[],<br/>overallSeverity, summary }

        Note over AG: Thought: Scam patterns<br/>found/not found
    end

    %% Step 5: Synthesis
    Note over AG: Aggregate all evidence
    AG->>LLM: Synthesise verdict<br/>with all tool observations
    LLM-->>AG: { verdict, confidence,<br/>explanation, reasoning,<br/>claims, sources }

    Note over AG: ReAct Loop Complete

    AG-->>API: Agent result (structured JSON)

    %% Output Guardrails
    API->>GR: runOutputGuardrails(explanation)
    alt Output invalid
        GR-->>API: 500 AGENT_ERROR
        API-->>EXT: { error: "Verification failed" }
        EXT-->>User: Show error tooltip
    end

    Note over API: Calculate processingTimeMs<br/>log.info({ verdict, confidence,<br/>processingTimeMs, toolsUsed })

    API-->>EXT: 200 VerifyResponse<br/>{ requestId, verdict, confidence,<br/>explanation, claims, sources,<br/>toolsUsed, reasoning,<br/>processingTimeMs, timestamp }

    EXT-->>User: Render verdict tooltip<br/>Badge + Confidence + Explanation<br/>+ Sources + Tools Used
```

## Data Shapes at Each Step

| Step | Data Shape |
|------|-----------|
| Extension → Backend | `{ message: string, context?: string, language?: string }` |
| Claim Extractor → Agent | `{ claims: [{ id: "c1", text: string, type: "factual"\|"statistical"\|... }] }` |
| Web Search → Agent | `{ query: string, answer: string, sources: [{ title, url, snippet, credibility }], totalResults: number }` |
| Fact Check → Agent | `{ summary: string, results: [{ organization, title, url, verdict?, snippet }] }` |
| Scam Detector → Agent | `{ isScam: boolean, detectedPatterns: [{ pattern, severity, description }], overallSeverity: string, summary: string }` |
| Backend → Extension | `{ requestId, verdict, confidence, explanation, claims[], sources[], toolsUsed[], reasoning, processingTimeMs, timestamp }` |

## Timing Expectations

| Phase | Expected Duration |
|-------|------------------|
| Input guardrails | < 5ms |
| Claim extraction | 1-2s |
| Web search (per claim) | 1-3s |
| Fact-check lookup (per claim) | 1-2s |
| Scam detection | < 1ms |
| Agent synthesis | 1-2s |
| Output guardrails | < 1ms |
| **Total (typical)** | **5-12s** |
