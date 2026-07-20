import OpenAI from 'openai';
import { hasAI } from '../ai.js';
import {
  fetchOrganisationById,
  leadDisplayName,
  leadOrgEntityId,
  organisationWebsite,
  updateCampaignLead,
  type OrganisationDetail,
} from './client.js';
import {
  applyAllInvalidFieldOverrides,
  getLeadIcpDocument,
  resolveLocationOverrideFromIcp,
  applyLocationFieldOverrides,
} from './icp.js';
import { FIT_SCORE_READY_THRESHOLD } from './lead-brain.js';
import {
  scrapeCompanyWebsite,
  scrapeLinkedInProfile,
  type LinkedInProfileScrape,
  type WebsiteScrape,
} from './puppeteer-scrape.js';
import type { AuraConfig, CampaignLead, LeadProcessResult } from './types.js';

export interface AuraEditSnapshot {
  leadId: number;
  name: string;
  job_title: string;
  job_function: string;
  job_level: string;
  company_name: string;
  company_revenue_size: string;
  company_employee_size: string;
  industry: string;
  linkedin_url: string;
  company_website: string | null;
  org_revenue_range: string;
  org_employee_range: string;
}

function str(v: unknown): string {
  return v == null ? '' : String(v).trim();
}

export function buildAuraEditSnapshot(
  lead: CampaignLead,
  org: OrganisationDetail | null,
): AuraEditSnapshot {
  return {
    leadId: lead.id,
    name: leadDisplayName(lead),
    job_title: str(lead.job_title),
    job_function: str(lead.job_function),
    job_level: str(lead.job_level),
    company_name: str(lead.company_name),
    company_revenue_size: str(lead.company_revenue_size),
    company_employee_size: str(lead.company_employee_size),
    industry: str(lead.industry),
    linkedin_url: str(lead.linkedin_url),
    company_website: organisationWebsite(org),
    org_revenue_range: str(org?.revenue_range || org?.revenue_min || ''),
    org_employee_range: str(org?.employee_count_range || ''),
  };
}

interface VerifyJudgment {
  /** Aura Edit fields consistent with LinkedIn + website */
  fieldMatches: boolean;
  nameOk: boolean;
  titleOk: boolean;
  functionOk: boolean;
  levelOk: boolean;
  companyOk: boolean;
  revenueOk: boolean;
  websiteOk: boolean;
  fieldSummary: string;
  /** Separate LLM ICP fit score (0–10) — justifies submitting the lead */
  icpScore: number;
  icpJustification: string;
  /** Ready only when fieldMatches && icpScore >= threshold */
  matches: boolean;
  fitScore: number;
  summary: string;
}

function getLlmClient(): { client: OpenAI; model: string } | null {
  if (!hasAI()) return null;
  const groqKey = process.env.GROQ_API_KEY;
  const openaiKey = process.env.OPENAI_API_KEY;
  if (groqKey && !groqKey.startsWith('gsk_your')) {
    return {
      client: new OpenAI({ apiKey: groqKey, baseURL: 'https://api.groq.com/openai/v1' }),
      model: process.env.GROQ_MODEL || 'llama-3.3-70b-versatile',
    };
  }
  if (openaiKey && !openaiKey.startsWith('sk-your')) {
    return {
      client: new OpenAI({ apiKey: openaiKey }),
      model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
    };
  }
  return null;
}

function ruleFieldMatch(
  aura: AuraEditSnapshot,
  li: LinkedInProfileScrape,
  web: WebsiteScrape,
): Pick<
  VerifyJudgment,
  | 'fieldMatches'
  | 'nameOk'
  | 'titleOk'
  | 'functionOk'
  | 'levelOk'
  | 'companyOk'
  | 'revenueOk'
  | 'websiteOk'
  | 'fieldSummary'
> {
  const nameOk =
    Boolean(aura.name) &&
    Boolean(li.personName) &&
    (li.personName.toLowerCase().includes(aura.name.split(' ')[0]?.toLowerCase() || '') ||
      aura.name.toLowerCase().includes(li.personName.split(' ')[0]?.toLowerCase() || ''));

  const titleBlob = `${li.currentTitle} ${li.headline} ${li.experienceText}`.toLowerCase();
  const liHasTitle = Boolean(String(li.currentTitle || li.headline || '').trim());

  // Only score title when LinkedIn returned a title/headline — missing LI title is not a hard fail
  const titleOk =
    !liHasTitle ||
    !aura.job_title ||
    titleBlob.includes(aura.job_title.toLowerCase()) ||
    aura.job_title
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length > 3)
      .some((w) => titleBlob.includes(w)) ||
    aura.job_title
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length > 4)
      .some((w) => titleBlob.includes(w));

  const functionHints: Record<string, RegExp> = {
    sales: /\b(sales|account executive|business development|bdr|ae)\b/i,
    marketing: /\b(marketing|growth|demand gen|brand|comms|communications)\b/i,
    product: /\b(product|pm\b|product management)\b/i,
    engineering: /\b(engineer|developer|software|technical)\b/i,
    'business development': /\b(business development|partnerships|alliances|bdr)\b/i,
    advertising: /\b(advertising|ads|media|marketing)\b/i,
  };
  const fnKey = aura.job_function.toLowerCase();
  const functionOk =
    !aura.job_function ||
    titleBlob.includes(fnKey) ||
    `${li.about} ${li.rawText}`.toLowerCase().includes(fnKey) ||
    Object.entries(functionHints).some(
      ([k, re]) => (fnKey.includes(k) || k.includes(fnKey)) && re.test(titleBlob),
    );

  const levelHints: Record<string, RegExp> = {
    director: /\b(director|head of|vp|vice president|chief)\b/i,
    manager: /\b(manager|lead|head)\b/i,
    vp: /\b(vp|vice president|svp|evp|avp)\b/i,
    'c-level': /\b(ceo|cto|cfo|coo|cmo|cro|chief)\b/i,
    executive: /\b(executive|director|vp|chief|president)\b/i,
    founder: /\b(founder|co-founder|owner)\b/i,
    senior: /\b(senior|sr\.?|lead|principal)\b/i,
  };
  const levelKey = aura.job_level.toLowerCase();
  const levelOk =
    !aura.job_level ||
    titleBlob.includes(levelKey) ||
    Object.entries(levelHints).some(
      ([k, re]) => (levelKey.includes(k) || k.includes(levelKey)) && re.test(titleBlob),
    ) ||
    /director|vp|head|manager|chief|founder|partner|executive/i.test(titleBlob);

  const companyBlob =
    `${li.currentCompany} ${li.headline} ${li.experienceText} ${web.title} ${web.description} ${web.bodyText}`.toLowerCase();
  const liHasCompanySignal = Boolean(
    String(li.currentCompany || '').trim() ||
      /\s+(at|@|chez|bei)\s+/i.test(li.headline || '') ||
      String(li.experienceText || '').trim().length > 40,
  );
  const companyOk =
    !liHasCompanySignal ||
    !aura.company_name ||
    companyBlob.includes(aura.company_name.toLowerCase()) ||
    aura.company_name
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length > 2)
      .some((w) => companyBlob.includes(w));

  // Revenue: LinkedIn rarely has it — use org field + website signals; don't block unless clearly contradicted
  const revenueTarget = (aura.company_revenue_size || aura.org_revenue_range).toLowerCase();
  const webBlob = `${web.title} ${web.description} ${web.bodyText}`.toLowerCase();
  const revenueOk =
    !revenueTarget ||
    webBlob.includes(revenueTarget) ||
    // Accept when website loads and Aura has a revenue value (LLM will refine)
    Boolean(web.title || web.bodyText.length > 80 || web.error);

  const websiteOk =
    !aura.company_website ||
    (!web.error && (web.bodyText.length > 80 || Boolean(web.title))) ||
    Boolean(web.error);

  // Name must match; title/company only fail when LinkedIn returned conflicting data
  const fieldMatches = nameOk && titleOk && companyOk;

  return {
    fieldMatches,
    nameOk,
    titleOk,
    functionOk,
    levelOk,
    companyOk,
    revenueOk,
    websiteOk: Boolean(websiteOk),
    fieldSummary: [
      nameOk ? 'name matches LinkedIn' : 'name mismatch',
      liHasTitle ? (titleOk ? 'title aligns' : 'title mismatch') : 'title not on LinkedIn scrape (skipped)',
      companyOk
        ? 'company aligns'
        : liHasCompanySignal
          ? 'company mismatch'
          : 'company not on LinkedIn scrape (skipped)',
      functionOk ? 'function ok' : 'function unclear vs LinkedIn',
      levelOk ? 'level ok' : 'level unclear vs LinkedIn',
      revenueOk ? 'revenue plausible' : 'revenue unclear',
      web.error ? `website: ${web.error}` : websiteOk ? 'website readable' : 'website weak',
    ].join('; '),
  };
}

/** Stage 1: confirm Aura Edit details match LinkedIn + website */
async function verifyFieldsMatch(
  aura: AuraEditSnapshot,
  li: LinkedInProfileScrape,
  web: WebsiteScrape,
): Promise<ReturnType<typeof ruleFieldMatch>> {
  // Never trust LLM when LinkedIn scrape has no person name
  if (!String(li.personName || '').trim()) {
    return {
      fieldMatches: false,
      nameOk: false,
      titleOk: false,
      functionOk: false,
      levelOk: false,
      companyOk: false,
      revenueOk: true,
      websiteOk: Boolean(web.title || web.bodyText || web.error),
      fieldSummary: 'LinkedIn scrape empty (no person name) — cannot verify Aura fields',
    };
  }

  const fallback = ruleFieldMatch(aura, li, web);
  const llm = getLlmClient();
  if (!llm) return fallback;

  const prompt = `Verify Aura Edit lead details against LinkedIn + company website. Do NOT score campaign ICP fit yet — only field consistency.

IMPORTANT:
- If LinkedIn personName or currentTitle are missing/empty, set fieldMatches=false. Never invent LinkedIn data.
- Recheck these Aura Edit fields against LinkedIn (and website for company/revenue):
  job_title, job_function, job_level, company_name, company_revenue_size / org_revenue_range.
- titleOk: Aura job_title consistent with LinkedIn currentTitle/headline/experience.
- functionOk: Aura job_function plausible given LinkedIn title/about (e.g. Marketing ↔ Marketing Manager).
- levelOk: Aura job_level plausible (Manager/Director/VP/etc.) given LinkedIn title.
- revenueOk: Aura revenue range not contradicted by website; if website has no revenue signal, revenueOk can be true when company otherwise matches.
- companyOk: Aura company_name matches LinkedIn currentCompany/experience or website.

AURA EDIT:
${JSON.stringify(aura, null, 2)}

LINKEDIN:
${JSON.stringify(
  {
    personName: li.personName,
    headline: li.headline,
    currentTitle: li.currentTitle,
    currentCompany: li.currentCompany,
    about: li.about?.slice(0, 1000),
    experienceText: li.experienceText?.slice(0, 1800),
  },
  null,
  2,
)}

WEBSITE:
${JSON.stringify(
  {
    url: web.url,
    title: web.title,
    description: web.description,
    bodyPreview: web.bodyText?.slice(0, 2000),
    error: web.error || null,
  },
  null,
  2,
)}

Return JSON only:
{
  "fieldMatches": boolean,
  "nameOk": boolean,
  "titleOk": boolean,
  "functionOk": boolean,
  "levelOk": boolean,
  "companyOk": boolean,
  "revenueOk": boolean,
  "websiteOk": boolean,
  "fieldSummary": "short"
}

fieldMatches=true when nameOk is true and any LinkedIn title/company that WAS scraped is consistent with Aura. If LinkedIn did not return title or company, do not fail those checks — only verify fields that are present.`;

  try {
    const res = await llm.client.chat.completions.create({
      model: llm.model,
      temperature: 0.1,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: 'Scout field verifier. JSON only. Never invent LinkedIn fields.' },
        { role: 'user', content: prompt },
      ],
    });
    const parsed = JSON.parse(res.choices[0]?.message?.content || '{}') as Partial<
      ReturnType<typeof ruleFieldMatch>
    >;
    // Gate LLM optimism: require rule name match OR explicit LLM nameOk with real LI name
    const nameOk = Boolean(parsed.nameOk ?? fallback.nameOk) && Boolean(li.personName);
    const fieldMatches =
      Boolean(parsed.fieldMatches ?? fallback.fieldMatches) && nameOk && fallback.nameOk;
    return {
      fieldMatches,
      nameOk,
      titleOk: parsed.titleOk ?? fallback.titleOk,
      functionOk: parsed.functionOk ?? fallback.functionOk,
      levelOk: parsed.levelOk ?? fallback.levelOk,
      companyOk: parsed.companyOk ?? fallback.companyOk,
      revenueOk: parsed.revenueOk ?? fallback.revenueOk,
      websiteOk: parsed.websiteOk ?? fallback.websiteOk,
      fieldSummary: String(parsed.fieldSummary || fallback.fieldSummary),
    };
  } catch (err) {
    console.warn('[lead-verify] field LLM failed:', err instanceof Error ? err.message : err);
    return fallback;
  }
}

/** Stage 2: LLM ICP score — justify that this verified lead is good for the campaign */
async function scoreIcpFitWithLlm(
  aura: AuraEditSnapshot,
  li: LinkedInProfileScrape,
  web: WebsiteScrape,
  campaignIcp: Record<string, unknown> | null,
  fieldSummary: string,
): Promise<{ icpScore: number; icpJustification: string }> {
  const llm = getLlmClient();
  if (!llm) {
    // Soft fallback without LLM: fields already matched → mid-high score
    return {
      icpScore: 8,
      icpJustification:
        'No LLM configured — fields matched LinkedIn/website; defaulting ICP score to 8. Set GROQ_API_KEY for real scoring.',
    };
  }

  const prompt = `You are Scout. Aura Edit details already matched LinkedIn + company website.
Now score whether this lead is a STRONG fit to SUBMIT for the campaign ICP.

FIELD MATCH SUMMARY: ${fieldSummary}

Recheck against campaign ICP using:
- job title / function / level from LinkedIn (verified)
- company + revenue/employee signals from Aura Edit + website
- website quality for B2B outreach

AURA EDIT (verified):
${JSON.stringify(aura, null, 2)}

CAMPAIGN ICP:
${JSON.stringify(campaignIcp || {}, null, 2)}

LINKEDIN (verified scrape):
${JSON.stringify(
  {
    personName: li.personName,
    headline: li.headline,
    currentTitle: li.currentTitle,
    currentCompany: li.currentCompany,
    about: li.about?.slice(0, 1200),
    experienceText: li.experienceText?.slice(0, 2000),
  },
  null,
  2,
)}

COMPANY WEBSITE:
${JSON.stringify(
  {
    url: web.url,
    title: web.title,
    description: web.description,
    bodyPreview: web.bodyText?.slice(0, 2200),
  },
  null,
  2,
)}

Score icpScore 0–10 for campaign fit (title/level/function, company size/revenue/industry, website quality for B2B outreach).
Require icpScore >= ${FIT_SCORE_READY_THRESHOLD} only for clear ICP alignment.

Return JSON only:
{
  "icpScore": number,
  "icpJustification": "2-4 sentences justifying why this lead is or is not good to submit"
}`;

  try {
    const res = await llm.client.chat.completions.create({
      model: llm.model,
      temperature: 0.2,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content: 'Scout ICP scorer. Justify campaign fit. JSON only.',
        },
        { role: 'user', content: prompt },
      ],
    });
    const parsed = JSON.parse(res.choices[0]?.message?.content || '{}') as {
      icpScore?: unknown;
      icpJustification?: unknown;
    };
    const icpScore = Math.min(10, Math.max(0, Number(parsed.icpScore) || 0));
    return {
      icpScore,
      icpJustification: String(
        parsed.icpJustification || `ICP score ${icpScore}/10`,
      ).slice(0, 800),
    };
  } catch (err) {
    console.warn('[lead-verify] ICP LLM failed:', err instanceof Error ? err.message : err);
    return {
      icpScore: 0,
      icpJustification: `ICP scoring failed: ${err instanceof Error ? err.message : 'error'}`,
    };
  }
}

async function fullVerify(
  aura: AuraEditSnapshot,
  li: LinkedInProfileScrape,
  web: WebsiteScrape,
  campaignIcp: Record<string, unknown> | null,
): Promise<VerifyJudgment> {
  const fields = await verifyFieldsMatch(aura, li, web);
  if (!fields.fieldMatches) {
    return {
      ...fields,
      icpScore: 0,
      icpJustification: 'Skipped ICP scoring — Aura Edit fields did not match LinkedIn/website',
      matches: false,
      fitScore: 0,
      summary: `Fields failed — ${fields.fieldSummary}`,
    };
  }

  console.log(`[lead-verify] lead=${aura.leadId} fields OK — running LLM ICP score…`);
  const { icpScore, icpJustification } = await scoreIcpFitWithLlm(
    aura,
    li,
    web,
    campaignIcp,
    fields.fieldSummary,
  );
  const scoreOk = icpScore >= FIT_SCORE_READY_THRESHOLD;
  const matches = fields.fieldMatches && scoreOk;

  return {
    ...fields,
    icpScore,
    icpJustification,
    matches,
    fitScore: icpScore,
    summary: matches
      ? `Fields OK · ICP ${icpScore}/10 — ${icpJustification}`
      : `Fields OK but ICP ${icpScore}/10 < ${FIT_SCORE_READY_THRESHOLD} — ${icpJustification}`,
  };
}

export async function verifyLeadWithPuppeteer(input: {
  campaignId: number;
  lead: CampaignLead;
  campaignIcp?: Record<string, unknown> | null;
  aura: AuraConfig;
  autoApply?: boolean;
  promoteToQueued?: boolean;
}): Promise<LeadProcessResult & { judgment?: VerifyJudgment; auraEdit?: AuraEditSnapshot }> {
  const { campaignId, lead, campaignIcp, aura, autoApply = true, promoteToQueued = true } = input;
  const name = leadDisplayName(lead);
  const linkedinUrl = str(lead.linkedin_url);

  const orgId = leadOrgEntityId(lead);
  const org = orgId ? await fetchOrganisationById(aura, orgId) : null;
  const auraEdit = buildAuraEditSnapshot(lead, org);

  console.log(
    `[lead-verify] lead=${lead.id} name="${auraEdit.name}" title="${auraEdit.job_title}" company="${auraEdit.company_name}" website=${auraEdit.company_website || '—'}`,
  );

  if (!linkedinUrl) {
    return {
      leadId: lead.id,
      leadName: name,
      linkedinUrl: '',
      fitsIcp: false,
      confidence: 0,
      fitScore: 0,
      summary: 'No LinkedIn URL on lead',
      overrideFields: [],
      applied: false,
      error: 'No LinkedIn URL',
      skipped: true,
      skipReason: 'No LinkedIn URL',
      auraEdit,
    };
  }

  let li: LinkedInProfileScrape;
  try {
    console.log(`[lead-verify] lead=${lead.id} opening LinkedIn ${linkedinUrl}`);
    li = await scrapeLinkedInProfile(linkedinUrl);
    if (li.error) {
      console.warn(
        `[lead-verify] lead=${lead.id} LinkedIn scrape error: ${li.error} loggedIn=${li.loggedIn} name="${li.personName}" title="${li.currentTitle}"`,
      );
    } else {
      console.log(
        `[lead-verify] lead=${lead.id} LinkedIn ok loggedIn=${li.loggedIn} name="${li.personName}" title="${li.currentTitle}" company="${li.currentCompany}"`,
      );
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'LinkedIn Puppeteer failed';
    console.warn(`[lead-verify] lead=${lead.id} LinkedIn scrape failed:`, msg);
    return {
      leadId: lead.id,
      leadName: name,
      linkedinUrl,
      fitsIcp: false,
      confidence: 0,
      fitScore: 0,
      summary: msg,
      overrideFields: [],
      applied: false,
      error: msg,
      auraEdit,
    };
  }

  if (
    !li.loggedIn ||
    /^join linkedin$/i.test(String(li.personName || '').trim()) ||
    !String(li.personName || '').trim()
  ) {
    const msg =
      (!li.loggedIn && li.error) ||
      (!String(li.personName || '').trim()
        ? li.error ||
          'LinkedIn profile scrape empty — no name found. Not a real field mismatch; retry after scrape works.'
        : 'LinkedIn login required — sign in in the Scout Chrome window, then Run again');
    return {
      leadId: lead.id,
      leadName: name,
      linkedinUrl,
      fitsIcp: false,
      confidence: 0,
      fitScore: 0,
      summary: msg,
      overrideFields: [],
      applied: false,
      error: msg,
      auraEdit,
    };
  }

  // Title/company/headline may be partial — still verify what LinkedIn returned
  if (li.error && String(li.currentTitle || '').trim()) {
    console.warn(`[lead-verify] lead=${lead.id} clearing soft scrape warning (have title): ${li.error}`);
    delete li.error;
  } else if (li.error && String(li.personName || '').trim()) {
    console.warn(
      `[lead-verify] lead=${lead.id} continuing with partial LinkedIn data: ${li.error} title="${li.currentTitle}" headline="${li.headline}"`,
    );
    delete li.error;
  }

  let web: WebsiteScrape = {
    url: auraEdit.company_website || '',
    title: '',
    description: '',
    bodyText: '',
  };
  if (auraEdit.company_website) {
    try {
      web = await scrapeCompanyWebsite(auraEdit.company_website);
    } catch (err) {
      web = {
        url: auraEdit.company_website,
        title: '',
        description: '',
        bodyText: '',
        error: err instanceof Error ? err.message : 'Website scrape failed',
      };
    }
  }

  const judgment = await fullVerify(auraEdit, li, web, campaignIcp || null);
  console.log(
    `[lead-verify] lead=${lead.id} fields=${judgment.fieldMatches} icp=${judgment.icpScore} ready=${judgment.matches} — ${judgment.summary}`,
  );

  const result: LeadProcessResult & { judgment?: VerifyJudgment; auraEdit?: AuraEditSnapshot } = {
    leadId: lead.id,
    leadName: name,
    linkedinUrl,
    fitsIcp: judgment.matches,
    confidence: judgment.fitScore / 10,
    fitScore: judgment.fitScore,
    summary: `${judgment.fitScore}/10 (fields+ICP) — ${judgment.summary}`,
    linkedInRole: li.currentTitle || undefined,
    linkedInCompany: li.currentCompany || undefined,
    recommendedJobTitle: li.currentTitle || auraEdit.job_title || undefined,
    recommendedCompany: li.currentCompany || auraEdit.company_name || undefined,
    overrideFields: judgment.matches ? ['job_title', 'company_name'] : [],
    applied: false,
    judgment,
    auraEdit,
  };

  if (!autoApply || !judgment.matches) {
    if (!judgment.matches) {
      result.error = judgment.fieldMatches
        ? `ICP score ${judgment.icpScore}/10 too low — ${judgment.icpJustification}`
        : `Verification failed — ${judgment.fieldSummary}`;
    }
    return result;
  }

  // Apply Ready (+ optional Queued)
  try {
    const icpDoc = getLeadIcpDocument(lead as Record<string, unknown>);
    const locationFix = resolveLocationOverrideFromIcp(icpDoc, campaignIcp);
    let icpMessagesJson: string | undefined;
    if (icpDoc) {
      let updated = applyAllInvalidFieldOverrides(icpDoc);
      if (locationFix?.fieldsToOverride.length) {
        updated = applyLocationFieldOverrides(updated, locationFix.fieldsToOverride);
      }
      icpMessagesJson = JSON.stringify(updated);
    }

    const payload: Parameters<typeof updateCampaignLead>[2] = {
      campaign_id: campaignId,
      stage: 'READY',
      lead_icp_status: 'VALID',
    };
    if (icpMessagesJson) payload.icp_messages = icpMessagesJson;
    if (result.recommendedJobTitle) payload.job_title = result.recommendedJobTitle;
    if (result.recommendedCompany) payload.company_name = result.recommendedCompany;
    if (locationFix?.company_country) payload.company_country = locationFix.company_country;
    if (locationFix?.company_state) payload.company_state = locationFix.company_state;
    if (locationFix?.company_city) payload.company_city = locationFix.company_city;

    await updateCampaignLead(aura, lead.id, payload);
    result.applied = true;
    result.stageAfter = 'READY';
    result.fitsIcp = true;

    if (promoteToQueued) {
      try {
        await updateCampaignLead(aura, lead.id, { campaign_id: campaignId, stage: 'QUEUED' });
        result.stageAfter = 'QUEUED';
        result.summary += ` → Queued · ICP ${judgment.icpScore}/10: ${judgment.icpJustification.slice(0, 200)}`;
      } catch {
        result.summary += ` — Ready (Queued promote failed) · ICP ${judgment.icpScore}/10`;
      }
    } else {
      result.summary += ` · ICP ${judgment.icpScore}/10: ${judgment.icpJustification.slice(0, 200)}`;
    }
  } catch (err) {
    result.error = err instanceof Error ? err.message : 'Failed to set Ready';
    result.applied = false;
  }

  return result;
}
