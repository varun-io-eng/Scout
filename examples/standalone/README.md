# Standalone enrichment (no CRM)

Test Scout’s company enrichment without HubSpot, Aura, or any CRM.

## Run

From project root, start Scout:

```bash
npm run dev
```

Then:

```bash
node examples/standalone/enrich-lead.js --company "Stripe"
```

With website hint (better Apollo match):

```bash
node examples/standalone/enrich-lead.js --company "Acme Corp" --website acme.com
```

From a JSON file:

```bash
node examples/standalone/enrich-lead.js --file lead.json
```

Example `lead.json`:

```json
{
  "id": 1,
  "campaign_id": 0,
  "company_name": "DEzen Technology",
  "company_website": ""
}
```

## Requirements

- Scout server on `http://localhost:3847`
- `APOLLO_API_KEY` in `server/.env` (recommended)

## Use this as a template

Copy this script when building a CRM bridge: replace the CLI input with your CRM’s API read, and print/output with your CRM’s API write.

See **[Connect your CRM](../CONNECT-YOUR-CRM.md)** for the full integration guide.
