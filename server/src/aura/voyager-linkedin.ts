/**
 * voyager-linkedin.ts
 *
 * LinkedIn profile scraping via LinkedIn's own internal Voyager API —
 * the same API the LinkedIn web app uses. No Puppeteer, no Apify.
 * Completely free but needs a valid `li_at` session cookie.
 *
 * HOW TO GET YOUR li_at COOKIE:
 *   1. Log into LinkedIn in your browser.
 *   2. Open DevTools → Application → Cookies → linkedin.com
 *   3. Find the cookie named "li_at" and copy its value.
 *   4. Paste it into server/.env as:  LINKEDIN_LI_AT=AQE...long...value
 *
 * The cookie typically lasts 1–2 years. Rate limit: ~50 req/min is safe.
 */

import type { LinkedInProfileScrape } from './puppeteer-scrape.js';

function slug(profileUrl: string): string | null {
  const t = String(profileUrl ?? '').trim();
  if (!t) return null;
  try {
    const u = new URL(/^https?:\/\//i.test(t) ? t : `https://${t}`);
    const m = u.pathname.match(/\/in\/([^/?#]+)/i);
    return m?.[1] ? decodeURIComponent(m[1]).toLowerCase().replace(/\/+$/, '') : null;
  } catch {
    const m = t.match(/\/in\/([^/?#]+)/i);
    return m?.[1] ?? null;
  }
}

function str(v: unknown): string {
  return v == null ? '' : String(v).trim();
}

/** Parse "City, State, Country" or "City, Country" into parts. */
export function parseLocationParts(location: string): {
  city: string;
  state: string;
  country: string;
} {
  const parts = location
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length === 0) return { city: '', state: '', country: '' };
  if (parts.length === 1) return { city: parts[0], state: '', country: '' };
  if (parts.length === 2) return { city: parts[0], state: '', country: parts[1] };
  return { city: parts[0], state: parts[1], country: parts[parts.length - 1] };
}

/** Infer job function from title keywords. */
export function inferJobFunction(title: string, about = ''): string {
  const blob = `${title} ${about}`.toLowerCase();
  const rules: [RegExp, string][] = [
    [/\b(ceo|cto|cfo|coo|cmo|cro|chief[^n])/i, 'Executive'],
    [/\b(founder|co-?founder|owner)\b/i, 'Founder'],
    [/\b(sales|account executive|ae\b|bdr|sdr|business development)\b/i, 'Sales'],
    [/\b(marketing|brand|growth|demand gen|content|comms|communications)\b/i, 'Marketing'],
    [/\b(product manager|pm\b|product management|product owner)\b/i, 'Product Management'],
    [/\b(engineer|developer|software|devops|sre|backend|frontend|fullstack|data scientist|ml |machine learning)\b/i, 'Engineering'],
    [/\b(design|ux|ui\b|creative|visual)\b/i, 'Design'],
    [/\b(finance|financial|accounting|controller|cfo\b|treasury)\b/i, 'Finance'],
    [/\b(human resources|hr\b|people ops|talent|recruiting|recruiter)\b/i, 'Human Resources'],
    [/\b(legal|counsel|attorney|compliance)\b/i, 'Legal'],
    [/\b(operations|ops\b|supply chain|logistics)\b/i, 'Operations'],
    [/\b(it\b|information technology|systems|infrastructure|network|security)\b/i, 'IT'],
    [/\b(customer success|cs\b|customer support|support)\b/i, 'Customer Success'],
    [/\b(data|analytics|analyst|bi\b|business intelligence)\b/i, 'Analytics'],
    [/\b(consulting|advisor|advisory)\b/i, 'Consulting'],
    [/\b(partnerships|alliances|channel)\b/i, 'Partnerships'],
  ];
  for (const [re, fn] of rules) {
    if (re.test(blob)) return fn;
  }
  return '';
}

/** Infer job level from title keywords. */
export function inferJobLevel(title: string): string {
  const t = title.toLowerCase();
  if (/\b(ceo|cto|cfo|coo|cmo|cro|chief)\b/.test(t)) return 'C-Level';
  if (/\b(founder|co-?founder|owner)\b/.test(t)) return 'Founder / Owner';
  if (/\b(president|evp|svp)\b/.test(t)) return 'Executive VP';
  if (/\b(vp|vice president)\b/.test(t)) return 'VP';
  if (/\b(director|head of|head\b)\b/.test(t)) return 'Director';
  if (/\b(manager|lead\b|principal)\b/.test(t)) return 'Manager';
  if (/\b(senior|sr\.?)\b/.test(t)) return 'Senior IC';
  if (/\b(junior|jr\.?|associate)\b/.test(t)) return 'Junior IC';
  if (/\b(intern)\b/.test(t)) return 'Intern';
  return 'Individual Contributor';
}

/** Parse a single Voyager profile element into our shape. */
function parseVoyagerProfile(
  profileEl: Record<string, unknown>,
  positionEls: Array<Record<string, unknown>>,
  geoEls: Array<Record<string, unknown>>,
): LinkedInProfileScrape {
  const firstName = str(profileEl.firstName);
  const lastName = str(profileEl.lastName);
  const personName = `${firstName} ${lastName}`.trim();
  const headline = str(profileEl.headline);

  // Find current position (no end date)
  const currentPos =
    positionEls.find((p) => {
      const timePeriod = p.timePeriod as Record<string, unknown> | undefined;
      return !timePeriod?.endDate;
    }) ?? positionEls[0];

  const currentTitle = str(currentPos?.title ?? currentPos?.jobTitle);
  const currentCompany = str(
    currentPos?.companyName ??
      (currentPos?.company as Record<string, unknown> | undefined)?.name,
  );

  // Experience text
  const experienceText = positionEls
    .slice(0, 6)
    .map((p) => {
      const title = str(p.title);
      const co = str(
        p.companyName ?? (p.company as Record<string, unknown> | undefined)?.name,
      );
      const loc = str(p.locationName);
      return [title, co, loc].filter(Boolean).join(' at ');
    })
    .join('\n');

  // Location
  const locationEl = geoEls[0];
  const locationFull = str(locationEl?.defaultLocalizedName ?? profileEl.locationName ?? profileEl.geoLocationName);
  const { city, state, country } = parseLocationParts(locationFull);

  // About
  const about = str(profileEl.summary);

  const rawText = [headline, about, experienceText, locationFull].filter(Boolean).join('\n');

  return {
    url: '',
    personName,
    headline,
    about,
    experienceText,
    currentTitle,
    currentCompany,
    loggedIn: true,
    rawText,
    // attach enriched fields for the enrichment route to use
    ...(city || state || country
      ? ({ _location: { city, state, country } } as Record<string, unknown>)
      : {}),
  } as LinkedInProfileScrape & { _location?: { city: string; state: string; country: string } };
}

/** Build headers for Voyager API calls. */
function voyagerHeaders(liAt: string, jsessionId: string): Record<string, string> {
  return {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    Accept: 'application/vnd.linkedin.normalized+json+2.1',
    'Accept-Language': 'en-US,en;q=0.9',
    'x-restli-protocol-version': '2.0.0',
    'x-li-lang': 'en_US',
    'x-li-page-instance': 'urn:li:page:d_flagship3_profile_view_base;1',
    'x-li-track':
      '{"clientVersion":"1.13.15470","mpVersion":"1.13.15470","osName":"web","timezoneOffset":0,"timezone":"UTC","deviceFormFactor":"DESKTOP","mpName":"voyager-web"}',
    Cookie: `li_at=${liAt}; JSESSIONID="${jsessionId}"`,
    'csrf-token': jsessionId,
    Referer: 'https://www.linkedin.com/',
  };
}

/** Extract JSESSIONID from the li_at JWT header (base64 segment). */
function extractJsessionId(liAt: string): string {
  // LinkedIn's JSESSIONID for CSRF is derived from the session; fall back to a
  // synthetic value if we can't extract it. Many public profiles work fine.
  try {
    const segment = liAt.split('.')[0];
    if (segment && segment.length > 10) return segment;
  } catch {}
  return `ajax:${Date.now()}`;
}

export async function scrapeLinkedInWithVoyager(
  profileUrl: string,
): Promise<LinkedInProfileScrape & { _location?: { city: string; state: string; country: string } }> {
  const liAt = process.env.LINKEDIN_LI_AT ?? '';

  if (!liAt || liAt.startsWith('your-')) {
    return makeError(
      profileUrl,
      'LINKEDIN_LI_AT not set. Copy your li_at cookie from LinkedIn (DevTools → Application → Cookies) and add it to server/.env.',
    );
  }

  const profileSlug = slug(profileUrl);
  if (!profileSlug) {
    return makeError(profileUrl, `Could not extract LinkedIn slug from URL: ${profileUrl}`);
  }

  // Generate a synthetic JSESSIONID — must match the csrf-token header
  const jsessionId = `ajax:${Math.floor(Math.random() * 9_000_000_000) + 1_000_000_000}`;
  const headers = voyagerHeaders(liAt, jsessionId);

  // ── Try endpoints in order (most to least current) ─────────────────────────
  const endpoints = [
    // Endpoint 1: basic profile (current, no /profileView suffix)
    `https://www.linkedin.com/voyager/api/identity/profiles/${profileSlug}`,
    // Endpoint 2: dash profiles (newer format)
    `https://www.linkedin.com/voyager/api/identity/dash/profiles?q=memberIdentity&memberIdentity=${profileSlug}&decorationId=com.linkedin.voyager.dash.deco.identity.profile.FullProfileWithEntities-35`,
  ];

  console.log(`[voyager-linkedin] fetching slug=${profileSlug}`);

  for (const apiUrl of endpoints) {
    try {
      const res = await fetch(apiUrl, {
        headers,
        signal: AbortSignal.timeout(30_000),
      });

      console.log(`[voyager-linkedin] ${apiUrl.split('?')[0].split('/').slice(-2).join('/')} → HTTP ${res.status}`);

      if (res.status === 401 || res.status === 403) {
        return makeError(
          profileUrl,
          'LinkedIn returned 401/403 — your li_at cookie may be expired. Refresh it: LinkedIn → F12 → Application → Cookies → li_at → copy Value → paste in server/.env.',
        );
      }

      // 410 = deprecated endpoint, try next
      if (res.status === 410) {
        console.log(`[voyager-linkedin] endpoint returned 410 (deprecated), trying next…`);
        continue;
      }

      if (!res.ok) {
        console.log(`[voyager-linkedin] HTTP ${res.status} from endpoint, trying next…`);
        continue;
      }

      const json = await res.json() as Record<string, unknown>;

      // Parse the response — Voyager returns an "included" array of typed elements
      const included: Array<Record<string, unknown>> = Array.isArray(json.included)
        ? (json.included as Array<Record<string, unknown>>)
        : [];

      // Also check the data.elements path (dash endpoint format)
      const dashElements = (
        (json.data as Record<string, unknown> | undefined)?.elements as
        Array<Record<string, unknown>> | undefined
      ) ?? [];
      const allElements = [...included, ...dashElements];

      const profileEl = allElements.find(
        (el) =>
          typeof el.$type === 'string' &&
          (el.$type.includes('Profile') || el.$type.includes('profile')) &&
          !el.$type.includes('Position') &&
          !el.$type.includes('Education') &&
          Boolean(el.firstName),
      ) as Record<string, unknown> | undefined;

      // Fallback: check data.profile (older endpoint format)
      const dataProfile = (json.data as Record<string, unknown> | undefined)?.profile as
        Record<string, unknown> | undefined;

      const profile = profileEl ?? (dataProfile?.firstName ? dataProfile : undefined);

      if (!profile) {
        console.log(`[voyager-linkedin] no profile element found in response, trying next endpoint…`);
        continue;
      }

      const positionEls = allElements.filter(
        (el) =>
          typeof el.$type === 'string' &&
          (el.$type.includes('Position') || el.$type.includes('Experience')) &&
          Boolean(el.title),
      ) as Array<Record<string, unknown>>;

      // Also check positionView.elements (older format)
      const positionViewEls = (
        (dataProfile as Record<string, unknown> | undefined)?.positionView as
        Record<string, unknown> | undefined
      )?.elements as Array<Record<string, unknown>> ?? [];

      const allPositions = positionEls.length > 0 ? positionEls : positionViewEls;

      const geoEls = allElements.filter(
        (el) =>
          typeof el.$type === 'string' &&
          el.$type.includes('Geo') &&
          Boolean(el.defaultLocalizedName),
      ) as Array<Record<string, unknown>>;

      const result = parseVoyagerProfile(profile, allPositions, geoEls);
      result.url = `https://www.linkedin.com/in/${profileSlug}`;

      console.log(
        `[voyager-linkedin] ok: name="${result.personName}" title="${result.currentTitle}" company="${result.currentCompany}"`,
      );
      return result;

    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Voyager scrape failed';
      const cause = (err as { cause?: { code?: string } })?.cause?.code ?? '';
      console.warn(`[voyager-linkedin] error on endpoint: ${msg}${cause ? ` (${cause})` : ''}`);
      if (cause === 'ECONNRESET' || cause === 'ETIMEDOUT' || msg.includes('fetch failed')) {
        console.warn('[voyager-linkedin] ⚠ LinkedIn may be rate-limiting this IP. Wait 2–3 min and try again.');
      }
      // Continue to next endpoint
    }
  }

  // All endpoints failed
  return makeError(
    profileUrl,
    `LinkedIn Voyager API could not fetch profile "${profileSlug}". The profile may be private, or your li_at cookie may have expired.`,
  );
}


function makeError(
  url: string,
  error: string,
): LinkedInProfileScrape & { _location?: { city: string; state: string; country: string } } {
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

