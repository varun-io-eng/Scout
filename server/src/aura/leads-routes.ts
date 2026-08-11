import { Router } from 'express';
import { z } from 'zod';
import {
  deleteCampaignLeads,
  enrichCampaignLead,
  findCampaignLead,
  getCampaignIcp,
  getCampaignIcpEnvelope,
  leadDisplayName,
  linkedInProfileSlug,
  listCampaignLeads,
  namesLooselyMatch,
  normalizeLinkedInUrl,
  updateCampaignLead,
} from './client.js';
import { buildLeadQueue, emptyCrmExtraction, processLeadWithLinkedIn } from './lead-brain.js';
import type { AutomationRunResult, AuraConfig, CampaignLead, LeadProcessResult } from './types.js';
import type { PageExtraction } from '../types.js';
import {
  enrichCompanyForLead,
  batchEnrichCompaniesForLeads,
  mergeCompanyEnrichmentIntoLead,
  isApolloConfigured,
  type LeadWithCompanyData,
} from './apollo-company-enrichment.js';
import { logLeadDecision } from '../decision-log.js';

async function hydrateLeadFromApi(
  aura: AuraConfig,
  campaignId: number,
  lead: Record<string, unknown>,
): Promise<CampaignLead> {
  const leadId = Number(lead.id);
  if (Number.isFinite(leadId) && leadId > 0) {
    // Best-effort official enrich before scoring
    await enrichCampaignLead(aura, leadId);
  }
  const fresh = Number.isFinite(leadId) ? await findCampaignLead(aura, campaignId, leadId) : null;
  return { ...(fresh ?? {}), ...lead, id: leadId } as CampaignLead;
}

const auraConfigSchema = z.object({
  datahubBaseUrl: z.string().url(),
  authToken: z.string().min(10),
});

const extractionSchema = z.object({
  url: z.string(),
  title: z.string(),
  sourceType: z.enum(['linkedin', 'website', 'crunchbase', 'news', 'manual', 'other']),
  companyName: z.string().optional(),
  personName: z.string().optional(),
  description: z.string().optional(),
  industry: z.string().optional(),
  location: z.string().optional(),
  employeeCount: z.string().optional(),
  funding: z.string().optional(),
  technologies: z.array(z.string()).optional(),
  rawText: z.string(),
  metadata: z.record(z.unknown()).optional(),
});

const processOptionsSchema = z.object({
  campaignId: z.number(),
  lead: z.record(z.unknown()),
  extraction: extractionSchema.optional(),
  autoApply: z.boolean().optional(),
  operatorVerified: z.boolean().optional(),
  confirmedJobTitle: z.string().optional(),
  confirmedCompany: z.string().optional(),
  promoteToQueued: z.boolean().optional(),
  aura: auraConfigSchema,
});

function serializeLead(lead: CampaignLead) {
  return {
    ...lead,
    name: leadDisplayName(lead),
    jobTitle: lead.job_title,
    company: lead.company_name,
    linkedinUrl: normalizeLinkedInUrl(lead.linkedin_url),
    linkedinSlug: linkedInProfileSlug(lead.linkedin_url),
    leadIcpStatus: lead.lead_icp_status,
    stage: lead.stage,
  };
}

export function createLeadRoutes(): Router {
  const router = Router();

  router.get('/leads/queue/:campaignId', async (req, res) => {
    try {
      const campaignId = Number(req.params.campaignId);
      if (!Number.isFinite(campaignId)) {
        return res.status(400).json({ error: 'Invalid campaign ID' });
      }

      const aura = auraConfigSchema.parse({
        datahubBaseUrl: req.headers['x-datahub-url'] || req.query.datahubUrl,
        authToken: req.headers['x-aura-token'] || req.query.token,
      });

      const stage = String(req.query.stage || 'NOT_ELIGIBLE');
      const leads = await listCampaignLeads(aura, campaignId, { limit: 500 });
      const queue = buildLeadQueue(leads, stage);

      res.json({
        campaignId,
        stage,
        total: leads.length,
        queue: queue.map(serializeLead),
      });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Queue fetch failed' });
    }
  });

  /** Resolve a campaign lead from an open LinkedIn profile (any stage). */
  router.get('/leads/resolve/:campaignId', async (req, res) => {
    try {
      const campaignId = Number(req.params.campaignId);
      if (!Number.isFinite(campaignId)) {
        return res.status(400).json({ error: 'Invalid campaign ID' });
      }

      const aura = auraConfigSchema.parse({
        datahubBaseUrl: req.headers['x-datahub-url'] || req.query.datahubUrl,
        authToken: req.headers['x-aura-token'] || req.query.token,
      });

      const linkedinUrl = String(req.query.linkedinUrl || '');
      const personName = String(req.query.personName || req.query.name || '');
      const leadId = Number(req.query.leadId || 0);
      const slug = linkedInProfileSlug(linkedinUrl);

      const leads = await listCampaignLeads(aura, campaignId, { limit: 500 });
      let match: CampaignLead | null = null;
      let matchReason = '';

      if (Number.isFinite(leadId) && leadId > 0) {
        match = leads.find((l) => Number(l.id) === leadId) || null;
        if (match) matchReason = 'leadId';
      }

      if (!match && slug) {
        match =
          leads.find((l) => linkedInProfileSlug(l.linkedin_url) === slug) || null;
        if (match) matchReason = 'linkedinSlug';
      }

      if (!match && personName) {
        const candidates = leads.filter((l) =>
          namesLooselyMatch(personName, leadDisplayName(l)),
        );
        // Prefer Not Eligible when multiple name matches
        match =
          candidates.find((l) => String(l.stage || '').toUpperCase() === 'NOT_ELIGIBLE') ||
          candidates[0] ||
          null;
        if (match) matchReason = 'name';
      }

      const stage = match ? String(match.stage || '').toUpperCase() : '';
      console.log(
        `[leads/resolve] campaign=${campaignId} slug=${slug || '—'} name="${personName}" leadId=${leadId || '—'} → ${
          match ? `lead=${match.id} stage=${stage} via=${matchReason}` : 'no match'
        }`,
      );

      if (!match) {
        return res.json({
          found: false,
          campaignId,
          slug,
          reason: 'No campaign lead matches this LinkedIn profile',
        });
      }

      res.json({
        found: true,
        campaignId,
        matchReason,
        slug,
        stage,
        processable: stage === 'NOT_ELIGIBLE',
        lead: serializeLead(match),
      });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Resolve failed' });
    }
  });

  router.get('/leads/icp/:campaignId', async (req, res) => {
    try {
      const campaignId = Number(req.params.campaignId);
      const aura = auraConfigSchema.parse({
        datahubBaseUrl: req.headers['x-datahub-url'] || req.query.datahubUrl,
        authToken: req.headers['x-aura-token'] || req.query.token,
      });
      const icp = await getCampaignIcp(aura, campaignId);
      res.json({ campaignId, icp });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'ICP fetch failed' });
    }
  });

  router.post('/leads/process', async (req, res) => {
    try {
      const body = processOptionsSchema.parse(req.body);

      const campaignIcp = await getCampaignIcp(body.aura, body.campaignId);
      const campaignIcpEnvelope = await getCampaignIcpEnvelope(body.aura, body.campaignId);
      const lead = await hydrateLeadFromApi(body.aura, body.campaignId, body.lead);
      const extraction =
        (body.extraction as PageExtraction | undefined) || emptyCrmExtraction(lead);
      const result = await processLeadWithLinkedIn({
        campaignId: body.campaignId,
        lead,
        extraction,
        campaignIcp,
        campaignIcpEnvelope,
        aura: body.aura,
        autoApply: body.autoApply ?? true,
        operatorVerified: body.operatorVerified,
        confirmedJobTitle: body.confirmedJobTitle,
        confirmedCompany: body.confirmedCompany,
        promoteToQueued: body.promoteToQueued ?? Boolean(body.operatorVerified),
      });

      res.json(result);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Lead processing failed' });
    }
  });

  /** Puppeteer: Aura edit fields + LinkedIn + company website → Ready when matched */
  router.post('/leads/verify-puppeteer', async (req, res) => {
    try {
      const body = z
        .object({
          campaignId: z.number(),
          lead: z.record(z.unknown()),
          autoApply: z.boolean().optional(),
          promoteToQueued: z.boolean().optional(),
          aura: auraConfigSchema,
        })
        .parse(req.body);

      const { verifyLeadWithPuppeteer } = await import('./lead-verify.js');
      const campaignIcp = await getCampaignIcp(body.aura, body.campaignId);
      const lead = await hydrateLeadFromApi(body.aura, body.campaignId, body.lead);
      const result = await verifyLeadWithPuppeteer({
        campaignId: body.campaignId,
        lead,
        campaignIcp,
        aura: body.aura,
        autoApply: body.autoApply ?? true,
        promoteToQueued: body.promoteToQueued ?? true,
      });

      res.json(result);
    } catch (err) {
      res.status(400).json({
        error: err instanceof Error ? err.message : 'Puppeteer verification failed',
      });
    }
  });

  router.post('/leads/analyze', async (req, res) => {
    try {
      const body = processOptionsSchema.parse(req.body);

      const campaignIcp = await getCampaignIcp(body.aura, body.campaignId);
      const campaignIcpEnvelope = await getCampaignIcpEnvelope(body.aura, body.campaignId);
      const lead = await hydrateLeadFromApi(body.aura, body.campaignId, body.lead);
      const extraction =
        (body.extraction as PageExtraction | undefined) || emptyCrmExtraction(lead);
      const result = await processLeadWithLinkedIn({
        campaignId: body.campaignId,
        lead,
        extraction,
        campaignIcp,
        campaignIcpEnvelope,
        aura: body.aura,
        autoApply: false,
        operatorVerified: body.operatorVerified,
        confirmedJobTitle: body.confirmedJobTitle,
        confirmedCompany: body.confirmedCompany,
        promoteToQueued: false,
      });

      res.json(result);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Lead analysis failed' });
    }
  });

  router.post('/leads/apply', async (req, res) => {
    try {
      const body = processOptionsSchema.parse(req.body);

      const campaignIcp = await getCampaignIcp(body.aura, body.campaignId);
      const campaignIcpEnvelope = await getCampaignIcpEnvelope(body.aura, body.campaignId);
      const lead = await hydrateLeadFromApi(body.aura, body.campaignId, body.lead);
      const extraction =
        (body.extraction as PageExtraction | undefined) || emptyCrmExtraction(lead);
      const result = await processLeadWithLinkedIn({
        campaignId: body.campaignId,
        lead,
        extraction,
        campaignIcp,
        campaignIcpEnvelope,
        aura: body.aura,
        autoApply: true,
        operatorVerified: body.operatorVerified ?? true,
        confirmedJobTitle: body.confirmedJobTitle,
        confirmedCompany: body.confirmedCompany,
        promoteToQueued: body.promoteToQueued ?? true,
      });

      res.json(result);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Lead apply failed' });
    }
  });

  router.post('/leads/automate-batch', async (req, res) => {
    try {
      const body = z
        .object({
          campaignId: z.number(),
          aura: auraConfigSchema,
          results: z.array(
            z.object({
              lead: z.record(z.unknown()),
              extraction: extractionSchema,
            }),
          ),
        })
        .parse(req.body);

      const campaignIcp = await getCampaignIcp(body.aura, body.campaignId);
      const campaignIcpEnvelope = await getCampaignIcpEnvelope(body.aura, body.campaignId);
      const processed: LeadProcessResult[] = [];

      for (const item of body.results) {
        const lead = await hydrateLeadFromApi(body.aura, body.campaignId, item.lead);
        const result = await processLeadWithLinkedIn({
          campaignId: body.campaignId,
          lead,
          extraction: item.extraction as PageExtraction,
          campaignIcp,
          campaignIcpEnvelope,
          aura: body.aura,
          autoApply: true,
        });
        processed.push(result);
      }

      const response: AutomationRunResult = {
        campaignId: body.campaignId,
        processed,
        skipped: [],
        readyCount: processed.filter((p) => p.stageAfter === 'READY' || p.stageAfter === 'QUEUED').length,
        failedCount: processed.filter((p) => p.error).length,
      };

      res.json(response);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Batch apply failed' });
    }
  });

  router.post('/leads/delete', async (req, res) => {
    try {
      const body = z
        .object({
          campaignId: z.number(),
          leadIds: z.array(z.number()).min(1),
          aura: auraConfigSchema,
        })
        .parse(req.body);

      const result = await deleteCampaignLeads(body.aura, body.campaignId, body.leadIds);

      console.log(
        `[leads/delete] campaign=${body.campaignId} deleted=${result.deleted ?? body.leadIds.length}`,
      );

      for (const leadId of body.leadIds) {
        logLeadDecision({
          action: 'delete',
          leadId,
          campaignId: body.campaignId,
          reason: 'permanently removed from campaign via /leads/delete',
          source: 'operator',
        });
      }

      res.json({
        ok: true,
        campaignId: body.campaignId,
        leadIds: body.leadIds,
        deleted: result.deleted ?? body.leadIds.length,
      });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Delete failed' });
    }
  });


  /**
   * POST /leads/scrape-linkedin
   *
   * Scrapes a lead's LinkedIn profile via Apify (if APIFY_API_TOKEN is set)
   * or via the LinkedIn Voyager API (if LINKEDIN_LI_AT is set).
   *
   * Returns:
   *   - scraped:       raw data from LinkedIn
   *   - suggestedEdits: field-by-field suggestions ready to diff vs the lead
   *   - provider:      "apify" | "voyager" | "error"
   */
  router.post('/leads/scrape-linkedin', async (req, res) => {
    try {
      const body = z
        .object({
          campaignId: z.number().optional(),
          lead: z.record(z.unknown()),
          aura: auraConfigSchema.optional(),
        })
        .parse(req.body);

      const lead = body.lead as CampaignLead;
      const linkedinUrl = String(lead.linkedin_url ?? '').trim();

      if (!linkedinUrl) {
        return res.status(400).json({ error: 'Lead has no linkedin_url field set.' });
      }

      // ── Try Apify first (no cookie needed), then Voyager ──────────────────
      const hasApify =
        process.env.APIFY_API_TOKEN && !process.env.APIFY_API_TOKEN.startsWith('apify_api_your');
      const hasVoyager =
        process.env.LINKEDIN_LI_AT && !process.env.LINKEDIN_LI_AT.startsWith('your-');

      if (!hasApify && !hasVoyager) {
        return res.status(503).json({
          error:
            'No LinkedIn scraping credentials configured. Add APIFY_API_TOKEN or LINKEDIN_LI_AT to server/.env. See server/.env.example for instructions.',
          help: {
            apify: 'Sign up free at https://apify.com → Settings → Integrations → API token. Add: APIFY_API_TOKEN=apify_api_...',
            voyager: 'Copy li_at cookie from LinkedIn (DevTools → Application → Cookies → li_at). Add: LINKEDIN_LI_AT=AQE...',
          },
        });
      }

      // ── Apollo Company Enrichment (PRIMARY method) ─────────────────────────
      if (!isApolloConfigured()) {
        return res.status(422).json({
          error: 'Apollo API not configured. Set APOLLO_API_KEY in server/.env',
          linkedinUrl,
        });
      }

      console.log(`[enrich-company] Using Apollo company enrichment for lead=${lead.id}`);

      const leadWithCompanyData: LeadWithCompanyData = {
        id: lead.id,
        campaign_id: lead.campaign_id || Number(body.campaignId),
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

      const apolloResult = await enrichCompanyForLead(leadWithCompanyData);

      if (apolloResult.error) {
        return res.status(422).json({
          error: apolloResult.error,
          linkedinUrl,
        });
      }

      // ── Suggested edits: what we'd write to Aura ─────────────────────────
      const suggestedEdits: Record<string, string> = {};
      
      if (apolloResult.fields.company_name) suggestedEdits.company_name = apolloResult.fields.company_name;
      if (apolloResult.fields.company_employee_size) suggestedEdits.company_employee_size = apolloResult.fields.company_employee_size;
      if (apolloResult.fields.company_revenue_size) suggestedEdits.company_revenue_size = apolloResult.fields.company_revenue_size;
      if (apolloResult.fields.company_industry) suggestedEdits.company_industry = apolloResult.fields.company_industry;
      if (apolloResult.fields.company_website) suggestedEdits.company_website = apolloResult.fields.company_website;
      if (apolloResult.fields.company_city) suggestedEdits.company_city = apolloResult.fields.company_city;
      if (apolloResult.fields.company_state) suggestedEdits.company_state = apolloResult.fields.company_state;
      if (apolloResult.fields.company_country) suggestedEdits.company_country = apolloResult.fields.company_country;

      // Add enrichment metadata
      if (apolloResult.enrichedAt) {
        suggestedEdits.company_enriched_at = apolloResult.enrichedAt;
        suggestedEdits.company_last_verified_at = apolloResult.enrichedAt;
        suggestedEdits.company_enrichment_source = 'apollo';
      }

      res.json({
        leadId: lead.id,
        linkedinUrl,
        provider: 'apollo',
        scraped: {
          personName: lead.first_name + ' ' + lead.last_name,
          headline: lead.job_title,
          currentTitle: lead.job_title,
          currentCompany: lead.company_name,
          about: '',
          location: { city: lead.company_city, state: lead.company_state, country: lead.company_country },
          jobFunction: lead.job_function,
          jobLevel: lead.job_level,
          experienceText: '',
          loggedIn: false,
          error: null,
        },
        suggestedEdits,
        currentValues: {
          first_name: String(lead.first_name ?? ''),
          last_name: String(lead.last_name ?? ''),
          job_title: String(lead.job_title ?? ''),
          company_name: String(lead.company_name ?? ''),
          job_function: String(lead.job_function ?? ''),
          job_level: String(lead.job_level ?? ''),
          company_city: String(lead.company_city ?? ''),
          company_state: String(lead.company_state ?? ''),
          company_country: String(lead.company_country ?? ''),
          company_revenue_size: String(lead.company_revenue_size ?? ''),
          company_employee_size: String(lead.company_employee_size ?? ''),
        },
        apolloResult: {
          confidence: apolloResult.confidence,
          apolloOrganizationId: apolloResult.apolloOrganizationId,
          enrichedAt: apolloResult.enrichedAt,
        },
      });
    } catch (err) {
      console.error('[enrich-company] error:', err);
      res.status(400).json({ error: err instanceof Error ? err.message : 'Company enrichment failed' });
    }
  });

  /**
   * POST /leads/apply-linkedin-edits
   *
   * Applies the operator-confirmed field edits back to Aura.
   * Only fields explicitly included in `edits` are updated.
   */
  router.post('/leads/apply-linkedin-edits', async (req, res) => {
    try {
      const body = z
        .object({
          campaignId: z.number(),
          leadId: z.number(),
          aura: auraConfigSchema,
          edits: z.object({
            first_name: z.string().optional(),
            last_name: z.string().optional(),
            job_title: z.string().optional(),
            company_name: z.string().optional(),
            job_function: z.string().optional(),
            job_level: z.string().optional(),
            company_city: z.string().optional(),
            company_state: z.string().optional(),
            company_country: z.string().optional(),
            company_revenue_size: z.string().optional(),
            company_employee_size: z.string().optional(),
            linkedin_headline: z.string().optional(),
          }).passthrough(),
        })
        .parse(req.body);

      const payload: Record<string, unknown> = {
        campaign_id: body.campaignId,
        ...body.edits,
      };

      // Remove empty strings — don't overwrite with blank
      for (const [k, v] of Object.entries(payload)) {
        if (v === '') delete payload[k as keyof typeof payload];
      }

      const datahubBase = body.aura.datahubBaseUrl.replace(/\/$/, '');
      const updateUrl = `${datahubBase}/api/leads/${body.leadId}`;

      console.log(`[apply-linkedin-edits] PUT ${updateUrl}`);
      console.log(`[apply-linkedin-edits] token present=${!!body.aura.authToken} len=${body.aura.authToken?.length ?? 0}`);
      console.log(`[apply-linkedin-edits] payload=`, JSON.stringify(payload));

      // Make the request directly — full visibility into response
      const datahubRes = await fetch(updateUrl, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          accept: 'application/json',
          Authorization: `Bearer ${body.aura.authToken}`,
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(30_000),
      });

      const datahubBody = await datahubRes.text();
      console.log(`[apply-linkedin-edits] Datahub HTTP ${datahubRes.status}`);
      console.log(`[apply-linkedin-edits] Datahub response: ${datahubBody.slice(0, 500)}`);

      let datahubJson: unknown = {};
      try { datahubJson = JSON.parse(datahubBody); } catch { /* keep empty */ }

      if (!datahubRes.ok) {
        const msg =
          (datahubJson as { message?: string; error?: string }).message ||
          (datahubJson as { message?: string; error?: string }).error ||
          `Datahub returned HTTP ${datahubRes.status}`;
        console.error(`[apply-linkedin-edits] Datahub error: ${msg}`);
        return res.status(datahubRes.status).json({ error: msg, datahubStatus: datahubRes.status });
      }

      console.log(
        `[apply-linkedin-edits] ✅ lead=${body.leadId} updated fields: ${Object.keys(body.edits).join(', ')}`,
      );

      res.json({
        ok: true,
        leadId: body.leadId,
        campaignId: body.campaignId,
        updatedFields: Object.keys(body.edits),
        result: datahubJson,
      });
    } catch (err) {
      console.error('[apply-linkedin-edits] error:', err);
      res.status(400).json({ error: err instanceof Error ? err.message : 'Apply edits failed' });
    }
  });


  // ──────────────────────────────────────────────────────────────────────────
  // POST /leads/enrich-and-ready
  //
  // Waterfall enrichment for a single lead (matches approved flow):
  //   1. Check Aura CRM — if all 10 fields present → READY immediately
  //   2. Apollo.io /people/match — fast pre-built DB, no live scraping
  //   3. If still gaps → LinkedIn scrape pipeline (Voyager → Apify → Puppeteer)
  //   4. Merge results (only fill blanks, never overwrite existing values)
  //   5. All 10 required fields filled → set stage=READY in Aura CRM
  //      Otherwise → return incomplete + list of remaining missing fields
  // ──────────────────────────────────────────────────────────────────────────
  router.post('/leads/enrich-and-ready', async (req, res) => {
    try {
      const body = z
        .object({
          campaignId: z.number(),
          lead: z.record(z.unknown()),
          aura: auraConfigSchema,
          /**
           * If true (default), apply edits and set stage=READY automatically.
           * If false, just return what we'd set (dry-run / preview mode).
           */
          autoApply: z.boolean().optional().default(true),
        })
        .parse(req.body);

      const campaignId = body.campaignId;
      const aura = body.aura;

      // ── 1. Hydrate lead from Aura CRM ────────────────────────────────────
      const lead = await hydrateLeadFromApi(aura, campaignId, body.lead);
      const leadName = leadDisplayName(lead);
      console.log(`[enrich-and-ready] lead=${lead.id} "${leadName}" campaign=${campaignId}`);

      // ── 2. Check which company fields are already populated ─────────────────
      const companyFields = ['company_employee_size', 'company_revenue_size', 'company_industry', 'company_website', 'company_city', 'company_state', 'company_country'];
      let missing = companyFields.filter(field => {
        const val = lead[field as keyof typeof lead];
        return !val || String(val).trim() === '';
      });
      const enrichmentLog: string[] = [];

      if (missing.length === 0) {
        // All fields already good — just set READY
        console.log(`[enrich-and-ready] lead=${lead.id} CRM complete — setting READY directly`);
        enrichmentLog.push('CRM complete — all required fields present');
        if (body.autoApply) {
          const datahubBase = aura.datahubBaseUrl.replace(/\/$/, '');
          await fetch(`${datahubBase}/api/leads/${lead.id}`, {
            method: 'PUT',
            headers: {
              'Content-Type': 'application/json',
              accept: 'application/json',
              Authorization: `Bearer ${aura.authToken}`,
            },
            body: JSON.stringify({ campaign_id: campaignId, stage: 'READY' }),
            signal: AbortSignal.timeout(15_000),
          });
        }
        logLeadDecision({
          action: 'ready',
          leadId: lead.id,
          campaignId,
          reason: 'all company fields present in CRM — enrich-and-ready',
          source: 'enrich-and-ready',
          stageAfter: 'READY',
          method: 'crm_complete',
        });
        return res.json({
          leadId: lead.id,
          leadName,
          action: 'ready',
          method: 'crm_complete',
          missingFields: [],
          filledFields: [],
          stage: 'READY',
          apolloUsed: false,
          enrichmentLog,
        });
      }

      console.log(`[enrich-and-ready] lead=${lead.id} missing: ${missing.join(', ')}`);
      enrichmentLog.push(`CRM missing: ${missing.join(', ')}`);

      let mergedLead = { ...lead };
      let apolloChanged: string[] = [];
      let apolloUsed = false;

      // ── 3. Apollo Company Enrichment (PRIMARY method) ─────────────────────
      if (isApolloConfigured()) {
        console.log(`[enrich-and-ready] lead=${lead.id} → Apollo company enrichment`);
        enrichmentLog.push(`Apollo: querying /organizations/search → /organizations/enrich`);

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

        const apolloResult = await enrichCompanyForLead(leadWithCompanyData);
        
        if (apolloResult.fields && Object.keys(apolloResult.fields).length > 0) {
          const merged = mergeCompanyEnrichmentIntoLead(
            leadWithCompanyData,
            apolloResult.fields,
            apolloResult.enrichedAt || new Date().toISOString()
          );
          
          // Update mergedLead with enriched fields
          if (merged.updated.company_employee_size) mergedLead.company_employee_size = merged.updated.company_employee_size;
          if (merged.updated.company_revenue_size) mergedLead.company_revenue_size = merged.updated.company_revenue_size;
          if (merged.updated.company_industry) mergedLead.company_industry = merged.updated.company_industry;
          if (merged.updated.company_website) mergedLead.company_website = merged.updated.company_website;
          if (merged.updated.company_city) mergedLead.company_city = merged.updated.company_city;
          if (merged.updated.company_state) mergedLead.company_state = merged.updated.company_state;
          if (merged.updated.company_country) mergedLead.company_country = merged.updated.company_country;
          if (merged.updated.company_enriched_at) mergedLead.company_enriched_at = merged.updated.company_enriched_at;
          if (merged.updated.company_last_verified_at) mergedLead.company_last_verified_at = merged.updated.company_last_verified_at;
          if (merged.updated.company_enrichment_source) mergedLead.company_enrichment_source = merged.updated.company_enrichment_source;
          
          apolloChanged = merged.changedFields.filter(f => !f.startsWith('company_'));
          if (apolloChanged.length) {
            enrichmentLog.push(`Apollo filled: ${apolloChanged.join(', ')}`);
          } else {
            enrichmentLog.push('Apollo matched but all returned fields already present in CRM');
          }
          apolloUsed = true;
        } else {
          enrichmentLog.push(`Apollo: ${apolloResult.error || 'no match found'}`);
        }
      } else {
        enrichmentLog.push('Apollo not configured (APOLLO_API_KEY not set) — skipping');
      }

      // Re-check missing after Apollo
      missing = companyFields.filter(field => {
        const val = mergedLead[field as keyof typeof mergedLead];
        return !val || String(val).trim() === '';
      });

      // Final missing check
      const allFieldsFilled = missing.length === 0;
      const allChangedFields = [...apolloChanged];

      // ── 4. Apply merged result to Aura CRM ───────────────────────────────
      if (body.autoApply && allChangedFields.length > 0) {
        const payload: Record<string, unknown> = {
          campaign_id: campaignId,
        };
        for (const field of allChangedFields) {
          const val = (mergedLead as Record<string, unknown>)[field];
          if (val && String(val).trim()) payload[field] = val;
        }
        if (allFieldsFilled) payload.stage = 'READY';

        await updateCampaignLead(aura, lead.id, payload as any);
        enrichmentLog.push(`Aura updated with ${allChangedFields.join(', ')}`);
      } else if (allFieldsFilled && body.autoApply) {
        // No new fields filled but all required fields already present — set READY
        await updateCampaignLead(aura, lead.id, { campaign_id: campaignId, stage: 'READY' } as any);
        enrichmentLog.push('Aura stage set to READY (all fields already present)');
      }

      // ── 5. Return result ───────────────────────────────────────────────────
      if (allFieldsFilled) {
        console.log(`[enrich-and-ready] lead=${lead.id} Enrichment successful, lead is READY`);
        logLeadDecision({
          action: 'ready',
          leadId: lead.id,
          campaignId,
          reason: apolloUsed
            ? 'company enrichment complete via Apollo — enrich-and-ready'
            : 'all company fields present — enrich-and-ready',
          source: 'enrich-and-ready',
          stageAfter: 'READY',
          method: apolloUsed ? 'apollo_company_enrichment' : 'crm_complete',
        });
        return res.json({
          leadId: lead.id,
          leadName,
          action: 'ready',
          method: apolloUsed ? 'apollo_company_enrichment' : 'crm_complete',
          missingFields: [],
          filledFields: allChangedFields,
          stage: 'READY',
          apolloUsed,
          enrichmentLog,
        });
      } else {
        console.log(`[enrich-and-ready] lead=${lead.id} Enrichment incomplete, needs manual edit`);
        return res.json({
          leadId: lead.id,
          leadName,
          action: 'incomplete',
          method: apolloUsed ? 'apollo_company_enrichment' : 'crm_only',
          missingFields: missing,
          filledFields: allChangedFields,
          stage: lead.stage,
          apolloUsed,
          needsManualEdit: true,
          enrichmentLog,
        });
      }
    } catch (err) {
      console.error('[enrich-and-ready] Error:', err);
      return res.status(400).json({ error: err instanceof Error ? err.message : 'Enrichment failed' });
    }
  });

  // ──────────────────────────────────────────────────────────────────────────
  // POST /leads/enrich-batch
  //
  // Bulk version: process all (or specified) NOT_ELIGIBLE leads in a campaign
  // through the enrich-and-ready waterfall.
  // ──────────────────────────────────────────────────────────────────────────
  router.post('/leads/enrich-batch', async (req, res) => {
    try {
      const body = z
        .object({
          campaignId: z.number(),
          aura: auraConfigSchema,
          /** Optional explicit list of lead IDs to process. Defaults to all NOT_ELIGIBLE. */
          leadIds: z.array(z.number()).optional(),
          /** Stage filter when leadIds not specified. Default: NOT_ELIGIBLE */
          stage: z.string().optional().default('NOT_ELIGIBLE'),
          /** Milliseconds to wait between leads to respect API rate limits. Default: 400ms */
          delayMs: z.number().optional().default(400),
          autoApply: z.boolean().optional().default(true),
        })
        .parse(req.body);

      const campaignId = body.campaignId;
      const aura = body.aura;

      console.log(
        `[enrich-batch] campaign=${campaignId} stage=${body.stage} apollo=${isApolloConfigured()}`,
      );

      // Fetch leads to process
      const allLeads = await listCampaignLeads(aura, campaignId, { limit: 500 });
      let toProcess: CampaignLead[];

      if (body.leadIds && body.leadIds.length > 0) {
        const idSet = new Set(body.leadIds);
        toProcess = allLeads.filter((l) => idSet.has(Number(l.id)));
      } else {
        const targetStage = body.stage.toUpperCase();
        toProcess = allLeads.filter(
          (l) => String(l.stage ?? '').toUpperCase() === targetStage,
        );
      }

      console.log(`[enrich-batch] ${toProcess.length} leads to process`);

      const results: Array<{
        leadId: number;
        leadName: string;
        action: string;
        stage: string;
        filledFields: string[];
        missingFields: string[];
        apolloUsed: boolean;
        error?: string;
      }> = [];

      let readyCount = 0;
      let incompleteCount = 0;
      let errorCount = 0;

      for (let i = 0; i < toProcess.length; i++) {
        const lead = toProcess[i];
        const leadName = leadDisplayName(lead);

        try {
          // Rate-limit delay between leads
          if (i > 0 && body.delayMs > 0) {
            await new Promise<void>((resolve) => setTimeout(resolve, body.delayMs));
          }

          // Inline enrich-and-ready waterfall (Apollo Company Enrichment only)
          const companyFields = ['company_employee_size', 'company_revenue_size', 'company_industry', 'company_website', 'company_city', 'company_state', 'company_country'];
          let missing = companyFields.filter(field => {
            const val = lead[field as keyof typeof lead];
            return !val || String(val).trim() === '';
          });
          const enrichmentLog: string[] = [];

          // ── Step A: Apollo Company Enrichment ─────────────────────────────
          let mergedLead = { ...lead };
          let apolloChanged: string[] = [];
          let apolloUsed = false;

          if (missing.length > 0 && isApolloConfigured()) {
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

            const apolloResult = await enrichCompanyForLead(leadWithCompanyData);
            if (apolloResult.fields && Object.keys(apolloResult.fields).length > 0) {
              const merged = mergeCompanyEnrichmentIntoLead(
                leadWithCompanyData,
                apolloResult.fields,
                apolloResult.enrichedAt || new Date().toISOString()
              );
              
              // Update mergedLead with enriched fields
              if (merged.updated.company_employee_size) mergedLead.company_employee_size = merged.updated.company_employee_size;
              if (merged.updated.company_revenue_size) mergedLead.company_revenue_size = merged.updated.company_revenue_size;
              if (merged.updated.company_industry) mergedLead.company_industry = merged.updated.company_industry;
              if (merged.updated.company_website) mergedLead.company_website = merged.updated.company_website;
              if (merged.updated.company_city) mergedLead.company_city = merged.updated.company_city;
              if (merged.updated.company_state) mergedLead.company_state = merged.updated.company_state;
              if (merged.updated.company_country) mergedLead.company_country = merged.updated.company_country;
              if (merged.updated.company_enriched_at) mergedLead.company_enriched_at = merged.updated.company_enriched_at;
              if (merged.updated.company_last_verified_at) mergedLead.company_last_verified_at = merged.updated.company_last_verified_at;
              if (merged.updated.company_enrichment_source) mergedLead.company_enrichment_source = merged.updated.company_enrichment_source;
              
              apolloChanged = merged.changedFields.filter(f => !f.startsWith('company_'));
              apolloUsed = true;
              if (apolloChanged.length) {
                enrichmentLog.push(`Apollo filled: ${apolloChanged.join(', ')}`);
              }
            } else {
              enrichmentLog.push(`Apollo: ${apolloResult.error || 'no match'}`);
            }
          }

          missing = companyFields.filter(field => {
            const val = mergedLead[field as keyof typeof mergedLead];
            return !val || String(val).trim() === '';
          });

          // ── Step B: Apply to Aura CRM if autoApply ─────────────────────────
          const allFieldsFilled = missing.length === 0;
          const allChangedFields = [...apolloChanged];

          if (body.autoApply && allChangedFields.length > 0) {
            const payload: Record<string, unknown> = { campaign_id: campaignId };
            for (const field of allChangedFields) {
              const val = (mergedLead as Record<string, unknown>)[field];
              if (val && String(val).trim()) payload[field] = val;
            }
            if (allFieldsFilled) payload.stage = 'READY';

            await updateCampaignLead(aura, lead.id, payload as any);
            enrichmentLog.push(`Aura updated with ${allChangedFields.join(', ')}`);
          } else if (allFieldsFilled && body.autoApply) {
            await updateCampaignLead(aura, lead.id, { campaign_id: campaignId, stage: 'READY' } as any);
            enrichmentLog.push('Aura stage set to READY');
          }

          // ── Step C: Record result ─────────────────────────────────────────
          const stage = allFieldsFilled ? 'READY' : String(lead.stage ?? 'NOT_ELIGIBLE');
          if (allFieldsFilled) readyCount++;
          else incompleteCount++;

          results.push({
            leadId: Number(lead.id),
            leadName,
            action: allFieldsFilled ? 'ready' : 'incomplete',
            stage,
            filledFields: allChangedFields,
            missingFields: missing,
            apolloUsed,
          });

          console.log(
            `[enrich-batch] [${i + 1}/${toProcess.length}] lead=${lead.id} "${leadName}" → ${
              stage
            } (filled=${allChangedFields.length} missing=${missing.length})`,
          );
        } catch (err) {
          errorCount++;
          const errMsg = err instanceof Error ? err.message : String(err);
          console.error(`[enrich-batch] lead=${lead.id} error: ${errMsg}`);
          results.push({
            leadId: Number(lead.id),
            leadName,
            action: 'error',
            stage: String(lead.stage ?? ''),
            filledFields: [],
            missingFields: [],
            apolloUsed: false,
            error: errMsg,
          });
        }
      }

      console.log(
        `[enrich-batch] done — ready=${readyCount} incomplete=${incompleteCount} errors=${errorCount}`,
      );

      return res.json({
        campaignId,
        total: toProcess.length,
        readyCount,
        incompleteCount,
        errorCount,
        apolloConfigured: isApolloConfigured(),
        results,
      });
    } catch (err) {
      console.error('[enrich-batch] error:', err);
      res.status(400).json({
        error: err instanceof Error ? err.message : 'Enrich batch failed',
      });
    }
  });

  return router;
}

