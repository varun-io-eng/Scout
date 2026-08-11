/**
 * Standalone Scout enrichment — no CRM required.
 *
 * Usage:
 *   node enrich-lead.js --company "Stripe"
 *   node enrich-lead.js --company "Acme" --website acme.com
 *   node enrich-lead.js --file lead.json
 *
 * Requires Scout server: npm run dev (from project root)
 */

const SCOUT_API = process.env.SCOUT_API_URL || 'http://localhost:3847/api';

const PLACEHOLDER_AURA = {
  datahubBaseUrl: 'https://placeholder.example.com/datahub',
  authToken: 'standalone-integration-token',
};

function parseArgs() {
  const args = process.argv.slice(2);
  const out = { company: '', website: '', file: null };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--company' && args[i + 1]) out.company = args[++i];
    else if (args[i] === '--website' && args[i + 1]) out.website = args[++i];
    else if (args[i] === '--file' && args[i + 1]) out.file = args[++i];
  }
  return out;
}

async function healthCheck() {
  const res = await fetch(`${SCOUT_API}/health`);
  if (!res.ok) throw new Error(`Scout health check failed: HTTP ${res.status}`);
  return res.json();
}

async function enrichLead(lead) {
  const res = await fetch(`${SCOUT_API}/leads/company-enrich`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ lead, aura: PLACEHOLDER_AURA }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

async function main() {
  const { company, website, file } = parseArgs();

  console.log('Checking Scout…');
  const health = await healthCheck();
  console.log('Scout status:', health.status || health.ai || 'ok');

  let lead;
  if (file) {
    const fs = await import('fs');
    lead = JSON.parse(fs.readFileSync(file, 'utf8'));
  } else if (company) {
    lead = {
      id: 1,
      campaign_id: 0,
      company_name: company,
      company_website: website || '',
    };
  } else {
    console.error(`
Usage:
  node enrich-lead.js --company "Stripe"
  node enrich-lead.js --company "Acme Corp" --website acme.com
  node enrich-lead.js --file lead.json

Environment:
  SCOUT_API_URL=http://localhost:3847/api  (default)
`);
    process.exit(1);
  }

  console.log('\nEnriching:', lead.company_name || lead.id);
  const result = await enrichLead(lead);

  if (result.skipped) {
    console.log('\nSkipped:', result.message);
    process.exit(0);
  }

  console.log('\nSuccess:', result.message);
  console.log('Changed fields:', (result.changed_fields || []).join(', ') || '(none)');
  console.log('\nUpdated lead:\n', JSON.stringify(result.updated_lead, null, 2));
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
