# ForwardGuard — Requirements & Progress Tracker

## Core MVP Requirements

- [ ] Chrome extension injects Verify button into WhatsApp Web messages
- [ ] Extension extracts message text from DOM
- [ ] POST /api/v1/verify endpoint accepts message and returns verdict
- [ ] Agent calls claim_extractor tool
- [ ] Agent calls web_search tool via Tavily
- [ ] Agent calls fact_check_db tool via Tavily
- [ ] Agent calls scam_detector tool
- [ ] Agent returns structured JSON verdict
- [ ] Tooltip renders verdict, confidence, explanation
- [ ] Tooltip shows sources with credibility indicators
- [ ] Tooltip shows which tools were used

## Architecture Requirements

- [ ] TypeScript strict mode throughout
- [ ] Zod input validation
- [ ] Rate limiting (10 req/IP/min)
- [ ] Input content guardrails
- [ ] Output guardrails
- [ ] Pino structured logging with requestId
- [ ] Request/response lifecycle logging
- [ ] Fail-fast env validation on startup
- [ ] CORS configured for extension origin
- [ ] Global error handler (no raw errors to client)
- [ ] Health check endpoint

## Agent Quality Requirements

- [ ] Temperature 0 (deterministic verdicts)
- [ ] Max 8 iterations (prevent runaway loops)
- [ ] Intermediate steps logged
- [ ] Fallback for JSON parse failures
- [ ] Agent reasoning exposed in response

## UX & Deployment Requirements

- [ ] Works on real WhatsApp Web messages
- [ ] Response time under 15 seconds
- [ ] Tooltip looks professional
- [ ] README with setup instructions
- [ ] .env.example committed
