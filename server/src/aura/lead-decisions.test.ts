import { describe, it, expect } from 'vitest';
import {
  parseFitScore,
  evaluateReadyDecision,
  DEFAULT_READY_THRESHOLD,
} from './lead-decisions.js';

describe('parseFitScore', () => {
  it('clamps to 0–10', () => {
    expect(parseFitScore(12)).toBe(10);
    expect(parseFitScore(-3)).toBe(0);
  });

  it('returns null for non-numeric input', () => {
    expect(parseFitScore('n/a')).toBeNull();
    expect(parseFitScore(undefined)).toBeNull();
  });

  it('rounds to one decimal place', () => {
    expect(parseFitScore(7.86)).toBe(7.9);
  });
});

describe('evaluateReadyDecision', () => {
  it('auto-ready when score >= threshold', () => {
    const d = evaluateReadyDecision({
      fitScore: 8,
      threshold: DEFAULT_READY_THRESHOLD,
      operatorVerified: false,
      scrapeUsable: false,
      hasLocationFix: false,
      autoApply: true,
    });
    expect(d.shouldReady).toBe(true);
    expect(d.action).toBe('ready');
  });

  it('rejects when below threshold and LinkedIn not usable', () => {
    const d = evaluateReadyDecision({
      fitScore: 6,
      threshold: 8,
      operatorVerified: false,
      scrapeUsable: false,
      hasLocationFix: false,
      autoApply: true,
    });
    expect(d.shouldReady).toBe(false);
    expect(d.action).toBe('reject');
  });

  it('ready on operator verify even with low score', () => {
    const d = evaluateReadyDecision({
      fitScore: 5,
      threshold: 8,
      operatorVerified: true,
      scrapeUsable: true,
      hasLocationFix: false,
      autoApply: true,
    });
    expect(d.shouldReady).toBe(true);
    expect(d.action).toBe('ready');
  });

  it('ready via location fix when scrape usable', () => {
    const d = evaluateReadyDecision({
      fitScore: 6,
      threshold: 8,
      operatorVerified: false,
      scrapeUsable: true,
      hasLocationFix: true,
      autoApply: true,
    });
    expect(d.shouldReady).toBe(true);
    expect(d.reason).toMatch(/location override/i);
  });

  it('preview only when autoApply is false', () => {
    const d = evaluateReadyDecision({
      fitScore: 9,
      operatorVerified: false,
      scrapeUsable: true,
      hasLocationFix: false,
      autoApply: false,
    });
    expect(d.action).toBe('preview');
    expect(d.shouldReady).toBe(false);
  });
});
