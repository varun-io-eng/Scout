/**
 * Runs in a plain Node process (not tsx) so Puppeteer cannot freeze the Scout API.
 * Protocol: JSON lines on stdin → JSON lines on stdout. Logs go to stderr.
 *
 * IMPORTANT: Never close the last Chrome tab — that exits the whole browser on Windows.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer-core';
import readline from 'readline';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROFILE_DIR = path.resolve(
  process.env.PUPPETEER_USER_DATA_DIR || path.join(__dirname, '../../data/puppeteer-profile'),
);
const HEADLESS = String(process.env.PUPPETEER_HEADLESS || 'false').toLowerCase() === 'true';
const LOGIN_WAIT_MS = Number(process.env.PUPPETEER_LOGIN_WAIT_MS || 5 * 60 * 1000);

const SYSTEM_CHROME = [
  process.env.PUPPETEER_EXECUTABLE_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  process.env.LOCALAPPDATA
    ? path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe')
    : '',
].find((p) => p && fs.existsSync(p));

let browser = null;
/** Single persistent tab — reused for login + every scrape. */
let mainPage = null;
let linkedInSessionOk = false;
let queue = Promise.resolve();

function log(...args) {
  console.error('[puppeteer-worker]', ...args);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function clearStaleProfileLocks() {
  if (!fs.existsSync(PROFILE_DIR)) return;
  for (const name of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
    const lockPath = path.join(PROFILE_DIR, name);
    try {
      if (fs.existsSync(lockPath)) {
        fs.rmSync(lockPath, { force: true });
        log('removed stale', name);
      }
    } catch (err) {
      log('could not remove', name, err?.message || err);
    }
  }
}

function looksLoggedInFromUrl(url) {
  const u = String(url || '').toLowerCase();
  if (/\/login|authwall|checkpoint|signup|uas\/authenticate/.test(u)) return false;
  return /linkedin\.com\/(feed|in\/|mynetwork|messaging|jobs|notifications|company\/)/.test(u);
}

function looksLoggedInFromDom(data) {
  const name = String(data?.personName || '').trim();
  if (/^join linkedin$/i.test(name)) return false;
  if (/sign in|create account/i.test(name)) return false;
  return Boolean(data?.loggedIn && name);
}

async function getBrowser() {
  if (browser?.connected) return browser;
  if (!SYSTEM_CHROME) {
    throw new Error(
      'No Chrome found. Install Google Chrome or set PUPPETEER_EXECUTABLE_PATH in server/.env',
    );
  }
  if (!fs.existsSync(PROFILE_DIR)) fs.mkdirSync(PROFILE_DIR, { recursive: true });
  clearStaleProfileLocks();
  linkedInSessionOk = false;
  mainPage = null;
  log(`launching ONE Chrome window headless=${HEADLESS} exe=${SYSTEM_CHROME}`);
  browser = await puppeteer.launch({
    headless: HEADLESS,
    executablePath: SYSTEM_CHROME,
    userDataDir: PROFILE_DIR,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-gpu',
      '--disable-blink-features=AutomationControlled',
      '--disable-session-crashed-bubble',
      '--disable-restore-session-state',
      '--no-first-run',
      '--no-default-browser-check',
      '--window-size=1280,900',
      '--window-position=80,80',
    ],
    defaultViewport: null,
  });
  browser.on('disconnected', () => {
    log('browser disconnected');
    browser = null;
    mainPage = null;
    linkedInSessionOk = false;
  });
  log('Chrome ready — keep this window open');
  return browser;
}

async function getMainPage() {
  const b = await getBrowser();
  if (mainPage && !mainPage.isClosed()) {
    return mainPage;
  }
  const pages = await b.pages();
  mainPage = pages[0] || (await b.newPage());
  // Close extras only — never close the last/main tab (that kills Chrome on Windows)
  for (const p of pages) {
    if (p !== mainPage) await p.close().catch(() => undefined);
  }
  await mainPage.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  );
  return mainPage;
}

/**
 * Block until LinkedIn session exists. Gives the user time to sign in in the ONE Chrome window.
 */
async function ensureLinkedInSession() {
  if (linkedInSessionOk) return;

  const page = await getMainPage();
  await page.bringToFront().catch(() => undefined);
  log('Checking LinkedIn session…');
  await page.goto('https://www.linkedin.com/feed/', {
    waitUntil: 'domcontentloaded',
    timeout: 45000,
  });
  await sleep(1500);

  if (looksLoggedInFromUrl(page.url())) {
    linkedInSessionOk = true;
    log('LinkedIn session OK');
    return;
  }

  await page.goto('https://www.linkedin.com/login', {
    waitUntil: 'domcontentloaded',
    timeout: 45000,
  });
  await page.bringToFront().catch(() => undefined);

  const minutes = Math.round(LOGIN_WAIT_MS / 60000);
  log(`>>> SIGN IN TO LINKEDIN NOW in this Chrome window. Waiting up to ${minutes} minutes…`);
  log('>>> Do not close the window. After you reach your Feed, Scout continues automatically.');

  const deadline = Date.now() + LOGIN_WAIT_MS;
  while (Date.now() < deadline) {
    await sleep(5000);
    // Prefer reading the live URL — do NOT force-navigate every loop (that steals the login form)
    let url = page.url();
    if (looksLoggedInFromUrl(url)) {
      linkedInSessionOk = true;
      log('LinkedIn login detected — continuing automation');
      return;
    }
    // If still on login, leave the user alone; only probe feed occasionally
    if (!/login|authwall|checkpoint|signup/i.test(url)) {
      try {
        await page.goto('https://www.linkedin.com/feed/', {
          waitUntil: 'domcontentloaded',
          timeout: 20000,
        });
        if (looksLoggedInFromUrl(page.url())) {
          linkedInSessionOk = true;
          log('LinkedIn login detected — continuing automation');
          return;
        }
      } catch {
        /* keep waiting */
      }
    }
    const left = Math.max(0, Math.round((deadline - Date.now()) / 1000));
    log(`Still waiting for LinkedIn login… (${left}s left) — finish signing in in the Chrome window`);
  }

  throw new Error(
    'LinkedIn login timed out. Sign in in the Scout Chrome window, then click Run automation again.',
  );
}

function profileVanityFromUrl(profileUrl) {
  try {
    const u = new URL(String(profileUrl || ''));
    const m = u.pathname.match(/\/in\/([^/?#]+)/i);
    return m ? decodeURIComponent(m[1]).replace(/\/$/, '').toLowerCase() : '';
  } catch {
    return '';
  }
}

function namesCompatiblyMatch(a, b) {
  const na = String(a || '').toLowerCase().replace(/[^a-z\s]/g, ' ').replace(/\s+/g, ' ').trim();
  const nb = String(b || '').toLowerCase().replace(/[^a-z\s]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!na || !nb) return false;
  if (na === nb) return true;
  const fa = na.split(' ')[0];
  const fb = nb.split(' ')[0];
  return fa.length >= 3 && fa === fb;
}

function jsonMentionsVanity(json, vanity) {
  if (!vanity) return true;
  const v = vanity.toLowerCase();
  let hit = false;
  walkJson(json, (cur) => {
    if (hit || Array.isArray(cur)) return;
    for (const key of ['publicIdentifier', 'vanityName', 'profileId', 'entityUrn', 'url', 'navigationUrl']) {
      const val = cur[key];
      if (typeof val === 'string' && val.toLowerCase().includes(v)) hit = true;
    }
  }, 3000);
  return hit;
}

function isLinkedInProfileApiUrl(url, vanity) {
  const u = String(url || '').toLowerCase();
  if (!u.includes('linkedin.com')) return false;
  return (
    u.includes('/voyager/api/') ||
    u.includes('/graphql') ||
    u.includes('profileview') ||
    u.includes('profileactionsittopcard') ||
    u.includes('/identity/profiles/') ||
    u.includes('position') ||
    u.includes('profilecards') ||
    u.includes('dash/profiles')
  );
}

function walkJson(root, visit, maxNodes = 8000) {
  const stack = [root];
  let n = 0;
  while (stack.length && n++ < maxNodes) {
    const cur = stack.pop();
    if (!cur || typeof cur !== 'object') continue;
    visit(cur);
    if (Array.isArray(cur)) {
      for (const x of cur) stack.push(x);
    } else {
      for (const v of Object.values(cur)) {
        if (v && typeof v === 'object') stack.push(v);
      }
    }
  }
}

function companyNameFromObj(obj) {
  if (!obj || typeof obj !== 'object') return '';
  if (typeof obj.companyName === 'string' && obj.companyName.trim()) return obj.companyName.trim();
  if (obj.company && typeof obj.company === 'object') {
    if (typeof obj.company.name === 'string') return obj.company.name.trim();
    if (typeof obj.company.companyName === 'string') return obj.company.companyName.trim();
  }
  if (obj.companyUrn && typeof obj.companyResolutionResult === 'object') {
    const r = obj.companyResolutionResult;
    if (typeof r.name === 'string') return r.name.trim();
  }
  return '';
}

/** Pull personName / headline / title / company from LinkedIn voyager/graphql JSON. */
function extractProfileFromNetworkJson(json, vanity) {
  const out = {
    personName: '',
    headline: '',
    currentTitle: '',
    currentCompany: '',
    publicIdentifier: '',
    hits: 0,
  };
  if (!json || typeof json !== 'object') return out;

  const positions = [];

  walkJson(json, (cur) => {
    if (Array.isArray(cur)) return;

    if (!out.publicIdentifier && typeof cur.publicIdentifier === 'string') {
      out.publicIdentifier = cur.publicIdentifier.trim();
    }

    if (!out.headline && typeof cur.headline === 'string' && cur.headline.trim().length >= 3) {
      out.headline = cur.headline.trim();
      out.hits += 1;
    }

    const first = typeof cur.firstName === 'string' ? cur.firstName.trim() : '';
    const last = typeof cur.lastName === 'string' ? cur.lastName.trim() : '';
    if (!out.personName && first && last) {
      out.personName = `${first} ${last}`.trim();
      out.hits += 1;
    }

    const title = typeof cur.title === 'string' ? cur.title.trim() : '';
    const company = companyNameFromObj(cur);
    const looksPosition =
      Boolean(title) &&
      (Boolean(company) ||
        cur.dateRange ||
        cur.timePeriod ||
        /position|experience|job/i.test(String(cur.$type || cur.entityUrn || '')));

    if (looksPosition && title.length >= 2 && title.length <= 160) {
      positions.push({
        title,
        company,
        current:
          !cur.dateRange?.end ||
          !cur.timePeriod?.endDate ||
          cur.dateRange?.end === null ||
          cur.timePeriod?.endDate === null,
      });
      out.hits += 1;
    }

    if (!out.currentTitle && typeof cur.occupation === 'string' && cur.occupation.trim().length >= 3) {
      out.currentTitle = cur.occupation.trim();
      out.hits += 1;
    }
  });

  if (vanity && out.publicIdentifier) {
    const pid = out.publicIdentifier.toLowerCase();
    const v = vanity.toLowerCase();
    if (pid && pid !== v && !pid.includes(v) && !v.includes(pid)) {
      return {
        personName: '',
        headline: '',
        currentTitle: '',
        currentCompany: '',
        publicIdentifier: out.publicIdentifier,
        hits: 0,
      };
    }
  }

  const preferred = positions.find((p) => p.current && p.title) || positions[0];
  if (preferred) {
    if (!out.currentTitle) out.currentTitle = preferred.title;
    if (!out.currentCompany && preferred.company) out.currentCompany = preferred.company;
  }

  if (out.headline && (!out.currentTitle || !out.currentCompany)) {
    const m = out.headline.match(/^(.{2,100}?)\s+(?:at|@|chez|bei)\s+(.{2,80}?)(?:\s*[·|•]|$)/i);
    if (m) {
      if (!out.currentTitle) out.currentTitle = m[1].trim();
      if (!out.currentCompany) out.currentCompany = m[2].trim();
    } else if (!out.currentTitle) {
      out.currentTitle = out.headline.split(/\s*[·|•|]\s*/)[0].trim();
    }
  }

  return out;
}

function attachLinkedInNetworkCapture(page, vanity) {
  const captured = {
    personName: '',
    headline: '',
    currentTitle: '',
    currentCompany: '',
    responseCount: 0,
    usefulCount: 0,
  };

  const onResponse = async (response) => {
    try {
      const reqUrl = response.url();
      if (!isLinkedInProfileApiUrl(reqUrl, vanity)) return;
      const ct = String(response.headers()['content-type'] || '');
      if (!/json|javascript|text\/plain/i.test(ct) && !reqUrl.includes('graphql')) return;
      if (response.status() < 200 || response.status() >= 300) return;
      const textBody = await response.text();
      if (!textBody || textBody.length < 20 || textBody.length > 2_000_000) return;
      captured.responseCount += 1;
      let json;
      try {
        json = JSON.parse(textBody);
      } catch {
        return;
      }
      const extracted = extractProfileFromNetworkJson(json);
      if (extracted.hits <= 0) return;
      captured.usefulCount += 1;
      if (extracted.personName && !captured.personName) captured.personName = extracted.personName;
      if (extracted.headline && (!captured.headline || extracted.headline.length > captured.headline.length)) {
        captured.headline = extracted.headline;
      }
      if (extracted.currentTitle && !captured.currentTitle) captured.currentTitle = extracted.currentTitle;
      if (extracted.currentCompany && !captured.currentCompany) {
        captured.currentCompany = extracted.currentCompany;
      }
    } catch {
      /* ignore individual response errors */
    }
  };

  page.on('response', onResponse);
  return {
    captured,
    detach() {
      page.off('response', onResponse);
    },
  };
}

async function scrapeLinkedIn(url) {
  await ensureLinkedInSession();

  const page = await getMainPage();
  await page.bringToFront().catch(() => undefined);
  log('navigating profile', url);

  const vanity = profileVanityFromUrl(url);
  const net = attachLinkedInNetworkCapture(page, vanity);
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page
      .waitForFunction(
        () => {
          const h1 = document.querySelector('main h1, h1');
          const t = (h1?.textContent || '').replace(/\s+/g, ' ').trim();
          const title = (document.title || '').replace(/\s*\|\s*LinkedIn\s*$/i, '').trim();
          const exp = document.querySelector('#experience')?.closest('section');
          const expText = (exp?.innerText || '').replace(/\s+/g, ' ').trim();
          return (
            (t.length >= 2 && !/^join linkedin$/i.test(t)) ||
            title.split(/\s[-–—]\s/)[0]?.length >= 2 ||
            expText.length > 40
          );
        },
        { timeout: 25000 },
      )
      .catch(() => undefined);
    await sleep(1500);

    if (!looksLoggedInFromUrl(page.url())) {
      linkedInSessionOk = false;
      log('LinkedIn session lost — need sign-in again');
      await ensureLinkedInSession();
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await sleep(2000);
    }

    // Prepare like extension: see-more + wake Experience + return to top
    await page.evaluate(async () => {
      window.scrollTo(0, 0);
      document
        .querySelectorAll(
          'button.inline-show-more-text__button, button[aria-label*="see more" i], .inline-show-more-text__button',
        )
        .forEach((btn) => {
          try {
            btn.click();
          } catch {
            /* ignore */
          }
        });
      await new Promise((r) => setTimeout(r, 500));
      for (const y of [600, 1200, 2000, 2800]) {
        window.scrollTo(0, y);
        await new Promise((r) => setTimeout(r, 400));
      }
      const exp =
        document.querySelector('#experience') ||
        document.querySelector('[data-section="experience"]') ||
        [...document.querySelectorAll('h2, .pvs-header__title')].find((h) =>
          /^experience$/i.test((h.textContent || '').trim()),
        );
      if (exp) exp.scrollIntoView({ block: 'center', behavior: 'instant' });
      await new Promise((r) => setTimeout(r, 900));
      window.scrollTo(0, 0);
      await new Promise((r) => setTimeout(r, 400));
    });

    // Brief settle: LinkedIn defers Voyager/GraphQL responses after scroll — wait for them
    // to arrive and be processed by the network capture listener before reading DOM.
    await sleep(1800);

    const data = await page.evaluate(() => {
      const text = (el) => (el?.textContent || '').replace(/\s+/g, ' ').trim();
      const pathName = location.pathname.toLowerCase();
      const pageText = (document.body?.innerText || '').slice(0, 3000);

      const isUiChrome = (s) => {
        const t = String(s || '').replace(/\s+/g, ' ').trim();
        if (!t) return true;
        if (/^[·•|.\s]*\d*(st|nd|rd|th)\+?$/i.test(t)) return true;
        if (/^(1st|2nd|3rd|3rd\+)$/i.test(t)) return true;
        if (/^(he|she|they)(\s*\/\s*(him|her|them))+$/i.test(t)) return true;
        if (/^(he\/him|she\/her|they\/them|she|he|they)$/i.test(t)) return true;
        if (/^(in remembrance|memorial|open to work|hiring|contact info|message|connect|follow|more|pending)$/i.test(t))
          return true;
        if (/^\d+\+?\s*(followers?|connections?)$/i.test(t)) return true;
        if (/^(experience|education|about|skills|activity|featured|interests|feed)$/i.test(t)) return true;
        return false;
      };

      const JOB_HINT =
        /\b(director|vice[\s-]?president|evp|svp|avp|vp\b|president|manager|engineer|founder|co-?founder|head of|\bhead\b|lead\b|chief|officer|executive|analyst|consultant|specialist|product|marketing|sales|developer|designer|partner|owner|ceo|cto|cfo|coo|cmo|cro|business development|account executive|gtm|communications?)\b/i;

      const isEdu = (s) =>
        /\b(university|institute|college|school|iit\b|iim\b|bachelor|master|mba|ph\.?d|lycée|école)\b/i.test(
          String(s || ''),
        );

      const isDateLine = (s) => {
        const t = String(s || '').trim();
        return (
          (/^(full-time|part-time|contract|internship|self-employed|present)/i.test(t) ||
            /\b(yrs?|mos?|present)\b/i.test(t) ||
            /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\b/i.test(t)) &&
          /\d/.test(t)
        );
      };

      const isLikelyJobHeadline = (s, personName) => {
        const t = String(s || '').replace(/\s+/g, ' ').trim();
        if (!t || t.length < 3 || t.length > 220 || isUiChrome(t) || isEdu(t)) return false;
        if (personName) {
          const n = personName.toLowerCase();
          const tl = t.toLowerCase();
          if (tl === n || n.includes(tl) || tl.includes(n)) return false;
        }
        if (/followers?|connections?|message|connect|follow|reposted|activity|sign in|join linkedin/i.test(t))
          return false;
        if (/^[A-Za-z .'-]+,\s*[A-Za-z .'-]+$/.test(t) && t.length < 45) return false;
        if (JOB_HINT.test(t)) return true;
        if (/\s+(at|@|chez|bei)\s+/i.test(t) && t.length <= 120) return true;
        if (/[|@]/.test(t) && t.length <= 120 && JOB_HINT.test(t.split(/[|@]/)[0])) return true;
        return false;
      };

      const isJobTitleLine = (s, personName) => {
        const t = String(s || '').replace(/\s+/g, ' ').trim();
        if (!isLikelyJobHeadline(t, personName)) return false;
        return JOB_HINT.test(t) || /\s+at\s+/i.test(t);
      };

      // --- Name ---
      const h1 =
        document.querySelector('main h1.text-heading-xlarge') ||
        document.querySelector('.pv-text-details__left-panel h1') ||
        document.querySelector('main h1') ||
        document.querySelector('h1');
      let name = text(h1);
      if (isUiChrome(name) || /^join linkedin$/i.test(name)) name = '';

      const docTitle = (document.title || '').replace(/\s*\|\s*LinkedIn\s*$/i, '').trim();
      const ogTitle = (
        document.querySelector('meta[property="og:title"]')?.getAttribute('content') || ''
      )
        .replace(/\s*\|\s*LinkedIn\s*$/i, '')
        .trim();
      const ogDesc = (
        document.querySelector('meta[property="og:description"]')?.getAttribute('content') ||
        document.querySelector('meta[name="description"]')?.getAttribute('content') ||
        ''
      ).trim();
      if ((!name || name.length < 2) && (docTitle || ogTitle)) {
        name = (docTitle || ogTitle).split(/\s[-–—]\s/)[0].trim();
      }

      // JSON-LD
      let jsonLdTitle = '';
      let jsonLdCompany = '';
      try {
        for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
          const raw = script.textContent || '';
          if (!raw || raw.length > 500000) continue;
          let j;
          try {
            j = JSON.parse(raw);
          } catch {
            continue;
          }
          const nodes = Array.isArray(j) ? j : [j];
          for (const node of nodes) {
            if (!node || typeof node !== 'object') continue;
            if (typeof node.jobTitle === 'string' && node.jobTitle.trim()) jsonLdTitle = node.jobTitle.trim();
            const wf = node.worksFor;
            if (wf && typeof wf === 'object' && typeof wf.name === 'string') jsonLdCompany = wf.name.trim();
            if (Array.isArray(wf) && wf[0]?.name) jsonLdCompany = String(wf[0].name).trim();
          }
        }
      } catch {
        /* ignore */
      }

      // --- Headline (strict — never the person name) ---
      let headline = '';
      const classic = [
        ...document.querySelectorAll(
          '.pv-text-details__left-panel .text-body-medium.break-words, .ph5 .text-body-medium.break-words, .mt2 .text-body-medium.break-words, [data-anonymize="headline"], .top-card-layout__headline, .profile-topcard-person-entity__headline, .artdeco-entity-lockup__subtitle, .text-body-medium.break-words',
        ),
      ];
      for (const el of classic) {
        if (el.closest('#activity, #experience, #education, #skills, #about, footer, nav, .scaffold-layout__aside'))
          continue;
        const rect = el.getBoundingClientRect();
        if (rect.top + window.scrollY > 1200) continue;
        const t = text(el);
        if (t && isLikelyJobHeadline(t, name)) {
          headline = t;
          break;
        }
      }

      const card =
        h1?.closest('.pv-top-card') ||
        h1?.closest('.ph5') ||
        h1?.closest('section.artdeco-card') ||
        h1?.closest('section') ||
        h1?.parentElement?.parentElement;
      const topCardLines = [];
      if (!headline && card) {
        const lines = String(card.innerText || '')
          .split('\n')
          .map((l) => l.replace(/\s+/g, ' ').trim())
          .filter(Boolean);
        const nameIdx = lines.findIndex((l) => l === name || (name && l.startsWith(name.split(' ')[0])));
        const start = nameIdx >= 0 ? nameIdx + 1 : 0;
        for (let i = start; i < Math.min(lines.length, start + 12); i++) {
          topCardLines.push(lines[i]);
          if (isLikelyJobHeadline(lines[i], name)) {
            headline = lines[i];
            break;
          }
        }
      }

      if (!headline && h1) {
        let sib = h1.nextElementSibling;
        for (let i = 0; i < 8 && sib; i++, sib = sib.nextElementSibling) {
          const t = text(sib);
          if (isLikelyJobHeadline(t, name)) {
            headline = t;
            break;
          }
          for (const el of sib.querySelectorAll('.text-body-medium, span[aria-hidden="true"]')) {
            const inner = text(el);
            if (isLikelyJobHeadline(inner, name)) {
              headline = inner;
              break;
            }
          }
          if (headline) break;
        }
      }

      if (!headline && jsonLdTitle && isLikelyJobHeadline(jsonLdTitle, name)) headline = jsonLdTitle;
      if (!headline && ogDesc) {
        const first = ogDesc.split(/[.|]/)[0]?.trim();
        if (isLikelyJobHeadline(first, name)) headline = first;
      }
      if (!headline && /[-–—]/.test(docTitle || ogTitle)) {
        const parts = (docTitle || ogTitle).split(/\s[-–—]\s/).map((p) => p.trim()).filter(Boolean);
        if (parts[1] && isLikelyJobHeadline(parts[1], name)) headline = parts.slice(1).join(' · ');
      }

      // --- Experience (extension/background.js style: prefer aria-hidden) ---
      const expSection =
        document.querySelector('#experience')?.closest('section') ||
        document.querySelector('#experience')?.parentElement ||
        document.querySelector('[data-section="experience"]') ||
        document.querySelector('[componentkey*="Experience"]')?.closest('section') ||
        [...document.querySelectorAll('section, div')].find((el) => {
          const h = el.querySelector('h2, .pvs-header__title');
          return h && /^experience$/i.test(text(h));
        }) ||
        null;

      const aboutSection =
        document.querySelector('#about')?.closest('section') ||
        [...document.querySelectorAll('section')].find((s) => /^about$/i.test(text(s.querySelector('h2, h3')))) ||
        null;

      let experienceText = '';
      const candidates = [];
      const unique = [];
      if (expSection && !expSection.closest('#activity')) {
        // Prefer aria-hidden (LinkedIn duplicates visually-hidden text)
        for (const line of [...expSection.querySelectorAll('span[aria-hidden="true"]')].map(text)) {
          if (
            line &&
            line.length >= 2 &&
            line.length < 180 &&
            !isUiChrome(line) &&
            !unique.includes(line)
          ) {
            unique.push(line);
          }
        }
        if (unique.length < 2) {
          for (const line of String(expSection.innerText || '')
            .split('\n')
            .map((l) => l.replace(/\s+/g, ' ').trim())
            .filter((t) => t && t.length >= 2 && t.length < 180 && !isUiChrome(t))) {
            if (!unique.includes(line)) unique.push(line);
          }
        }
        experienceText = unique.join('\n').slice(0, 4500);
        candidates.push(...unique.slice(0, 10));
      }

      // Main-text Experience fallback
      if (!experienceText) {
        const mainText = document.querySelector('main')?.innerText || '';
        const m = mainText.match(
          /Experience\s*\n([\s\S]{20,2500}?)(?:\n(?:Education|Skills|Licenses|Languages|Interests|Activity|About)\b|$)/i,
        );
        if (m?.[1]) experienceText = m[1].trim().slice(0, 4500);
      }

      const about = text(aboutSection).slice(0, 2500);

      let currentTitle = '';
      let currentCompany = '';

      // 1) Experience-first (most reliable for title/company) — like background.js
      const expLines = (experienceText || unique.join('\n'))
        .split(/\n+|(?:\s*[·|•]\s*)/)
        .map((l) => l.replace(/\s+/g, ' ').trim())
        .filter(
          (l) =>
            l.length > 2 &&
            l.length < 160 &&
            !/^experience$/i.test(l) &&
            !isUiChrome(l) &&
            !isEdu(l) &&
            !(name && l.toLowerCase() === name.toLowerCase()),
        );

      // Regex harvest if blob collapsed
      if (expLines.length <= 1 && experienceText.length > 160) {
        const re =
          /((?:Senior |Junior |Lead |Principal |Staff |Head of |Vice President of |Vice President |VP of |VP |Director of |Director |Executive |Account )?[w/&+-]*(?:Manager|Director|Executive|Engineer|Founder|Officer|President|Consultant|Analyst|Specialist|Lead|Head)(?:\s+[\w/&+-]+){0,6})/gi;
        let m;
        while ((m = re.exec(experienceText)) && expLines.length < 8) {
          const t = m[1].replace(/\s+/g, ' ').trim();
          if (t.length >= 4 && t.length <= 120 && !expLines.includes(t) && isJobTitleLine(t, name)) {
            expLines.push(t);
          }
        }
      }

      for (let i = 0; i < expLines.length; i++) {
        const line = expLines[i];
        if (isDateLine(line) && !/ at /i.test(line) && !isJobTitleLine(line, name)) continue;

        const at = line.match(/^(.+?)\s+at\s+(.+)$/i);
        if (at) {
          const left = at[1].trim();
          const right = at[2].split(/[·|•]/)[0].trim();
          if (isJobTitleLine(left, name) && !isEdu(right)) {
            currentTitle = left;
            currentCompany = right;
            break;
          }
          continue;
        }

        const left = line.split(/[·|•]/)[0].trim();
        if (!currentTitle && isJobTitleLine(left, name)) {
          currentTitle = left;
          const next = expLines[i + 1];
          if (
            next &&
            !isJobTitleLine(next, name) &&
            !isDateLine(next) &&
            !isEdu(next) &&
            next.length < 120
          ) {
            currentCompany = next.split(/[·|•]/)[0].trim();
          }
          if (currentCompany) break;
          continue;
        }
        if (currentTitle && !currentCompany && !isJobTitleLine(line, name) && !isDateLine(line) && !isEdu(line)) {
          currentCompany = line.split(/[·|•]/)[0].trim();
          break;
        }
      }

      // 2) Headline only if it looks like a real job (not the name)
      if ((!currentTitle || !currentCompany) && headline && isLikelyJobHeadline(headline, name)) {
        const atCo = headline.match(/@\s*([^|·•]+)/);
        if (atCo) {
          if (!currentCompany) currentCompany = atCo[1].trim();
          if (!currentTitle) currentTitle = (headline.split('@')[0].split(/[|·•]/)[0] || '').trim();
        } else {
          const atMatch = headline.match(/^(.{2,120}?)\s+(?:at|chez|bei)\s+(.{2,100}?)(?:\s*[·|•]|$)/i);
          if (atMatch) {
            if (!currentTitle) currentTitle = atMatch[1].trim();
            if (!currentCompany) currentCompany = atMatch[2].trim();
          } else if (!currentTitle && isJobTitleLine(headline, name)) {
            currentTitle = headline.split(/\s*[·|•|]\s*/)[0].trim();
          }
        }
      }

      if (jsonLdTitle && !currentTitle && isJobTitleLine(jsonLdTitle, name)) currentTitle = jsonLdTitle;
      if (jsonLdCompany && !currentCompany) currentCompany = jsonLdCompany;

      // Final sanitize — never return the person name as title
      if (currentTitle && name && currentTitle.toLowerCase() === name.toLowerCase()) currentTitle = '';
      if (currentTitle && isUiChrome(currentTitle)) currentTitle = '';
      if (currentCompany && (isUiChrome(currentCompany) || isEdu(currentCompany))) currentCompany = '';
      if (headline && (!isLikelyJobHeadline(headline, name) || (name && headline.toLowerCase() === name.toLowerCase()))) {
        headline = currentTitle
          ? currentCompany
            ? currentTitle + ' at ' + currentCompany
            : currentTitle
          : '';
      } else if (!headline && currentTitle) {
        headline = currentCompany ? currentTitle + ' at ' + currentCompany : currentTitle;
      }

      const hasProfileChrome = Boolean(
        document.querySelector('.pv-top-card, .scaffold-layout__main h1, main h1, [data-anonymize="person-name"]'),
      );
      const authWall =
        /authwall|sign in to (view|see)|join linkedin|agree & join/i.test(pathName + ' ' + pageText) &&
        !hasProfileChrome;
      const loggedIn =
        !authWall &&
        !/\/login|authwall|checkpoint|signup|\/404/.test(pathName) &&
        Boolean(name || hasProfileChrome);

      return {
        personName: name,
        headline,
        about,
        experienceText,
        currentTitle,
        currentCompany,
        loggedIn,
        pageTitle: document.title || '',
        finalUrl: location.href,
        debugCandidates: (topCardLines.length ? topCardLines : candidates).slice(0, 5),
        experienceChars: experienceText.length,
        rawText: `${name}\n${headline}\n${currentTitle}\n${currentCompany}\n${about}\n${experienceText}\n${pageText}`.slice(
          0,
          8000,
        ),
      };
    });

    // Give async network capture handlers (response.text() is a promise) time to resolve
    // before we read netCap. If we already have useful data, a short wait is enough.
    {
      const captureDeadline = Date.now() + 2500;
      while (Date.now() < captureDeadline) {
        if (net.captured.usefulCount > 0 && net.captured.personName) break;
        await sleep(300);
      }
      if (net.captured.usefulCount === 0) {
        log('network capture: no useful API responses yet — DOM data will be used as primary');
      }
    }

    const netCap = net.captured;
    const pageUrl = String(data.finalUrl || page.url() || '');
    const onLeadProfile = Boolean(vanity) && pageUrl.toLowerCase().includes('/in/' + vanity.toLowerCase());
    if (!onLeadProfile) {
      log('warn: not on lead profile vanity=' + vanity + ' url=' + pageUrl + ' — ignoring network merge');
      // Don't accept feed/chrome as a successful lead scrape
      if (/\/feed\/?/i.test(pageUrl) || /^feed$/i.test(String(data.personName || ''))) {
        data.personName = '';
        data.headline = '';
        data.currentTitle = '';
        data.currentCompany = '';
        data.loggedIn = looksLoggedInFromUrl(pageUrl);
        data.error =
          'Navigated away from lead LinkedIn profile (ended on feed/login). Retry — keep Scout Chrome on the lead URL.';
      }
    }
    const netMatchesLead =
      onLeadProfile &&
      netCap.usefulCount > 0 &&
      (!data.personName || !netCap.personName || namesCompatiblyMatch(data.personName, netCap.personName));

    // Prefer DOM for the open lead profile; only fill gaps from network when it matches this lead
    if (netMatchesLead) {
      if (netCap.personName && !data.personName) data.personName = netCap.personName;
      if (!data.headline && netCap.headline) data.headline = netCap.headline;
      if (!data.currentTitle && netCap.currentTitle) data.currentTitle = netCap.currentTitle;
      if (!data.currentCompany && netCap.currentCompany) data.currentCompany = netCap.currentCompany;
    } else if (netCap.usefulCount > 0) {
      log(
        'ignored network profile (logged-in user bleed) netName="' +
          netCap.personName +
          '" netTitle="' +
          String(netCap.currentTitle || netCap.headline || '').slice(0, 60) +
          '" pageName="' +
          data.personName +
          '"',
      );
    }

    if (data.headline && (!data.currentTitle || !data.currentCompany)) {
      const m = String(data.headline).match(
        /^(.{2,100}?)\s+(?:at|@|chez|bei)\s+(.{2,80}?)(?:\s*[·|•]|$)/i,
      );
      if (m) {
        if (!data.currentTitle) data.currentTitle = m[1].trim();
        if (!data.currentCompany) data.currentCompany = m[2].trim();
      } else if (
        !data.currentTitle &&
        data.headline.length >= 3 &&
        data.headline.length <= 120 &&
        !/btech|b\.tech|tiet|dsa|leetcode|freshman|sophomore/i.test(data.headline)
      ) {
        data.currentTitle = data.headline.split(/\s*[·|•|]\s*/)[0].trim();
      }
    }

    log(
      `profile scrape name="${data.personName}" title="${data.currentTitle}" company="${data.currentCompany}" headline="${String(data.headline || '').slice(0, 80)}" netHits=${netCap.usefulCount}/${netCap.responseCount} expChars=${data.experienceChars || 0} url=${data.finalUrl || page.url()}`,
    );

    if (!String(data.currentTitle || '').trim()) {
      log(
        `scrape debug candidates=${JSON.stringify((data.debugCandidates || []).slice(0, 3))} netTitle="${netCap.currentTitle}" netHeadline="${String(netCap.headline || '').slice(0, 60)}"`,
      );
    }

    delete data.debugCandidates;
    delete data.experienceChars;

    if (!looksLoggedInFromDom(data) && !looksLoggedInFromUrl(page.url())) {
      linkedInSessionOk = false;
      return {
        url,
        ...data,
        loggedIn: false,
        error: 'LinkedIn login required — sign in in the Scout Chrome window, then Run again',
      };
    }

    if (!String(data.personName || '').trim()) {
      return {
        url,
        ...data,
        loggedIn: true,
        error:
          'LinkedIn profile scrape empty — no name/title found (auth wall or page not loaded). Not deleting; fix scrape/login and retry.',
      };
    }

    return { url, ...data, loggedIn: true };
  } finally {
    net.detach();
  }
}

async function scrapeWebsite(url) {
  await ensureLinkedInSession();

  const page = await getMainPage();
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 35000 });
    await sleep(1500);
    const data = await page.evaluate(() => {
      const meta =
        document.querySelector('meta[name="description"]')?.getAttribute('content') ||
        document.querySelector('meta[property="og:description"]')?.getAttribute('content') ||
        '';
      const title = document.title || '';
      const body = (document.body?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 6000);
      return { title, description: meta.slice(0, 800), bodyText: body };
    });
    return { url, ...data };
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

function reply(msg) {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

async function handle(msg) {
  const { id, action, url } = msg || {};
  try {
    if (action === 'ping') {
      reply({ id, ok: true, result: { pong: true } });
      return;
    }
    if (action === 'linkedin') {
      log('scrape LinkedIn', url);
      const result = await scrapeLinkedIn(String(url || ''));
      reply({ id, ok: true, result });
      return;
    }
    if (action === 'website') {
      log('scrape website', url);
      const result = await scrapeWebsite(String(url || ''));
      reply({ id, ok: true, result });
      return;
    }
    if (action === 'close') {
      mainPage = null;
      if (browser) {
        await browser.close().catch(() => undefined);
        browser = null;
      }
      linkedInSessionOk = false;
      reply({ id, ok: true, result: { closed: true } });
      return;
    }
    reply({ id, ok: false, error: `Unknown action: ${action}` });
  } catch (err) {
    reply({ id, ok: false, error: err instanceof Error ? err.message : String(err) });
  }
}

function enqueue(msg) {
  queue = queue.then(() => handle(msg)).catch((err) => {
    reply({
      id: msg?.id,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  });
}

log('started');
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    reply({ id: null, ok: false, error: 'Invalid JSON' });
    return;
  }
  enqueue(msg);
});
rl.on('close', async () => {
  if (browser) await browser.close().catch(() => undefined);
  process.exit(0);
});
