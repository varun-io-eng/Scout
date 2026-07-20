import type { IcpFieldEntry, IcpMessagesDoc } from './types.js';

const OVERRIDE_FORM_FIELDS = ['job_title', 'company_name'] as const;
export type IcpOverrideField = (typeof OVERRIDE_FORM_FIELDS)[number];

const FORM_TO_ICP_FIELD: Record<IcpOverrideField, string> = {
  job_title: 'job_title',
  company_name: 'company_name',
};

function normalizeFieldKey(name: string): string {
  return name.trim().toLowerCase().replace(/[\s-]+/g, '_');
}

function fieldKeysMatch(left: string, right: string): boolean {
  return normalizeFieldKey(left) === normalizeFieldKey(right);
}

export function parseIcpMessages(raw: unknown): IcpMessagesDoc | null {
  if (!raw) return null;
  let doc: IcpMessagesDoc | null = null;
  if (typeof raw === 'object' && !Array.isArray(raw)) {
    doc = raw as IcpMessagesDoc;
  } else if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        doc = parsed as IcpMessagesDoc;
      }
    } catch {
      return null;
    }
  }
  return doc;
}

export function isFieldOverridden(entry: IcpFieldEntry): boolean {
  const overridden = entry.over_ridden ?? (entry as Record<string, unknown>).overridden;
  return overridden === true || overridden === 'true' || overridden === 'TRUE';
}

export function getInvalidFields(icpDoc: IcpMessagesDoc | null): string[] {
  if (!icpDoc?.fields?.length) return [];
  return icpDoc.fields
    .filter((f) => {
      const status = typeof f.status === 'string' ? f.status.trim().toUpperCase() : '';
      return status === 'INVALID' && !isFieldOverridden(f);
    })
    .map((f) => String(f.field ?? ''))
    .filter(Boolean);
}

export function applyFieldOverride(icpDoc: IcpMessagesDoc, icpFieldName: string): IcpMessagesDoc {
  const fields = Array.isArray(icpDoc.fields) ? [...icpDoc.fields] : [];
  let found = false;
  const nextFields = fields.map((entry) => {
    if (!entry?.field || !fieldKeysMatch(entry.field, icpFieldName)) return entry;
    found = true;
    return { ...entry, over_ridden: 'true' };
  });
  if (!found) {
    nextFields.push({ field: icpFieldName, status: 'INVALID', over_ridden: 'true' });
  }
  return { ...icpDoc, fields: nextFields };
}

export function applyOverridesForFields(
  icpDoc: IcpMessagesDoc,
  fields: IcpOverrideField[],
): IcpMessagesDoc {
  let doc = icpDoc;
  for (const formField of fields) {
    doc = applyFieldOverride(doc, FORM_TO_ICP_FIELD[formField]);
  }
  return doc;
}

export function deriveStageAfterOverride(
  currentStage: string | undefined,
  icpMessagesJson: string,
): string | undefined {
  const stage = String(currentStage ?? '').trim().toUpperCase();
  if (stage !== 'NOT_ELIGIBLE') return undefined;

  const parsed = parseIcpMessages(icpMessagesJson);
  if (!parsed?.fields?.length) return undefined;

  const hasBlockingInvalid = parsed.fields.some((field) => {
    const status = typeof field.status === 'string' ? field.status.trim().toUpperCase() : '';
    return status === 'INVALID' && !isFieldOverridden(field);
  });

  return hasBlockingInvalid ? undefined : 'READY';
}

export function finalizeIcpMessages(icpDoc: IcpMessagesDoc): IcpMessagesDoc {
  const hasBlockingInvalid = (icpDoc.fields ?? []).some((field) => {
    const status = typeof field.status === 'string' ? field.status.trim().toUpperCase() : '';
    return status === 'INVALID' && !isFieldOverridden(field);
  });
  const status = typeof icpDoc.status === 'string' ? icpDoc.status.trim().toUpperCase() : '';
  if (!hasBlockingInvalid && status === 'INVALID') {
    return { ...icpDoc, status: 'VALID' };
  }
  return icpDoc;
}

export function applyAllInvalidFieldOverrides(icpDoc: IcpMessagesDoc): IcpMessagesDoc {
  let doc = icpDoc;
  for (const field of icpDoc.fields ?? []) {
    if (!field?.field) continue;
    const status = typeof field.status === 'string' ? field.status.trim().toUpperCase() : '';
    if (status === 'INVALID' && !isFieldOverridden(field)) {
      doc = applyFieldOverride(doc, String(field.field));
    }
  }
  return finalizeIcpMessages(doc);
}

export function mapInvalidFieldToOverride(invalidField: string): IcpOverrideField | null {
  const key = normalizeFieldKey(invalidField);
  if (key === 'job_title' || key === 'title') return 'job_title';
  if (key === 'company_name' || key === 'company') return 'company_name';
  return null;
}

export function isLocationIcpField(fieldName: string): boolean {
  const key = normalizeFieldKey(fieldName);
  return (
    key === 'country' ||
    key === 'company_country' ||
    key === 'state' ||
    key === 'company_state' ||
    key === 'city' ||
    key === 'company_city' ||
    key === 'location' ||
    key === 'company_location' ||
    key === 'geo' ||
    key === 'geography' ||
    key.includes('location') ||
    key.includes('country') ||
    key.includes('state') ||
    key.includes('city')
  );
}

function fieldLooksLikeLocation(field: IcpFieldEntry): boolean {
  if (field?.field && isLocationIcpField(String(field.field))) return true;
  const msg = String(field?.message ?? '').toLowerCase();
  return /\blocation\b|\bcountry\b|\bstate\b|\bcity\b|\bgeo/.test(msg);
}

function firstCampaignValue(campaignIcp: Record<string, unknown> | null | undefined, keys: string[]): string | undefined {
  if (!campaignIcp) return undefined;
  for (const key of keys) {
    const v = campaignIcp[key];
    if (Array.isArray(v) && v.length) {
      const s = String(v[0] ?? '').trim();
      if (s) return s;
    }
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return undefined;
}

function expectedListFromField(field: IcpFieldEntry): string[] {
  const fromArr = Array.isArray(field.expected_values)
    ? field.expected_values.map((v) => String(v).trim()).filter(Boolean)
    : [];
  if (fromArr.length) return fromArr;
  const single = String(field.expected_value ?? '').trim();
  if (!single) return [];
  if (single.includes(',')) return single.split(',').map((s) => s.trim()).filter(Boolean);
  return [single];
}

/**
 * When location ICP fields are INVALID, pick the first listed expected value
 * (same options operators see in Aura Organisation edit) and map to lead fields.
 * Falls back to campaign ICP country/state/city when field expected_values are empty.
 */
export function resolveLocationOverrideFromIcp(
  icpDoc: IcpMessagesDoc | null,
  campaignIcp?: Record<string, unknown> | null,
): {
  company_country?: string;
  company_state?: string;
  company_city?: string;
  fieldsToOverride: string[];
} | null {
  if (!icpDoc?.fields?.length) return null;

  const invalidLocation = icpDoc.fields.filter((f) => {
    if (!f?.field && !f?.message) return false;
    const status = typeof f.status === 'string' ? f.status.trim().toUpperCase() : '';
    return status === 'INVALID' && !isFieldOverridden(f) && fieldLooksLikeLocation(f);
  });
  if (!invalidLocation.length) return null;

  const out: {
    company_country?: string;
    company_state?: string;
    company_city?: string;
    fieldsToOverride: string[];
  } = { fieldsToOverride: [] };

  const campaignCountry = firstCampaignValue(campaignIcp, [
    'country',
    'company_country',
    'countries',
    'company_countries',
  ]);
  const campaignState = firstCampaignValue(campaignIcp, [
    'state',
    'company_state',
    'states',
    'company_states',
  ]);
  const campaignCity = firstCampaignValue(campaignIcp, [
    'city',
    'company_city',
    'cities',
    'company_cities',
  ]);

  for (const field of invalidLocation) {
    const key = normalizeFieldKey(String(field.field || 'location'));
    const expected = expectedListFromField(field);
    out.fieldsToOverride.push(String(field.field || 'location'));

    if (key === 'state' || key === 'company_state' || key.includes('state')) {
      const pick = expected[0] || campaignState;
      if (pick) out.company_state = pick;
      continue;
    }
    if (key === 'city' || key === 'company_city' || key.includes('city')) {
      const pick = expected[0] || campaignCity;
      if (pick) out.company_city = pick;
      continue;
    }
    // country / location / generic geo message
    const pick = expected[0] || campaignCountry || campaignState || campaignCity;
    if (pick) {
      // If expected looks like "United States" use as country; if only state/city in campaign, set those too
      if (campaignCountry && (pick === campaignCountry || !out.company_country)) {
        out.company_country = campaignCountry;
      } else if (!out.company_country) {
        out.company_country = pick;
      }
      if (campaignState && !out.company_state) out.company_state = campaignState;
      if (campaignCity && !out.company_city) out.company_city = campaignCity;
    }
  }

  // Ensure we always have at least campaign geo when location is the blocker
  if (!out.company_country && campaignCountry) out.company_country = campaignCountry;
  if (!out.company_state && campaignState) out.company_state = campaignState;
  if (!out.company_city && campaignCity) out.company_city = campaignCity;

  if (!out.company_country && !out.company_state && !out.company_city) return null;
  // Deduplicate field names
  out.fieldsToOverride = [...new Set(out.fieldsToOverride.filter(Boolean))];
  return out;
}

export function applyLocationFieldOverrides(
  icpDoc: IcpMessagesDoc,
  fieldNames: string[],
): IcpMessagesDoc {
  let doc = icpDoc;
  for (const name of fieldNames) {
    doc = applyFieldOverride(doc, name);
  }
  return finalizeIcpMessages(doc);
}

export function getLeadIcpDocument(lead: Record<string, unknown>): IcpMessagesDoc | null {
  const extras = lead.extras as Record<string, unknown> | undefined;
  return (
    parseIcpMessages(lead.icp_messages) ??
    parseIcpMessages(extras?.icp_messages) ??
    null
  );
}
