# HubSpot + Scout Integration

This example pulls contacts from HubSpot CRM, enriches them using Scout's Apollo + LLM pipeline, and pushes the updated fields back to HubSpot.

## Setup

### 1. Install dependencies

```bash
cd examples/hubspot
npm install
```

### 2. Configure

Copy the env file and add your HubSpot API key:

```bash
cp .env.example .env
```

```env
HUBSPOT_ACCESS_TOKEN=pat-na1-xxxxxxxx
SCOUT_API_URL=http://localhost:3847/api
```

Get your HubSpot access token from:
**HubSpot → Settings → Integrations → Private Apps → Create a private app**

Required scopes: `crm.objects.contacts.read`, `crm.objects.contacts.write`

### 3. Run

```bash
# Enrich all contacts that have a company name but are missing industry/revenue
node enrich-contacts.js

# Enrich a single contact by HubSpot contact ID
node enrich-contacts.js --contact-id 12345

# Dry run (score leads without writing back to HubSpot)
node enrich-contacts.js --dry-run
```

## What It Does

```
HubSpot Contacts (missing fields)
        │
        ▼
  Scout /leads/company-enrich
  (Apollo: industry, revenue, employee size, website)
        │
        ▼
  Scout /leads/analyze
  (LLM scores lead fit against your ICP)
        │
        ▼
  HubSpot API (PATCH updated fields)
```

## Fields Mapped

| HubSpot Property | Scout Field | Source |
|-----------------|-------------|--------|
| `company` | `company_name` | CRM / Apollo |
| `jobtitle` | `job_title` | CRM |
| `industry` | `company_industry` | Apollo |
| `annualrevenue` | `company_revenue_size` | Apollo |
| `numberofemployees` | `company_employee_size` | Apollo |
| `website` | `company_website` | Apollo |
| `city` | `company_city` | Apollo |
| `state` | `company_state` | Apollo |
| `country` | `company_country` | Apollo |
| `scout_fit_score` | `fitScore` | LLM |
| `scout_enriched_at` | timestamp | Scout |
