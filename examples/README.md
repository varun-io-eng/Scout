# Scout Integration Examples

Connect Scout to your CRM — or test enrichment without a CRM at all.

## Start here

| Goal | Guide |
|------|--------|
| **Live demo (Aura)** | [Main README](../README.md) — extension + Run automation |
| **Connect any CRM** | **[CONNECT-YOUR-CRM.md](./CONNECT-YOUR-CRM.md)** ← start here for HubSpot, Salesforce, etc. |
| **HubSpot (working script)** | [hubspot/](./hubspot/) |
| **Test without CRM** | [standalone/](./standalone/) |

---

## How Scout fits your stack

Scout is an **automation brain** (Apollo enrichment + LLM). Your CRM talks to it over HTTP:

```
Your CRM  →  your script  →  Scout API (localhost:3847)  →  enriched fields back
```

**Aura** is the reference integration (Chrome extension, full ICP pipeline).  
**Every other CRM** uses the same REST API — see [CONNECT-YOUR-CRM.md](./CONNECT-YOUR-CRM.md).

---

## Key API endpoints

Base: `http://localhost:3847/api`

| Endpoint | CRM-agnostic? | What it does |
|----------|---------------|--------------|
| `GET /health` | Yes | Health check |
| `POST /leads/company-enrich` | Yes | Apollo company enrichment |
| `POST /leads/company-enrich-batch` | Yes | Batch enrichment |
| `POST /leads/analyze` | Aura ICP required | Score lead vs campaign |
| `POST /leads/enrich-and-ready` | Aura required | Full enrich → Ready pipeline |
| `POST /ask-page` | Yes | Research Q&A over page data |

Full details, curl examples, and field mapping: **[CONNECT-YOUR-CRM.md](./CONNECT-YOUR-CRM.md)**

---

## Prerequisites

```bash
cd scout && npm install && npm run dev
```

`server/.env`:

```env
GROQ_API_KEY=gsk_...
APOLLO_API_KEY=your_key    # for company enrichment
```

Quick test:

```bash
curl http://localhost:3847/api/health
node examples/standalone/enrich-lead.js --company "Stripe"
```

---

## Examples in this folder

| Folder | Description |
|--------|-------------|
| [hubspot/](./hubspot/) | Pull HubSpot contacts → enrich → write back |
| [standalone/](./standalone/) | Enrich one company from CLI — no CRM |
| CONNECT-YOUR-CRM.md | Generic guide for Salesforce, Pipedrive, Zapier, etc. |

---

## Adding your CRM

1. Read [CONNECT-YOUR-CRM.md](./CONNECT-YOUR-CRM.md)  
2. Copy [hubspot/enrich-contacts.js](./hubspot/enrich-contacts.js) as a template  
3. Replace CRM API calls with yours; keep Scout calls the same  
4. (Optional) Add `examples/your-crm/README.md` and open a PR
