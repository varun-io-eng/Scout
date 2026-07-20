/**
 * Enrichment API helpers for the Scout Operator Dashboard.
 * Connects to the Scout server (running at /api) to scrape LinkedIn
 * and apply edits to Aura.
 */

export interface Company {
  id: string;
  name: string;
  domain?: string;
  industry?: string;
  description?: string;
  location?: string;
  employeeCount?: string;
  funding?: string;
  technologies: string[];
  competitors: Array<{ name: string; reason: string; confidence: number }>;
  investmentInsights: string[];
  hiringInsights: string[];
  sources: Array<{ url: string; title: string; sourceType: string; capturedAt: string }>;
  createdAt: string;
  updatedAt: string;
}

export interface AskResult {
  answer: string;
  sources: Array<{ url: string; title: string; snippet: string }>;
  companies: string[];
}

export interface AuraConfig {
  datahubBaseUrl: string;
  authToken: string;
}

export interface LeadFields {
  id: number;
  first_name?: string;
  last_name?: string;
  job_title?: string;
  company_name?: string;
  linkedin_url?: string;
  job_function?: string;
  job_level?: string;
  company_city?: string;
  company_state?: string;
  company_country?: string;
  company_revenue_size?: string;
  company_employee_size?: string;
  [key: string]: unknown;
}

export interface ScrapedLinkedIn {
  personName: string;
  headline: string;
  currentTitle: string;
  currentCompany: string;
  about?: string;
  location: { city: string; state: string; country: string };
  jobFunction: string;
  jobLevel: string;
  experienceText?: string;
  loggedIn: boolean;
  error?: string | null;
}

export interface EnrichmentResult {
  leadId: number;
  linkedinUrl: string;
  provider: string;
  scraped: ScrapedLinkedIn;
  suggestedEdits: Record<string, string>;
  currentValues: Record<string, string>;
}

const API = '/api';

export async function fetchCompanies(): Promise<Company[]> {
  const res = await fetch(`${API}/companies`);
  if (!res.ok) throw new Error('Failed to load companies');
  return res.json();
}

export async function askQuestion(question: string): Promise<AskResult> {
  const res = await fetch(`${API}/ask`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question }),
  });
  if (!res.ok) throw new Error('Query failed');
  return res.json();
}

export async function searchKnowledge(q: string): Promise<{ companies: Company[] }> {
  const res = await fetch(`${API}/search?q=${encodeURIComponent(q)}`);
  if (!res.ok) throw new Error('Search failed');
  return res.json();
}

/** Scrape a lead's LinkedIn profile and get suggested field edits. */
export async function scrapeLinkedIn(
  lead: LeadFields,
  campaignId?: number,
): Promise<EnrichmentResult> {
  const res = await fetch(`${API}/leads/scrape-linkedin`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ campaignId, lead }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'LinkedIn scrape failed');
  return data as EnrichmentResult;
}

/** Apply operator-confirmed field edits to Aura. */
export async function applyLinkedInEdits(
  campaignId: number,
  leadId: number,
  edits: Record<string, string>,
  aura: AuraConfig,
): Promise<{ ok: boolean; updatedFields: string[] }> {
  const res = await fetch(`${API}/leads/apply-linkedin-edits`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ campaignId, leadId, edits, aura }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Apply edits failed');
  return data;
}
