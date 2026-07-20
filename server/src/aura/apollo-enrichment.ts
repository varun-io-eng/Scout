/**
 * apollo-enrichment.ts
 *
 * Apollo.io free-tier enrichment — used as a waterfall fallback when
 * our own Aura CRM data + LinkedIn scrape still has gaps in required fields.
 *
 * Endpoint: POST https://api.apollo.io/api/v1/people/match
 * Auth:     X-Api-Key header  (set APOLLO_API_KEY in server/.env)
 *
 * Apollo free plan: ~50 enrichment credits/month.
 * We only call this when Aura + LinkedIn scrape leave gaps, so credit usage
 * stays minimal at 100 leads/day.
 */

import type { CampaignLead } from './types.js';
import { inferJobFunction, inferJobLevel } from './voyager-linkedin.js';

const APOLLO_API_KEY = process.env.APOLLO_API_KEY ?? '';
const APOLLO_BASE = 'https://api.apollo.io/api/v1';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ApolloEnrichResult {
  /** Field values we can use to fill gaps. Only keys with non-empty values. */
  fields: Partial<ApolloLeadFields>;
  /** 0–1 confidence estimate based on how much Apollo returned. */
  confidence: number;
  source: 'apollo';
  apolloPersonId?: string;
  error?: string;
}

export interface ApolloLeadFields {
  first_name: string;
  last_name: string;
  job_title: string;
  job_level: string;
  job_function: string;
  company_name: string;
  company_city: string;
  company_state: string;
  company_country: string;
  company_revenue_size: string;
  company_employee_size: string;
  linkedin_url: string;
}

/** The 10 fields Scout needs to mark a lead READY. */
export const REQUIRED_LEAD_FIELDS: (keyof ApolloLeadFields)[] = [
  'first_name',
  'last_name',
  'job_title',
  'job_level',
  'job_function',
  'company_name',
  'company_revenue_size',
  'company_city',
  'company_state',
  'company_country',
];

// ── Helpers ───────────────────────────────────────────────────────────────────

function str(v: unknown): string {
  return v == null ? '' : String(v).trim();
}

/**
 * Map Apollo seniority string → our job_level values.
 * Apollo returns: owner, founder, c_suite, partner, vp, head,
 *   director, manager, senior, entry, intern
 */
function mapSeniority(seniority: string): string {
  const s = seniority.toLowerCase().replace(/_/g, ' ');
  if (/c.?suite|c.?level/.test(s)) return 'C-Level';
  if (/founder|owner/.test(s)) return 'Founder / Owner';
  if (/partner/.test(s)) return 'Partner';
  if (/^vp|vice president/.test(s)) return 'VP';
  if (/^head/.test(s)) return 'Director';
  if (/^director/.test(s)) return 'Director';
  if (/^manager/.test(s)) return 'Manager';
  if (/^senior|sr\.?$/.test(s)) return 'Senior IC';
  if (/^entry|associate|junior/.test(s)) return 'Junior IC';
  if (/^intern/.test(s)) return 'Intern';
  return 'Individual Contributor';
}

/**
 * Map Apollo departments array → our job_function values.
 * Apollo departments: engineering, finance, human_resources, information_technology,
 *   legal, marketing, master_engineering_hardware, master_engineering_software,
 *   medical_health, operations, real_estate, sales, support
 */
function mapDepartment(dept: string): string {
  const d = dept.toLowerCase().replace(/_/g, ' ');
  if (/engineering|software|hardware|technical/.test(d)) return 'Engineering';
  if (/sales|business development/.test(d)) return 'Sales';
  if (/marketing/.test(d)) return 'Marketing';
  if (/finance|accounting/.test(d)) return 'Finance';
  if (/human resource|hr|people|talent|recruiting/.test(d)) return 'Human Resources';
  if (/information technology|it |infrastructure/.test(d)) return 'IT';
  if (/legal|compliance/.test(d)) return 'Legal';
  if (/operations|ops/.test(d)) return 'Operations';
  if (/support|customer success/.test(d)) return 'Customer Success';
  if (/product/.test(d)) return 'Product Management';
  if (/design|creative/.test(d)) return 'Design';
  if (/data|analytics/.test(d)) return 'Analytics';
  if (/medical|health/.test(d)) return 'Healthcare';
  if (/real estate/.test(d)) return 'Real Estate';
  return dept.split('_').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

/**
 * Convert Apollo annual_revenue_printed / estimated_annual_revenue values
 * into a standardised Aura company_revenue_size string.
 * Apollo may give "$1M to $10M", "<$1M", ">$1B", or a raw numeric.
 */
function mapRevenue(printed: string, numeric?: number): string {
  // Prefer the human-readable string Apollo already provides
  if (printed) {
    const p = String(printed).trim();
    // Normalise common formats Apollo uses
    if (/less\s*than\s*\$?1\s*m/i.test(p)) return '<$1M';
    if (/\$?1\s*m\s*(to|-)\s*\$?10\s*m/i.test(p)) return '$1M–$10M';
    if (/\$?10\s*m\s*(to|-)\s*\$?50\s*m/i.test(p)) return '$10M–$50M';
    if (/\$?50\s*m\s*(to|-)\s*\$?100\s*m/i.test(p)) return '$50M–$100M';
    if (/\$?100\s*m\s*(to|-)\s*\$?250\s*m/i.test(p)) return '$100M–$250M';
    if (/\$?250\s*m\s*(to|-)\s*\$?500\s*m/i.test(p)) return '$250M–$500M';
    if (/\$?500\s*m\s*(to|-)\s*\$?1\s*b/i.test(p)) return '$500M–$1B';
    if (/>\s*\$?1\s*b|over\s*\$?1\s*b|>\s*1\s*billion/i.test(p)) return '>$1B';
    // If Apollo string is already reasonable, pass it through
    if (p.length > 0 && p.length < 40) return p;
  }
  // Fallback: bucket from numeric
  if (typeof numeric === 'number' && numeric > 0) {
    const m = numeric / 1_000_000;
    if (m < 1) return '<$1M';
    if (m < 10) return '$1M–$10M';
    if (m < 50) return '$10M–$50M';
    if (m < 100) return '$50M–$100M';
    if (m < 250) return '$100M–$250M';
    if (m < 500) return '$250M–$500M';
    if (m < 1000) return '$500M–$1B';
    return '>$1B';
  }
  return '';
}

/**
 * Map Apollo estimated_num_employees to a size-bucket string.
 * Apollo returns values like 1, 10, 50, 100, 200, 500, 1000, 5000, 10000, 20000, …
 * or a raw integer.
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

// ── Core Apollo call ──────────────────────────────────────────────────────────

interface ApolloPersonResponse {
  person?: {
    id?: string;
    first_name?: string;
    last_name?: string;
    name?: string;
    title?: string;
    seniority?: string;
    departments?: string[];
    city?: string;
    state?: string;
    country?: string;
    linkedin_url?: string;
    organization?: {
      name?: string;
      city?: string;
      state?: string;
      country?: string;
      estimated_num_employees?: number | string;
      annual_revenue_printed?: string;
      estimated_annual_revenue?: number;
      primary_domain?: string;
    };
  };
  error_code?: string;
  error?: string;
}

/**
 * Call Apollo's /v1/people/match with whatever identifiers we have.
 * Returns null if Apollo is not configured or the call fails fatally.
 */
async function callApollo(
  params: {
    first_name?: string;
    last_name?: string;
    name?: string;
    organization_name?: string;
    linkedin_url?: string;
    domain?: string;
  },
  timeoutMs = 15_000,
): Promise<ApolloPersonResponse | null> {
  if (!APOLLO_API_KEY || APOLLO_API_KEY.startsWith('your_')) {
    console.log('[apollo] No API key configured — skipping Apollo enrichment');
    return null;
  }

  const body: Record<string, unknown> = { ...params };
  // Apollo requires at least linkedin_url OR (name + organization_name/domain)
  const hasLinkedin = !!params.linkedin_url;
  const hasName = !!(params.first_name || params.name);
  const hasOrg = !!(params.organization_name || params.domain);

  if (!hasLinkedin && !(hasName && hasOrg)) {
    console.log('[apollo] Insufficient identifiers for match — skipping');
    return null;
  }

  console.log(
    `[apollo] /people/match → name="${params.first_name ?? params.name}" org="${params.organization_name}" li="${params.linkedin_url}"`,
  );

  try {
    const res = await fetch(`${APOLLO_BASE}/people/match`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        accept: 'application/json',
        'X-Api-Key': APOLLO_API_KEY,
        'Cache-Control': 'no-cache',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (res.status === 429) {
      const retryAfter = res.headers.get('retry-after') || '60';
      console.warn(`[apollo] Rate limited — retry-after=${retryAfter}s. Skipping Apollo for this lead.`);
      return null;
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      console.warn(`[apollo] HTTP ${res.status}: ${text.slice(0, 200)}`);
      return null;
    }

    const json = (await res.json()) as ApolloPersonResponse;
    if (json.error_code || json.error) {
      console.warn(`[apollo] API error: ${json.error_code} — ${json.error}`);
      return null;
    }

    return json;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Timeout or network failure — not fatal
    console.warn(`[apollo] Request failed: ${msg}`);
    return null;
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Enrich a lead using Apollo.io's /v1/people/match endpoint.
 * Only fills gaps — does not overwrite fields that already have values.
 */
export async function enrichLeadWithApollo(lead: CampaignLead): Promise<ApolloEnrichResult> {
  const firstName = str(lead.first_name);
  const lastName = str(lead.last_name);
  const fullName = `${firstName} ${lastName}`.trim();
  const companyName = str(lead.company_name);
  const linkedinUrl = str(lead.linkedin_url);

  const apolloRes = await callApollo({
    first_name: firstName || undefined,
    last_name: lastName || undefined,
    name: fullName || undefined,
    organization_name: companyName || undefined,
    linkedin_url: linkedinUrl || undefined,
  });

  if (!apolloRes?.person) {
    return { fields: {}, confidence: 0, source: 'apollo', error: 'No match found in Apollo' };
  }

  const p = apolloRes.person;
  const org = p.organization ?? {};
  const fields: Partial<ApolloLeadFields> = {};

  // ── Person fields ────────────────────────────────────────────────────────
  const apoFirstName = str(p.first_name);
  const apoLastName = str(p.last_name);
  if (apoFirstName) fields.first_name = apoFirstName;
  if (apoLastName) fields.last_name = apoLastName;

  // Job title
  const apoTitle = str(p.title);
  if (apoTitle) fields.job_title = apoTitle;

  // Job level — from seniority, then fall back to inferring from title
  const apoSeniority = str(p.seniority);
  if (apoSeniority) {
    fields.job_level = mapSeniority(apoSeniority);
  } else if (apoTitle) {
    const inferred = inferJobLevel(apoTitle);
    if (inferred) fields.job_level = inferred;
  }

  // Job function — from departments, then fall back to inferring from title
  const apoDepts = Array.isArray(p.departments) ? p.departments : [];
  if (apoDepts.length > 0) {
    fields.job_function = mapDepartment(apoDepts[0]);
  } else if (apoTitle) {
    const inferred = inferJobFunction(apoTitle, '');
    if (inferred) fields.job_function = inferred;
  }

  // LinkedIn URL
  const apoLinkedin = str(p.linkedin_url);
  if (apoLinkedin) fields.linkedin_url = apoLinkedin;

  // ── Company fields ───────────────────────────────────────────────────────
  const apoCompany = str(org.name);
  if (apoCompany) fields.company_name = apoCompany;

  // Location — prefer org-level, then person-level
  const city = str(org.city) || str(p.city);
  const state = str(org.state) || str(p.state);
  const country = str(org.country) || str(p.country);
  if (city) fields.company_city = city;
  if (state) fields.company_state = state;
  if (country) fields.company_country = country;

  // Revenue size
  const revPrinted = str(org.annual_revenue_printed);
  const revNumeric = typeof org.estimated_annual_revenue === 'number'
    ? org.estimated_annual_revenue
    : undefined;
  const revSize = mapRevenue(revPrinted, revNumeric);
  if (revSize) fields.company_revenue_size = revSize;

  // Employee size
  const empCount = org.estimated_num_employees;
  if (empCount != null) {
    const empSize = mapEmployeeSize(empCount);
    if (empSize) fields.company_employee_size = empSize;
  }

  // ── Confidence ───────────────────────────────────────────────────────────
  const filledCount = Object.keys(fields).length;
  const maxFields = REQUIRED_LEAD_FIELDS.length;
  const confidence = Math.min(1, filledCount / maxFields);

  console.log(
    `[apollo] ✅ lead="${fullName}" → filled ${filledCount} fields (confidence=${(confidence * 100).toFixed(0)}%)`,
  );

  return {
    fields,
    confidence,
    source: 'apollo',
    apolloPersonId: str(p.id) || undefined,
  };
}

/** True if APOLLO_API_KEY is set and not a placeholder. */
export function isApolloConfigured(): boolean {
  return !!(APOLLO_API_KEY && !APOLLO_API_KEY.startsWith('your_'));
}

// ── Field completeness utilities ──────────────────────────────────────────────

/** Return list of required fields that are blank/missing on this lead. */
export function getMissingRequiredFields(lead: CampaignLead): (keyof ApolloLeadFields)[] {
  return REQUIRED_LEAD_FIELDS.filter((field) => {
    const val = lead[field as keyof CampaignLead];
    return !val || String(val).trim() === '';
  });
}

/** Return true if all required fields are populated. */
export function isLeadComplete(lead: CampaignLead): boolean {
  return getMissingRequiredFields(lead).length === 0;
}

/**
 * Merge enrichment results into a lead object, only filling blank fields.
 * Returns the updated lead and which fields were changed.
 */
export function mergeEnrichmentIntoLead(
  lead: CampaignLead,
  enrichedFields: Partial<ApolloLeadFields>,
): { updated: CampaignLead; changedFields: string[] } {
  const updated = { ...lead };
  const changedFields: string[] = [];

  for (const [key, value] of Object.entries(enrichedFields)) {
    if (!value || typeof value !== 'string') continue;
    const existing = lead[key as keyof CampaignLead];
    if (existing && String(existing).trim() !== '') continue; // Don't overwrite
    (updated as Record<string, unknown>)[key] = value;
    changedFields.push(key);
  }

  return { updated, changedFields };
}
