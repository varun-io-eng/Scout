import type { PageExtraction } from '../types.js';

export interface AuraConfig {
  datahubBaseUrl: string;
  authToken: string;
}

export interface CampaignLead {
  id: number;
  campaign_id?: number;
  first_name?: string;
  last_name?: string;
  job_title?: string;
  company_name?: string;
  linkedin_url?: string;
  linkedin_headline?: string;
  linkedin_industry?: string;
  linkedin_summary?: string;
  stage?: string;
  lead_icp_status?: string;
  icp_messages?: string | Record<string, unknown>;
  industry?: string;
  job_level?: string;
  job_function?: string;
  company_city?: string;
  company_state?: string;
  company_country?: string;
  company_employee_size?: string;
  company_revenue_size?: string;
  email?: string;
  extras?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface IcpFieldEntry {
  field?: string;
  status?: string;
  over_ridden?: boolean | string;
  actual_value?: string;
  expected_value?: string;
  actual_values?: unknown[];
  expected_values?: unknown[];
  message?: string;
}

export interface IcpMessagesDoc {
  status?: string;
  fields?: IcpFieldEntry[];
}

export interface LeadProcessRequest {
  campaignId: number;
  lead: CampaignLead;
  extraction: PageExtraction;
  campaignIcp?: Record<string, unknown> | null;
  aura: AuraConfig;
}

export interface LeadProcessResult {
  leadId: number;
  leadName: string;
  linkedinUrl: string;
  fitsIcp: boolean;
  confidence: number;
  summary: string;
  linkedInRole?: string;
  linkedInCompany?: string;
  recommendedJobTitle?: string;
  recommendedCompany?: string;
  overrideFields: Array<'job_title' | 'company_name'>;
  fitScore?: number;
  icpMessagesJson?: string;
  stageAfter?: string;
  applied: boolean;
  error?: string;
  skipped?: boolean;
  skipReason?: string;
  locationOverride?: {
    company_country?: string;
    company_state?: string;
    company_city?: string;
  };
}

export interface AutomationRunRequest {
  campaignId: number;
  aura: AuraConfig;
  leadIds?: number[];
  stage?: string;
  autoApply?: boolean;
  limit?: number;
}

export interface AutomationRunResult {
  campaignId: number;
  processed: LeadProcessResult[];
  skipped: Array<{ leadId: number; reason: string }>;
  readyCount: number;
  failedCount: number;
}
