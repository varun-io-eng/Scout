/**
 * Scout + HubSpot Integration Example
 *
 * Pulls contacts from HubSpot, enriches them via Scout's API (Apollo + LLM),
 * and pushes updated fields back to HubSpot.
 *
 * Usage:
 *   node enrich-contacts.js                    # Enrich all incomplete contacts
 *   node enrich-contacts.js --contact-id 123   # Enrich a specific contact
 *   node enrich-contacts.js --dry-run          # Score without writing to HubSpot
 *   node enrich-contacts.js --limit 10         # Process at most 10 contacts
 */

import 'dotenv/config';

// ── Configuration ─────────────────────────────────────────────────────────────

const HUBSPOT_TOKEN = process.env.HUBSPOT_ACCESS_TOKEN;
const SCOUT_API = process.env.SCOUT_API_URL || 'http://localhost:3847/api';
const HUBSPOT_API = 'https://api.hubapi.com';

if (!HUBSPOT_TOKEN) {
  console.error('❌ HUBSPOT_ACCESS_TOKEN is not set. See .env.example');
  process.exit(1);
}

// ── CLI Arguments ─────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const LIMIT = (() => {
  const idx = args.indexOf('--limit');
  return idx >= 0 && args[idx + 1] ? parseInt(args[idx + 1], 10) : 50;
})();
const SINGLE_CONTACT_ID = (() => {
  const idx = args.indexOf('--contact-id');
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : null;
})();

// ── HubSpot API Helpers ───────────────────────────────────────────────────────

/**
 * Make a request to the HubSpot API.
 */
async function hubspotRequest(method, path, body = null) {
  const url = `${HUBSPOT_API}${path}`;
  const options = {
    method,
    headers: {
      Authorization: `Bearer ${HUBSPOT_TOKEN}`,
      'Content-Type': 'application/json',
    },
  };
  if (body) options.body = JSON.stringify(body);

  const res = await fetch(url, options);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`HubSpot API ${method} ${path} → ${res.status}: ${text.slice(0, 300)}`);
  }
  return res.json();
}

/**
 * Fetch contacts from HubSpot that are missing key fields.
 * Returns contacts that have a company name but are missing industry, revenue, etc.
 */
async function fetchIncompleteContacts(limit = 50) {
  const properties = [
    'firstname', 'lastname', 'email', 'jobtitle', 'company',
    'industry', 'annualrevenue', 'numberofemployees', 'website',
    'city', 'state', 'country', 'linkedinbio',
  ];

  if (SINGLE_CONTACT_ID) {
    // Fetch a single contact by ID
    const contact = await hubspotRequest(
      'GET',
      `/crm/v3/objects/contacts/${SINGLE_CONTACT_ID}?properties=${properties.join(',')}`,
    );
    return [contact];
  }

  // Search for contacts that have a company name but missing enrichment fields
  const data = await hubspotRequest('POST', '/crm/v3/objects/contacts/search', {
    filterGroups: [
      {
        filters: [
          {
            propertyName: 'company',
            operator: 'HAS_PROPERTY',
          },
        ],
      },
    ],
    properties,
    limit: Math.min(limit, 100),
    sorts: [{ propertyName: 'createdate', direction: 'DESCENDING' }],
  });

  return data.results || [];
}

/**
 * Update a HubSpot contact with enriched fields.
 */
async function updateHubSpotContact(contactId, properties) {
  return hubspotRequest('PATCH', `/crm/v3/objects/contacts/${contactId}`, {
    properties,
  });
}

// ── Scout API Helpers ─────────────────────────────────────────────────────────

/**
 * Check if Scout server is running.
 */
async function checkScoutHealth() {
  try {
    const res = await fetch(`${SCOUT_API}/health`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    console.log('✅ Scout server is running:', data.status || 'ok');
    return true;
  } catch (err) {
    console.error(`❌ Scout server is not reachable at ${SCOUT_API}`);
    console.error('   Start it with: cd scout && npm run dev');
    return false;
  }
}

/**
 * Call Scout's company enrichment endpoint.
 * This uses Apollo to fill in company_industry, company_revenue_size, etc.
 */
async function scoutEnrichCompany(lead) {
  const res = await fetch(`${SCOUT_API}/leads/company-enrich`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      lead,
      // Scout needs an aura config for its internal routing,
      // but for standalone use we pass a dummy placeholder.
      // The enrichment itself only needs the Apollo API key on the server.
      aura: {
        datahubBaseUrl: 'https://placeholder.example.com/datahub',
        authToken: 'standalone-integration-token',
      },
    }),
  });

  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `Scout enrich failed (HTTP ${res.status})`);
  return data;
}

/**
 * Call Scout's LinkedIn scrape + enrichment endpoint.
 */
async function scoutScrapeLinkedIn(lead) {
  const res = await fetch(`${SCOUT_API}/leads/scrape-linkedin`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ lead, campaignId: 0 }),
  });

  const data = await res.json();
  if (!res.ok) return null; // LinkedIn scrape is optional
  return data;
}

// ── Field Mapping ─────────────────────────────────────────────────────────────

/**
 * Convert a HubSpot contact into a Scout lead object.
 */
function hubspotContactToScoutLead(contact) {
  const p = contact.properties || {};
  return {
    id: parseInt(contact.id, 10) || 0,
    campaign_id: 0,
    first_name: p.firstname || '',
    last_name: p.lastname || '',
    job_title: p.jobtitle || '',
    company_name: p.company || '',
    company_industry: p.industry || '',
    company_revenue_size: p.annualrevenue || '',
    company_employee_size: p.numberofemployees || '',
    company_website: p.website || '',
    company_city: p.city || '',
    company_state: p.state || '',
    company_country: p.country || '',
    linkedin_url: p.linkedinbio || '',
    email: p.email || '',
  };
}

/**
 * Convert Scout's enrichment response back to HubSpot property updates.
 */
function scoutResultToHubSpotProperties(scoutResult) {
  const updates = {};
  const lead = scoutResult.updated_lead || {};

  const mapping = {
    company_name: 'company',
    company_industry: 'industry',
    company_revenue_size: 'annualrevenue',
    company_employee_size: 'numberofemployees',
    company_website: 'website',
    company_city: 'city',
    company_state: 'state',
    company_country: 'country',
  };

  for (const [scoutField, hubspotProp] of Object.entries(mapping)) {
    if (lead[scoutField] && String(lead[scoutField]).trim()) {
      updates[hubspotProp] = String(lead[scoutField]).trim();
    }
  }

  // Add Scout metadata as custom properties (create these in HubSpot first)
  if (scoutResult.confidence != null) {
    updates.scout_enrichment_confidence = String(scoutResult.confidence);
  }

  return updates;
}

/**
 * Check which fields are missing on a contact.
 */
function getMissingFields(contact) {
  const p = contact.properties || {};
  const missing = [];
  if (!p.industry) missing.push('industry');
  if (!p.annualrevenue) missing.push('annualrevenue');
  if (!p.numberofemployees) missing.push('numberofemployees');
  if (!p.website) missing.push('website');
  if (!p.city && !p.state && !p.country) missing.push('location');
  return missing;
}

// ── Main Pipeline ─────────────────────────────────────────────────────────────

async function main() {
  console.log('');
  console.log('╔══════════════════════════════════════════════╗');
  console.log('║   Scout + HubSpot Enrichment Pipeline       ║');
  console.log('╚══════════════════════════════════════════════╝');
  console.log('');

  if (DRY_RUN) console.log('🔍 DRY RUN mode — will not write to HubSpot\n');

  // 1. Check Scout is running
  const healthy = await checkScoutHealth();
  if (!healthy) process.exit(1);

  // 2. Fetch contacts from HubSpot
  console.log(`\n📥 Fetching contacts from HubSpot (limit: ${LIMIT})...`);
  const contacts = await fetchIncompleteContacts(LIMIT);
  console.log(`   Found ${contacts.length} contact(s)\n`);

  if (contacts.length === 0) {
    console.log('No contacts to process. Done.');
    return;
  }

  // 3. Process each contact
  let enriched = 0;
  let skipped = 0;
  let errors = 0;

  for (const contact of contacts) {
    const p = contact.properties || {};
    const name = `${p.firstname || ''} ${p.lastname || ''}`.trim() || `Contact #${contact.id}`;
    const company = p.company || '(no company)';
    const missing = getMissingFields(contact);

    if (missing.length === 0) {
      console.log(`  ⏭  ${name} @ ${company} — already complete, skipping`);
      skipped++;
      continue;
    }

    console.log(`  🔄 ${name} @ ${company} — missing: ${missing.join(', ')}`);

    try {
      // Convert HubSpot contact → Scout lead format
      const scoutLead = hubspotContactToScoutLead(contact);

      // Call Scout's enrichment API
      const result = await scoutEnrichCompany(scoutLead);

      if (!result.success) {
        console.log(`     ⚠  Scout: ${result.message || 'enrichment incomplete'}`);
        skipped++;
        continue;
      }

      const hubspotUpdates = scoutResultToHubSpotProperties(result);
      const changedCount = Object.keys(hubspotUpdates).length;

      if (changedCount === 0) {
        console.log(`     ℹ  No new fields to update`);
        skipped++;
        continue;
      }

      console.log(`     ✅ Scout enriched ${changedCount} field(s): ${Object.keys(hubspotUpdates).join(', ')}`);

      // Write back to HubSpot
      if (!DRY_RUN) {
        await updateHubSpotContact(contact.id, hubspotUpdates);
        console.log(`     💾 HubSpot contact ${contact.id} updated`);
      } else {
        console.log(`     🔍 [DRY RUN] Would update:`, JSON.stringify(hubspotUpdates));
      }

      enriched++;
    } catch (err) {
      console.error(`     ❌ Error: ${err.message}`);
      errors++;
    }

    // Rate limit: 100ms between contacts to avoid overwhelming APIs
    await new Promise((r) => setTimeout(r, 100));
  }

  // 4. Summary
  console.log('\n────────────────────────────────────────────');
  console.log(`✅ Enriched: ${enriched}`);
  console.log(`⏭  Skipped:  ${skipped}`);
  console.log(`❌ Errors:   ${errors}`);
  console.log(`📊 Total:    ${contacts.length}`);
  if (DRY_RUN) console.log('\n🔍 This was a dry run. No changes were made to HubSpot.');
  console.log('');
}

main().catch((err) => {
  console.error('\n💥 Fatal error:', err.message);
  process.exit(1);
});
