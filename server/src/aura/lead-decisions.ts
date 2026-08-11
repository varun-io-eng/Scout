/**
 * Pure decision helpers for ICP scoring thresholds and Ready/ reject paths.
 * Used by lead-brain and unit tests.
 */

export const DEFAULT_READY_THRESHOLD = 8;

export function parseFitScore(raw: unknown): number | null {
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n)) return null;
  return Math.min(10, Math.max(0, Math.round(n * 10) / 10));
}

export interface ReadyDecisionInput {
  fitScore: number;
  threshold?: number;
  operatorVerified: boolean;
  scrapeUsable: boolean;
  hasLocationFix: boolean;
  autoApply: boolean;
}

export type ReadyDecisionAction = 'ready' | 'reject' | 'preview' | 'skip';

export interface ReadyDecisionResult {
  shouldReady: boolean;
  action: ReadyDecisionAction;
  reason: string;
}

/**
 * Mirrors processLeadWithLinkedIn auto-apply gate:
 * - score >= threshold → auto-ready
 * - score < threshold && !scrapeUsable → reject (needs LinkedIn Confirm)
 * - otherwise operator verify, location fix, or fitsIcp may still Ready
 */
export function evaluateReadyDecision(input: ReadyDecisionInput): ReadyDecisionResult {
  const threshold = input.threshold ?? DEFAULT_READY_THRESHOLD;
  const scoreClears = input.fitScore >= threshold;
  const fitsIcp = scoreClears && input.scrapeUsable;

  if (!input.autoApply) {
    return {
      shouldReady: false,
      action: 'preview',
      reason: 'autoApply disabled — score-only preview',
    };
  }

  if (scoreClears) {
    return {
      shouldReady: true,
      action: 'ready',
      reason: `fitScore ${input.fitScore} >= threshold ${threshold} — auto-ready`,
    };
  }

  if (!input.scrapeUsable) {
    return {
      shouldReady: false,
      action: 'reject',
      reason: `Below threshold (${input.fitScore} < ${threshold}) — needs LinkedIn Confirm`,
    };
  }

  const shouldReady =
    input.operatorVerified ||
    scoreClears ||
    fitsIcp ||
    (input.scrapeUsable && input.hasLocationFix);

  if (!shouldReady) {
    return {
      shouldReady: false,
      action: 'skip',
      reason: `Below threshold (${input.fitScore} < ${threshold}) and no location fix`,
    };
  }

  if (input.operatorVerified) {
    return {
      shouldReady: true,
      action: 'ready',
      reason: 'operator verified role on LinkedIn',
    };
  }

  if (input.hasLocationFix) {
    return {
      shouldReady: true,
      action: 'ready',
      reason: `location override applied with fitScore ${input.fitScore}/10`,
    };
  }

  return {
    shouldReady: true,
    action: 'ready',
    reason: `fitScore ${input.fitScore} with usable LinkedIn scrape`,
  };
}
