# ForwardGuard — API Specification

## Base URL

```
http://localhost:3001/api/v1
```

---

## Endpoints

### POST /api/v1/verify

Verify a message for misinformation, scams, or false claims.

#### Request

```json
{
  "message": "string (required, 5-2000 chars)",
  "context": "string (optional, max 500 chars)",
  "language": "string (optional, 2 chars, default: \"en\")"
}
```

| Field | Type | Required | Constraints | Description |
|-------|------|----------|-------------|-------------|
| `message` | string | Yes | min 5, max 2000, trimmed | The message text to verify |
| `context` | string | No | max 500 | Surrounding conversation context |
| `language` | string | No | exactly 2 chars, default "en" | ISO 639-1 language code |

#### Response (200 OK)

```json
{
  "requestId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "verdict": "FALSE",
  "confidence": 0.95,
  "explanation": "This claim has been repeatedly debunked by multiple fact-checking organizations. NASA has never made such an announcement.",
  "claims": [
    {
      "id": "c1",
      "text": "NASA confirms Earth will experience 15 days of darkness",
      "type": "factual"
    }
  ],
  "sources": [
    {
      "title": "No, NASA Did Not Predict 15 Days of Darkness",
      "url": "https://www.snopes.com/fact-check/15-days-of-darkness/",
      "snippet": "This claim has been circulating since 2015 and has been repeatedly debunked...",
      "credibility": "high"
    }
  ],
  "toolsUsed": ["claim_extractor", "web_search", "fact_check_db"],
  "reasoning": "Step 1: Extracted one factual claim about NASA and darkness. Step 2: Web search found no credible sources confirming. Step 3: Snopes and AFP confirm this is a debunked hoax.",
  "processingTimeMs": 4523,
  "timestamp": "2024-11-15T10:30:00.000Z"
}
```

| Field | Type | Description |
|-------|------|-------------|
| `requestId` | string (UUID) | Unique ID for log tracing |
| `verdict` | `"TRUE"` \| `"FALSE"` \| `"UNKNOWN"` \| `"SCAM"` | Final verdict |
| `confidence` | number (0.0-1.0) | Confidence score |
| `explanation` | string | 2-4 sentences, plain English for non-experts |
| `claims` | Claim[] | Individual claims extracted from the message |
| `sources` | Source[] | Sources consulted with credibility ratings |
| `toolsUsed` | string[] | Which agent tools were called |
| `reasoning` | string | Agent's full chain of thought |
| `processingTimeMs` | number | Total processing time in milliseconds |
| `timestamp` | string (ISO 8601) | Response timestamp |

#### Verdict Rules

| Verdict | Meaning | Confidence Range |
|---------|---------|-----------------|
| `TRUE` | Multiple independent credible sources confirm | 0.90-1.00 |
| `FALSE` | Credible sources directly contradict or debunk | 0.90-1.00 |
| `UNKNOWN` | Insufficient evidence, or confidence below 0.50 | 0.00-0.69 |
| `SCAM` | Manipulation patterns detected (urgency, threats) | Varies |

---

### GET /api/v1/health

Health check endpoint. Use to verify the backend is running before making verify calls.

#### Response (200 OK)

```json
{
  "status": "ok",
  "service": "forwardguard",
  "uptime": 1234.567,
  "timestamp": "2024-11-15T10:30:00.000Z"
}
```

---

## Error Responses

All errors return a consistent shape:

```json
{
  "requestId": "a1b2c3d4-...",
  "error": "Human-readable error message",
  "code": "ERROR_CODE",
  "timestamp": "2024-11-15T10:30:00.000Z"
}
```

### Error Codes

| HTTP Status | Code | Description |
|-------------|------|-------------|
| 429 | `RATE_LIMITED` | More than 10 requests per minute from this IP |
| 400 | `VALIDATION_ERROR` | Request body fails Zod schema validation |
| 422 | `CONTENT_BLOCKED` | Message contains blocked content patterns or is too short |
| 500 | `AGENT_ERROR` | Agent failed to produce a valid verdict |
| 500 | `INTERNAL_ERROR` | Unexpected server error |

---

## curl Examples

### Health Check

```bash
curl http://localhost:3001/api/v1/health
```

### Verify a Factual Claim

```bash
curl -X POST http://localhost:3001/api/v1/verify \
  -H "Content-Type: application/json" \
  -d '{
    "message": "NASA confirms Earth will experience 15 days of darkness in November 2024"
  }'
```

### Verify with Context

```bash
curl -X POST http://localhost:3001/api/v1/verify \
  -H "Content-Type: application/json" \
  -d '{
    "message": "Forward this to 10 people within 24 hours or your WhatsApp will be deactivated! WhatsApp is now charging Rs 49 per message. Forward to avoid charges.",
    "context": "Received as a forwarded message in a family group"
  }'
```

### Verify a Health Claim

```bash
curl -X POST http://localhost:3001/api/v1/verify \
  -H "Content-Type: application/json" \
  -d '{
    "message": "Scientists at Harvard have confirmed that drinking warm lemon water cures diabetes and cancer. Share with everyone you know!"
  }'
```
