# Scout

**AI-assisted lead operator for Zequinia Aura with Apollo company enrichment.**

Scout sits beside Aura (no Aura code changes). It provides two main capabilities:

## 1. Lead Verification & Enrichment

**Run automation** verifies and enriches each **Not Eligible** lead:

1. **Apollo Company Enrichment** (90-day staleness check)
   - Check if `company_last_verified_at` > 90 days
   - If stale: Query Apollo's organization APIs
   - Search company by name → Enrich with domain
   - Compare every field → Update only fields that differ
   - Fields enriched: company_name, employee_size, revenue_size, industry, website, city, state, country

2. **LLM ICP Scoring**
   - Score lead fit against campaign ICP (must be ≥ `LEAD_FIT_READY_THRESHOLD`, default 8)
   - **No manual confirm needed** if score passes threshold
   - Auto-edit necessary fields and make lead Ready

3. **Decision Logic**
   - Score ≥ 8 → Auto-edit fields → Ready → Queued (no manual confirm)
   - Score < 8 → Manual LinkedIn verification required
   - Otherwise → deleted from campaign

## 2. Research Copilot

Original Scout functionality for investors/recruiters:
- Visit a company or LinkedIn page
- Open Scout → scout the page
- Ask questions in the side panel or dashboard

Extension version: **1.7.5**

## What it does

| Action | Behavior |
|--------|----------|
| **Scope** | Only processes **Not Eligible** leads in campaigns |
| **Apollo Company Enrichment** | Auto-enriches stale company data (>90 days) using Apollo organization APIs |
| **LLM ICP Scoring** | Scores lead fit against campaign ICP (threshold: 8) |
| **Auto-ready** | Score ≥ 8 → Auto-edit fields → Ready → Queued (no manual confirm) |
| **Manual-ready** | Score < 8 → Manual LinkedIn verification required |
| **No match** | Permanently **deleted** from the Aura campaign |

The Scout box sits at **center-top** and is **draggable** (position remembered).

## Fit score threshold (`LEAD_FIT_READY_THRESHOLD`)

Default: **8 / 10**.

| | |
|--|--|
| **Meaning** | Minimum LLM/rule fit score for Ready; below this the lead is deleted from the campaign |
| **Why 8** | Intentionally high — Ready/Queued should mean “strong ICP fit,” not “maybe.” Aligns with `FIT_SCORE_READY_THRESHOLD` in `lead-brain.ts` |
| **Tuning** | Set `LEAD_FIT_READY_THRESHOLD` in `server/.env` (e.g. `7` for looser campaigns) |
| **Eval today** | No labeled FP/FN harness yet — threshold is a product default, not a measured ROC cutoff |
| **Future** | Log score + Ready/delete outcomes; compute precision/recall against operator decisions |

## Auth & trust model

Scout does **not** implement its own login. It reuses the **Aura operator session**:

- Extension reads `auth_token` from Aura page storage and Datahub URL from the page / user profile.
- Requests to Scout include `{ aura: { authToken, datahubBaseUrl } }` (or `x-aura-token` / `x-datahub-url` headers).
- Scout forwards that Bearer token to Datahub — same trust boundary as the Aura UI.

**Limits (by design today):**

| Topic | Behavior |
|-------|----------|
| Token expiry | No Scout-side refresh. If Aura session expires, Run/Confirm fail until the operator re-signs into Aura |
| Rate limiting | No Scout API rate limit; LLM providers may 429 (Scout falls back across providers / rules) |
| Datahub URL | Taken from the Aura page the operator already trusts. Spoofing requires controlling that page or the extension — treat Scout API as **localhost / private**, not a public internet service |
| Production hardening | Bind Scout to localhost, don’t expose `:3847` publicly, keep tokens out of logs |

## Architecture

```
scout/
├── extension/     Chrome MV3 — Aura operator UI + LinkedIn assist
├── server/        Node.js brain — ICP scoring, Datahub API
├── dashboard/     React app — research / ask-page copilot
└── scripts/       Utilities
```

```
Aura (Not Eligible leads) → Scout enriches & scores (Apollo + LLM)
                ├─ Score ≥ 8 → Auto-edit fields → Ready → Queued
                └─ Score < 8 → Manual verification required
```

## Quick start

### 1. Install

```bash
cd scout
npm install
```

### 2. Configure

```bash
cp server/.env.example server/.env
```

```env
PORT=3847
GROQ_API_KEY=gsk_...
# or OPENAI_API_KEY=sk_...

DATAHUB_BASE_URL=https://app.zequinia.com/zequinia-datahub

# Fit gate (default 8). Below this → manual verification required.
LEAD_FIT_READY_THRESHOLD=8

# Apollo API key for company enrichment
APOLLO_API_KEY=your_apollo_api_key_here
```

### 3. Run server (+ optional dashboard)

```bash
npm run dev
```

- API: http://localhost:3847
- Dashboard: http://localhost:5173

### 4. Load the extension

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. **Load unpacked** → select `extension/`
4. After code changes: **Reload** the extension, then refresh Aura

### 5. Operator flow

1. Sign in to **Aura**
2. Open a campaign: `/dashboard/campaigns/{id}`
3. Scout panel appears (center-top) — drag if needed
4. Click **Run automation** (sign into LinkedIn in the Scout Chrome window if asked)
5. Refresh the Aura leads table

## API (lead brain)

Base: `http://localhost:3847/api`

| Method | Path | Description |
|--------|------|-------------|
| GET | `/leads/queue/:campaignId` | Not Eligible leads with LinkedIn URLs |
| GET | `/leads/resolve/:campaignId` | Match profile → campaign lead |
| GET | `/leads/icp/:campaignId` | Campaign ICP |
| POST | `/leads/process` | Score / apply |
| POST | `/leads/analyze` | Score only |
| POST | `/leads/apply` | Apply with operator verify |
| POST | `/leads/verify-puppeteer` | Puppeteer: Aura Edit + LinkedIn + website → Ready |
| POST | `/leads/delete` | Permanently remove leads from campaign |
| POST | `/leads/automate-batch` | Batch apply |

## Design choices

- **No Aura fork** — Scout only calls the same Datahub APIs Aura uses.
- **Hard delete on fail** — failed verifies are removed from the campaign (no restore list).
- **Location override** — uses ICP `expected_values` / campaign geo when location blocks eligibility.

## Production Readiness Features

Scout includes several production-ready features for reliability and observability:

### Caching
- **In-memory cache** with TTL for Apollo API responses (15-minute default)
- **Cache hit/miss logging** for monitoring cache effectiveness
- **Automatic cleanup** of expired entries

### Retry & Circuit Breaker
- **Exponential backoff** retry policy for failed API calls (max 3 attempts)
- **Circuit breaker pattern** to prevent cascading failures (5 failures → open circuit for 60s)
- **Configurable retry logic** for network errors, 5xx, and 429 responses

### Metrics & Monitoring
- **Counters** for request success/failure tracking
- **Gauges** for lead scores and performance metrics
- **Histograms** for request duration tracking (p50, p95, p99 percentiles)
- **Metrics endpoint** at `/metrics` for monitoring integration

### Structured Logging
- **JSON-formatted logs** with timestamps, levels, and context
- **Service-specific loggers** (apollo, llm, lead, aura) for better filtering
- **Context-aware logging** for debugging and audit trails

### Health Checks
- **Health endpoint** (`/health`) - basic service health and uptime
- **Readiness endpoint** (`/ready`) - dependency checks (AI configuration)
- **Metrics endpoint** (`/metrics`) - all collected metrics

### Rate Limiting
- **Token bucket algorithm** for API rate limiting
- **Per-service limits** (Apollo: 100/min, LLM: 50/min, General: 1000/min)
- **Rate limit logging** when limits are exceeded

## Research copilot (original Scout)

Still available for investors/recruiters:

1. Visit a company or LinkedIn page
2. Open Scout → scout the page
3. Ask questions in the side panel or dashboard

## License

MIT
