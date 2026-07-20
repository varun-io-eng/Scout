import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import { createInterface } from 'readline';
import {
  cleanLinkedInHeadline,
  looksLikeJobTitle,
  splitExperienceLines,
} from './lead-brain.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKER_PATH = path.join(__dirname, 'puppeteer-worker.mjs');

export interface LinkedInProfileScrape {
  url: string;
  personName: string;
  headline: string;
  about: string;
  experienceText: string;
  currentTitle: string;
  currentCompany: string;
  loggedIn: boolean;
  rawText: string;
  error?: string;
}

export interface WebsiteScrape {
  url: string;
  title: string;
  description: string;
  bodyText: string;
  error?: string;
}

type WorkerResponse = {
  id: number;
  ok: boolean;
  result?: unknown;
  error?: string;
};

let worker: ChildProcessWithoutNullStreams | null = null;
let nextId = 1;
const pending = new Map<
  number,
  { resolve: (v: WorkerResponse) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }
>();

function rejectAll(err: Error) {
  for (const [, p] of pending) {
    clearTimeout(p.timer);
    p.reject(err);
  }
  pending.clear();
}

function workerAlive(): boolean {
  return Boolean(worker && !worker.killed && worker.exitCode === null);
}

function ensureWorker(): ChildProcessWithoutNullStreams {
  if (workerAlive() && worker) return worker;

  console.log('[puppeteer] starting Chrome worker (separate process)…');
  const child = spawn(process.execPath, [WORKER_PATH], {
    cwd: path.resolve(__dirname, '../..'),
    env: { ...process.env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  worker = child;

  const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg: WorkerResponse;
    try {
      msg = JSON.parse(trimmed) as WorkerResponse;
    } catch {
      console.warn('[puppeteer] worker non-JSON stdout:', trimmed.slice(0, 200));
      return;
    }
    const wait = pending.get(msg.id);
    if (!wait) return;
    clearTimeout(wait.timer);
    pending.delete(msg.id);
    wait.resolve(msg);
  });

  child.stderr.on('data', (buf) => {
    const text = String(buf).trimEnd();
    if (text) console.log(text);
  });

  child.on('exit', (code, signal) => {
    console.warn(`[puppeteer] worker exited code=${code} signal=${signal}`);
    if (worker === child) worker = null;
    rejectAll(new Error(`Chrome worker exited (code=${code}, signal=${signal})`));
  });

  child.on('error', (err) => {
    console.warn('[puppeteer] worker error:', err.message);
    if (worker === child) worker = null;
    rejectAll(err);
  });

  return child;
}

function callWorker<T>(
  action: 'linkedin' | 'website' | 'ping' | 'close',
  url: string,
  timeoutMs: number,
): Promise<T> {
  const child = ensureWorker();
  const id = nextId++;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(
        new Error(
          `Chrome worker timed out after ${Math.round(timeoutMs / 1000)}s on ${action}. Check the separate Chrome window / LinkedIn login.`,
        ),
      );
    }, timeoutMs);

    pending.set(id, {
      resolve: (msg) => {
        if (!msg.ok) {
          reject(new Error(msg.error || `Worker failed on ${action}`));
          return;
        }
        resolve(msg.result as T);
      },
      reject,
      timer,
    });

    try {
      child.stdin.write(`${JSON.stringify({ id, action, url })}\n`);
    } catch (err) {
      clearTimeout(timer);
      pending.delete(id);
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

/** Normalize worker output with the same title/company heuristics used elsewhere in Scout. */
export function normalizeLinkedInScrape(raw: LinkedInProfileScrape): LinkedInProfileScrape {
  const cleaned = cleanLinkedInHeadline(raw.headline || raw.currentTitle || '');
  let currentTitle = '';
  let currentCompany = '';

  if (looksLikeJobTitle(raw.currentTitle)) currentTitle = raw.currentTitle.trim();
  else if (raw.currentTitle?.trim() && !/^[·•|.\s]*\d*(st|nd|rd|th)/i.test(raw.currentTitle)) {
    // Trust worker network/DOM title when it isn't obvious UI chrome
    const t = raw.currentTitle.trim();
    if (t.length >= 3 && t.length <= 100 && !/^(she|he|they|in remembrance)$/i.test(t)) {
      currentTitle = t;
    }
  }
  // Never keep person name as job title
  if (
    currentTitle &&
    raw.personName &&
    currentTitle.toLowerCase() === raw.personName.toLowerCase()
  ) {
    currentTitle = '';
  }
  if (raw.currentCompany?.trim()) currentCompany = raw.currentCompany.trim();

  if (!currentTitle && cleaned.title) {
    currentTitle = cleaned.title;
    if (!currentCompany && cleaned.company) currentCompany = cleaned.company;
  }

  if (!currentTitle) {
    const expLines = splitExperienceLines(raw.experienceText || '');
    for (const line of expLines) {
      const fromLine = cleanLinkedInHeadline(line);
      if (fromLine.title && looksLikeJobTitle(fromLine.title)) {
        currentTitle = fromLine.title;
        if (!currentCompany && fromLine.company) currentCompany = fromLine.company;
        break;
      }
      if (looksLikeJobTitle(line)) {
        currentTitle = line.replace(/\s*[·|•].*$/, '').trim();
        break;
      }
    }
    // Soft salvage: first multi-word non-chrome experience line
    if (!currentTitle) {
      for (const line of expLines) {
        const t = line.replace(/\s+/g, ' ').trim();
        if (
          t.length >= 4 &&
          t.length <= 90 &&
          (t.match(/\s/g) || []).length >= 1 &&
          !/^(experience|full-time|part-time|present)/i.test(t) &&
          !/^[·•|.\s]*\d*(st|nd|rd|th)/i.test(t)
        ) {
          currentTitle = t.replace(/\s*[·|•].*$/, '').trim();
          break;
        }
      }
    }
  }

  // French/German "chez"/"bei" company salvage from headline
  if (currentTitle && !currentCompany) {
    const m = String(raw.headline || raw.currentTitle || '').match(
      /^(.+?)\s+(?:at|@|chez|bei)\s+(.+?)(?:\s*[·|•]|$)/i,
    );
    if (m) {
      currentTitle = m[1].trim();
      currentCompany = m[2].trim();
    }
  }

  const headline =
    cleaned.headline && looksLikeJobTitle(cleaned.headline.split(/[·|]/)[0] || '')
      ? cleaned.headline
      : currentTitle && currentCompany
        ? `${currentTitle} at ${currentCompany}`
        : currentTitle || (looksLikeJobTitle(raw.headline) ? raw.headline : raw.headline || '');

  const out: LinkedInProfileScrape = {
    ...raw,
    currentTitle,
    currentCompany,
    headline: headline && !/^[·•|.\s]*\d*(st|nd|rd|th)/i.test(headline) ? headline : currentTitle,
  };

  if (raw.loggedIn && raw.personName && !currentTitle) {
    const expChars = String(raw.experienceText || '').length;
    console.warn(
      `[puppeteer] normalize: partial scrape name="${raw.personName}" expChars=${expChars} rawTitle="${raw.currentTitle}" rawHeadline="${String(raw.headline || '').slice(0, 60)}"`,
    );
    // Do not set error — lead-verify continues with whatever fields LinkedIn returned
  } else if (currentTitle && out.error?.includes('no job title')) {
    delete out.error;
  }

  return out;
}

export async function closeBrowser(): Promise<void> {
  if (!worker) return;
  try {
    await callWorker('close', '', 10000);
  } catch {
    /* ignore */
  }
  try {
    worker.kill();
  } catch {
    /* ignore */
  }
  worker = null;
}

export async function scrapeLinkedInProfile(profileUrl: string): Promise<LinkedInProfileScrape> {
  const url = String(profileUrl || '').trim();
  if (!url) {
    return {
      url: '',
      personName: '',
      headline: '',
      about: '',
      experienceText: '',
      currentTitle: '',
      currentCompany: '',
      loggedIn: false,
      rawText: '',
      error: 'Missing LinkedIn URL',
    };
  }

  try {
    const raw = await callWorker<LinkedInProfileScrape>('linkedin', url, 6 * 60 * 1000);
    return normalizeLinkedInScrape(raw);
  } catch (err) {
    return {
      url,
      personName: '',
      headline: '',
      about: '',
      experienceText: '',
      currentTitle: '',
      currentCompany: '',
      loggedIn: false,
      rawText: '',
      error: err instanceof Error ? err.message : 'LinkedIn scrape failed',
    };
  }
}

export async function scrapeCompanyWebsite(websiteUrl: string): Promise<WebsiteScrape> {
  const url = String(websiteUrl || '').trim();
  if (!url) {
    return { url: '', title: '', description: '', bodyText: '', error: 'No company website' };
  }

  try {
    return await callWorker<WebsiteScrape>('website', url, 60000);
  } catch (err) {
    return {
      url,
      title: '',
      description: '',
      bodyText: '',
      error: err instanceof Error ? err.message : 'Website scrape failed',
    };
  }
}
