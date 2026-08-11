import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { logLeadDecision, setDecisionLogPathForTests } from './decision-log.js';

describe('decision log', () => {
  let tempFile: string;

  beforeEach(() => {
    tempFile = path.join(os.tmpdir(), `scout-decisions-${Date.now()}.jsonl`);
    setDecisionLogPathForTests(tempFile);
  });

  afterEach(() => {
    setDecisionLogPathForTests(null);
    if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
  });

  it('appends JSONL with score and reason', () => {
    logLeadDecision({
      action: 'ready',
      leadId: 99,
      campaignId: 3,
      fitScore: 8.5,
      threshold: 8,
      reason: 'fitScore 8.5 >= threshold 8',
      stageAfter: 'READY',
    });

    const lines = fs.readFileSync(tempFile, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0]);
    expect(entry.action).toBe('ready');
    expect(entry.leadId).toBe(99);
    expect(entry.fitScore).toBe(8.5);
    expect(entry.reason).toMatch(/threshold/);
    expect(entry.ts).toBeTruthy();
  });

  it('logs delete decisions', () => {
    logLeadDecision({
      action: 'delete',
      leadId: 12,
      campaignId: 1,
      reason: 'permanently removed from campaign',
    });
    const entry = JSON.parse(fs.readFileSync(tempFile, 'utf8').trim());
    expect(entry.action).toBe('delete');
  });
});

describe('POST /api/leads/company-enrich', () => {
  const mockEnrich = vi.fn();
  const mockConfigured = vi.fn();

  beforeEach(() => {
    vi.resetModules();
    mockConfigured.mockReturnValue(false);
    mockEnrich.mockReset();
  });

  it('returns 400 when Apollo is not configured', async () => {
    vi.doMock('./aura/apollo-company-enrichment.js', () => ({
      enrichCompanyForLead: mockEnrich,
      mergeCompanyEnrichmentIntoLead: vi.fn(),
      batchEnrichCompaniesForLeads: vi.fn(),
      isApolloConfigured: mockConfigured,
    }));
    vi.doMock('./db.js', () => ({
      listCompanies: () => [],
      findCompanyById: vi.fn(),
      upsertCompany: vi.fn(),
      addKnowledgeChunk: vi.fn(),
      getAllChunks: () => [],
      searchChunksKeyword: () => [],
    }));
    vi.doMock('./ai.js', () => ({
      hasAI: () => false,
      getProvider: () => 'none',
      buildProfileFromExtraction: vi.fn(),
      detectCompetitors: vi.fn(),
      embedText: vi.fn(),
      answerQuestion: vi.fn(),
      semanticSearch: vi.fn(),
    }));
    vi.doMock('./enrichment-orchestrator.js', () => ({ enrichLead: vi.fn() }));
    vi.doMock('./aura/leads-routes.js', () => {
      const { Router } = require('express');
      return { createLeadRoutes: () => Router() };
    });

    const express = (await import('express')).default;
    const routes = (await import('./routes.js')).default;
    const app = express();
    app.use(express.json());
    app.use('/api', routes);

    const request = (await import('supertest')).default;
    const res = await request(app)
      .post('/api/leads/company-enrich')
      .send({
        lead: { id: 1, campaign_id: 2, company_name: 'Stripe' },
        aura: {
          datahubBaseUrl: 'https://example.com/datahub',
          authToken: 'test-token-1234567890',
        },
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Apollo API not configured/i);
  });
});
