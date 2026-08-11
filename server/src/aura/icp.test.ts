import { describe, it, expect } from 'vitest';
import {
  getInvalidFields,
  deriveStageAfterOverride,
  applyFieldOverride,
  resolveLocationOverrideFromIcp,
  mapInvalidFieldToOverride,
} from './icp.js';
import type { IcpMessagesDoc } from './types.js';

describe('ICP field helpers', () => {
  const baseDoc: IcpMessagesDoc = {
    status: 'INVALID',
    fields: [
      { field: 'job_title', status: 'INVALID' },
      { field: 'company_name', status: 'VALID' },
      { field: 'country', status: 'INVALID', expected_values: ['United States'] },
    ],
  };

  it('getInvalidFields returns non-overridden INVALID fields', () => {
    expect(getInvalidFields(baseDoc)).toEqual(['job_title', 'country']);
  });

  it('getInvalidFields ignores overridden INVALID fields', () => {
    const doc = applyFieldOverride(baseDoc, 'job_title');
    expect(getInvalidFields(doc)).toEqual(['country']);
  });

  it('deriveStageAfterOverride returns READY when blockers cleared', () => {
    let doc = applyFieldOverride(baseDoc, 'job_title');
    doc = applyFieldOverride(doc, 'country');
    const json = JSON.stringify(doc);
    expect(deriveStageAfterOverride('NOT_ELIGIBLE', json)).toBe('READY');
  });

  it('deriveStageAfterOverride returns undefined when INVALID remains', () => {
    const json = JSON.stringify(baseDoc);
    expect(deriveStageAfterOverride('NOT_ELIGIBLE', json)).toBeUndefined();
  });

  it('mapInvalidFieldToOverride maps title aliases', () => {
    expect(mapInvalidFieldToOverride('Title')).toBe('job_title');
    expect(mapInvalidFieldToOverride('company')).toBe('company_name');
    expect(mapInvalidFieldToOverride('industry')).toBeNull();
  });

  it('resolveLocationOverrideFromIcp picks expected country', () => {
    const fix = resolveLocationOverrideFromIcp(baseDoc);
    expect(fix?.company_country).toBe('United States');
    expect(fix?.fieldsToOverride).toContain('country');
  });
});
