import { Router } from 'express';
import { z } from 'zod';
import {
  listCompanies,
  findCompanyById,
  upsertCompany,
  addKnowledgeChunk,
  getAllChunks,
  searchChunksKeyword,
} from './db.js';
import {
  buildProfileFromExtraction,
  detectCompetitors,
  embedText,
  answerQuestion,
  semanticSearch,
  hasAI,
  getProvider,
} from './ai.js';
import type { PageExtraction, SourceRef, LinkedInProfileData, EnrichedProfileData } from './types.js';
import { buildScrapedSections } from './scraped.js';
import { generatePageBrief } from './brief.js';
import { createLeadRoutes } from './aura/leads-routes.js';
import { enrichLead } from './enrichment-orchestrator.js';
import { enrichCompanyForLead, batchEnrichCompaniesForLeads, mergeCompanyEnrichmentIntoLead, isApolloConfigured, type LeadWithCompanyData } from './aura/apollo-company-enrichment.js';

const router = Router();
router.use(createLeadRoutes());

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

router.get('/health', (_req, res) => {
  res.json({ status: 'ok', ai: hasAI() ? getProvider() : 'fallback' });
});

router.get('/companies', (_req, res) => {
  res.json(listCompanies());
});

router.get('/companies/:id', (req, res) => {
  const company = findCompanyById(req.params.id);
  if (!company) return res.status(404).json({ error: 'Company not found' });
  res.json(company);
});

router.post('/analyze', async (req, res) => {
  try {
    const extraction = extractionSchema.parse(req.body) as PageExtraction;
    const allCompanies = listCompanies();
    const existing = allCompanies.find(
      (c) =>
        extraction.companyName &&
        c.name.toLowerCase() === extraction.companyName.toLowerCase()
    );

    const context = existing
      ? `Name: ${existing.name}\nIndustry: ${existing.industry}\nDescription: ${existing.description}`
      : undefined;

    const profileData = await buildProfileFromExtraction(extraction, context);

    const source: SourceRef = {
      url: extraction.url,
      title: extraction.title,
      sourceType: extraction.sourceType,
      capturedAt: new Date().toISOString(),
    };

    const company = upsertCompany({
      ...profileData,
      technologies: profileData.technologies || [],
      competitors: existing?.competitors || [],
      investmentInsights: profileData.investmentInsights || [],
      hiringInsights: profileData.hiringInsights || [],
      sources: [source],
    });

    const competitors = await detectCompetitors(company, listCompanies());
    const updated = upsertCompany({ ...company, competitors, sources: [] });

    const chunkContent = [
      `Company: ${updated.name}`,
      updated.description,
      updated.industry && `Industry: ${updated.industry}`,
      updated.funding && `Funding: ${updated.funding}`,
      updated.technologies.length && `Tech: ${updated.technologies.join(', ')}`,
      extraction.rawText.slice(0, 2000),
    ]
      .filter(Boolean)
      .join('\n');

    const embedding = await embedText(chunkContent);
    addKnowledgeChunk({
      companyId: updated.id,
      content: chunkContent,
      sourceUrl: extraction.url,
      embedding: embedding ?? undefined,
      metadata: { title: extraction.title, sourceType: extraction.sourceType },
    });

    res.json({
      company: updated,
      message: `Profile built for ${updated.name}`,
      aiEnabled: hasAI(),
      provider: getProvider(),
    });
  } catch (err) {
    console.error(err);
    res.status(400).json({ error: err instanceof Error ? err.message : 'Analysis failed' });
  }
});

router.post('/ask-page', async (req, res) => {
  try {
    const body = z
      .object({
        question: z.string().min(1),
        url: z.string(),
        extraction: extractionSchema.optional(),
      })
      .parse(req.body);

    if (!body.extraction) {
      return res.status(400).json({ error: 'No page data. Reload the page and try again.' });
    }

    const extraction = body.extraction as PageExtraction;
    const scraped = buildScrapedSections(extraction);

    if (!scraped.length) {
      return res.status(400).json({
        error: 'Nothing scraped from this page yet. Make sure the content is visible, then try again.',
      });
    }

    const subjectName =
      extraction.personName ||
      extraction.companyName ||
      extraction.title?.split('|')[0]?.trim() ||
      'this page';

    const brief = await generatePageBrief(scraped, subjectName, body.question);

    res.json({
      answer: brief.answer,
      summary: brief.summary,
      chips: brief.chips,
      highlights: brief.highlights,
      subject: subjectName,
      url: body.url,
      scraped,
    });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Query failed' });
  }
});

router.post('/ask', async (req, res) => {
  try {
    const { question } = z.object({ question: z.string().min(1) }).parse(req.body);
    const chunks = getAllChunks();
    const companies = listCompanies();

    let relevantContent: string[];
    if (hasAI() && getProvider() === 'openai' && chunks.some((c) => c.embedding)) {
      relevantContent = await semanticSearch(question, chunks);
    } else {
      relevantContent = searchChunksKeyword(question).map((c) => c.content);
    }

    if (!relevantContent.length) {
      relevantContent = chunks.slice(0, 5).map((c) => c.content);
    }

    const answer = await answerQuestion(
      question,
      relevantContent,
      companies.map((c) => c.name)
    );

    const matchedChunks = chunks.filter((c) =>
      relevantContent.includes(c.content)
    );

    res.json({
      answer,
      sources: matchedChunks.slice(0, 5).map((c) => ({
        url: c.sourceUrl,
        title: (c.metadata.title as string) || c.sourceUrl,
        snippet: c.content.slice(0, 200),
      })),
      companies: [...new Set(matchedChunks.map((c) => c.companyId).filter(Boolean))].map(
        (id) => companies.find((c) => c.id === id)?.name || id
      ),
    });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Query failed' });
  }
});

router.get('/search', (req, res) => {
  const q = (req.query.q as string) || '';
  if (!q) return res.json({ companies: listCompanies(), chunks: [] });

  const companies = listCompanies().filter(
    (c) =>
      c.name.toLowerCase().includes(q.toLowerCase()) ||
      c.industry?.toLowerCase().includes(q.toLowerCase()) ||
      c.description?.toLowerCase().includes(q.toLowerCase())
  );

  const chunks = searchChunksKeyword(q);
  res.json({ companies, chunks: chunks.slice(0, 10) });
});

// New endpoint: Lead enrichment using waterfall approach (Aura → Apollo Company Enrichment)
// This implements the compliant enrichment strategy using only CRM and Apollo
router.post('/enrich-lead', async (req, res) => {
  try {
    const { campaignId, leadId, aura } = z.object({
      campaignId: z.number(),
      leadId: z.number(),
      aura: z.object({
        datahubBaseUrl: z.string().url(),
        authToken: z.string().min(10),
      }),
    }).parse(req.body);

    console.log('[enrich-lead] Starting enrichment for lead:', leadId);

    const result = await enrichLead(campaignId, leadId, aura);

    if (result.success) {
      console.log('[enrich-lead] Enrichment successful:', result.source);
      res.json({
        success: true,
        source: result.source,
        data: result.data,
        confidence: result.confidence,
        message: result.message,
        enrichment_log: result.enrichment_log,
      });
    } else {
      console.log('[enrich-lead] Enrichment incomplete, needs manual edit');
      res.json({
        success: false,
        source: result.source,
        missing_fields: result.missing_fields,
        confidence: result.confidence,
        needs_manual_edit: result.needs_manual_edit,
        message: result.message,
        enrichment_log: result.enrichment_log,
      });
    }
  } catch (err) {
    console.error('[enrich-lead] Error:', err);
    res.status(400).json({ error: err instanceof Error ? err.message : 'Enrichment failed' });
  }
});

// New endpoint: Company enrichment using Apollo organizations APIs
// Enriches company data for a single lead using Apollo organizations/search → organizations/enrich
router.post('/leads/company-enrich', async (req, res) => {
  try {
    const { lead, aura } = z.object({
      lead: z.object({
        id: z.number(),
        campaign_id: z.number(),
        company_name: z.string().optional(),
        company_employee_size: z.string().optional(),
        company_revenue_size: z.string().optional(),
        company_industry: z.string().optional(),
        company_website: z.string().optional(),
        company_city: z.string().optional(),
        company_state: z.string().optional(),
        company_country: z.string().optional(),
        company_enriched_at: z.string().optional(),
        company_last_verified_at: z.string().optional(),
        company_enrichment_source: z.string().optional(),
      }),
      aura: z.object({
        datahubBaseUrl: z.string().url(),
        authToken: z.string().min(10),
      }),
    }).parse(req.body);

    console.log('[company-enrich] Starting company enrichment for lead:', lead.id);

    if (!isApolloConfigured()) {
      return res.status(400).json({ 
        error: 'Apollo API not configured. Set APOLLO_API_KEY in server/.env' 
      });
    }

    const result = await enrichCompanyForLead(lead);

    if (result.error) {
      console.log('[company-enrich] Enrichment skipped:', result.error);
      return res.json({
        success: false,
        skipped: true,
        message: result.error,
        confidence: result.confidence,
      });
    }

    // Merge enrichment results into lead
    const { updated, changedFields } = mergeCompanyEnrichmentIntoLead(
      lead,
      result.fields,
      result.enrichedAt || new Date().toISOString(),
    );

    console.log('[company-enrich] Company enriched successfully, changed fields:', changedFields);

    res.json({
      success: true,
      updated_lead: updated,
      changed_fields: changedFields,
      confidence: result.confidence,
      apollo_organization_id: result.apolloOrganizationId,
      message: `Company enriched with ${changedFields.length} fields`,
    });
  } catch (err) {
    console.error('[company-enrich] Error:', err);
    res.status(400).json({ error: err instanceof Error ? err.message : 'Company enrichment failed' });
  }
});

// New endpoint: Batch company enrichment for multiple leads
// Optimizes by deduplicating companies and calling Apollo once per unique company
router.post('/leads/company-enrich-batch', async (req, res) => {
  try {
    const { leads, aura } = z.object({
      leads: z.array(
        z.object({
          id: z.number(),
          campaign_id: z.number(),
          company_name: z.string().optional(),
          company_employee_size: z.string().optional(),
          company_revenue_size: z.string().optional(),
          company_industry: z.string().optional(),
          company_website: z.string().optional(),
          company_city: z.string().optional(),
          company_state: z.string().optional(),
          company_country: z.string().optional(),
          company_enriched_at: z.string().optional(),
          company_last_verified_at: z.string().optional(),
          company_enrichment_source: z.string().optional(),
        })
      ),
      aura: z.object({
        datahubBaseUrl: z.string().url(),
        authToken: z.string().min(10),
      }),
    }).parse(req.body);

    console.log('[company-enrich-batch] Starting batch company enrichment for', leads.length, 'leads');

    if (!isApolloConfigured()) {
      return res.status(400).json({ 
        error: 'Apollo API not configured. Set APOLLO_API_KEY in server/.env' 
      });
    }

    const results = await batchEnrichCompaniesForLeads(leads);

    // Merge enrichment results into leads
    const updatedLeads: LeadWithCompanyData[] = [];
    const allChangedFields: string[] = [];
    let skippedCount = 0;
    let enrichedCount = 0;

    for (const lead of leads) {
      const result = results.get(lead.id);
      if (!result) continue;

      if (result.error) {
        skippedCount++;
        continue;
      }

      const { updated, changedFields } = mergeCompanyEnrichmentIntoLead(
        lead,
        result.fields,
        result.enrichedAt || new Date().toISOString(),
      );

      updatedLeads.push(updated);
      allChangedFields.push(...changedFields);
      enrichedCount++;
    }

    const uniqueChangedFields = [...new Set(allChangedFields)];

    console.log('[company-enrich-batch] Batch enrichment complete:', {
      enriched: enrichedCount,
      skipped: skippedCount,
      total: leads.length,
    });

    res.json({
      success: true,
      updated_leads: updatedLeads,
      enriched_count: enrichedCount,
      skipped_count: skippedCount,
      total_count: leads.length,
      changed_fields: uniqueChangedFields,
      message: `Batch enriched ${enrichedCount} companies, skipped ${skippedCount}`,
    });
  } catch (err) {
    console.error('[company-enrich-batch] Error:', err);
    res.status(400).json({ error: err instanceof Error ? err.message : 'Batch company enrichment failed' });
  }
});

export default router;
