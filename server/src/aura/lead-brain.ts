import type { PageExtraction } from '../types.js';
import { hasAI } from '../ai.js';
import OpenAI from 'openai';
import type { CampaignLead, LeadProcessResult } from './types.js';
import {
  applyAllInvalidFieldOverrides,
  applyLocationFieldOverrides,
  applyOverridesForFields,
  deriveStageAfterOverride,
  getInvalidFields,
  getLeadIcpDocument,
  mapInvalidFieldToOverride,
  resolveLocationOverrideFromIcp,
  type IcpOverrideField,
} from './icp.js';
import {
  findCampaignLead,
  leadDisplayName,
  normalizeLinkedInUrl,
  updateCampaignLead,
} from './client.js';
import type { AuraConfig } from './types.js';
import {
  enrichCompanyForLead,
  mergeCompanyEnrichmentIntoLead,
  isApolloConfigured,
  type LeadWithCompanyData,
} from './apollo-company-enrichment.js';
import { parseFitScore, evaluateReadyDecision, DEFAULT_READY_THRESHOLD } from './lead-decisions.js';
import { logLeadDecision } from '../decision-log.js';

export const FIT_SCORE_READY_THRESHOLD = Number(process.env.LEAD_FIT_READY_THRESHOLD) || DEFAULT_READY_THRESHOLD;

interface LlmClient {
  client: OpenAI;
  model: string;
  name: string;
}

function getLlmClients(): LlmClient[] {
  const clients: LlmClient[] = [];
  const openaiKey = process.env.OPENAI_API_KEY;
  if (openaiKey && !openaiKey.startsWith('sk-your')) {
    clients.push({
      client: new OpenAI({ apiKey: openaiKey }),
      model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
      name: 'openai',
    });
  }
  const groqKey = process.env.GROQ_API_KEY;
  if (groqKey && !groqKey.startsWith('gsk_your')) {
    clients.push({
      client: new OpenAI({ apiKey: groqKey, baseURL: 'https://api.groq.com/openai/v1' }),
      model: process.env.GROQ_MODEL || 'llama-3.3-70b-versatile',
      name: 'groq',
    });
  }
  return clients;
}

function isRateLimitError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /rate limit|429|too many requests/i.test(msg);
}

export interface LinkedInRoleInfo {
  jobTitle: string;
  company: string;
  headline: string;
  industry?: string;
  location?: string;
  whatTheyDo: string;
  source: 'linkedin' | 'crm' | 'mixed' | 'operator';
}

const LINKEDIN_GARBAGE_PATTERNS = [
  /linkedin corporation/i,
  /privacy\s*&\s*terms/i,
  /help center/i,
  /accessibility/i,
  /community guidelines/i,
  /ad choices/i,
  /sign in to linkedin/i,
  /join linkedin/i,
  /recommendation transparen/i,
  /marketing solutions/i,
  /sales solutions/i,
  /people also viewed/i,
  /contact info/i,
  /^\d[\d,+]*\s*\+?\s*(followers?|connections?)$/i,
];

/** Soft check — do not reject normal long headlines. */
function isValidScrapedText(value: string, maxLen = 120): boolean {
  const t = String(value || '').trim();
  if (!t || t.length > maxLen) return false;
  if (LINKEDIN_GARBAGE_PATTERNS.some((p) => p.test(t))) return false;
  // Only reject severe glued UI blobs (almost no spaces + many camelCase joins)
  const spaces = (t.match(/\s/g) || []).length;
  const camel = (t.match(/[a-z][A-Z]/g) || []).length;
  if (t.length > 40 && spaces < 2 && camel > 4) return false;
  return true;
}

function isUsableFieldText(value: string, maxLen = 150): boolean {
  const t = String(value || '').trim();
  if (!t || t.length > maxLen) return false;
  if (LINKEDIN_GARBAGE_PATTERNS.some((p) => p.test(t))) return false;
  return true;
}

function isAboutOrBioBlob(value: string): boolean {
  const t = String(value || '').trim();
  if (!t) return false;
  if (/^about\b/i.test(t) || /^aboutmy/i.test(t.replace(/\s+/g, ''))) return true;
  if (/\bmy expertise\b/i.test(t)) return true;
  if (t.length > 120 && (t.match(/\./g) || []).length >= 1) return true;
  return false;
}

function isActivityOrFeedBlob(value: string): boolean {
  const t = String(value || '').trim();
  if (!t) return false;
  if (/activity\d|^\s*activity\b/i.test(t)) return true;
  if (/\b(followers?|reposted this|suggested for you|view my profile)\b/i.test(t)) return true;
  if (/\bfollow(ers?)?\b/i.test(t) && /\b(posts?|comments?|images)\b/i.test(t)) return true;
  // LinkedIn feed / connection chrome glued into "titles"
  if (/^[·•|.\s]*\d*(st|nd|rd|th)\+?$/i.test(t)) return true; // "· 3rd"
  if (/\b\d(st|nd|rd|th)\+/i.test(t)) return true; // "3rd+"
  if (/\b\d(st|nd|rd|th)\b/i.test(t) && t.length <= 8) return true;
  if (/\d+\s*(mo|mos|w|wk|d|h|yr|yrs)\b/i.test(t) || /\d(mo|w|d|h)\b/i.test(t)) return true; // "1mo"
  if (/using the power of|transform business|reposted|liked by|celebrates/i.test(t)) return true;
  if (/\+\s*[A-Z][a-z]*[A-Z]/.test(t) || /\d(st|nd|rd|th)\+[A-Za-z]/i.test(t)) return true; // "3rd+SAP"
  return false;
}

/** Schools / degrees — never treat as job title. */
export function isEducationText(value: string): boolean {
  const t = String(value || '').trim();
  if (!t) return false;
  return /\b(university|universit[aá]|institute of technology|institute|college|school of|high school|polytechnic|academy|bachelor|master'?s?\b|mba\b|b\.?\s?tech|m\.?\s?tech|ph\.?\s?d|alumn|undergraduate|graduate student|campus|iit\b|iim\b|stanford|harvard|mit\b|oxford|cambridge|urbana-?champaign)\b/i.test(
    t,
  );
}

const JOB_TITLE_HINT =
  /\b(director|vice[\s-]?president|evp|svp|avp|vp\b|president|manager|engineer|engineering|founder|co-?founder|head of|\bhead\b|lead\b|chief|officer|executive|account executive|analyst|consultant|specialist|product|marketing|sales|developer|designer|partner|owner|ceo|cto|cfo|coo|cmo|cro|business development|go-?to-?market|gtm|communications?)\b/i;

/** Only mine these blocks from rawText — never Activity/posts. */
function roleSafeRawText(raw: string): string {
  const text = String(raw || '');
  const blocks: string[] = [];
  for (const key of ['HEADLINE', 'CURRENT_TITLE', 'CURRENT_COMPANY', 'TOP_CARD', 'EXPERIENCE', 'ABOUT']) {
    const re = new RegExp(`${key}:\\s*\\n([\\s\\S]*?)(?=\\n(?:HEADLINE|CURRENT_TITLE|CURRENT_COMPANY|TOP_CARD|EXPERIENCE|ABOUT|EDUCATION|SKILLS|ACTIVITY|HIRING|VISIBLE POSTS)\\b|$)`, 'i');
    const m = text.match(re);
    if (m?.[1]) blocks.push(m[1].trim());
  }
  return blocks.join('\n');
}

/** Split LinkedIn experience blobs that often arrive as one long line. */
export function splitExperienceLines(experience: string): string[] {
  const raw = String(experience || '').trim();
  if (!raw) return [];
  // Never split activity feed
  if (isActivityOrFeedBlob(raw)) return [];
  const parts = raw
    .split(/\n+|(?:\s*[·|•]\s*)|(?<=Present)|(?<=Full-time)|(?<=Part-time)/)
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter((l) => l.length >= 2 && l.length <= 120 && !isActivityOrFeedBlob(l));
  if (parts.length >= 2) return parts;

  const found: string[] = [];
  const re =
    /\b((?:Senior |Junior |Lead |Principal |Staff |Head of |Vice President of |Vice President |VP of |VP |EVP |SVP |Director of |Director |Services Account Executive|Account Executive|Executive |Account )?[\w/&+-]*(?:Manager|Director|Executive|Engineer|Founder|Officer|President|Consultant|Analyst|Specialist|Developer|Designer|Lead|Head)(?:\s+(?:of\s+)?[\w/&+-]+){0,4})\b/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) && found.length < 8) {
    const t = m[1].replace(/\s+/g, ' ').trim();
    if (t.length >= 4 && t.length <= 80 && !isActivityOrFeedBlob(t) && !found.includes(t)) found.push(t);
  }
  return found.length ? found : parts;
}

export function looksLikeJobTitle(value: string): boolean {
  const t = String(value || '').trim();
  if (!t || t.length < 2 || t.length > 100) return false;
  if (isAboutOrBioBlob(t) || isEducationText(t) || isActivityOrFeedBlob(t)) return false;
  if (/^(experience|education|about|skills|activity|posts|comments)$/i.test(t)) return false;
  // Location-only lines
  if (/^[A-Za-zÀ-ÿ .'-]+,\s*[A-Za-zÀ-ÿ .'-]+/.test(t) && !JOB_TITLE_HINT.test(t)) return false;
  if (!JOB_TITLE_HINT.test(t)) {
    // Allow short clean headlines with | or @ (e.g. niche titles)
    if (/[|@]/.test(t) && t.length <= 90) return true;
    // Soft accept: clean Experience-style role line without keyword (e.g. "PCM", "Growth")
    if (
      t.length >= 4 &&
      t.length <= 80 &&
      !/\d{4}/.test(t) &&
      !/^(full-time|part-time|present)/i.test(t) &&
      (t.match(/\s/g) || []).length >= 1
    ) {
      return true;
    }
    return false;
  }
  // Must look like a title, not a sentence/post
  if ((t.match(/\./g) || []).length >= 1) return false;
  if (t.length > 85) return false;
  return true;
}

/** Pull a usable title/company out of messy LinkedIn top-card text. */
export function cleanLinkedInHeadline(raw: string): {
  title: string;
  company: string;
  headline: string;
} {
  let t = String(raw || '').replace(/\s+/g, ' ').trim();
  if (!t) return { title: '', company: '', headline: '' };

  if (isAboutOrBioBlob(t) || isEducationText(t) || isActivityOrFeedBlob(t)) {
    return { title: '', company: '', headline: '' };
  }

  t = t
    .replace(/^(Message|Connect|Follow|Pending|Accept)\s+/gi, '')
    .replace(/\s*Contact info.*$/i, '')
    .replace(/\s+\d[\d,+]*\s*\+?\s*(followers?|connections?).*$/i, '')
    .replace(/\s*[·•]\s*\d*(st|nd|rd|th)\+?\b.*$/i, '')
    .replace(/^(·\s*)?\d*(st|nd|rd|th)\+?\s*/i, '')
    .trim();

  t = t.split(/(?=Message\b|Connect\b|Follow\b|Pending\b|Contact info\b)/i)[0]?.trim() || t;

  // "Services Account Executive | PCI @ SAP"
  const atCompany = t.match(/@\s*([^|·•]+)/);
  if (atCompany) {
    const company = atCompany[1].trim();
    const beforeAt = t.split('@')[0].trim();
    const title = (beforeAt.split(/[|·•]/)[0] || beforeAt).trim();
    if (looksLikeJobTitle(title) && !isEducationText(company)) {
      return { title, company, headline: `${title} at ${company}` };
    }
  }

  const atMatch = t.match(/^(.{2,120}?)\s+at\s+(.{2,100}?)(?:\s*[·|•]|$)/i);
  if (atMatch) {
    const title = atMatch[1].trim();
    const company = atMatch[2].trim();
    if (!looksLikeJobTitle(title) || isEducationText(title) || isEducationText(company)) {
      return { title: '', company: '', headline: '' };
    }
    return { title, company, headline: `${title} at ${company}` };
  }

  let first = (t.split(/\s*[·|•]\s*/)[0] || t).trim();
  if (first.length > 160) first = first.slice(0, 160).trim();
  if (!looksLikeJobTitle(first)) {
    return { title: '', company: '', headline: '' };
  }

  return { title: first, company: '', headline: first };
}

export function isLinkedInScrapeUsable(
  extraction: PageExtraction,
  role: LinkedInRoleInfo,
): { usable: boolean; reason?: string } {
  const meta = extraction.metadata as Record<string, unknown> | undefined;
  if (meta?.scrapeBlocked === true) {
    return { usable: false, reason: 'LinkedIn auth wall — sign in to LinkedIn in this browser' };
  }
  const name = String(extraction.personName ?? '').trim();
  if (!name || name.length < 2) {
    return { usable: false, reason: 'Could not read profile name from LinkedIn' };
  }
  const metaTitle = String(meta?.currentTitle ?? '').trim();
  const cleaned = cleanLinkedInHeadline(
    isAboutOrBioBlob(String(extraction.description || '')) ? '' : String(extraction.description || ''),
  );
  const hasTitle =
    (isValidScrapedText(role.jobTitle, 160) && looksLikeJobTitle(role.jobTitle)) ||
    (isValidScrapedText(role.headline, 300) && looksLikeJobTitle(role.headline.split(/[·|]/)[0] || '')) ||
    (isValidScrapedText(metaTitle, 160) && looksLikeJobTitle(metaTitle)) ||
    (isValidScrapedText(cleaned.title, 160) && looksLikeJobTitle(cleaned.title));
  if (hasTitle) {
    return { usable: true };
  }
  // Experience present with a parseable role — treat as usable even if extension marked weak
  const exp = String((extraction.metadata as any)?.sections?.experience || '');
  if (exp.length >= 40) {
    const fromExp = splitExperienceLines(exp).find((l) => looksLikeJobTitle(l) && JOB_TITLE_HINT.test(l));
    if (fromExp) return { usable: true };
  }
  if (isEducationText(role.jobTitle) || isEducationText(metaTitle) || isEducationText(String(extraction.description || ''))) {
    return { usable: false, reason: 'LinkedIn scrape picked education, not job title' };
  }
  if (
    meta?.scrapeWeak === true ||
    meta?.scrapeMode === 'title-only' ||
    meta?.scrapeMode === 'title-last-resort' ||
    meta?.scrapeMode === 'inline-name-only' ||
    meta?.scrapeMode === 'content-name-only' ||
    meta?.scrapeMode === 'targeted-name-only' ||
    meta?.scrapeMode === 'targeted-empty'
  ) {
    // Re-check after experience salvage in extractRoleFromLinkedIn — role.jobTitle may now be set
    if (looksLikeJobTitle(role.jobTitle) && JOB_TITLE_HINT.test(role.jobTitle)) {
      return { usable: true };
    }
    return { usable: false, reason: 'LinkedIn scrape weak — using CRM fields' };
  }
  return { usable: false, reason: 'Could not read job title from LinkedIn (page may be blocked)' };
}

export function extractRoleFromLinkedIn(extraction: PageExtraction): LinkedInRoleInfo {
  const sections = extraction.metadata?.sections as Record<string, string> | undefined;
  const meta = extraction.metadata as Record<string, unknown> | undefined;
  const experience = String(sections?.experience ?? '');
  const rawDesc = String(extraction.description || '');
  const rawHeadline =
    isAboutOrBioBlob(rawDesc) || isEducationText(rawDesc) || isActivityOrFeedBlob(rawDesc)
      ? ''
      : rawDesc;
  const cleaned = cleanLinkedInHeadline(rawHeadline);

  let jobTitle = '';
  let company = '';

  // 1) Top-card / cleaned headline first (real job line)
  if (cleaned.title && looksLikeJobTitle(cleaned.title)) {
    jobTitle = cleaned.title;
    if (cleaned.company && !isEducationText(cleaned.company)) company = cleaned.company;
  }

  const metaTitle = String(meta?.currentTitle ?? '').trim();
  const metaCompany = String(meta?.currentCompany ?? '').trim();
  if (!jobTitle && looksLikeJobTitle(metaTitle) && isValidScrapedText(metaTitle, 160)) {
    jobTitle = metaTitle;
  }
  if (!company && metaCompany && !isEducationText(metaCompany) && isValidScrapedText(metaCompany, 150)) {
    company = metaCompany;
  }

  // 2) Experience lines that look like jobs (skip schools)
  // Experience often arrives as one long space-collapsed blob — split carefully
  const expLines = splitExperienceLines(experience).filter(
    (l) => l && !/^about\b/i.test(l) && !isAboutOrBioBlob(l) && !isEducationText(l) && !isActivityOrFeedBlob(l),
  );

  if (!jobTitle || !looksLikeJobTitle(jobTitle)) {
    jobTitle = looksLikeJobTitle(jobTitle) ? jobTitle : '';
    for (let i = 0; i < expLines.length; i++) {
      const line = expLines[i];
      if (!isValidScrapedText(line, 160)) continue;
      if (/^experience$/i.test(line)) continue;
      if (/^\d|present|yr|mo|full-time|part-time/i.test(line) && !/ at /i.test(line) && !JOB_TITLE_HINT.test(line)) {
        continue;
      }

      const atMatch = line.match(/^(.+?)\s+at\s+(.+?)(?:\s*·|$)/i);
      if (atMatch) {
        const left = atMatch[1].trim();
        const right = atMatch[2].trim();
        if (looksLikeJobTitle(left) && !isEducationText(right)) {
          jobTitle = left;
          company = company || right;
          break;
        }
        continue;
      }

      const candidate = line.replace(/\s*·.*$/, '').trim();
      if (looksLikeJobTitle(candidate)) {
        jobTitle = candidate;
        const next = expLines[i + 1];
        if (
          next &&
          !company &&
          !isEducationText(next) &&
          !looksLikeJobTitle(next) &&
          !/^\d|present|yr|mo|full-time|part-time/i.test(next)
        ) {
          company = next.replace(/\s*·.*$/, '').trim();
        }
        break;
      }
    }
  }

  // 2b) Only search role-safe raw blocks — NEVER Activity / posts
  if (!jobTitle) {
    const safe = roleSafeRawText(String(extraction.rawText || ''));
    const titleBlock = String(extraction.rawText || '').match(/CURRENT_TITLE:\s*\n([^\n]+)/i)?.[1]?.trim();
    const headBlock = String(extraction.rawText || '').match(/HEADLINE:\s*\n([^\n]+)/i)?.[1]?.trim();
    const topCard = String(extraction.rawText || '').match(/TOP_CARD:\s*\n([\s\S]*?)(?=\n[A-Z_]+:|$)/i)?.[1]?.trim();

    if (titleBlock && looksLikeJobTitle(titleBlock)) {
      jobTitle = titleBlock;
    } else if (headBlock) {
      const fromHead = cleanLinkedInHeadline(headBlock);
      if (fromHead.title && looksLikeJobTitle(fromHead.title)) {
        jobTitle = fromHead.title;
        if (!company && fromHead.company) company = fromHead.company;
      }
    } else if (topCard) {
      const lines = topCard
        .split('\n')
        .map((l) => l.replace(/\s+/g, ' ').trim())
        .filter(Boolean);
      for (const line of lines) {
        const cleanedLine = cleanLinkedInHeadline(line);
        if (cleanedLine.title && looksLikeJobTitle(cleanedLine.title)) {
          jobTitle = cleanedLine.title;
          if (!company && cleanedLine.company) company = cleanedLine.company;
          break;
        }
        if (looksLikeJobTitle(line)) {
          jobTitle = line.split(/[|·@]/)[0].trim();
          break;
        }
      }
    } else if (safe) {
      for (const line of splitExperienceLines(safe)) {
        if (looksLikeJobTitle(line) && JOB_TITLE_HINT.test(line)) {
          jobTitle = line;
          break;
        }
      }
    }
  }

  // Final junk guard
  if (!looksLikeJobTitle(jobTitle) || isActivityOrFeedBlob(jobTitle)) jobTitle = '';
  if (isEducationText(company) || isAboutOrBioBlob(company) || isActivityOrFeedBlob(company) || !isValidScrapedText(company, 150)) {
    company = '';
  }

  if (!company && extraction.companyName && isValidScrapedText(String(extraction.companyName), 150)) {
    const cn = String(extraction.companyName);
    if (!isAboutOrBioBlob(cn) && !isEducationText(cn)) company = cn;
  }

  const about = String(sections?.about ?? sections?.summary ?? '')
    .replace(/^About\s*/i, '')
    .trim();
  const headlineOut =
    (cleaned.headline && looksLikeJobTitle(cleaned.headline.split(/[·|]/)[0] || cleaned.headline) && cleaned.headline) ||
    (rawHeadline && looksLikeJobTitle(rawHeadline.split(/[·|]/)[0] || rawHeadline) ? rawHeadline : '') ||
    jobTitle;

  const whatTheyDo = [headlineOut, about, experience.slice(0, 1200)]
    .filter(Boolean)
    .join('\n\n')
    .slice(0, 2500);

  return {
    jobTitle: jobTitle || '',
    company: company || '',
    headline: headlineOut || '',
    industry: extraction.industry,
    location: extraction.location,
    whatTheyDo,
    source: jobTitle || company ? 'linkedin' : 'crm',
  };
}

/** Prefer rich LinkedIn scrape; fall back to CRM fields so scoring never stalls. */
export function resolveRoleContext(
  extraction: PageExtraction,
  lead: CampaignLead,
): { role: LinkedInRoleInfo; scrapeUsable: boolean; scrapeNote?: string } {
  const scraped = extractRoleFromLinkedIn(extraction);
  const scrapeCheck = isLinkedInScrapeUsable(extraction, scraped);
  const crmTitle = isUsableFieldText(String(lead.job_title ?? '')) ? String(lead.job_title).trim() : '';
  const crmCompany = isUsableFieldText(String(lead.company_name ?? ''), 150)
    ? String(lead.company_name).trim()
    : '';

  const meta = extraction.metadata as Record<string, unknown> | undefined;
  console.log(
    `[lead-brain] scrape lead=${lead.id} usable=${scrapeCheck.usable} mode=${meta?.scrapeMode || '?'} headlineSrc=${meta?.headlineSource || '?'} name="${String(extraction.personName || '').slice(0, 60)}" title="${scraped.jobTitle || meta?.currentTitle || ''}" descChars=${String(extraction.description || '').length} expChars=${String((extraction.metadata as any)?.sections?.experience || '').length} desc="${String(extraction.description || '').slice(0, 140).replace(/\n/g, ' ')}" expPreview="${String((extraction.metadata as any)?.sections?.experience || '').slice(0, 120).replace(/\n/g, ' | ')}" note=${scrapeCheck.reason || 'ok'}`,
  );

  if (scrapeCheck.usable) {
    return {
      role: {
        ...scraped,
        jobTitle: scraped.jobTitle || crmTitle,
        company: scraped.company || crmCompany,
        industry: scraped.industry || lead.industry,
        source: scraped.jobTitle || scraped.company ? 'mixed' : 'crm',
        whatTheyDo:
          scraped.whatTheyDo ||
          [crmTitle, crmCompany, lead.industry, lead.job_level, lead.job_function]
            .filter(Boolean)
            .join(' · '),
      },
      scrapeUsable: true,
    };
  }

  return {
    role: {
      jobTitle: crmTitle,
      company: crmCompany,
      headline: crmTitle,
      industry: lead.industry ? String(lead.industry) : undefined,
      location: undefined,
      whatTheyDo: [
        crmTitle && `CRM job title: ${crmTitle}`,
        crmCompany && `CRM company: ${crmCompany}`,
        lead.industry && `Industry: ${lead.industry}`,
        lead.job_level && `Job level: ${lead.job_level}`,
        lead.job_function && `Job function: ${lead.job_function}`,
        lead.linkedin_headline && `Stored LinkedIn headline: ${lead.linkedin_headline}`,
      ]
        .filter(Boolean)
        .join('\n'),
      source: 'crm',
    },
    scrapeUsable: false,
    scrapeNote: scrapeCheck.reason,
  };
}

function strArr(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String).filter(Boolean);
  if (typeof v === 'string' && v.trim()) {
    return v.split(',').map((s) => s.trim()).filter(Boolean);
  }
  return [];
}

function matchesAny(value: string, candidates: string[]): boolean {
  if (!candidates.length) return true;
  const v = value.toLowerCase();
  return candidates.some((c) => {
    const t = c.toLowerCase();
    return v.includes(t) || t.includes(v);
  });
}

interface LeadFitAnalysis {
  fitScore: number;
  summary: string;
  recommendedJobTitle?: string;
  recommendedCompany?: string;
  overrideFields: IcpOverrideField[];
}

export function ruleBasedFitScore(
  role: LinkedInRoleInfo,
  lead: CampaignLead,
  campaignIcp: Record<string, unknown> | null | undefined,
  invalidFields: string[],
): LeadFitAnalysis {
  const icpTitles = strArr(campaignIcp?.job_title);
  const icpCompanies = strArr(campaignIcp?.company_name);
  const title = isUsableFieldText(role.jobTitle) ? role.jobTitle : '';
  const company = isUsableFieldText(role.company, 150) ? role.company : '';
  const src = role.source === 'crm' ? 'CRM' : 'profile';

  const titleOk = Boolean(title) && (!icpTitles.length || matchesAny(title, icpTitles));
  const companyOk = Boolean(company) && (!icpCompanies.length || matchesAny(company, icpCompanies));

  let score = 3;
  const reasons: string[] = [];

  if (titleOk) {
    score += 3;
    reasons.push(`${src} title "${title}" aligns with ICP`);
  } else if (title) {
    reasons.push(`${src} title "${title}" does not match ICP titles`);
  } else {
    reasons.push('no job title available in CRM or LinkedIn');
  }

  if (companyOk) {
    score += 2;
    reasons.push(`${src} company "${company}" aligns with ICP`);
  } else if (company) {
    reasons.push(`${src} company "${company}" does not match ICP`);
  }

  // Strong CRM/profile alignment → Ready-eligible
  if (titleOk && (companyOk || !icpCompanies.length)) score = Math.max(score, 8);
  if (!invalidFields.length && titleOk && companyOk) score = 8;

  const overrideFields: IcpOverrideField[] = [];
  if (score >= FIT_SCORE_READY_THRESHOLD) {
    if (title) overrideFields.push('job_title');
    if (company) overrideFields.push('company_name');
    for (const field of invalidFields) {
      const mapped = mapInvalidFieldToOverride(field);
      if (mapped && !overrideFields.includes(mapped)) overrideFields.push(mapped);
    }
  }

  return {
    fitScore: Math.min(10, Math.max(0, score)),
    summary: reasons.join('; ') || 'Rule-based ICP check (no LLM available)',
    recommendedJobTitle: title || undefined,
    recommendedCompany: company || undefined,
    overrideFields: [...new Set(overrideFields)],
  };
}

async function scoreLeadFitWithLlm(
  role: LinkedInRoleInfo,
  lead: CampaignLead,
  campaignId: number,
  campaignIcp: Record<string, unknown> | null | undefined,
  campaignIcpEnvelope: Record<string, unknown> | null | undefined,
  invalidFields: string[],
  extraction: PageExtraction,
  scrapeUsable: boolean,
): Promise<LeadFitAnalysis> {
  const clients = getLlmClients();
  if (!clients.length) {
    return ruleBasedFitScore(role, lead, campaignIcp, invalidFields);
  }

  const prompt = `You are Scout, a B2B lead qualification AI. Score how well this lead fits the campaign Ideal Customer Profile (ICP).

PRIMARY DATA: CRM fields already stored in Aura/Datahub (always available).
OPTIONAL DATA: LinkedIn scrape when present and usable.

CAMPAIGN ID: ${campaignId}

CAMPAIGN ICP (full details):
${JSON.stringify(campaignIcpEnvelope ?? campaignIcp ?? {}, null, 2)}

ICP TARGET CRITERIA (summary):
${JSON.stringify(campaignIcp ?? {}, null, 2)}

LEAD IN CRM (authoritative when LinkedIn scrape is weak/missing):
- Name: ${leadDisplayName(lead)}
- Job title: ${lead.job_title || 'unknown'}
- Company: ${lead.company_name || 'unknown'}
- Industry: ${lead.industry || 'unknown'}
- Job level: ${lead.job_level || 'unknown'}
- Job function: ${lead.job_function || 'unknown'}
- Stage: ${lead.stage || 'unknown'}
- ICP status: ${lead.lead_icp_status || 'unknown'}
- ICP invalid fields (not yet overridden): ${invalidFields.join(', ') || 'none'}
- Stored LinkedIn headline: ${lead.linkedin_headline || 'none'}

RESOLVED ROLE CONTEXT (source=${role.source}, linkedInScrapeUsable=${scrapeUsable}):
- Role/title: ${role.jobTitle || 'unknown'}
- Company: ${role.company || 'unknown'}
- Headline: ${role.headline || 'unknown'}
- Industry: ${role.industry || 'unknown'}
- Location: ${role.location || 'unknown'}
- What they do: ${role.whatTheyDo || extraction.rawText?.slice(0, 1200) || 'unknown'}

Score fitScore from 0 to 10:
- 9-10: Excellent fit — role/seniority/company clearly match ICP
- 8: Strong fit — worth moving to Ready (operator override)
- 5-7: Partial fit — notable gaps
- 0-4: Poor fit

Rules:
- Use semantic similarity (e.g. "Head of Growth" can match "Marketing Director" / "VP Marketing" if ICP implies growth/marketing leadership).
- If LinkedIn scrape is missing or weak, still score CRM vs ICP for information — but note in summary that current role is unverified.
- Trust LinkedIn over CRM only when scrape is usable and clearly better.
- fitScore >= 8 means a strong ICP match; Scout will only auto-Ready when LinkedIn scrape is usable.

Respond ONLY with valid JSON:
{
  "fitScore": number between 0 and 10,
  "summary": "one sentence explaining the score and data source (CRM and/or LinkedIn)",
  "recommendedJobTitle": "best job title to store in CRM",
  "recommendedCompany": "best company name to store in CRM"
}`;

  for (const { client, model, name } of clients) {
    try {
      const res = await client.chat.completions.create({
        model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.1,
        response_format: { type: 'json_object' },
      });
      const text = res.choices[0]?.message?.content || '{}';
      const parsed = JSON.parse(text) as {
        fitScore?: unknown;
        fit_score?: unknown;
        score?: unknown;
        summary?: string;
        recommendedJobTitle?: string;
        recommendedCompany?: string;
      };

      const fitScore =
        parseFitScore(parsed.fitScore) ??
        parseFitScore(parsed.fit_score) ??
        parseFitScore(parsed.score) ??
        5;

      const recommendedJobTitle =
        [parsed.recommendedJobTitle, role.jobTitle, lead.job_title]
          .map((v) => String(v ?? '').trim())
          .find((v) => isUsableFieldText(v)) || undefined;
      const recommendedCompany =
        [parsed.recommendedCompany, role.company, lead.company_name]
          .map((v) => String(v ?? '').trim())
          .find((v) => isUsableFieldText(v, 150)) || undefined;

      const overrideFields: IcpOverrideField[] = [];
      if (fitScore >= FIT_SCORE_READY_THRESHOLD) {
        if (recommendedJobTitle) overrideFields.push('job_title');
        if (recommendedCompany) overrideFields.push('company_name');
        for (const field of invalidFields) {
          const mapped = mapInvalidFieldToOverride(field);
          if (mapped && !overrideFields.includes(mapped)) overrideFields.push(mapped);
        }
      }

      console.log(
        `[lead-brain] LLM score lead=${lead.id} score=${fitScore} provider=${name} source=${role.source} role="${recommendedJobTitle ?? ''}"`,
      );

      return {
        fitScore,
        summary: parsed.summary || `LLM fit score ${fitScore}/10 (${name}, ${role.source})`,
        recommendedJobTitle,
        recommendedCompany,
        overrideFields: [...new Set(overrideFields)],
      };
    } catch (err) {
      if (isRateLimitError(err)) {
        console.warn(`[lead-brain] LLM rate limited (${name}), trying next provider…`);
        continue;
      }
      console.warn(`[lead-brain] LLM scoring failed (${name}):`, err instanceof Error ? err.message : err);
    }
  }

  console.warn(`[lead-brain] LLM unavailable for lead=${lead.id}, using rule-based score`);
  return ruleBasedFitScore(role, lead, campaignIcp, invalidFields);
}

function buildOperatorRole(
  lead: CampaignLead,
  confirmedJobTitle?: string,
  confirmedCompany?: string,
): LinkedInRoleInfo {
  const jobTitle = isUsableFieldText(String(confirmedJobTitle || lead.job_title || ''))
    ? String(confirmedJobTitle || lead.job_title).trim()
    : '';
  const company = isUsableFieldText(String(confirmedCompany || lead.company_name || ''), 150)
    ? String(confirmedCompany || lead.company_name).trim()
    : '';
  return {
    jobTitle,
    company,
    headline: jobTitle,
    industry: lead.industry ? String(lead.industry) : undefined,
    whatTheyDo: [jobTitle, company, lead.industry, lead.job_level, lead.job_function]
      .filter(Boolean)
      .join(' · '),
    source: 'operator',
  };
}

export function emptyCrmExtraction(lead: CampaignLead, url = ''): PageExtraction {
  return {
    url: normalizeLinkedInUrl(lead.linkedin_url) || url || '',
    title: leadDisplayName(lead),
    sourceType: 'linkedin',
    personName: leadDisplayName(lead),
    companyName: lead.company_name ? String(lead.company_name) : undefined,
    description: '',
    rawText: '',
    metadata: { scrapeMode: 'crm-only', operatorPath: true },
  };
}

export async function processLeadWithLinkedIn(input: {
  campaignId: number;
  lead: CampaignLead;
  extraction: PageExtraction;
  campaignIcp?: Record<string, unknown> | null;
  campaignIcpEnvelope?: Record<string, unknown> | null;
  aura: AuraConfig;
  autoApply?: boolean;
  /** Human confirmed role on LinkedIn — allows Ready without DOM scrape */
  operatorVerified?: boolean;
  confirmedJobTitle?: string;
  confirmedCompany?: string;
  /** After READY, move to QUEUED (Aura allows READY→QUEUED) */
  promoteToQueued?: boolean;
}): Promise<LeadProcessResult> {
  const {
    campaignId,
    lead,
    extraction,
    campaignIcp,
    campaignIcpEnvelope,
    aura,
    autoApply = false,
    operatorVerified = false,
    confirmedJobTitle,
    confirmedCompany,
    promoteToQueued = false,
  } = input;
  const linkedinUrl = normalizeLinkedInUrl(lead.linkedin_url) || extraction.url;
  const name = leadDisplayName(lead);

  let role: LinkedInRoleInfo;
  let scrapeUsable: boolean;
  let scrapeNote: string | undefined;

  if (operatorVerified) {
    role = buildOperatorRole(lead, confirmedJobTitle, confirmedCompany);
    scrapeUsable = true;
    scrapeNote = 'operator-verified';
  } else {
    const resolved = resolveRoleContext(extraction, lead);
    role = resolved.role;
    scrapeUsable = resolved.scrapeUsable;
    scrapeNote = resolved.scrapeNote;
  }

  const icpDoc = getLeadIcpDocument(lead as Record<string, unknown>);
  const invalidFields = getInvalidFields(icpDoc);

  // ── Apollo Company Enrichment (before LLM scoring) ─────────────────────
  const companyFields = ['company_employee_size', 'company_revenue_size', 'company_industry', 'company_website', 'company_city', 'company_state', 'company_country'];
  const missingCompanyFields = companyFields.filter(field => {
    const val = lead[field as keyof typeof lead];
    return !val || String(val).trim() === '';
  });

  if (missingCompanyFields.length > 0 && isApolloConfigured()) {
    console.log(`[lead-brain] lead=${lead.id} Apollo company enrichment for missing: ${missingCompanyFields.join(', ')}`);
    console.log(`[lead-brain] lead=${lead.id} company_name from CRM: "${lead.company_name}"`);
    
    const leadWithCompanyData: LeadWithCompanyData = {
      id: lead.id,
      campaign_id: lead.campaign_id || campaignId,
      company_name: lead.company_name ? String(lead.company_name) : undefined,
      company_employee_size: lead.company_employee_size ? String(lead.company_employee_size) : undefined,
      company_revenue_size: lead.company_revenue_size ? String(lead.company_revenue_size) : undefined,
      company_industry: lead.company_industry ? String(lead.company_industry) : undefined,
      company_website: lead.company_website ? String(lead.company_website) : undefined,
      company_city: lead.company_city ? String(lead.company_city) : undefined,
      company_state: lead.company_state ? String(lead.company_state) : undefined,
      company_country: lead.company_country ? String(lead.company_country) : undefined,
      company_enriched_at: lead.company_enriched_at ? String(lead.company_enriched_at) : undefined,
      company_last_verified_at: lead.company_last_verified_at ? String(lead.company_last_verified_at) : undefined,
      company_enrichment_source: lead.company_enrichment_source ? String(lead.company_enrichment_source) : undefined,
    };

    console.log(`[lead-brain] lead=${lead.id} company_name passed to enrichCompanyForLead: "${leadWithCompanyData.company_name}"`);

    const apolloResult = await enrichCompanyForLead(leadWithCompanyData);
    
    if (apolloResult.fields && Object.keys(apolloResult.fields).length > 0) {
      const merged = mergeCompanyEnrichmentIntoLead(
        leadWithCompanyData,
        apolloResult.fields,
        apolloResult.enrichedAt || new Date().toISOString()
      );
      
      // Update lead with enriched fields
      if (merged.updated.company_employee_size) lead.company_employee_size = merged.updated.company_employee_size;
      if (merged.updated.company_revenue_size) lead.company_revenue_size = merged.updated.company_revenue_size;
      if (merged.updated.company_industry) lead.company_industry = merged.updated.company_industry;
      if (merged.updated.company_website) lead.company_website = merged.updated.company_website;
      if (merged.updated.company_city) lead.company_city = merged.updated.company_city;
      if (merged.updated.company_state) lead.company_state = merged.updated.company_state;
      if (merged.updated.company_country) lead.company_country = merged.updated.company_country;
      if (merged.updated.company_enriched_at) lead.company_enriched_at = merged.updated.company_enriched_at;
      if (merged.updated.company_last_verified_at) lead.company_last_verified_at = merged.updated.company_last_verified_at;
      if (merged.updated.company_enrichment_source) lead.company_enrichment_source = merged.updated.company_enrichment_source;
      
      // Apply to Aura CRM if autoApply
      if (autoApply) {
        const payload: Record<string, unknown> = { campaign_id: campaignId };
        for (const field of merged.changedFields) {
          const val = (lead as Record<string, unknown>)[field];
          if (val && String(val).trim()) payload[field] = val;
        }
        if (Object.keys(payload).length > 1) {
          await updateCampaignLead(aura, lead.id, payload as any);
          console.log(`[lead-brain] lead=${lead.id} Aura updated with Apollo enriched fields: ${merged.changedFields.join(', ')}`);
        }
      }
      
      console.log(`[lead-brain] lead=${lead.id} Apollo enriched ${merged.changedFields.length} fields`);
    } else {
      console.log(`[lead-brain] lead=${lead.id} Apollo: ${apolloResult.error || 'no match found'}`);
    }
  } else if (missingCompanyFields.length > 0) {
    console.log(`[lead-brain] lead=${lead.id} Apollo not configured, skipping company enrichment`);
  }

  if (!scrapeUsable && !operatorVerified) {
    console.warn(`[lead-brain] lead=${lead.id} LinkedIn weak (${scrapeNote}) — scoring from CRM`);
  }

  const analysis = hasAI()
    ? await scoreLeadFitWithLlm(
        role,
        lead,
        campaignId,
        campaignIcp,
        campaignIcpEnvelope,
        invalidFields,
        extraction,
        scrapeUsable,
      )
    : ruleBasedFitScore(role, lead, campaignIcp, invalidFields);

  // Prefer human-confirmed title/company when applying
  if (operatorVerified) {
    if (confirmedJobTitle && isUsableFieldText(confirmedJobTitle)) {
      analysis.recommendedJobTitle = confirmedJobTitle.trim();
      if (!analysis.overrideFields.includes('job_title')) analysis.overrideFields.push('job_title');
    }
    if (confirmedCompany && isUsableFieldText(confirmedCompany, 150)) {
      analysis.recommendedCompany = confirmedCompany.trim();
      if (!analysis.overrideFields.includes('company_name')) analysis.overrideFields.push('company_name');
    }
  }

  const scoreClearsThreshold = analysis.fitScore >= FIT_SCORE_READY_THRESHOLD;
  const locationFix = resolveLocationOverrideFromIcp(icpDoc, campaignIcp);
  // Ready requires operator verify (or legacy scrape usable)
  const fitsIcp = scoreClearsThreshold && scrapeUsable;
  const confidence = analysis.fitScore / 10;
  const sourceLabel = operatorVerified
    ? 'operator-verified'
    : scrapeUsable
      ? 'LinkedIn+CRM'
      : 'CRM-only (preview)';

  console.log(
    `[lead-brain] lead=${lead.id} score=${analysis.fitScore} readyEligible=${fitsIcp} scrapeUsable=${scrapeUsable} operatorVerified=${operatorVerified} locationFix=${Boolean(locationFix)} title="${role.jobTitle}"`,
  );

  let summary = `${analysis.fitScore}/10 (${sourceLabel}) — ${analysis.summary}`;
  if (scoreClearsThreshold && !scrapeUsable) {
    summary += ` — open LinkedIn and Confirm to move to Ready/Queued`;
  }
  if (locationFix) {
    summary += ` · location override → ${[locationFix.company_city, locationFix.company_state, locationFix.company_country].filter(Boolean).join(', ')}`;
  }

  const result: LeadProcessResult = {
    leadId: lead.id,
    leadName: name,
    linkedinUrl: linkedinUrl || '',
    fitsIcp,
    confidence,
    fitScore: analysis.fitScore,
    summary,
    linkedInRole: role.jobTitle || undefined,
    linkedInCompany: role.company || undefined,
    recommendedJobTitle: analysis.recommendedJobTitle,
    recommendedCompany: analysis.recommendedCompany,
    overrideFields: scrapeUsable ? analysis.overrideFields : [],
    locationOverride: locationFix
      ? {
          company_country: locationFix.company_country,
          company_state: locationFix.company_state,
          company_city: locationFix.company_city,
        }
      : undefined,
    applied: false,
  };

  if (!autoApply) return result;

  const readyDecision = evaluateReadyDecision({
    fitScore: analysis.fitScore,
    threshold: FIT_SCORE_READY_THRESHOLD,
    operatorVerified,
    scrapeUsable,
    hasLocationFix: Boolean(locationFix),
    autoApply,
  });

  if (readyDecision.action === 'ready' && scoreClearsThreshold) {
    console.log(
      `[lead-brain] lead=${lead.id} score=${analysis.fitScore} passes threshold — auto-ready without manual confirm`,
    );
  }

  if (readyDecision.action === 'reject') {
    console.log(
      `[lead-brain] lead=${lead.id} below threshold (${analysis.fitScore} < ${FIT_SCORE_READY_THRESHOLD}) — needs LinkedIn Confirm`,
    );
    result.error = `Below threshold — scored ${analysis.fitScore}/10 from CRM. Needs LinkedIn Confirm to proceed.`;
    logLeadDecision({
      action: 'reject',
      leadId: lead.id,
      campaignId,
      fitScore: analysis.fitScore,
      threshold: FIT_SCORE_READY_THRESHOLD,
      reason: readyDecision.reason,
      source: sourceLabel,
      operatorVerified,
      scrapeUsable,
    });
    return result;
  }

  if (!readyDecision.shouldReady) {
    console.log(
      `[lead-brain] lead=${lead.id} below threshold (${analysis.fitScore} < ${FIT_SCORE_READY_THRESHOLD}) and no location fix, skipping save`,
    );
    logLeadDecision({
      action: 'skip',
      leadId: lead.id,
      campaignId,
      fitScore: analysis.fitScore,
      threshold: FIT_SCORE_READY_THRESHOLD,
      reason: readyDecision.reason,
      source: sourceLabel,
      operatorVerified,
      scrapeUsable,
    });
    return result;
  }

  try {
    let icpMessagesJson: string | undefined;
    let stageAfter: string | undefined;
    const applyRoleOverrides = fitsIcp || operatorVerified;

    if (icpDoc) {
      let updated = icpDoc;
      if (analysis.overrideFields.length && applyRoleOverrides) {
        updated = applyOverridesForFields(updated, analysis.overrideFields);
      }
      if (locationFix?.fieldsToOverride.length) {
        updated = applyLocationFieldOverrides(updated, locationFix.fieldsToOverride);
      }
      // Clear remaining invalids when role fit cleared threshold or operator confirmed
      if (applyRoleOverrides) {
        updated = applyAllInvalidFieldOverrides(updated);
      }
      icpMessagesJson = JSON.stringify(updated);
      stageAfter = deriveStageAfterOverride(String(lead.stage ?? ''), icpMessagesJson);
    }

    if (!stageAfter && String(lead.stage ?? '').toUpperCase() === 'NOT_ELIGIBLE') {
      // If location was the only remaining blocker and we overrode it, deriveStage may already be READY
      if (applyRoleOverrides || locationFix) stageAfter = 'READY';
    }

    // If location override didn't clear all invalids and score < 8 (and not operator confirm), don't force Ready
    if (stageAfter !== 'READY' && locationFix && !applyRoleOverrides && icpMessagesJson) {
      const stillBlocking = getInvalidFields(
        (() => {
          try {
            return JSON.parse(icpMessagesJson) as import('./types.js').IcpMessagesDoc;
          } catch {
            return null;
          }
        })(),
      );
      if (stillBlocking.length) {
        // Save location update only, stay Not Eligible
        const locPayload: Parameters<typeof updateCampaignLead>[2] = {
          campaign_id: campaignId,
          icp_messages: icpMessagesJson,
        };
        if (locationFix.company_country) locPayload.company_country = locationFix.company_country;
        if (locationFix.company_state) locPayload.company_state = locationFix.company_state;
        if (locationFix.company_city) locPayload.company_city = locationFix.company_city;
        await updateCampaignLead(aura, lead.id, locPayload);
        result.applied = true;
        result.summary += ' — location updated; other ICP fields still block Ready';
        return result;
      }
      stageAfter = 'READY';
    }

    if (!icpMessagesJson && !locationFix) {
      const payloadOnly: Parameters<typeof updateCampaignLead>[2] = {
        campaign_id: campaignId,
        stage: 'READY',
        lead_icp_status: 'VALID',
      };
      if (analysis.recommendedJobTitle && isUsableFieldText(analysis.recommendedJobTitle)) {
        payloadOnly.job_title = analysis.recommendedJobTitle.trim();
      }
      if (analysis.recommendedCompany && isUsableFieldText(analysis.recommendedCompany, 150)) {
        payloadOnly.company_name = analysis.recommendedCompany.trim();
      }
      await updateCampaignLead(aura, lead.id, payloadOnly);
      result.applied = true;
      result.stageAfter = 'READY';
      result.fitsIcp = true;
      logLeadDecision({
        action: 'ready',
        leadId: lead.id,
        campaignId,
        fitScore: analysis.fitScore,
        threshold: FIT_SCORE_READY_THRESHOLD,
        reason: readyDecision.reason,
        source: sourceLabel,
        stageAfter: 'READY',
        operatorVerified,
        scrapeUsable,
        method: 'icp-auto',
      });
      if (promoteToQueued) {
        await promoteLeadToQueued(aura, campaignId, lead.id, result, {
          fitScore: analysis.fitScore,
          source: sourceLabel,
          operatorVerified,
          scrapeUsable,
        });
      }
      return result;
    }

    const payload: Parameters<typeof updateCampaignLead>[2] = {
      campaign_id: campaignId,
    };
    if (icpMessagesJson) payload.icp_messages = icpMessagesJson;
    if (analysis.recommendedJobTitle && isUsableFieldText(analysis.recommendedJobTitle) && applyRoleOverrides) {
      payload.job_title = analysis.recommendedJobTitle.trim();
    }
    if (analysis.recommendedCompany && isUsableFieldText(analysis.recommendedCompany, 150) && applyRoleOverrides) {
      payload.company_name = analysis.recommendedCompany.trim();
    }
    if (locationFix?.company_country) payload.company_country = locationFix.company_country;
    if (locationFix?.company_state) payload.company_state = locationFix.company_state;
    if (locationFix?.company_city) payload.company_city = locationFix.company_city;
    if (stageAfter === 'READY') {
      payload.stage = 'READY';
      payload.lead_icp_status = 'VALID';
    }

    console.log(
      `[lead-brain] saving lead=${lead.id} stage=${stageAfter ?? 'unchanged'} location=${Boolean(locationFix)}`,
    );

    await updateCampaignLead(aura, lead.id, payload);

    const verified = await findCampaignLead(aura, campaignId, lead.id);
    const verifiedStage = String(verified?.stage ?? '').toUpperCase();
    result.applied = true;
    result.icpMessagesJson = icpMessagesJson;
    result.stageAfter = verifiedStage === 'READY' ? 'READY' : stageAfter;
    result.fitsIcp = result.stageAfter === 'READY';
    if (stageAfter === 'READY' && verifiedStage !== 'READY') {
      try {
        await updateCampaignLead(aura, lead.id, {
          campaign_id: campaignId,
          ...(icpMessagesJson ? { icp_messages: icpMessagesJson } : {}),
          stage: 'READY',
          lead_icp_status: 'VALID',
          ...(locationFix?.company_country ? { company_country: locationFix.company_country } : {}),
          ...(locationFix?.company_state ? { company_state: locationFix.company_state } : {}),
          ...(locationFix?.company_city ? { company_city: locationFix.company_city } : {}),
        });
        result.stageAfter = 'READY';
        result.fitsIcp = true;
      } catch {
        result.error = `Saved but stage is still ${verifiedStage || 'NOT_ELIGIBLE'}`;
      }
    }

    if (promoteToQueued && result.stageAfter === 'READY' && !result.error) {
      await promoteLeadToQueued(aura, campaignId, lead.id, result, {
        fitScore: analysis.fitScore,
        source: sourceLabel,
        operatorVerified,
        scrapeUsable,
      });
    }

    if (result.stageAfter === 'READY' && !result.error) {
      logLeadDecision({
        action: 'ready',
        leadId: lead.id,
        campaignId,
        fitScore: analysis.fitScore,
        threshold: FIT_SCORE_READY_THRESHOLD,
        reason: readyDecision.reason,
        source: sourceLabel,
        stageAfter: result.stageAfter,
        operatorVerified,
        scrapeUsable,
        method: 'icp-auto',
      });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Failed to apply lead update';
    console.error(`[lead-brain] lead=${lead.id} save failed:`, msg);
    result.error = msg;
  }

  return result;
}

async function promoteLeadToQueued(
  aura: AuraConfig,
  campaignId: number,
  leadId: number,
  result: LeadProcessResult,
  context?: {
    fitScore?: number;
    source?: string;
    operatorVerified?: boolean;
    scrapeUsable?: boolean;
  },
): Promise<void> {
  try {
    await updateCampaignLead(aura, leadId, {
      campaign_id: campaignId,
      stage: 'QUEUED',
    });
    const verified = await findCampaignLead(aura, campaignId, leadId);
    const stage = String(verified?.stage ?? '').toUpperCase();
    if (stage === 'QUEUED') {
      result.stageAfter = 'QUEUED';
      result.summary += ' → Queued';
      console.log(`[lead-brain] lead=${leadId} promoted READY → QUEUED`);
      logLeadDecision({
        action: 'queued',
        leadId,
        campaignId,
        fitScore: context?.fitScore,
        threshold: FIT_SCORE_READY_THRESHOLD,
        reason: 'promoted READY → QUEUED after ICP pass',
        source: context?.source,
        stageAfter: 'QUEUED',
        operatorVerified: context?.operatorVerified,
        scrapeUsable: context?.scrapeUsable,
        method: 'icp-auto',
      });
    } else {
      result.summary += ` — Ready but Queued failed (stage=${stage || '?'})`;
      console.warn(`[lead-brain] lead=${leadId} Queued promote failed, stage=${stage}`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Queued promote failed';
    result.summary += ` — Ready but Queued failed: ${msg}`;
    console.warn(`[lead-brain] lead=${leadId} Queued promote error:`, msg);
  }
}

export function buildLeadQueue(leads: CampaignLead[], stage = 'NOT_ELIGIBLE'): CampaignLead[] {
  return leads.filter((lead) => {
    const s = String(lead.stage ?? '').trim().toUpperCase();
    if (s !== stage.toUpperCase()) return false;
    return Boolean(normalizeLinkedInUrl(lead.linkedin_url));
  });
}
