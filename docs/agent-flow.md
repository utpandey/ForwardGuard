# ForwardGuard — Agent Reasoning Flow

## ReAct Loop Flowchart

```mermaid
flowchart TD
    START([START<br/>Message received]) --> PARSE[Parse incoming message<br/>Extract text + context]

    PARSE --> CE[/"Call claim_extractor<br/>Decompose into individual claims"/]
    CE --> CE_CHECK{Claims found?}

    CE_CHECK -->|No claims| UNKNOWN_DIRECT[Return UNKNOWN<br/>confidence: 0.3<br/>"No verifiable claims found"]
    CE_CHECK -->|Claims found| INIT_LOOP[Initialize claim loop<br/>iteration = 0]

    INIT_LOOP --> ITER_CHECK{iteration < max_claims<br/>AND total_iterations < 8?}

    ITER_CHECK -->|Max iterations reached| SYNTHESISE
    ITER_CHECK -->|Continue| WEB[/"Call web_search<br/>Search live web for claim"/]

    WEB --> WEB_EVAL{Sufficient web<br/>evidence?}

    WEB_EVAL -->|Strong evidence| FC_CHECK{Check fact-check<br/>databases too?}
    WEB_EVAL -->|Weak/no evidence| FC[/"Call fact_check_db<br/>Query fact-checking orgs"/]

    FC_CHECK -->|Yes - for thoroughness| FC
    FC_CHECK -->|Skip - evidence clear| SCAM_CHECK

    FC --> FC_EVAL[Evaluate fact-checker<br/>verdicts + snippets]
    FC_EVAL --> SCAM_CHECK

    SCAM_CHECK{Scam signals<br/>detected in message?}

    SCAM_CHECK -->|"Urgency, threats,<br/>forwarding pressure"| SD[/"Call scam_detector<br/>Run regex patterns"/]
    SCAM_CHECK -->|No scam signals| NEXT_CLAIM

    SD --> SD_EVAL{isScam == true?}
    SD_EVAL -->|Yes| SCAM_VERDICT[Set verdict lean: SCAM<br/>Record detected patterns]
    SD_EVAL -->|No| NEXT_CLAIM

    SCAM_VERDICT --> NEXT_CLAIM

    NEXT_CLAIM[Move to next claim<br/>iteration++] --> ITER_CHECK

    %% Synthesis phase
    SYNTHESISE[Aggregate all evidence<br/>from all tool calls]

    ITER_CHECK -->|All claims checked| SYNTHESISE

    SYNTHESISE --> EVIDENCE_EVAL{Evidence quality<br/>assessment}

    EVIDENCE_EVAL -->|"Multiple credible sources<br/>confirm claim"| VERDICT_TRUE[verdict: TRUE<br/>confidence: 0.90-1.00]
    EVIDENCE_EVAL -->|"Credible sources<br/>contradict/debunk"| VERDICT_FALSE[verdict: FALSE<br/>confidence: 0.90-1.00]
    EVIDENCE_EVAL -->|"Mixed or limited<br/>evidence"| MIXED_CHECK{confidence >= 0.50?}
    EVIDENCE_EVAL -->|"Scam patterns<br/>detected"| VERDICT_SCAM[verdict: SCAM<br/>confidence: based on patterns]

    MIXED_CHECK -->|Yes| VERDICT_LEAN[verdict: TRUE/FALSE<br/>confidence: 0.50-0.89]
    MIXED_CHECK -->|No| VERDICT_UNKNOWN[verdict: UNKNOWN<br/>confidence: < 0.50]

    VERDICT_TRUE --> FORMAT
    VERDICT_FALSE --> FORMAT
    VERDICT_LEAN --> FORMAT
    VERDICT_UNKNOWN --> FORMAT
    VERDICT_SCAM --> FORMAT
    UNKNOWN_DIRECT --> FORMAT

    FORMAT[Format structured JSON output<br/>verdict + confidence + explanation<br/>+ claims + sources + reasoning]

    FORMAT --> VALIDATE{Output valid?<br/>explanation > 10 chars?}

    VALIDATE -->|Valid| RETURN([RETURN<br/>VerifyResponse JSON])
    VALIDATE -->|Invalid| FALLBACK[Generate fallback response<br/>UNKNOWN + safe explanation]
    FALLBACK --> RETURN

    %% Styling
    classDef tool fill:#e8f5e9,stroke:#2e7d32,stroke-width:2px
    classDef decision fill:#fff3e0,stroke:#e65100,stroke-width:2px
    classDef verdict fill:#e3f2fd,stroke:#1976d2,stroke-width:2px
    classDef error fill:#fce4ec,stroke:#c62828,stroke-width:2px

    class CE,WEB,FC,SD tool
    class CE_CHECK,WEB_EVAL,FC_CHECK,SCAM_CHECK,SD_EVAL,EVIDENCE_EVAL,MIXED_CHECK,ITER_CHECK,VALIDATE decision
    class VERDICT_TRUE,VERDICT_FALSE,VERDICT_LEAN,VERDICT_UNKNOWN,VERDICT_SCAM,UNKNOWN_DIRECT verdict
    class FALLBACK error
```

## Decision Points Explained

### 1. "Claims found?"
The claim extractor may find zero verifiable claims in opinion-only or emotional messages. In this case, we return UNKNOWN immediately rather than wasting tool calls.

### 2. "Max iterations reached?"
Hard cap of 8 total tool calls prevents runaway agent loops. If reached, the agent synthesizes a verdict from whatever evidence it has gathered so far.

### 3. "Sufficient web evidence?"
If web search returns strong, unambiguous evidence (multiple high-credibility sources agreeing), the agent may still check fact-check databases for thoroughness but can skip if the evidence is overwhelming.

### 4. "Scam signals detected?"
The agent looks for manipulation language patterns (urgency, threats, chain-letter pressure) in the original message. Scam detection is only triggered when these signals are present — not for every message.

### 5. "confidence >= 0.50?"
Below 0.50 confidence, the agent MUST return UNKNOWN regardless of which direction the evidence leans. This prevents low-confidence guesses from being presented as verdicts.

### 6. "Output valid?"
Final safety check: if the agent somehow produces an empty or nonsensical explanation, we return a safe fallback rather than exposing garbage to the user.

## Tool Call Patterns

| Message Type | Typical Tool Sequence |
|---|---|
| Simple factual claim | claim_extractor → web_search → fact_check_db |
| Multi-claim forward | claim_extractor → (web_search + fact_check_db) × N |
| Obvious scam | claim_extractor → scam_detector → web_search |
| Opinion/emotional | claim_extractor → UNKNOWN (no verifiable claims) |
| Complex claim | claim_extractor → web_search → fact_check_db → web_search (refined) |
