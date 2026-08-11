import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

export type LeadDecisionAction = 'ready' | 'queued' | 'delete' | 'reject' | 'skip';

export interface LeadDecisionLogEntry {
  ts: string;
  action: LeadDecisionAction;
  leadId: number;
  campaignId?: number;
  fitScore?: number;
  threshold?: number;
  reason: string;
  source?: string;
  stageAfter?: string;
  operatorVerified?: boolean;
  scrapeUsable?: boolean;
  method?: string;
}

let logPathOverride: string | null = null;

/** Test hook — redirect JSONL output to a temp file. */
export function setDecisionLogPathForTests(filePath: string | null): void {
  logPathOverride = filePath;
}

function getLogPath(): string {
  if (logPathOverride) return logPathOverride;
  const envPath = process.env.SCOUT_DECISION_LOG_PATH;
  if (envPath) return envPath;
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'data');
  return path.join(dir, 'decisions.jsonl');
}

export function logLeadDecision(entry: Omit<LeadDecisionLogEntry, 'ts'>): void {
  const full: LeadDecisionLogEntry = { ...entry, ts: new Date().toISOString() };
  const line = `${JSON.stringify(full)}\n`;
  const filePath = getLogPath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, line, 'utf8');
}
