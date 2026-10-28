/**
 * apify-linkedin.ts
 *
 * LinkedIn profile scraping via the Apify platform.
 * No Puppeteer / Chrome needed. Requires APIFY_API_TOKEN in .env.
 *
 * Sign up free at https://apify.com → Settings → Integrations → API token.
 * Free tier gives $5/month (~100–200 profiles at ~$0.03 each).
 *
 * Configured actor (APIFY_ACTOR env):
 *   Default: "johnvc~linkedin-profile-api"  — no LinkedIn cookie needed
 *   Alt:     "curious_coder~linkedin-profile-scraper"  — needs LINKEDIN_LI_AT cookie
 */

import type { LinkedInProfileScrape } from './puppeteer-scrape.js';

const APIFY_BASE = 'https://api.apify.com/v2';

/** Run an Apify actor synchronously and return dataset items. */
async function runApifyActor(
  actorId: string,
  token: string,
  input: Record<string, unknown>,
  timeoutSecs = 120,
): Promise<unknown[]> {
  const url = `${APIFY_BASE}/acts/${encodeURIComponent(actorId)}/run-sync-get-dataset-items?token=${token}&timeout=${timeoutSecs}`;

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
    signal: AbortSignal.timeout((timeoutSecs + 30) * 1000),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    let detail = body.slice(0, 400);
    try { detail = JSON.stringify(JSON.parse(body)); } catch { /* keep raw */ }
    throw new Error(`Apify actor ${actorId} failed: HTTP ${res.status} — ${detail}`);
  }

  const data = await res.json();
  if (Array.isArray(data)) return data;
  if (data && typeof data === 'object') {
    const o = data as Record<string, unknown>;
    for (const key of ['items', 'data', 'results']) {
      if (Array.isArray(o[key])) return o[key] as unknown[];
    }
  }
  return [];
}

/** Normalise one Apify LinkedIn result item into LinkedInProfileScrape. */
function normalizeApifyItem(item: unknown): LinkedInProfileScrape | null {
  if (!item || typeof item !== 'object') return null;
  const d = item as Record<string, unknown>;

  // ── Name ──────────────────────────────────────────────────────────────────
  const firstName = String(d.firstName ?? d.first_name ?? '').trim();
  const lastName = String(d.lastName ?? d.last_name ?? '').trim();
  const fullName = String(d.fullName ?? d.full_name ?? d.name ?? `${firstName} ${lastName}`).trim();
  const personName = fullName || `${firstName} ${lastName}`.trim();

  // ── Headline ─────────────────────────────────────────────────────────────
  const headline = String(d.headline ?? d.title ?? '').trim();

  // ── About ─────────────────────────────────────────────────────────────────
  const about = String(d.about ?? d.summary ?? d.bio ?? '').slice(0, 3000).trim();

  // ── Location string ───────────────────────────────────────────────────────
  const locationRaw = String(
    d.location ?? d.locationName ?? d.geoLocationName ??
    (d.geo && typeof d.geo === 'object' ? (d.geo as Record<string, unknown>).full : '') ??
    '',
  ).trim();

  // ── Experience ────────────────────────────────────────────────────────────
  // Many actors return experience as an array of position objects.
  const expArr: Array<Record<string, unknown>> = Array.isArray(d.experiences)
    ? (d.experiences as Array<Record<string, unknown>>)
    : Array.isArray(d.experience)
      ? (d.experience as Array<Record<string, unknown>>)
      : Array.isArray(d.positions)
        ? (d.positions as Array<Record<string, unknown>>)
        : Array.isArray(d.position)
          ? (d.position as Array<Record<string, unknown>>)
          : [];

  // Find current position (prefer isCurrent===true, then first item)
  const currentPos = expArr.find((p) => p.isCurrent === true || p.isCurrentRole === true || !p.endDate) ?? expArr[0];

  const currentTitle =
    String(
      d.currentJobTitle ?? d.current_title ?? d.currentTitle ?? currentPos?.title ?? currentPos?.jobTitle ?? '',
    ).trim();

  const currentCompany =
    String(
      d.currentCompanyName ?? d.current_company ?? d.currentCompany ?? currentPos?.companyName ?? currentPos?.company ?? '',
    ).trim();

  // Build experience text blob for compatibility with existing logic
  const experienceText = expArr
    .slice(0, 5)
    .map((p) =>
      [p.title, p.companyName ?? p.company, p.location, p.startDate ?? p.start_date, p.endDate ?? p.end_date ?? 'Present']
        .filter(Boolean)
        .join(' · '),
    )
    .join('\n');

  // ── Raw text blob ─────────────────────────────────────────────────────────
  const rawText = [headline, about, experienceText, locationRaw].filter(Boolean).join('\n');

  if (!personName) return null;

  return {
    url: String(d.profileUrl ?? d.url ?? d.linkedinUrl ?? d.publicUrl ?? '').trim(),
    personName,
    headline,
    about,
    experienceText,
    currentTitle,
    currentCompany,
    loggedIn: true, // Apify successfully got the profile
    rawText,
  };
}

/** Scrape a LinkedIn profile via Apify. */
export async function scrapeLinkedInWithApify(profileUrl: string): Promise<LinkedInProfileScrape> {
  const token = process.env.APIFY_API_TOKEN ?? '';
  const actorId = process.env.APIFY_ACTOR ?? 'johnvc~linkedin-profile-api';

  if (!token || token.startsWith('apify_api_your')) {
    return makeError(profileUrl, 'APIFY_API_TOKEN not set. Sign up free at apify.com and add the token to server/.env.');
  }

  const url = profileUrl.trim();
  if (!url) return makeError(url, 'Missing LinkedIn URL');

  console.log(`[apify-linkedin] scraping ${url} via actor=${actorId}`);

  // ── Build input for curious_coder~linkedin-profile-scraper (most popular)
  // Input schema: { urls: [{url}], cookie: "li_at_value", proxyConfiguration: {...} }
  // For other actors, profileUrls / startUrls formats are also included as fallbacks.
  const liAt = process.env.LINKEDIN_LI_AT ?? '';
  const hasCookie = liAt && !liAt.startsWith('your-');

  const input: Record<string, unknown> = {
    // curious_coder format
    urls: [{ url }],
    // johnvc~linkedin-profile-api / other actors format
    profileUrls: [url],
    startUrls: [{ url }],
    proxyConfiguration: { useApifyProxy: true },
    maxItems: 1,
  };

  if (hasCookie) {
    // curious_coder accepts cookie as the raw li_at value
    input.cookie = liAt;
    // some actors want the full cookie header string
    input.li_at = liAt;
    input.rawCookie = `li_at=${liAt}`;
  }

  try {
    const items = await runApifyActor(actorId, token, input, 120);
    if (!items.length) {
      return makeError(url, `Apify actor returned no results for ${url}. Profile may be private or URL is invalid.`);
    }
    const normalized = normalizeApifyItem(items[0]);
    if (!normalized) {
      return makeError(url, 'Apify returned data but could not parse a person name from it.');
    }
    console.log(`[apify-linkedin] scraped ok: name="${normalized.personName}" title="${normalized.currentTitle}" company="${normalized.currentCompany}"`);
    return normalized;
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Apify scrape failed';
    console.warn(`[apify-linkedin] error for ${url}:`, msg);
    return makeError(url, msg);
  }
}

function makeError(url: string, error: string): LinkedInProfileScrape {
  return {
    url,
    personName: '',
    headline: '',
    about: '',
    experienceText: '',
    currentTitle: '',
    currentCompany: '',
    loggedIn: false,
    rawText: '',
    error,
  };
}
