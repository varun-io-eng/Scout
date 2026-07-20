export type SourceType = 'linkedin' | 'website' | 'crunchbase' | 'news' | 'manual' | 'other';

export interface PageExtraction {
  url: string;
  title: string;
  sourceType: SourceType;
  companyName?: string;
  personName?: string;
  description?: string;
  industry?: string;
  location?: string;
  employeeCount?: string;
  funding?: string;
  technologies?: string[];
  rawText: string;
  metadata?: Record<string, unknown>;
}

export interface LinkedInProfileData {
  personName: string;
  headline?: string;
  jsonTitle?: string;
  jsonCompany?: string;
  location?: string;
  expLines?: string[];
  profileUrl: string;
  currentCompany: string;
  currentTitle: string;
  email?: string;
  phone?: string;
  workHistory?: Array<{ title: string; company: string; duration: string }>;
  education?: Array<{ school: string; degree: string; field: string }>;
  skills?: string[];
  about?: string;
  connections?: string;
}

export interface EnrichedProfileData extends LinkedInProfileData {
  enrichedEmail?: string;
  enrichedPhone?: string;
  enrichedWorkHistory?: Array<{ title: string; company: string; duration: string; startDate?: string; endDate?: string }>;
  enrichedEducation?: Array<{ school: string; degree: string; field: string; startDate?: string; endDate?: string }>;
  enrichedSkills?: string[];
  verifiedEmail?: boolean;
  verifiedPhone?: boolean;
  enrichmentSource?: 'proxycurl' | 'pdl' | 'dom';
  enrichmentTimestamp?: string;
}

export interface CompanyProfile {
  id: string;
  name: string;
  domain?: string;
  industry?: string;
  description?: string;
  location?: string;
  employeeCount?: string;
  funding?: string;
  technologies: string[];
  competitors: Competitor[];
  investmentInsights: string[];
  hiringInsights: string[];
  sources: SourceRef[];
  createdAt: string;
  updatedAt: string;
}

export interface Competitor {
  name: string;
  reason: string;
  confidence: number;
}

export interface SourceRef {
  url: string;
  title: string;
  sourceType: SourceType;
  capturedAt: string;
}

export interface KnowledgeChunk {
  id: string;
  companyId?: string;
  content: string;
  sourceUrl: string;
  embedding?: number[];
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface AskResponse {
  answer: string;
  sources: Array<{ url: string; title: string; snippet: string }>;
  companies: string[];
}
