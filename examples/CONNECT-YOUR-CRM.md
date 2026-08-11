# Connect Scout to Your CRM

Scout ships with a **full native integration for Aura** (Chrome extension + campaign automation). For any other CRM, you connect through Scout’s **local REST API** — your CRM (or a small script) pulls records, calls Scout, and writes results back.

No Scout code changes are required in your CRM. You only need HTTP.

---

## Two ways to use Scout

| Mode | Best for | What you get |
|------|----------|--------------|
| **Aura (built-in)** | Live demo, production with Aura/Datahub | Extension UI, Run automation, ICP scoring, auto Ready/Queued |
| **API bridge (any CRM)** | HubSpot, Salesforce, Pipedrive, custom DB | Company enrichment (+ optional scoring via script) |

**Aura demo:** see the [main README](../README.md#quick-start).

**Other CRMs:** follow this guide or the [HubSpot example](./hubspot/).

---

## Architecture

```
┌─────────────┐     pull leads      ┌─────────────┐     PATCH fields     ┌─────────────┐
│  Your CRM   │ ──────────────────► │ Your script │ ──────────────────► │  Your CRM   │
│             │                     │  (or Zapier)│                     │             │
└─────────────┘                     └──────┬──────┘                     └─────────────┘
                                           │
                                           │ POST /api/leads/company-enrich
                                           │ POST /api/leads/analyze (Aura ICP)
                                           ▼
                                    ┌─────────────┐
                                    │ Scout server│  localhost:3847
                                    │ Apollo + LLM│
                                    └─────────────┘
```

Scout does **not** store your CRM credentials long-term. Your integration holds the CRM token; Scout only receives lead payloads per request.

---

## Prerequisites

1. **Scout server running**

```bash
cd scout
npm install
npm run dev
# API → http://localhost:3847/api
```

2. **Configure `server/.env`**

```env
PORT=3847
GROQ_API_KEY=gsk_...          # or OPENAI_API_KEY
APOLLO_API_KEY=your_key       # optional but recommended for company enrichment
```

3. **Verify health**

```bash
curl http://localhost:3847/api/health
```

---

## Canonical lead shape

Map your CRM contact/lead to this object before calling Scout:

```json
{
  "id": 12345,
  "campaign_id": 0,
  "first_name": "Jane",
  "last_name": "Doe",
  "job_title": "Head of Engineering",
  "company_name": "Acme Corp",
  "linkedin_url": "https://www.linkedin.com/in/janedoe",
  "email": "jane@acme.com",
  "company_industry": "",
  "company_employee_size": "",
  "company_revenue_size": "",
  "company_website": "",
  "company_city": "",
  "company_state": "",
  "company_country": "",
  "company_enriched_at": "",
  "company_last_verified_at": ""
}
```

| Scout field | Typical CRM source |
|-------------|-------------------|
| `company_name` | Company / Account name |
| `job_title` | Title / Job title |
| `linkedin_url` | LinkedIn URL custom field |
| `company_industry` | Industry |
| `company_employee_size` | Employee count / company size |
| `company_revenue_size` | Annual revenue |
| `company_website` | Website / domain |
| `company_city` / `state` / `country` | Address fields |

Use your CRM’s native field names internally; convert to Scout’s shape in your script.

---

## API endpoints (CRM integrators)

Base URL: `http://localhost:3847/api`

### CRM-agnostic (works with any CRM)

These only need a **lead object**. The `aura` block in the body is required by the schema but **not used for enrichment logic** — use a placeholder (see HubSpot example).

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/leads/company-enrich` | POST | Fill company fields via Apollo |
| `/leads/company-enrich-batch` | POST | Same, batch (dedupes by company) |
| `/health` | GET | Health check |
| `/ask-page` | POST | Q&A over scraped page JSON (research copilot) |
| `/analyze` | POST | Build company profile from page extraction |

### Aura-native (full pipeline)

These need a **real Aura/Datahub** session (`datahubBaseUrl` + `authToken`) and `campaignId`:

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/leads/analyze` | POST | Score lead vs campaign ICP (no write) |
| `/leads/apply` | POST | Score + write back to Aura |
| `/leads/enrich-and-ready` | POST | Enrich → score → set Ready |
| `/leads/queue/:campaignId` | GET | List Not Eligible leads |
| `/leads/icp/:campaignId` | GET | Fetch campaign ICP rules |

---

## Integration loop (any CRM)

```text
1. SELECT leads from CRM where company fields are incomplete
2. FOR EACH lead:
     a. Map CRM record → Scout lead JSON
     b. POST /leads/company-enrich
     c. Map response.updated_lead → CRM field updates
     d. PATCH lead in CRM
3. (Optional) Run on a schedule — cron, Zapier, GitHub Action
```

---

## Example: enrich one lead (curl)

```bash
curl -X POST http://localhost:3847/api/leads/company-enrich \
  -H "Content-Type: application/json" \
  -d '{
    "lead": {
      "id": 1,
      "campaign_id": 0,
      "company_name": "Stripe",
      "company_website": "stripe.com"
    },
    "aura": {
      "datahubBaseUrl": "https://placeholder.example.com/datahub",
      "authToken": "your-integration-token-min-10-chars"
    }
  }'
```

**Response (success):**

```json
{
  "success": true,
  "updated_lead": { "company_name": "Stripe", "company_industry": "...", ... },
  "changed_fields": ["company_industry", "company_employee_size", "company_website"],
  "confidence": 0.85,
  "message": "Company enriched with 3 fields"
}
```

Write `changed_fields` back to your CRM only for fields you want to update.

---

## Example: Node.js bridge (minimal)

See [standalone/enrich-lead.js](./standalone/enrich-lead.js) — pass a JSON file, get enriched output. No CRM required for testing.

```bash
cd examples/standalone
node enrich-lead.js --company "Acme Corp"
```

---

## CRM-specific guides

| CRM | Status | Guide |
|-----|--------|-------|
| **Aura / Datahub** | Native (extension) | [Main README](../README.md) |
| **HubSpot** | Example script | [hubspot/README.md](./hubspot/README.md) |
| **Salesforce** | Pattern below | This doc — [Salesforce section](#salesforce) |
| **Pipedrive / Zoho / etc.** | Same pattern | Map fields → call `/leads/company-enrich` → write back |

---

## HubSpot

Full working example: **[examples/hubspot/](./hubspot/)**

```bash
cd examples/hubspot
cp .env.example .env   # add HUBSPOT_ACCESS_TOKEN
npm install
node enrich-contacts.js --dry-run
```

---

## Salesforce

Scout does not ship a Salesforce package yet. Use the same bridge pattern:

1. **Auth:** Salesforce Connected App → OAuth → `access_token` + `instance_url`
2. **Pull:** `GET /services/data/v59.0/query?q=SELECT+Id,Company,Title,Industry+FROM+Lead+WHERE+Industry=NULL`
3. **Enrich:** `POST http://localhost:3847/api/leads/company-enrich` with mapped lead
4. **Push:** `PATCH /services/data/v59.0/sobjects/Lead/{Id}` with enriched fields

**Suggested field mapping:**

| Scout | Salesforce Lead field |
|-------|----------------------|
| `company_name` | `Company` |
| `job_title` | `Title` |
| `company_industry` | `Industry` |
| `company_employee_size` | `NumberOfEmployees` |
| `company_revenue_size` | `AnnualRevenue` |
| `company_website` | `Website` |
| `company_city` | `City` |
| `company_state` | `State` |
| `company_country` | `Country` |

Store Scout metadata in custom fields if desired: `Scout_Enriched_At__c`, `Scout_Fit_Score__c`.

---

## Pipedrive, Zoho, Copper, etc.

Same 3-step loop:

1. **Export or API-read** contacts/deals with missing company data  
2. **POST** to `/leads/company-enrich`  
3. **Update** via that CRM’s REST API  

Use [HubSpot’s `enrich-contacts.js`](./hubspot/enrich-contacts.js) as a template — replace `hubspotRequest()` with your CRM’s client.

---

## Zapier / Make (no-code)

1. **Trigger:** New or updated CRM contact (missing industry)  
2. **Action:** Webhooks by Zapier → POST to Scout  
   - URL: `http://YOUR_MACHINE:3847/api/leads/company-enrich`  
   - Body: mapped lead JSON  
3. **Action:** Update CRM contact with response fields  

Note: Scout must be reachable from the automation runner (use ngrok for demos, or host Scout on a private server).

---

## Research copilot (no CRM)

For investors/recruiters browsing LinkedIn — no CRM needed:

1. Load the Scout Chrome extension  
2. Visit any company or profile page  
3. Use the side panel to ask questions  

API alternative: `POST /api/ask-page` with page extraction JSON from your own scraper.

---

## What Scout provides vs what you build

| Scout provides | You build (for non-Aura CRM) |
|----------------|------------------------------|
| Apollo company enrichment | CRM read/write script |
| LLM scoring (Aura campaigns) | Field mapping |
| Browser research copilot | Scheduler (optional) |
| Metrics, cache, retries | OAuth / token storage |

---

## Troubleshooting

| Issue | Fix |
|-------|-----|
| `Apollo API not configured` | Set `APOLLO_API_KEY` in `server/.env` |
| `Cannot reach Scout` | Run `npm run dev` in project root |
| Enrichment returns `skipped: true` | Company name too vague — add `company_website` |
| `/leads/analyze` fails | Needs real Aura ICP — use company-enrich only, or use Aura demo |
| LinkedIn features fail | Use company-enrich path; LinkedIn is optional |

---

## Next steps

- **Demo Aura:** [Main README → Quick start](../README.md#quick-start)  
- **Try HubSpot:** [examples/hubspot/](./hubspot/)  
- **Test without CRM:** [examples/standalone/](./standalone/)  
- **Questions:** Open an issue or extend `examples/your-crm/` using the HubSpot script as a fork
