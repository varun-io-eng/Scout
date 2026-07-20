/**
 * apollo-company-enrichment.ts
 *
 * Apollo.io company enrichment using organizations APIs only.
 * 
 * Endpoints:
 * - POST https://api.apollo.io/api/v1/organizations/search
 * - POST https://api.apollo.io/api/v1/organizations/enrich
 * - POST https://api.apollo.io/api/v1/organizations/bulk_enrich
 * 
 * Auth: X-Api-Key header (set APOLLO_API_KEY in server/.env)
 * 
 * Flow:
 * 1. Check if company_name exists
 * 2. Check if company was enriched within last 90 days
 * 3. If not stale: organizations/search → organizations/enrich
 * 4. Merge results (only missing/stale fields)
 * 5. Update Aura CRM with enriched data
 * 6. Store enrichment metadata
 */

import { apolloCache } from '../cache.js';
import { retryWithBackoff, CircuitBreaker } from '../retry.js';
import { trackApolloRequest } from '../metrics.js';
import { apolloLogger } from '../logger.js';
import { apolloRateLimiter } from '../rate-limit.js';

const APOLLO_API_KEY = process.env.APOLLO_API_KEY ?? '';
const APOLLO_BASE = 'https://api.apollo.io/api/v1';

// Circuit breaker for Apollo API
const apolloCircuitBreaker = new CircuitBreaker(5, 60000);

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ApolloCompanyEnrichResult {
  /** Field values we can use to fill gaps. Only keys with non-empty values. */
  fields: Partial<ApolloCompanyFields>;
  /** 0–1 confidence estimate based on how much Apollo returned. */
  confidence: number;
  source: 'apollo';
  apolloOrganizationId?: string;
  error?: string;
  enrichedAt?: string;
}

export interface ApolloCompanyFields {
  company_name: string;
  company_employee_size: string;
  company_revenue_size: string;
  company_industry: string;
  company_website: string;
  company_city: string;
  company_state: string;
  company_country: string;
}

/** The 8 company fields Scout enriches. */
export const COMPANY_FIELDS_TO_ENRICH: (keyof ApolloCompanyFields)[] = [
  'company_name',
  'company_employee_size',
  'company_revenue_size',
  'company_industry',
  'company_website',
  'company_city',
  'company_state',
  'company_country',
];

/** Company enrichment metadata stored in CRM. */
export interface CompanyEnrichmentMetadata {
  company_enriched_at?: string;
  company_last_verified_at?: string;
  company_enrichment_source?: string;
}

/** Lead with company data and enrichment metadata. */
export interface LeadWithCompanyData {
  id: number;
  campaign_id: number;
  company_name?: string;
  company_employee_size?: string;
  company_revenue_size?: string;
  company_industry?: string;
  company_website?: string;
  company_city?: string;
  company_state?: string;
  company_country?: string;
  company_enriched_at?: string;
  company_last_verified_at?: string;
  company_enrichment_source?: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function str(v: unknown): string {
  return v == null ? '' : String(v).trim();
}

/**
 * Check if company enrichment is stale (>90 days old based on last_verified_at).
 */
export function isCompanyEnrichmentStale(metadata?: CompanyEnrichmentMetadata): boolean {
  if (!metadata?.company_last_verified_at) return true; // Never verified
  
  const lastVerified = new Date(metadata.company_last_verified_at);
  const ninetyDaysAgo = new Date();
  ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);
  
  return lastVerified < ninetyDaysAgo;
}

/**
 * Map Apollo employee count to size bucket.
 */
function mapEmployeeSize(count: number | string): string {
  const n = typeof count === 'number' ? count : parseInt(String(count), 10);
  if (!Number.isFinite(n) || n <= 0) return '';
  if (n <= 1) return '1';
  if (n <= 10) return '2–10';
  if (n <= 50) return '11–50';
  if (n <= 200) return '51–200';
  if (n <= 500) return '201–500';
  if (n <= 1000) return '501–1000';
  if (n <= 5000) return '1001–5000';
  if (n <= 10000) return '5001–10000';
  return '10000+';
}

/**
 * Map Apollo revenue to size bucket.
 */
function mapRevenue(revenue: string | number): string {
  if (typeof revenue === 'number') {
    const m = revenue / 1_000_000;
    if (m < 1) return '<$1M';
    if (m < 10) return '$1M–$10M';
    if (m < 50) return '$10M–$50M';
    if (m < 100) return '$50M–$100M';
    if (m < 250) return '$100M–$250M';
    if (m < 500) return '$250M–$500M';
    if (m < 1000) return '$500M–$1B';
    return '>$1B';
  }
  
  if (typeof revenue === 'string') {
    const r = revenue.toLowerCase();
    if (/less\s*than\s*\$?1\s*m/i.test(r)) return '<$1M';
    if (/\$?1\s*m\s*(to|-)\s*\$?10\s*m/i.test(r)) return '$1M–$10M';
    if (/\$?10\s*m\s*(to|-)\s*\$?50\s*m/i.test(r)) return '$10M–$50M';
    if (/\$?50\s*m\s*(to|-)\s*\$?100\s*m/i.test(r)) return '$50M–$100M';
    if (/\$?100\s*m\s*(to|-)\s*\$?250\s*m/i.test(r)) return '$100M–$250M';
    if (/\$?250\s*m\s*(to|-)\s*\$?500\s*m/i.test(r)) return '$250M–$500M';
    if (/\$?500\s*m\s*(to|-)\s*\$?1\s*b/i.test(r)) return '$500M–$1B';
    if (/>\s*\$?1\s*b|over\s*\$?1\s*b/i.test(r)) return '>$1B';
    return revenue;
  }
  
  return '';
}

// ── Apollo API Calls ─────────────────────────────────────────────────────────

interface ApolloOrganizationSearchResponse {
  organizations?: Array<{
    id?: string;
    name?: string;
    website_url?: string;
    primary_domain?: string;
    estimated_num_employees?: number;
    organization_revenue?: number;
    organization_revenue_printed?: string;
    industry?: string;
    city?: string;
    state?: string;
    country?: string;
    linkedin_url?: string;
  }>;
  error_code?: string;
  error?: string;
}

interface ApolloOrganizationEnrichResponse {
  organization?: {
    id?: string;
    name?: string;
    website_url?: string;
    primary_domain?: string;
    employee_count?: number;
    estimated_annual_revenue?: number;
    annual_revenue_printed?: string;
    industry?: string;
    city?: string;
    state?: string;
    country?: string;
  };
  error_code?: string;
  error?: string;
}

interface ApolloBulkEnrichRequest {
  organization_details: Array<{
    organization_id?: string;
    name?: string;
    website_url?: string;
    primary_domain?: string;
  }>;
}

interface ApolloBulkEnrichResponse {
  organizations?: Array<{
    id?: string;
    name?: string;
    website_url?: string;
    primary_domain?: string;
    estimated_num_employees?: number;
    organization_revenue?: number;
    organization_revenue_printed?: string;
    industry?: string;
    city?: string;
    state?: string;
    country?: string;
    linkedin_url?: string;
  }>;
  error_code?: string;
  error?: string;
}

/**
 * Call Apollo's /organizations/search to find a company by name.
 */
async function searchOrganization(
  companyName: string,
  timeoutMs = 15_000,
): Promise<ApolloOrganizationSearchResponse | null> {
  if (!APOLLO_API_KEY || APOLLO_API_KEY.startsWith('your_')) {
    apolloLogger.warn('No API key configured', { companyName });
    return null;
  }

  if (!companyName || companyName.trim().length < 2) {
    apolloLogger.warn('Company name too short', { companyName });
    return null;
  }

  // Check cache first
  const cacheKey = `search:${companyName.toLowerCase()}`;
  const cached = apolloCache.get(cacheKey);
  if (cached) {
    apolloLogger.info('Cache hit for company search', { companyName });
    return cached;
  }

  apolloLogger.info('Searching organization', { companyName });

  // Check rate limit
  const rateLimitKey = 'global';
  if (!apolloRateLimiter.isAllowed(rateLimitKey)) {
    apolloLogger.warn('Rate limit exceeded', { companyName, remaining: apolloRateLimiter.getRemainingRequests(rateLimitKey) });
    return null;
  }

  const requestBody = {
    q_organization_name: companyName,
    page: 1,
    per_page: 1,
  };

  const startTime = Date.now();

  try {
    const result = await apolloCircuitBreaker.execute(async () => {
      return await retryWithBackoff(async () => {
        const res = await fetch(`${APOLLO_BASE}/organizations/search`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            accept: 'application/json',
            'X-Api-Key': APOLLO_API_KEY,
            'Cache-Control': 'no-cache',
          },
          body: JSON.stringify(requestBody),
          signal: AbortSignal.timeout(timeoutMs),
        });

        if (res.status === 429) {
          const retryAfter = res.headers.get('retry-after') || '60';
          apolloLogger.warn('Rate limited', { retryAfter, companyName });
          throw { status: 429, message: 'Rate limited' };
        }

        if (!res.ok) {
          const text = await res.text().catch(() => '');
          apolloLogger.error('HTTP error', { status: res.status, error: text.slice(0, 500), companyName });
          throw { status: res.status, message: text };
        }

        const json = await res.json() as ApolloOrganizationSearchResponse;
        
        if (json.error_code || json.error) {
          apolloLogger.error('API error', { error_code: json.error_code, error: json.error, companyName });
          throw { status: 400, message: json.error || 'API error' };
        }

        return json;
      }, {
        maxAttempts: 3,
        initialDelayMs: 1000,
        maxDelayMs: 10000,
      });
    });

    const duration = Date.now() - startTime;
    trackApolloRequest(duration, true);
    apolloLogger.info('Search successful', { companyName, duration, resultCount: result.organizations?.length });

    // Cache the result
    apolloCache.set(cacheKey, result);

    return result;
  } catch (error) {
    const duration = Date.now() - startTime;
    trackApolloRequest(duration, false);
    apolloLogger.error('Search failed', { companyName, duration, error: (error as Error).message });
    return null;
  }
}

/**
 * Call Apollo's /organizations/enrich to get detailed company data.
 */
async function enrichOrganization(
  organizationId: string,
  timeoutMs = 15_000,
): Promise<ApolloOrganizationEnrichResponse | null> {
  if (!APOLLO_API_KEY || APOLLO_API_KEY.startsWith('your_')) {
    console.log('[apollo-company] No API key configured — skipping');
    return null;
  }

  console.log(`[apollo-company] /organizations/enrich → id="${organizationId}"`);

  const requestBody = {
    organization_id: organizationId,
    reveal_email_addresses: false,
  };
  console.log(`[apollo-company] Request body:`, JSON.stringify(requestBody, null, 2));

  try {
    const res = await fetch(`${APOLLO_BASE}/organizations/enrich`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        accept: 'application/json',
        'X-Api-Key': APOLLO_API_KEY,
        'Cache-Control': 'no-cache',
      },
      body: JSON.stringify(requestBody),
      signal: AbortSignal.timeout(timeoutMs),
    });

    console.log(`[apollo-company] Response status: ${res.status} ${res.statusText}`);

    if (res.status === 429) {
      const retryAfter = res.headers.get('retry-after') || '60';
      console.warn(`[apollo-company] Rate limited — retry-after=${retryAfter}s`);
      return null;
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      console.error(`[apollo-company] HTTP ${res.status}: ${text.slice(0, 500)}`);
      console.error(`[apollo-company] Full error response:`, text);
      return null;
    }

    const json = (await res.json()) as ApolloOrganizationEnrichResponse;
    console.log(`[apollo-company] Response body:`, JSON.stringify(json, null, 2));
    
    if (json.error_code || json.error) {
      console.error(`[apollo-company] API error: error_code=${json.error_code} error=${json.error}`);
      return null;
    }

    if (!json.organization) {
      console.error(`[apollo-company] No organization in response despite HTTP 200`);
      return null;
    }

    return json;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[apollo-company] Request failed: ${msg}`);
    if (err instanceof Error) console.error(`[apollo-company] Error stack:`, err.stack);
    return null;
  }
}

/**
 * Call Apollo's /organizations/bulk_enrich to enrich multiple companies at once.
 * Uses domains parameter as required by Apollo API.
 */
async function bulkEnrichOrganizations(
  domains: string[],
  timeoutMs = 30_000,
): Promise<ApolloBulkEnrichResponse | null> {
  if (!APOLLO_API_KEY || APOLLO_API_KEY.startsWith('your_')) {
    console.log('[apollo-company] No API key configured — skipping');
    return null;
  }

  if (domains.length === 0) {
    console.log('[apollo-company] No domains provided — skipping');
    return null;
  }

  console.log(`[apollo-company] /organizations/bulk_enrich → ${domains.length} domains: ${domains.join(', ')}`);

  try {
    const res = await fetch(`${APOLLO_BASE}/organizations/bulk_enrich`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        accept: 'application/json',
        'X-Api-Key': APOLLO_API_KEY,
        'Cache-Control': 'no-cache',
      },
      body: JSON.stringify({
        domains: domains,
        reveal_email_addresses: false,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });

    console.log(`[apollo-company] Response status: ${res.status} ${res.statusText}`);

    if (res.status === 429) {
      const retryAfter = res.headers.get('retry-after') || '60';
      console.warn(`[apollo-company] Rate limited — retry-after=${retryAfter}s`);
      return null;
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      console.error(`[apollo-company] HTTP ${res.status}: ${text.slice(0, 500)}`);
      console.error(`[apollo-company] Full error response:`, text);
      return null;
    }

    const json = (await res.json()) as ApolloBulkEnrichResponse;
    console.log(`[apollo-company] Response body:`, JSON.stringify(json, null, 2));
    
    if (json.error_code || json.error) {
      console.error(`[apollo-company] API error: error_code=${json.error_code} error=${json.error}`);
      return null;
    }

    return json;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[apollo-company] Request failed: ${msg}`);
    if (err instanceof Error) console.error(`[apollo-company] Error stack:`, err.stack);
    return null;
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Enrich a single lead's company using Apollo organizations APIs.
 * Only fills gaps — does not overwrite fields that already have values unless stale.
 */
export async function enrichCompanyForLead(
  lead: LeadWithCompanyData,
): Promise<ApolloCompanyEnrichResult> {
  const companyName = str(lead.company_name);
  
  // Skip if company name is missing
  if (!companyName) {
    return { 
      fields: {}, 
      confidence: 0, 
      source: 'apollo', 
      error: 'Company name missing — skipping' 
    };
  }

  // Check if enrichment is stale
  const metadata: CompanyEnrichmentMetadata = {
    company_enriched_at: lead.company_enriched_at,
    company_last_verified_at: lead.company_last_verified_at,
    company_enrichment_source: lead.company_enrichment_source,
  };

  if (!isCompanyEnrichmentStale(metadata)) {
    console.log(`[apollo-company] Company "${companyName}" enriched recently — skipping`);
    return { 
      fields: {}, 
      confidence: 0, 
      source: 'apollo', 
      error: 'Company enriched within last 90 days — skipping' 
    };
  }

  // Step 1: Search for the organization
  const searchResult = await searchOrganization(companyName);
  if (!searchResult?.organizations || searchResult.organizations.length === 0) {
    return { 
      fields: {}, 
      confidence: 0, 
      source: 'apollo', 
      error: 'No match found in Apollo' 
    };
  }

  const org = searchResult.organizations[0];
  const organizationId = str(org.id);
  const domain = str(org.website_url || org.primary_domain);
  const searchResultName = str(org.name);
  
  console.log(`[apollo-company] Search result: name="${searchResultName}" id="${organizationId}" domain="${domain}"`);
  
  if (!organizationId) {
    return { 
      fields: {}, 
      confidence: 0, 
      source: 'apollo', 
      error: 'No organization ID in search result' 
    };
  }

  // Step 2: Enrich the organization using bulk_enrich with domain (more reliable)
  if (!domain) {
    console.error(`[apollo-company] No domain found in search result for "${companyName}"`);
    return { 
      fields: {}, 
      confidence: 0, 
      source: 'apollo', 
      error: 'No domain found in search result' 
    };
  }

  // Validate that search result name matches expected company name
  const normalizedSearchName = searchResultName.toLowerCase().trim();
  const normalizedCompanyName = companyName.toLowerCase().trim();
  const nameMatch = normalizedSearchName.includes(normalizedCompanyName) || 
                    normalizedCompanyName.includes(normalizedSearchName) ||
                    normalizedSearchName === normalizedCompanyName;
  
  if (!nameMatch) {
    console.error(`[apollo-company] Company name mismatch: expected "${companyName}" but search returned "${searchResultName}"`);
    return { 
      fields: {}, 
      confidence: 0, 
      source: 'apollo', 
      error: `Company name mismatch: expected "${companyName}" but search returned "${searchResultName}"` 
    };
  }

  const enrichResult = await bulkEnrichOrganizations([domain]);
  if (!enrichResult?.organizations || enrichResult.organizations.length === 0) {
    console.error(`[apollo-company] bulk_enrich returned no organizations for domain="${domain}"`);
    return { 
      fields: {}, 
      confidence: 0, 
      source: 'apollo', 
      error: 'Failed to enrich organization (empty response)' 
    };
  }

  const enrichedOrg = enrichResult.organizations[0];
  const enrichedName = str(enrichedOrg.name);
  
  console.log(`[apollo-company] Enrich result: name="${enrichedName}" domain="${domain}"`);
  
  // Validate that enriched company name matches expected company name
  const normalizedEnrichedName = enrichedName.toLowerCase().trim();
  const enrichedNameMatch = normalizedEnrichedName.includes(normalizedCompanyName) || 
                          normalizedCompanyName.includes(normalizedEnrichedName) ||
                          normalizedEnrichedName === normalizedCompanyName;
  
  if (!enrichedNameMatch) {
    console.error(`[apollo-company] Company name mismatch after enrich: expected "${companyName}" but enrich returned "${enrichedName}"`);
    return { 
      fields: {}, 
      confidence: 0, 
      source: 'apollo', 
      error: `Company name mismatch after enrich: expected "${companyName}" but enrich returned "${enrichedName}"` 
    };
  }
  const fields: Partial<ApolloCompanyFields> = {};

  // Map Apollo fields to our fields
  if (enrichedOrg.name) fields.company_name = str(enrichedOrg.name);
  if (enrichedOrg.estimated_num_employees) fields.company_employee_size = mapEmployeeSize(enrichedOrg.estimated_num_employees);
  if (enrichedOrg.organization_revenue || enrichedOrg.organization_revenue_printed) {
    fields.company_revenue_size = mapRevenue(enrichedOrg.organization_revenue || enrichedOrg.organization_revenue_printed || '');
  }
  if (enrichedOrg.industry) fields.company_industry = str(enrichedOrg.industry);
  if (enrichedOrg.website_url || enrichedOrg.primary_domain) {
    fields.company_website = str(enrichedOrg.website_url || enrichedOrg.primary_domain);
  }
  if (enrichedOrg.city) fields.company_city = str(enrichedOrg.city);
  if (enrichedOrg.state) fields.company_state = str(enrichedOrg.state);
  if (enrichedOrg.country) fields.company_country = str(enrichedOrg.country);

  // Calculate confidence
  const filledCount = Object.keys(fields).length;
  const maxFields = COMPANY_FIELDS_TO_ENRICH.length;
  const confidence = Math.min(1, filledCount / maxFields);

  const enrichedAt = new Date().toISOString();

  console.log(
    `[apollo-company] ✅ company="${companyName}" → filled ${filledCount} fields (confidence=${(confidence * 100).toFixed(0)}%)`,
  );

  return {
    fields,
    confidence,
    source: 'apollo',
    apolloOrganizationId: organizationId,
    enrichedAt,
  };
}

/**
 * Merge company enrichment results into a lead, comparing every field and updating only those that differ.
 */
export function mergeCompanyEnrichmentIntoLead(
  lead: LeadWithCompanyData,
  enrichedFields: Partial<ApolloCompanyFields>,
  enrichedAt: string,
): { updated: LeadWithCompanyData; changedFields: string[] } {
  const updated = { ...lead };
  const changedFields: string[] = [];

  for (const [key, value] of Object.entries(enrichedFields)) {
    if (!value || typeof value !== 'string') continue;
    
    const existing = lead[key as keyof LeadWithCompanyData];
    const existingStr = str(existing);
    
    // Compare fields: update if missing, empty, or differs from Apollo
    if (!existingStr || existingStr !== value) {
      (updated as Record<string, unknown>)[key] = value;
      changedFields.push(key);
      console.log(`[apollo-company] Field "${key}": "${existingStr}" → "${value}"`);
    }
  }

  // Add enrichment metadata
  updated.company_enriched_at = enrichedAt;
  updated.company_last_verified_at = enrichedAt;
  updated.company_enrichment_source = 'apollo';
  if (!changedFields.includes('company_enriched_at')) changedFields.push('company_enriched_at');
  if (!changedFields.includes('company_last_verified_at')) changedFields.push('company_last_verified_at');
  if (!changedFields.includes('company_enrichment_source')) changedFields.push('company_enrichment_source');

  return { updated, changedFields };
}

/**
 * Batch enrich companies for multiple leads.
 * Optimizes by deduplicating companies and calling bulk_enrich once per unique company.
 */
export async function batchEnrichCompaniesForLeads(
  leads: LeadWithCompanyData[],
): Promise<Map<number, ApolloCompanyEnrichResult>> {
  const results = new Map<number, ApolloCompanyEnrichResult>();

  // Group leads by company name
  const companyToLeads = new Map<string, LeadWithCompanyData[]>();
  for (const lead of leads) {
    const companyName = str(lead.company_name);
    if (!companyName) {
      results.set(lead.id, {
        fields: {},
        confidence: 0,
        source: 'apollo',
        error: 'Company name missing — skipping',
      });
      continue;
    }
    
    if (!companyToLeads.has(companyName)) {
      companyToLeads.set(companyName, []);
    }
    companyToLeads.get(companyName)!.push(lead);
  }

  // For each unique company, search and enrich
  for (const [companyName, companyLeads] of companyToLeads.entries()) {
    // Check staleness for the first lead (they should all have similar enrichment status)
    const firstLead = companyLeads[0];
    const metadata: CompanyEnrichmentMetadata = {
      company_enriched_at: firstLead.company_enriched_at,
      company_last_verified_at: firstLead.company_last_verified_at,
      company_enrichment_source: firstLead.company_enrichment_source,
    };

    if (!isCompanyEnrichmentStale(metadata)) {
      console.log(`[apollo-company] Company "${companyName}" enriched recently — skipping batch`);
      for (const lead of companyLeads) {
        results.set(lead.id, {
          fields: {},
          confidence: 0,
          source: 'apollo',
          error: 'Company enriched within last 90 days — skipping',
        });
      }
      continue;
    }

    // Search for the organization
    const searchResult = await searchOrganization(companyName);
    if (!searchResult?.organizations || searchResult.organizations.length === 0) {
      for (const lead of companyLeads) {
        results.set(lead.id, {
          fields: {},
          confidence: 0,
          source: 'apollo',
          error: 'No match found in Apollo',
        });
      }
      continue;
    }

    const org = searchResult.organizations[0];
    const organizationId = str(org.id);
    
    if (!organizationId) {
      for (const lead of companyLeads) {
        results.set(lead.id, {
          fields: {},
          confidence: 0,
          source: 'apollo',
          error: 'No organization ID in search result',
        });
      }
      continue;
    }

    // Enrich the organization
    const enrichResult = await enrichOrganization(organizationId);
    if (!enrichResult?.organization) {
      for (const lead of companyLeads) {
        results.set(lead.id, {
          fields: {},
          confidence: 0,
          source: 'apollo',
          error: 'Failed to enrich organization',
        });
      }
      continue;
    }

    // Map enriched data to fields
    const enrichedOrg = enrichResult.organization;
    const fields: Partial<ApolloCompanyFields> = {};

    if (enrichedOrg.name) fields.company_name = str(enrichedOrg.name);
    if (enrichedOrg.employee_count) fields.company_employee_size = mapEmployeeSize(enrichedOrg.employee_count);
    if (enrichedOrg.estimated_annual_revenue || enrichedOrg.annual_revenue_printed) {
      fields.company_revenue_size = mapRevenue(enrichedOrg.estimated_annual_revenue || enrichedOrg.annual_revenue_printed || '');
    }
    if (enrichedOrg.industry) fields.company_industry = str(enrichedOrg.industry);
    if (enrichedOrg.website_url || enrichedOrg.primary_domain) {
      fields.company_website = str(enrichedOrg.website_url || enrichedOrg.primary_domain);
    }
    if (enrichedOrg.city) fields.company_city = str(enrichedOrg.city);
    if (enrichedOrg.state) fields.company_state = str(enrichedOrg.state);
    if (enrichedOrg.country) fields.company_country = str(enrichedOrg.country);

    // Calculate confidence
    const filledCount = Object.keys(fields).length;
    const maxFields = COMPANY_FIELDS_TO_ENRICH.length;
    const confidence = Math.min(1, filledCount / maxFields);
    const enrichedAt = new Date().toISOString();

    console.log(
      `[apollo-company] ✅ batch company="${companyName}" → ${companyLeads.length} leads, filled ${filledCount} fields`,
    );

    // Apply the same enrichment result to all leads with this company
    for (const lead of companyLeads) {
      results.set(lead.id, {
        fields,
        confidence,
        source: 'apollo',
        apolloOrganizationId: organizationId,
        enrichedAt,
      });
    }
  }

  return results;
}

/** True if APOLLO_API_KEY is set and not a placeholder. */
export function isApolloConfigured(): boolean {
  return !!(APOLLO_API_KEY && !APOLLO_API_KEY.startsWith('your_'));
}
