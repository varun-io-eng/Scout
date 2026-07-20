/**
 * Lead Enrichment Orchestrator
 * Implements the waterfall enrichment approach: Aura → Apollo Company Enrichment
 * Validates required fields and updates Aura CRM when data is complete
 */

import { enrichCompanyForLead, mergeCompanyEnrichmentIntoLead, isApolloConfigured, type LeadWithCompanyData } from './aura/apollo-company-enrichment.js';
import { findCampaignLead, updateCampaignLead } from './aura/client.js';

export interface EnrichmentResult {
  success: boolean;
  source: 'aura' | 'apollo' | 'manual';
  data?: any;
  missing_fields?: string[];
  confidence?: number;
  needs_manual_edit?: boolean;
  message?: string;
  enrichment_log?: string[];
}

export interface AuraLeadData {
  id: number;
  campaign_id: number;
  company_name?: string;
  company_employee_size?: string;
  company_revenue_size?: string;
  company_industry?: string;
  company_website?: string;
  company_city?: string;
  company_state?: string;
  company_country?: string;
  company_enriched_at?: string;
  company_last_verified_at?: string;
  company_enrichment_source?: string;
  stage?: string;
}

/** The 8 company fields Scout enriches. */
const COMPANY_FIELDS_TO_ENRICH: (keyof AuraLeadData)[] = [
  'company_name',
  'company_employee_size',
  'company_revenue_size',
  'company_industry',
  'company_website',
  'company_city',
  'company_state',
  'company_country',
];

/** Return list of company fields that are blank/missing on this lead. */
function getMissingCompanyFields(lead: AuraLeadData): (keyof AuraLeadData)[] {
  return COMPANY_FIELDS_TO_ENRICH.filter((field) => {
    const val = lead[field];
    return !val || String(val).trim() === '';
  });
}

/**
 * Main enrichment orchestrator implementing the waterfall approach
 * Aura CRM → Apollo Company Enrichment → Update CRM
 */
export async function enrichLead(campaignId: number, leadId: number, aura: any): Promise<EnrichmentResult> {
  console.log(`[enrichment-orchestrator] Starting enrichment for lead=${leadId} campaign=${campaignId}`);
  const enrichmentLog: string[] = [];

  // Step 1: Check Aura CRM for existing lead data
  const auraData = await findCampaignLead(aura, campaignId, leadId);
  console.log(`[enrichment-orchestrator] Aura CRM data:`, auraData ? 'Found' : 'Not found');
  enrichmentLog.push('Aura CRM data fetched');

  if (!auraData) {
    return {
      success: false,
      source: 'manual',
      missing_fields: ['all'],
      confidence: 0,
      needs_manual_edit: true,
      message: 'Lead not found in Aura CRM',
      enrichment_log: enrichmentLog,
    };
  }

  // Step 2: Check if Aura data has company_name
  if (!auraData.company_name || String(auraData.company_name).trim() === '') {
    console.log(`[enrichment-orchestrator] Company name missing — skipping enrichment`);
    enrichmentLog.push('Company name missing — skipping enrichment');
    
    return {
      success: false,
      source: 'manual',
      missing_fields: ['company_name'],
      confidence: 0,
      needs_manual_edit: true,
      message: 'Company name is required for enrichment',
      enrichment_log: enrichmentLog,
    };
  }

  // Convert CampaignLead to AuraLeadData with proper type handling
  const leadData: AuraLeadData = {
    id: auraData.id,
    campaign_id: auraData.campaign_id || 0,
    company_name: String(auraData.company_name || ''),
    company_employee_size: auraData.company_employee_size ? String(auraData.company_employee_size) : undefined,
    company_revenue_size: auraData.company_revenue_size ? String(auraData.company_revenue_size) : undefined,
    company_industry: auraData.company_industry ? String(auraData.company_industry) : undefined,
    company_website: auraData.company_website ? String(auraData.company_website) : undefined,
    company_city: auraData.company_city ? String(auraData.company_city) : undefined,
    company_state: auraData.company_state ? String(auraData.company_state) : undefined,
    company_country: auraData.company_country ? String(auraData.company_country) : undefined,
    company_enriched_at: auraData.company_enriched_at ? String(auraData.company_enriched_at) : undefined,
    company_last_verified_at: auraData.company_last_verified_at ? String(auraData.company_last_verified_at) : undefined,
    company_enrichment_source: auraData.company_enrichment_source ? String(auraData.company_enrichment_source) : undefined,
    stage: auraData.stage ? String(auraData.stage) : undefined,
  };

  // Step 3: Check if company fields are complete
  let missing = getMissingCompanyFields(leadData);
  if (missing.length === 0) {
    console.log(`[enrichment-orchestrator] Company data is complete, setting READY`);
    enrichmentLog.push('Company data complete — all required fields present');
    
    // Set stage to READY
    await updateCampaignLead(aura, leadId, { campaign_id: campaignId, stage: 'READY' });
    
    return {
      success: true,
      source: 'aura',
      data: auraData,
      missing_fields: [],
      confidence: 1.0,
      message: 'Using complete company data from Aura CRM',
      enrichment_log: enrichmentLog,
    };
  }

  console.log(`[enrichment-orchestrator] Company data incomplete, missing: ${missing.join(', ')}`);
  enrichmentLog.push(`Company missing: ${missing.join(', ')}`);

  // Step 4: Try Apollo company enrichment
  let apolloChanged: string[] = [];
  let apolloUsed = false;

  if (isApolloConfigured()) {
    console.log(`[enrichment-orchestrator] Trying Apollo company enrichment`);
    enrichmentLog.push('Apollo: querying /organizations/search → /organizations/enrich');

    const leadWithCompanyData: LeadWithCompanyData = {
      id: leadData.id,
      campaign_id: leadData.campaign_id,
      company_name: leadData.company_name,
      company_employee_size: leadData.company_employee_size,
      company_revenue_size: leadData.company_revenue_size,
      company_industry: leadData.company_industry,
      company_website: leadData.company_website,
      company_city: leadData.company_city,
      company_state: leadData.company_state,
      company_country: leadData.company_country,
      company_enriched_at: leadData.company_enriched_at,
      company_last_verified_at: leadData.company_last_verified_at,
      company_enrichment_source: leadData.company_enrichment_source,
    };

    const apolloResult = await enrichCompanyForLead(leadWithCompanyData);
    
    if (apolloResult.error) {
      enrichmentLog.push(`Apollo: ${apolloResult.error}`);
    } else if (apolloResult.fields && Object.keys(apolloResult.fields).length > 0) {
      const merged = mergeCompanyEnrichmentIntoLead(
        leadWithCompanyData,
        apolloResult.fields,
        apolloResult.enrichedAt || new Date().toISOString()
      );
      
      apolloChanged = merged.changedFields.filter(f => !f.startsWith('company_'));
      if (apolloChanged.length) {
        enrichmentLog.push(`Apollo filled: ${apolloChanged.join(', ')}`);
      } else {
        enrichmentLog.push('Apollo matched but all returned fields already present in CRM');
      }
      apolloUsed = true;
      
      // Update the lead data with merged results
      leadData.company_employee_size = merged.updated.company_employee_size;
      leadData.company_revenue_size = merged.updated.company_revenue_size;
      leadData.company_industry = merged.updated.company_industry;
      leadData.company_website = merged.updated.company_website;
      leadData.company_city = merged.updated.company_city;
      leadData.company_state = merged.updated.company_state;
      leadData.company_country = merged.updated.company_country;
      leadData.company_enriched_at = merged.updated.company_enriched_at;
      leadData.company_last_verified_at = merged.updated.company_last_verified_at;
      leadData.company_enrichment_source = merged.updated.company_enrichment_source;
    }
  } else {
    enrichmentLog.push('Apollo not configured (APOLLO_API_KEY not set) — skipping');
  }

  // Re-check missing after Apollo
  missing = getMissingCompanyFields(leadData);

  // Final missing check
  const allFieldsFilled = missing.length === 0;

  // Step 5: Apply merged result to Aura CRM
  if (apolloChanged.length > 0) {
    const payload: any = { campaign_id: campaignId };
    
    if (leadData.company_employee_size) payload.company_employee_size = leadData.company_employee_size;
    if (leadData.company_revenue_size) payload.company_revenue_size = leadData.company_revenue_size;
    if (leadData.company_industry) payload.company_industry = leadData.company_industry;
    if (leadData.company_website) payload.company_website = leadData.company_website;
    if (leadData.company_city) payload.company_city = leadData.company_city;
    if (leadData.company_state) payload.company_state = leadData.company_state;
    if (leadData.company_country) payload.company_country = leadData.company_country;
    
    payload.company_enriched_at = leadData.company_enriched_at;
    payload.company_last_verified_at = leadData.company_last_verified_at;
    payload.company_enrichment_source = leadData.company_enrichment_source;
    
    if (allFieldsFilled) payload.stage = 'READY';

    console.log(`[enrichment-orchestrator] Updating Aura lead=${leadId} with ${Object.keys(payload).length} fields`);
    await updateCampaignLead(aura, leadId, payload);
    enrichmentLog.push(`Aura updated with ${Object.keys(payload).join(', ')}`);
  } else if (allFieldsFilled) {
    // No new fields filled but all required fields already present — set READY
    await updateCampaignLead(aura, leadId, { campaign_id: campaignId, stage: 'READY' });
    enrichmentLog.push('Aura stage set to READY (all fields already present)');
  }

  // Step 6: Return result
  if (allFieldsFilled) {
    console.log(`[enrichment-orchestrator] Enrichment successful, lead is READY`);
    return {
      success: true,
      source: apolloUsed ? 'apollo' : 'aura',
      data: leadData,
      missing_fields: [],
      confidence: 1.0,
      message: apolloUsed ? 'Successfully enriched with Apollo company data' : 'Company data already complete in Aura CRM',
      enrichment_log: enrichmentLog,
    };
  } else {
    console.log(`[enrichment-orchestrator] Enrichment incomplete, needs manual edit`);
    return {
      success: false,
      source: 'manual',
      data: leadData,
      missing_fields: missing as string[],
      confidence: 1 - (missing.length / 8),
      needs_manual_edit: true,
      message: `Missing ${missing.length} company fields, requires manual edit in Aura CRM`,
      enrichment_log: enrichmentLog,
    };
  }
}
