import type { AuraConfig, CampaignLead } from './types.js';

function authHeaders(token: string): Record<string, string> {
  return {
    accept: 'application/json',
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
  };
}

function baseUrl(config: AuraConfig): string {
  return config.datahubBaseUrl.replace(/\/$/, '');
}

async function request<T>(
  config: AuraConfig,
  path: string,
  init?: RequestInit,
): Promise<T> {
  const url = `${baseUrl(config)}${path}`;
  let res;
  try {
    res = await fetch(url, {
      ...init,
      headers: {
        ...authHeaders(config.authToken),
        ...(init?.headers as Record<string, string> | undefined),
      },
    });
  } catch {
    throw new Error(
      `Cannot reach Datahub at ${baseUrl(config)}. Check your network or DATAHUB_BASE_URL in Scout server .env.`,
    );
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg =
      (json as { message?: string; error?: string }).message ||
      (json as { message?: string; error?: string }).error ||
      `Datahub error ${res.status}`;
    throw new Error(typeof msg === 'string' ? msg : 'Datahub request failed');
  }
  return json as T;
}

function parseLeadRow(row: unknown): CampaignLead | null {
  if (!row || typeof row !== 'object') return null;
  const o = row as Record<string, unknown>;
  const id = Number(o.id ?? o.lead_id);
  if (!Number.isFinite(id) || id <= 0) return null;
  return { ...o, id } as CampaignLead;
}

function parseLeadsList(json: unknown): CampaignLead[] {
  if (Array.isArray(json)) {
    return json.map(parseLeadRow).filter((r): r is CampaignLead => r != null);
  }
  if (json && typeof json === 'object') {
    const o = json as Record<string, unknown>;
    for (const key of ['data', 'items', 'results', 'leads', 'contacts']) {
      const arr = o[key];
      if (Array.isArray(arr)) {
        return arr.map(parseLeadRow).filter((r): r is CampaignLead => r != null);
      }
    }
  }
  return [];
}

export async function listCampaignLeads(
  config: AuraConfig,
  campaignId: number,
  params?: { stage?: string; limit?: number; offset?: number },
): Promise<CampaignLead[]> {
  const search = new URLSearchParams();
  if (params?.stage) search.set('stage', params.stage);
  if (params?.limit != null) search.set('limit', String(params.limit));
  if (params?.offset != null) search.set('offset', String(params.offset));
  const qs = search.toString();
  const json = await request<unknown>(
    config,
    `/api/campaigns/${campaignId}/leads${qs ? `?${qs}` : ''}`,
    { method: 'GET' },
  );
  return parseLeadsList(json);
}

export async function getCampaignIcp(
  config: AuraConfig,
  campaignId: number,
): Promise<Record<string, unknown> | null> {
  const json = await request<unknown>(config, `/api/campaigns/${campaignId}/icp`, {
    method: 'GET',
  });

  if (!json || typeof json !== 'object') return null;
  const root = json as Record<string, unknown>;

  if (root.icp && typeof root.icp === 'object' && !Array.isArray(root.icp)) {
    return root.icp as Record<string, unknown>;
  }

  const data = root.data;
  if (Array.isArray(data) && data.length) {
    const first = data[0];
    if (first && typeof first === 'object' && !Array.isArray(first)) {
      const icp = (first as Record<string, unknown>).icp;
      if (icp && typeof icp === 'object' && !Array.isArray(icp)) {
        return icp as Record<string, unknown>;
      }
    }
  }

  return null;
}

/** Full campaign ICP API response for LLM context. */
export async function getCampaignIcpEnvelope(
  config: AuraConfig,
  campaignId: number,
): Promise<Record<string, unknown>> {
  const json = await request<unknown>(config, `/api/campaigns/${campaignId}/icp`, {
    method: 'GET',
  });
  if (json && typeof json === 'object' && !Array.isArray(json)) {
    return json as Record<string, unknown>;
  }
  return {};
}

export interface UpdateLeadPayload {
  campaign_id: number;
  first_name?: string;
  last_name?: string;
  job_title?: string;
  company_name?: string;
  linkedin_url?: string;
  linkedin_headline?: string;
  linkedin_industry?: string;
  linkedin_summary?: string;
  icp_messages?: string;
  lead_icp_status?: string;
  stage?: string;
  industry?: string;
  job_level?: string;
  job_function?: string;
  company_city?: string;
  company_state?: string;
  company_country?: string;
  company_revenue_size?: string;
  company_employee_size?: string;
}


export async function updateCampaignLead(
  config: AuraConfig,
  leadId: number,
  payload: UpdateLeadPayload,
): Promise<Record<string, unknown>> {
  return request<Record<string, unknown>>(config, `/api/leads/${leadId}`, {
    method: 'PUT',
    body: JSON.stringify(payload),
  });
}

/** DELETE /api/campaigns/{campaign_id}/leads — body `{ lead_ids }` */
export async function deleteCampaignLeads(
  config: AuraConfig,
  campaignId: number,
  leadIds: number[],
): Promise<{ deleted?: number; status?: string }> {
  const lead_ids = [...new Set(leadIds.map(Number).filter((id) => Number.isFinite(id) && id > 0))];
  if (!lead_ids.length) return { deleted: 0 };
  return request<{ deleted?: number; status?: string }>(
    config,
    `/api/campaigns/${campaignId}/leads`,
    {
      method: 'DELETE',
      body: JSON.stringify({ lead_ids }),
    },
  );
}

/** POST /api/leads/add — body `{ campaign_id, people_ids }` (restore path) */
export async function assignPeopleToCampaign(
  config: AuraConfig,
  campaignId: number,
  peopleIds: string[],
): Promise<unknown> {
  const people_ids = [...new Set(peopleIds.map((id) => String(id).trim()).filter(Boolean))];
  if (!people_ids.length) throw new Error('At least one people_id is required to restore');
  return request<unknown>(config, `/api/leads/add`, {
    method: 'POST',
    body: JSON.stringify({ campaign_id: campaignId, people_ids }),
  });
}

/** Official Datahub enrich — best-effort; callers should ignore failures. */
export async function enrichCampaignLead(
  config: AuraConfig,
  leadId: number,
): Promise<Record<string, unknown> | null> {
  try {
    return await request<Record<string, unknown>>(config, `/api/leads/${leadId}/enrich`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
  } catch (err) {
    console.warn(
      `[aura-client] enrich lead=${leadId} skipped:`,
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

/** Re-fetch a single lead row from the campaign list (includes extras / icp_messages). */
export async function findCampaignLead(
  config: AuraConfig,
  campaignId: number,
  leadId: number,
): Promise<CampaignLead | null> {
  const leads = await listCampaignLeads(config, campaignId, { limit: 500 });
  return leads.find((lead) => lead.id === leadId) ?? null;
}

export interface OrganisationDetail {
  entity_id?: string;
  company_name?: string;
  website?: string;
  domain?: string;
  linkedin_url?: string;
  industry_linkedin?: string;
  employee_count_range?: string;
  revenue_range?: string;
  revenue_min?: string | number;
  revenue_max?: string | number;
  headquarters_location?: string;
  about_us?: string;
  [key: string]: unknown;
}

/** GET /api/organisations/{entity_id} — same org profile Aura Edit → Organisation shows */
export async function fetchOrganisationById(
  config: AuraConfig,
  entityId: string,
): Promise<OrganisationDetail | null> {
  const id = String(entityId || '').trim();
  if (!id) return null;
  try {
    const json = await request<{ data?: OrganisationDetail[] }>(
      config,
      `/api/organisations/${encodeURIComponent(id)}`,
      { method: 'GET' },
    );
    const detail = Array.isArray(json?.data) ? json.data[0] : null;
    return detail || null;
  } catch (err) {
    console.warn(
      `[aura-client] org fetch entity=${id} skipped:`,
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

export function leadOrgEntityId(lead: CampaignLead): string | null {
  const extras = lead.extras as Record<string, unknown> | undefined;
  const candidates = [
    lead.org_entity_id,
    lead.organisation_entity_id,
    extras?.org_entity_id,
    extras?.organisation_entity_id,
  ];
  for (const c of candidates) {
    if (c != null && String(c).trim()) return String(c).trim();
  }
  return null;
}

export function organisationWebsite(org: OrganisationDetail | null | undefined): string | null {
  if (!org) return null;
  const raw = String(org.website || org.domain || '').trim();
  if (!raw) return null;
  if (/^https?:\/\//i.test(raw)) return raw;
  return `https://${raw.replace(/^\/+/, '')}`;
}

export function leadDisplayName(lead: CampaignLead): string {
  const first = String(lead.first_name ?? '').trim();
  const last = String(lead.last_name ?? '').trim();
  const full = `${first} ${last}`.trim();
  return full || `Lead #${lead.id}`;
}

export function normalizeLinkedInUrl(raw: string | undefined): string | null {
  const t = String(raw ?? '').trim();
  if (!t || t === '—') return null;
  if (t.startsWith('http://') || t.startsWith('https://')) return t;
  return `https://${t}`;
}

/** Canonical /in/ slug for matching CRM URLs to open LinkedIn tabs. */
export function linkedInProfileSlug(raw: string | undefined | null): string | null {
  const t = String(raw ?? '').trim();
  if (!t || t === '—') return null;
  try {
    const withProto = /^https?:\/\//i.test(t) ? t : `https://${t.replace(/^\/+/, '')}`;
    const u = new URL(withProto);
    if (!/linkedin\.com$/i.test(u.hostname) && !/\.linkedin\.com$/i.test(u.hostname)) {
      // bare path like linkedin.com/in/foo or /in/foo
      const m = t.match(/\/in\/([^/?#]+)/i);
      return m?.[1] ? decodeURIComponent(m[1]).toLowerCase().replace(/\/+$/, '') : null;
    }
    const m = u.pathname.match(/\/in\/([^/]+)/i);
    if (!m?.[1]) return null;
    return decodeURIComponent(m[1]).toLowerCase().replace(/\/+$/, '');
  } catch {
    const m = t.match(/\/in\/([^/?#]+)/i) || t.match(/(?:^|[^\w])in\/([^/?#]+)/i);
    return m?.[1] ? decodeURIComponent(m[1]).toLowerCase().replace(/\/+$/, '') : null;
  }
}

export function namesLooselyMatch(a: string, b: string): boolean {
  const norm = (s: string) =>
    String(s || '')
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  const left = norm(a);
  const right = norm(b);
  if (!left || !right) return false;
  if (left === right) return true;
  if (left.includes(right) || right.includes(left)) return true;
  const la = left.split(' ').filter((w) => w.length > 1);
  const ra = right.split(' ').filter((w) => w.length > 1);
  if (!la.length || !ra.length) return false;
  const overlap = la.filter((w) => ra.includes(w));
  return overlap.length >= Math.min(2, la.length, ra.length);
}
