import { describe, it, expect } from 'vitest';
import { ruleBasedFitScore, FIT_SCORE_READY_THRESHOLD } from './lead-brain.js';
import type { CampaignLead } from './types.js';

const lead: CampaignLead = {
  id: 42,
  campaign_id: 7,
  first_name: 'Jane',
  last_name: 'Doe',
  job_title: 'VP Marketing',
  company_name: 'Acme Corp',
  stage: 'NOT_ELIGIBLE',
};

describe('ruleBasedFitScore', () => {
  it('scores 8+ when title and company match ICP', () => {
    const result = ruleBasedFitScore(
      {
        jobTitle: 'VP Marketing',
        company: 'Acme Corp',
        headline: 'VP Marketing at Acme Corp',
        whatTheyDo: 'Marketing leadership',
        source: 'crm',
      },
      lead,
      { job_title: ['VP Marketing', 'Head of Marketing'], company_name: ['Acme Corp'] },
      [],
    );
    expect(result.fitScore).toBeGreaterThanOrEqual(FIT_SCORE_READY_THRESHOLD);
    expect(result.overrideFields).toContain('job_title');
  });

  it('scores below threshold when title mismatches ICP', () => {
    const result = ruleBasedFitScore(
      {
        jobTitle: 'Intern',
        company: 'Acme Corp',
        headline: 'Intern',
        whatTheyDo: 'Student',
        source: 'crm',
      },
      lead,
      { job_title: ['VP Marketing'], company_name: ['Acme Corp'] },
      ['job_title'],
    );
    expect(result.fitScore).toBeLessThan(FIT_SCORE_READY_THRESHOLD);
    expect(result.overrideFields).toEqual([]);
  });
});
