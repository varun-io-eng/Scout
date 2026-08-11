import { describe, it, expect } from 'vitest';
import {
  mergeCompanyEnrichmentIntoLead,
  isCompanyEnrichmentStale,
  type LeadWithCompanyData,
} from './apollo-company-enrichment.js';

const baseLead: LeadWithCompanyData = {
  id: 1,
  campaign_id: 10,
  company_name: 'Stripe',
  company_industry: 'Payments',
};

describe('mergeCompanyEnrichmentIntoLead', () => {
  const enrichedAt = '2026-01-01T00:00:00.000Z';

  it('fills empty fields from Apollo', () => {
    const { updated, changedFields } = mergeCompanyEnrichmentIntoLead(
      baseLead,
      { company_website: 'https://stripe.com', company_city: 'San Francisco' },
      enrichedAt,
    );
    expect(updated.company_website).toBe('https://stripe.com');
    expect(updated.company_city).toBe('San Francisco');
    expect(changedFields).toContain('company_website');
    expect(changedFields).toContain('company_enrichment_source');
  });

  it('skips fields that already match', () => {
    const { changedFields } = mergeCompanyEnrichmentIntoLead(
      { ...baseLead, company_industry: 'Payments' },
      { company_industry: 'Payments', company_website: 'https://stripe.com' },
      enrichedAt,
    );
    expect(changedFields).not.toContain('company_industry');
    expect(changedFields).toContain('company_website');
  });

  it('updates fields that differ from CRM', () => {
    const { updated, changedFields } = mergeCompanyEnrichmentIntoLead(
      { ...baseLead, company_employee_size: '2–10' },
      { company_employee_size: '1001–5000' },
      enrichedAt,
    );
    expect(updated.company_employee_size).toBe('1001–5000');
    expect(changedFields).toContain('company_employee_size');
  });
});

describe('isCompanyEnrichmentStale', () => {
  it('treats missing last_verified_at as stale', () => {
    expect(isCompanyEnrichmentStale({})).toBe(true);
  });

  it('treats recent verification as fresh', () => {
    const recent = new Date();
    recent.setDate(recent.getDate() - 10);
    expect(
      isCompanyEnrichmentStale({ company_last_verified_at: recent.toISOString() }),
    ).toBe(false);
  });

  it('treats >90 day verification as stale', () => {
    const old = new Date();
    old.setDate(old.getDate() - 100);
    expect(isCompanyEnrichmentStale({ company_last_verified_at: old.toISOString() })).toBe(
      true,
    );
  });
});
