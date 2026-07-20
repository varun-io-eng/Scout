const API_BASE = 'http://localhost:3847/api';
const LINKEDIN_DELAY_MS = 800;
const LINKEDIN_RETRY_MS = 2000;
const LINKEDIN_MAX_ATTEMPTS = 8;
const BETWEEN_LEADS_MS = 1500;
const AUTO_PROCESS_COOLDOWN_MS = 3 * 60 * 1000;
const FIT_SCORE_CONFIRM_THRESHOLD = 8;

/** Shared automation control — Stop button sets stopRequested */
const automationControl = {
  running: false,
  stopRequested: false,
  workerTabId: null,
  auraTabId: null,
};

/** In-flight / recent auto-process for on-page LinkedIn assist */
const autoProcessState = {
  inFlightByTab: new Map(),
  recentBySlug: new Map(),
};

/**
 * Cache of LinkedIn profile fields pushed by the MutationObserver in linkedin-assist.js.
 * Key: LinkedIn slug (e.g. "johndoe"). Value: { fields, url, cachedAt }.
 * TTL: 60 seconds — stale entries are ignored so we re-read if the user re-visits.
 */
const linkedinProfileCache = new Map(); // slug → { fields, url, cachedAt }
const LINKEDIN_CACHE_TTL_MS = 60 * 1000;

function normalizeLinkedInProfileKey(raw) {
  try {
    const t = String(raw || '').trim();
    if (!t) return null;
    const withProto = /^https?:\/\//i.test(t) ? t : `https://${t.replace(/^\/+/, '')}`;
    const u = new URL(withProto);
    const m = u.pathname.match(/\/in\/([^/]+)/i);
    if (!m?.[1]) return null;
    return decodeURIComponent(m[1]).toLowerCase().replace(/\/+$/, '');
  } catch {
    const m = String(raw || '').match(/\/in\/([^/?#]+)/i);
    return m?.[1] ? decodeURIComponent(m[1]).toLowerCase().replace(/\/+$/, '') : null;
  }
}

function linkedInUrlsMatch(a, b) {
  const ka = normalizeLinkedInProfileKey(a);
  const kb = normalizeLinkedInProfileKey(b);
  return Boolean(ka && kb && ka === kb);
}

function sleepMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getStoredAuraContext() {
  const data = await chrome.storage.local.get(['scoutAuraSession', 'scoutPendingLinkedInLead']);
  return {
    session: data.scoutAuraSession || null,
    pending: data.scoutPendingLinkedInLead || null,
  };
}

async function resolveLeadForProfile(campaignId, aura, { linkedinUrl, leadId, personName }) {
  const params = new URLSearchParams();
  if (linkedinUrl) params.set('linkedinUrl', linkedinUrl);
  if (leadId) params.set('leadId', String(leadId));
  if (personName) params.set('personName', personName);
  const res = await fetch(`${API_BASE}/leads/resolve/${campaignId}?${params}`, {
    headers: {
      'x-aura-token': aura.authToken,
      'x-datahub-url': aura.datahubBaseUrl,
    },
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `Resolve error ${res.status}`);
  return data;
}

async function waitForOpenLinkedInProfile(tabId, expectedUrl, expectedLeadName) {
  let lastExtraction = null;
  let bestExtraction = null;

  for (let attempt = 0; attempt < LINKEDIN_MAX_ATTEMPTS; attempt++) {
    if (attempt > 0) await sleepMs(LINKEDIN_RETRY_MS);
    else await sleepMs(LINKEDIN_DELAY_MS);

    const missing = await detectLinkedInProfileMissing(tabId);
    if (missing?.missing) {
      const err = new Error(`LinkedIn profile does not exist — ${missing.reason || 'skipping'}`);
      err.code = 'PROFILE_MISSING';
      throw err;
    }

    let tabTitle = '';
    let tabUrl = '';
    try {
      const tab = await chrome.tabs.get(tabId);
      tabTitle = tab.title || '';
      tabUrl = tab.url || '';
    } catch {
      /* ignore */
    }

    const titleName = nameFromLinkedInTitle(tabTitle);
    const onProfile = /linkedin\.com\/in\//i.test(tabUrl || expectedUrl || '');

    if (expectedLeadName && titleName && !namesLooselyMatch(titleName, expectedLeadName) && attempt < 2) {
      continue;
    }
    if (!onProfile && attempt < 2) continue;

    try {
      await runOnTab(tabId, () => {
        window.scrollTo(0, 700);
        window.scrollTo(0, 1400);
        window.scrollTo(0, 0);
      });
    } catch {
      /* ignore */
    }

    // Use the polling extractor -- waits up to 15s for React to render
    let fields;
    try { fields = await extractLinkedInFieldsWaiting(tabId); } catch { continue; }
    if (!fields || fields.blocked) throw new Error('LinkedIn auth wall - sign in to LinkedIn, then retry');
    if (fields.missing) continue;
    // Build PageExtraction from targeted fields
    let curTitle = fields.jsonTitle || '';
    let curCompany = fields.jsonCompany || '';
    if (!curTitle && fields.headline) {
      const atM = fields.headline.match(/^(.+?)\s+(?:at|@)\s+(.+?)(?:\s*[|*]|$)/i);
      if (atM) { curTitle = atM[1].trim(); if (!curCompany) curCompany = atM[2].trim(); }
      else curTitle = fields.headline.split(/[|*@]/)[0].trim();
    }
    if (!curTitle && fields.expLines.length) {
      for (const line of fields.expLines) {
        if (!/^(full-time|part-time|contract|present|\d{4})/i.test(line) && line.length >= 4) {
          curTitle = line.split(/[*@]/)[0].trim(); break;
        }
      }
    }
    const expTextAuto = fields.expLines.join('\n');
    const rawTextAuto = [
      fields.headline  && ('HEADLINE:\n' + fields.headline),
      curTitle         && ('CURRENT_TITLE:\n' + curTitle),
      curCompany       && ('CURRENT_COMPANY:\n' + curCompany),
      fields.location  && ('LOCATION:\n' + fields.location),
      expTextAuto      && ('EXPERIENCE:\n' + expTextAuto),
    ].filter(Boolean).join('\n\n');
    const hasRoleAuto = Boolean(curTitle && curTitle.length >= 3);
    lastExtraction = {
      url: expectedUrl || '', title: fields.personName || titleName,
      sourceType: 'linkedin', personName: fields.personName || titleName,
      companyName: curCompany || undefined, description: fields.headline || curTitle || '',
      location: fields.location || undefined, rawText: rawTextAuto,
      metadata: {
        pageType: 'profile', currentTitle: curTitle, currentCompany: curCompany,
        scrapeMode: hasRoleAuto ? 'targeted-rich' : fields.personName ? 'targeted-name-only' : 'targeted-empty',
        scrapeWeak: !hasRoleAuto, profileLoaded: Boolean(fields.personName),
        sections: { experience: expTextAuto },
      },
    };
    if (!lastExtraction.personName && titleName) lastExtraction.personName = titleName;

    if (lastExtraction?.personName) {
      if (
        !bestExtraction ||
        String(lastExtraction.rawText || '').length > String(bestExtraction.rawText || '').length ||
        (extractionHasRoleSignal(lastExtraction) && !extractionHasRoleSignal(bestExtraction))
      ) {
        bestExtraction = lastExtraction;
      }
      if (extractionHasRoleSignal(lastExtraction) && extractionLooksRich(lastExtraction)) {
        return lastExtraction;
      }
      // Role signal alone is enough to stop early
      if (extractionHasRoleSignal(lastExtraction) && attempt >= 2) {
        return lastExtraction;
      }
    }
  }

  if (bestExtraction) {
    if (!extractionLooksRich(bestExtraction)) {
      bestExtraction.metadata = { ...(bestExtraction.metadata || {}), scrapeWeak: true };
    }
    return bestExtraction;
  }
  return lastExtraction;
}

async function autoProcessOpenLinkedInProfile(tabId, profileUrlHint) {
  if (automationControl.running) {
    return { skipped: true, reason: 'Bulk automation is running — finish or Stop first' };
  }

  if (autoProcessState.inFlightByTab.get(tabId)) {
    return { skipped: true, reason: 'Already inspecting this tab' };
  }

  let tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    return { error: 'LinkedIn tab closed' };
  }

  const profileUrl = profileUrlHint || tab.url || '';
  const slug = normalizeLinkedInProfileKey(profileUrl);
  if (!slug) {
    return { skipped: true, reason: 'Not a LinkedIn profile URL' };
  }

  const recentAt = autoProcessState.recentBySlug.get(slug) || 0;
  if (Date.now() - recentAt < AUTO_PROCESS_COOLDOWN_MS) {
    return { skipped: true, reason: 'Already inspected this profile recently' };
  }

  autoProcessState.inFlightByTab.set(tabId, true);

  try {
    const { session, pending } = await getStoredAuraContext();
    const pendingFresh =
      pending && Date.now() - Number(pending.stashedAt || 0) < 15 * 60 * 1000 ? pending : null;

    const campaignId = Number(pendingFresh?.campaignId || session?.campaignId);
    const aura = pendingFresh?.aura || session?.aura;
    if (!Number.isFinite(campaignId) || campaignId <= 0) {
      return {
        skipped: true,
        reason: 'Open an Aura campaign first so Scout knows which leads to update',
      };
    }
    if (!aura?.authToken || !aura?.datahubBaseUrl) {
      return { skipped: true, reason: 'Sign in to Aura, then open a campaign page once' };
    }

    const queue = await fetchLeadQueue(campaignId, aura);
    let lead =
      queue.find((l) => linkedInUrlsMatch(l.linkedinUrl || l.linkedin_url, profileUrl)) || null;

    // Prefer the lead the operator just clicked in Aura (even if CRM URL differs slightly)
    if (!lead && pendingFresh?.leadId) {
      lead =
        queue.find((l) => Number(l.id) === Number(pendingFresh.leadId)) ||
        {
          id: pendingFresh.leadId,
          linkedin_url: pendingFresh.linkedinUrl,
          linkedinUrl: pendingFresh.linkedinUrl,
          name: pendingFresh.leadName,
          ...(pendingFresh.lead || {}),
        };
    }

    // Server resolve: any stage, by slug / leadId / name (also logs to terminal)
    let tabPersonName = '';
    try {
      const early = await scrapeLinkedInProfileInline(tabId);
      tabPersonName = early?.personName || nameFromLinkedInTitle(early?.title || tab.title || '') || '';
    } catch {
      /* ignore */
    }

    if (!lead || !lead.id) {
      const resolved = await resolveLeadForProfile(campaignId, aura, {
        linkedinUrl: profileUrl,
        leadId: pendingFresh?.leadId,
        personName: pendingFresh?.leadName || tabPersonName,
      });
      if (resolved?.found && resolved.lead) {
        if (!resolved.processable) {
          return {
            skipped: true,
            reason: `${resolved.lead.name || 'Lead'} is already ${resolved.stage || 'not Not Eligible'} — open a Not Eligible lead`,
          };
        }
        lead = resolved.lead;
      }
    }

    if (!lead) {
      return {
        skipped: true,
        reason: tabPersonName
          ? `No Not Eligible lead matched "${tabPersonName}" / this LinkedIn URL in campaign #${campaignId}`
          : `No matching Not Eligible lead for this LinkedIn URL in campaign #${campaignId}`,
      };
    }

    const leadName = lead.name || leadDisplayNameFallback(lead) || `Lead #${lead.id}`;

    let extraction;
    try {
      extraction = await waitForOpenLinkedInProfile(tabId, profileUrl, leadName);
    } catch (err) {
      if (err?.code === 'PROFILE_MISSING') {
        return { skipped: true, reason: 'LinkedIn profile does not exist — skipped' };
      }
      throw err;
    }

    if (!extraction?.personName && !extractionLooksRich(extraction)) {
      return {
        skipped: true,
        reason: 'Could not read enough LinkedIn info — stay on the profile a moment and reopen',
      };
    }

    if (!extractionLooksRich(extraction)) {
      extraction.metadata = { ...(extraction.metadata || {}), scrapeWeak: true };
    }

    const result = await processLeadOnServer(campaignId, lead, extraction, aura);
    // Don't cooldown failed LinkedIn reads — operator can reopen and retry
    if (!result?.error || result.stageAfter === 'READY') {
      autoProcessState.recentBySlug.set(slug, Date.now());
    }

    try {
      await chrome.storage.local.remove('scoutPendingLinkedInLead');
    } catch {
      /* ignore */
    }

    // Nudge Aura banner if open
    broadcastProgress(
      result.stageAfter === 'READY'
        ? `Auto: ${leadName} → Ready (${result.fitScore ?? '?'}/10)`
        : `Auto: ${leadName} scored ${result.fitScore ?? '?'}/10 — ${result.stageAfter || 'not Ready'}`,
    );

    return {
      ...result,
      leadName,
      applied: result.stageAfter === 'READY' || Boolean(result.applied),
      summary: result.reason || result.message || '',
    };
  } finally {
    autoProcessState.inFlightByTab.delete(tabId);
  }
}

function leadDisplayNameFallback(lead) {
  return (
    lead?.name ||
    [lead?.first_name, lead?.last_name].filter(Boolean).join(' ') ||
    lead?.full_name ||
    ''
  );
}

function requestAutomationStop() {
  automationControl.stopRequested = true;
  broadcastProgress('Stopping automation…');
  broadcastAutomationState();
}

function broadcastAutomationState() {
  chrome.tabs.query({}, (tabs) => {
    if (chrome.runtime.lastError) return;
    for (const tab of tabs) {
      if (!tab.id) continue;
      chrome.tabs.sendMessage(
        tab.id,
        {
          type: 'SCOUT_AUTOMATION_STATE',
          running: automationControl.running,
          stopRequested: automationControl.stopRequested,
        },
        () => {
          void chrome.runtime.lastError;
        },
      );
    }
  });
}

function assertNotStopped() {
  if (automationControl.stopRequested) {
    const err = new Error('Automation stopped');
    err.code = 'STOPPED';
    throw err;
  }
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false });
});

self.addEventListener('unhandledrejection', (event) => {
  const msg = String(event.reason?.message || event.reason || '');
  if (/extension context invalidated/i.test(msg)) {
    event.preventDefault();
  }
});

function sleep(ms) {
  return new Promise(async (resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      if (automationControl.stopRequested) {
        reject(Object.assign(new Error('Automation stopped'), { code: 'STOPPED' }));
        return;
      }
      if (Date.now() - start >= ms) {
        resolve();
        return;
      }
      setTimeout(tick, Math.min(250, ms - (Date.now() - start)));
    };
    tick();
  });
}

function nameFromLinkedInTitle(title) {
  const t = String(title || '').trim();
  if (!t) return '';
  // "Seyedmehdi Jenab | LinkedIn" or "Seyedmehdi Jenab | Professional Profile ..."
  const m = t.match(/^(.+?)\s*\|\s*(LinkedIn|Professional|Profile)/i);
  if (m?.[1]) {
    const name = m[1].trim();
    if (name.length >= 2 && name.length <= 120 && !/^(sign in|join|feed|home|notifications)/i.test(name)) {
      return name;
    }
  }
  return '';
}

function extractionHasRoleSignal(extraction) {
  if (!extraction || extraction.error) return false;
  const desc = String(extraction.description || '').trim();
  const about = String(extraction.metadata?.sections?.about || '').trim();
  const exp = String(extraction.metadata?.sections?.experience || '').trim();
  const currentTitle = String(extraction.metadata?.currentTitle || '').trim();
  const isActivity = (t) =>
    /activity\d|\bfollowers?\b|\breposted this\b/i.test(t) ||
    (/\bfollow/i.test(t) && /\b(posts?|comments?|images)/i.test(t));
  if (currentTitle.length >= 2 && !isActivity(currentTitle)) return true;
  if (desc.length >= 4 && !isActivity(desc) && !/^about\b/i.test(desc)) return true;
  if (exp.length >= 30 && !isActivity(exp)) return true;
  if (about.length >= 40 && !isActivity(about)) return true;
  return false;
}

async function scrapeLinkedInProfileInline(tabId) {
  const result = await runOnTab(tabId, () => {
    const textOf = (el) => (el?.innerText || el?.textContent || '').replace(/\s+/g, ' ').trim();
    const isJunk = (t) =>
      !t ||
      /sign in|join linkedin|privacy|help center|linkedin corporation|cookie|accessibility|skip to|message|connect|follow|more profiles|people also viewed|ad choices|©/i.test(
        t,
      );

    const path = location.pathname.toLowerCase();
    const blocked =
      /\/login|authwall|checkpoint/.test(path) ||
      Boolean(document.querySelector('form.login__form, #username, input[name="session_key"]'));

    const parseJsonLdPerson = () => {
      const out = { name: '', jobTitle: '', company: '', description: '' };
      const scripts = [...document.querySelectorAll('script[type="application/ld+json"]')];
      for (const script of scripts) {
        let data;
        try {
          data = JSON.parse(script.textContent || '');
        } catch {
          continue;
        }
        const stack = Array.isArray(data) ? [...data] : [data];
        while (stack.length) {
          const node = stack.pop();
          if (!node || typeof node !== 'object') continue;
          if (Array.isArray(node['@graph'])) stack.push(...node['@graph']);
          if (node.mainEntity) stack.push(node.mainEntity);
          const types = []
            .concat(node['@type'] || [])
            .map((t) => String(t).toLowerCase());
          if (types.includes('person') || node.jobTitle || node.worksFor) {
            if (!out.name && node.name) out.name = String(node.name).trim();
            if (!out.jobTitle && node.jobTitle) out.jobTitle = String(node.jobTitle).trim();
            const wf = node.worksFor;
            if (!out.company && wf) {
              out.company = String(typeof wf === 'string' ? wf : wf.name || '').trim();
            }
            if (!out.description && node.description) out.description = String(node.description).trim();
          }
        }
      }
      return out;
    };

    const jsonLd = parseJsonLdPerson();

    const titleName = (() => {
      const t = String(document.title || '').trim();
      const m = t.match(/^(.+?)\s*\|\s*(LinkedIn|Professional|Profile)/i);
      const name = m?.[1]?.trim() || '';
      if (name.length >= 2 && name.length <= 120 && !/^(sign in|join|feed|home)/i.test(name)) return name;
      return '';
    })();

    const ogTitle = document.querySelector('meta[property="og:title"]')?.content?.trim() || '';
    const ogName = (() => {
      const m = ogTitle.match(/^(.+?)\s*\|\s*(LinkedIn|Professional|Profile)/i);
      return m?.[1]?.trim() || (ogTitle && !/linkedin/i.test(ogTitle) ? ogTitle : '');
    })();

    const ogDesc =
      document.querySelector('meta[property="og:description"]')?.content?.trim() ||
      document.querySelector('meta[name="description"]')?.content?.trim() ||
      '';

    const nameCandidates = [
      document.querySelector('h1.text-heading-xlarge'),
      document.querySelector('main h1'),
      document.querySelector('.pv-text-details__left-panel h1'),
      document.querySelector('[data-anonymize="person-name"]'),
      document.querySelector('.artdeco-entity-lockup__title'),
      document.querySelector('section.artdeco-card h1'),
      ...document.querySelectorAll('h1'),
    ];
    let domName = '';
    let nameEl = null;
    for (const el of nameCandidates) {
      const n = textOf(el);
      if (n && n.length >= 2 && n.length <= 120 && !/^(sign in|join linkedin|linkedin)/i.test(n)) {
        domName = n;
        nameEl = el;
        break;
      }
    }

    const personName = domName || jsonLd.name || titleName || ogName;

    const isActivityBlob = (t) =>
      /activity\d|\bfollowers?\b|\breposted this\b/i.test(t || '') ||
      (/\bfollow/i.test(t || '') && /\b(posts?|comments?|images)/i.test(t || '')) ||
      /\b\d(st|nd|rd|th)\+/i.test(t || '') ||
      /\d(mo|w|d|h)\b/i.test(t || '') ||
      /using the power of|transform business/i.test(t || '') ||
      /\d(st|nd|rd|th)\+[A-Za-z]/i.test(t || '');

    const looksLikeHeadline = (t) => {
      if (!t || t.length < 3 || t.length > 200) return false;
      if (isJunk(t) || isActivityBlob(t)) return false;
      if (personName && t === personName) return false;
      if (/^about\b/i.test(t) || /\bmy expertise\b/i.test(t)) return false;
      if (/\b(university|institute|college|school|iit\b|iim\b|bachelor|master|mba|ph\.?d|urbana-?champaign)\b/i.test(t)) {
        return false;
      }
      if (t.length > 120 && (t.match(/\./g) || []).length >= 1) return false;
      if (/^\d[\d,+.\s]*$/.test(t)) return false;
      if (/^(contact info|followers?|connections?|message|connect|follow|more|about|experience|education|activity|posts)$/i.test(t)) {
        return false;
      }
      if (/^[A-Za-z .'-]+,\s*[A-Za-z .'-]+$/.test(t) && t.length < 40 && !/\b(at|@|engineer|manager|director|founder|head|lead|vp|chief|officer|product|marketing|sales|executive|president|account)\b/i.test(t)) {
        return false;
      }
      return true;
    };

    // PRIMARY: classic headline near top, then text under name
    const headlineFromName = () => {
      const classic = [
        ...document.querySelectorAll(
          '.pv-text-details__left-panel .text-body-medium.break-words, .ph5 .text-body-medium.break-words, .mt2 .text-body-medium.break-words, [data-anonymize="headline"], .text-body-medium.break-words',
        ),
      ];
      for (const el of classic) {
        if (el.closest('#activity, #experience, #education, #skills, #about, footer, nav, .scaffold-layout__aside')) {
          continue;
        }
        const rect = el.getBoundingClientRect();
        if (rect.top + window.scrollY > 1100) continue;
        const t = textOf(el);
        if (t && t !== personName && looksLikeHeadline(t)) return t;
      }

      if (!nameEl) return '';
      const card =
        nameEl.closest('.pv-top-card') ||
        nameEl.closest('.ph5') ||
        nameEl.closest('section.artdeco-card') ||
        nameEl.closest('section') ||
        nameEl.parentElement?.parentElement;
      if (card) {
        const lines = String(card.innerText || '')
          .split('\n')
          .map((l) => l.replace(/\s+/g, ' ').trim())
          .filter(Boolean);
        const nameIdx = lines.findIndex((l) => l === personName || l.startsWith(personName));
        const start = nameIdx >= 0 ? nameIdx + 1 : 0;
        for (let i = start; i < Math.min(lines.length, start + 10); i++) {
          if (looksLikeHeadline(lines[i])) return lines[i];
        }
      }

      let sib = nameEl?.nextElementSibling;
      for (let i = 0; i < 8 && sib; i++, sib = sib.nextElementSibling) {
        const t = textOf(sib);
        if (looksLikeHeadline(t) && t.length <= 160) return t;
        for (const el of sib.querySelectorAll('.text-body-medium, span[aria-hidden="true"]')) {
          const inner = textOf(el);
          if (looksLikeHeadline(inner) && inner.length <= 160) return inner;
        }
      }
      return '';
    };

    let description = '';
    let headlineSource = '';
    const underName = headlineFromName();
    if (underName) {
      description = underName;
      headlineSource = 'under-h1';
    }

    if (!description && jsonLd.jobTitle) {
      description = jsonLd.company ? `${jsonLd.jobTitle} at ${jsonLd.company}` : jsonLd.jobTitle;
      headlineSource = 'json-ld';
    }

    if (!description && ogDesc && looksLikeHeadline(ogDesc.split(/[|·•]/)[0]?.trim() || ogDesc)) {
      const cleaned = ogDesc
        .replace(/\s*View\s+.+$/i, '')
        .split(/[|·•]/)[0]
        ?.trim();
      if (looksLikeHeadline(cleaned)) {
        description = cleaned;
        headlineSource = 'og-description';
      }
    }

    const headlineFromTopCard = () => {
      if (!nameEl || description) return '';
      const card =
        nameEl.closest('section') ||
        nameEl.closest('.artdeco-card') ||
        nameEl.closest('[data-view-name*="profile"]') ||
        nameEl.parentElement?.parentElement?.parentElement ||
        nameEl.parentElement;
      if (!card) return '';
      const ariaSpans = [...card.querySelectorAll('span[aria-hidden="true"]')]
        .map(textOf)
        .filter(looksLikeHeadline);
      for (const t of ariaSpans) {
        if (t !== personName) return t;
      }
      return '';
    };

    if (!description) {
      const top = headlineFromTopCard();
      if (top) {
        description = top;
        headlineSource = 'top-card';
      }
    }

    const sectionByHeading = (names) => {
      const headings = [...document.querySelectorAll('h2, h3, .pvs-header__title, div[id]')];
      for (const h of headings) {
        const label = textOf(h).replace(/#+$/, '').trim();
        if (!names.some((n) => new RegExp(`^${n}$`, 'i').test(label))) continue;
        const container =
          h.closest('section') ||
          h.closest('.artdeco-card') ||
          h.closest('div.pvs-list__container') ||
          (h.id ? h.parentElement : null);
        if (container) return container;
      }
      return null;
    };

    const experienceRoot =
      document.querySelector('#experience')?.closest('section') ||
      document.querySelector('#experience')?.parentElement ||
      document.querySelector('[data-section="experience"]') ||
      document.querySelector('section[componentkey*="Experience" i]') ||
      document.querySelector('[id*="experience" i]')?.closest('section') ||
      sectionByHeading(['Experience']);

    let experience = '';
    let currentTitle = '';
    let currentCompany = '';
    if (experienceRoot) {
      // LinkedIn duplicates text in visually-hidden + aria-hidden — prefer aria-hidden
      const ariaLines = [...experienceRoot.querySelectorAll('span[aria-hidden="true"]')]
        .map(textOf)
        .filter((t) => t && t.length >= 2 && t.length < 180 && !isJunk(t));
      const unique = [];
      for (const line of ariaLines) {
        if (!unique.includes(line)) unique.push(line);
      }
      experience = (unique.length ? unique.join('\n') : textOf(experienceRoot)).slice(0, 6000);

      // Job-like lines only — never schools/education
      const isEdu = (s) =>
        /\b(university|institute|college|school|iit\b|iim\b|bachelor|master|mba|ph\.?d|urbana-?champaign)\b/i.test(
          s,
        );
      const isJob = (s) =>
        looksLikeHeadline(s) &&
        !isEdu(s) &&
        /\b(director|vice|president|evp|svp|vp\b|manager|engineer|founder|head|lead|chief|officer|executive|analyst|consultant|specialist|product|marketing|sales|developer|designer|partner|owner|ceo|cto|business development)\b/i.test(
          s,
        );

      for (const line of unique) {
        if (/^experience$/i.test(line) || isEdu(line)) continue;
        if (/^\d|present|yr|mo|full-time|part-time/i.test(line) && !/ at /i.test(line)) continue;
        const left = line.split('·')[0].trim();
        const at = left.match(/^(.+?)\s+at\s+(.+)$/i);
        if (at) {
          if (!isJob(at[1]) || isEdu(at[2])) continue;
          currentTitle = at[1].trim();
          currentCompany = at[2].trim();
          break;
        }
        if (!currentTitle && (isJob(left) || (looksLikeHeadline(left) && !isEdu(left)))) {
          if (!isJob(left) && !/\b(director|manager|engineer|founder|head|lead|vp|chief|executive|president|product|marketing|sales)\b/i.test(left)) {
            continue;
          }
          currentTitle = left;
          continue;
        }
        if (currentTitle && !currentCompany && line.length < 120 && line !== currentTitle && !isEdu(line)) {
          currentCompany = line.split('·')[0].trim();
          break;
        }
      }
    }

    const aboutRoot =
      document.querySelector('#about')?.closest('section') ||
      document.querySelector('#about')?.parentElement ||
      document.querySelector('[id*="about" i]')?.closest('section') ||
      sectionByHeading(['About']);
    let about = aboutRoot ? textOf(aboutRoot).slice(0, 4000) : '';

    // Main-text fallback: "Experience" block between headings
    const main = document.querySelector('main');
    const mainText = main?.innerText || document.body?.innerText || '';
    if (!experience && /experience/i.test(mainText)) {
      const m = mainText.match(/Experience\s*\n([\s\S]{20,2500}?)(?:\n(?:Education|Skills|Licenses|Languages|Interests|Activity|About)\b|$)/i);
      if (m?.[1]) experience = m[1].trim().slice(0, 5000);
    }
    if (!about && /About\s*\n/i.test(mainText)) {
      const m = mainText.match(/About\s*\n([\s\S]{20,2000}?)(?:\n(?:Experience|Education|Activity|Skills)\b|$)/i);
      if (m?.[1]) about = m[1].trim().slice(0, 4000);
    }

    if (!description && currentTitle) {
      description = currentCompany ? `${currentTitle} at ${currentCompany}` : currentTitle;
      headlineSource = headlineSource || 'experience-first';
    }
    if (!description && experience) {
      const lines = experience
        .split(/\n/)
        .map((l) => l.trim())
        .filter(
          (l) =>
            l.length > 2 &&
            l.length < 160 &&
            !/^experience$/i.test(l) &&
            !/\b(university|institute|college|school|iit\b)\b/i.test(l),
        );
      for (const line of lines) {
        const left = line.split('·')[0].trim();
        if (
          looksLikeHeadline(left) &&
          /\b(director|manager|engineer|founder|head|lead|vp|chief|executive|president|product|marketing|sales|officer)\b/i.test(
            left,
          )
        ) {
          description = left;
          headlineSource = headlineSource || 'experience-line';
          break;
        }
      }
    }

    // Prefer top-card headline over experience for currentTitle when both exist
    if (description && looksLikeHeadline(description.split(/[·|]/)[0].trim())) {
      const at = description.match(/^(.+?)\s+at\s+(.+)$/i);
      if (at && !/\b(university|institute|college)\b/i.test(at[1])) {
        currentTitle = at[1].trim();
        currentCompany = currentCompany || at[2].trim();
      } else if (!/\b(university|institute|college|school|iit\b)\b/i.test(description)) {
        currentTitle = description.split(/[·|]/)[0].trim();
      }
    } else if (!currentTitle && description) {
      const at = description.match(/^(.+?)\s+at\s+(.+)$/i);
      if (at) {
        currentTitle = at[1].trim();
        currentCompany = currentCompany || at[2].trim();
      } else {
        currentTitle = description.split(/[·|]/)[0].trim();
      }
    }

    // Final guard — never ship education as title
    if (/\b(university|institute|college|school|iit\b|iim\b|urbana-?champaign)\b/i.test(currentTitle || '')) {
      currentTitle = '';
      currentCompany = '';
      if (/\b(university|institute|college|school|iit\b)\b/i.test(description || '')) {
        description = '';
        headlineSource = '';
      }
    }

    const location =
      textOf(document.querySelector('.text-body-small.inline.t-black--light.break-words')) ||
      textOf(document.querySelector('.text-body-small.inline.t-black--light')) ||
      [...document.querySelectorAll('.text-body-small')]
        .map(textOf)
        .find((t) => t.includes(',') && t.length < 80 && !isJunk(t)) ||
      undefined;

    const bodyText = ''; // never dump full main — Activity feed poisons role extraction
    if (isActivityBlob(description)) {
      description = '';
      headlineSource = '';
    }
    // Parse "Services Account Executive | PCI @ SAP"
    if (description && /@/.test(description)) {
      const atCompany = description.match(/@\s*([^|·•]+)/);
      if (atCompany && !currentCompany) currentCompany = atCompany[1].trim();
      const beforeAt = description.split('@')[0].trim();
      const titlePart = (beforeAt.split(/[|·•]/)[0] || beforeAt).trim();
      if (titlePart && looksLikeHeadline(titlePart)) currentTitle = titlePart;
    }

    const rawText = [
      description && `HEADLINE:\n${description}`,
      currentTitle && `CURRENT_TITLE:\n${currentTitle}`,
      currentCompany && `CURRENT_COMPANY:\n${currentCompany}`,
      about && `ABOUT:\n${about}`,
      experience && `EXPERIENCE:\n${experience}`,
    ]
      .filter(Boolean)
      .join('\n\n')
      .slice(0, 18000);

    const hasRole = Boolean(
      (currentTitle && currentTitle.length >= 2 && looksLikeHeadline(currentTitle)) ||
        (description && looksLikeHeadline(description.split(/[|·@]/)[0].trim())),
    );

    return {
      url: location.href,
      title: document.title,
      sourceType: 'linkedin',
      personName,
      companyName: currentCompany || jsonLd.company || undefined,
      description: description || '',
      location,
      rawText,
      metadata: {
        pageType: path.includes('/in/') ? 'profile' : 'other',
        sections: { about, experience },
        currentTitle: hasRole ? currentTitle || jsonLd.jobTitle || '' : '',
        currentCompany: currentCompany || jsonLd.company || '',
        scrapeBlocked: blocked,
        profileLoaded: Boolean(personName) && !blocked && path.includes('/in/'),
        scrapeMode: hasRole ? 'inline-rich' : personName ? 'inline-name-only' : 'inline-empty',
        scrapeWeak: Boolean(personName) && !hasRole && !blocked,
        headlineSource,
        path,
        titleName,
        domName,
        jsonLd,
        hasMain: Boolean(main),
        detailChars: rawText.length,
        mainChars: mainText.length,
      },
    };
  });
  return result;
}

async function prepareLinkedInProfileForScrape(tabId) {
  try {
    await runOnTab(tabId, () => {
      window.scrollTo(0, 0);
      // Click "see more" in top card / about if present
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
    });
    await sleepMs(600);
    await runOnTab(tabId, () => {
      const exp = document.querySelector('#experience');
      if (exp) exp.scrollIntoView({ block: 'center', behavior: 'instant' });
      else window.scrollTo(0, 900);
    });
    await sleepMs(800);
    await runOnTab(tabId, () => {
      window.scrollTo(0, 0);
    });
    await sleepMs(400);
  } catch {
    /* ignore */
  }
}

async function extractFromTab(tabId, opts = {}) {
  // LinkedIn: never accept name-only scrapes — keep trying until role signal or attempts exhausted
  try {
    const tab = await chrome.tabs.get(tabId);
    const host = new URL(tab.url || '').hostname;
    if (host.includes('linkedin.com')) {
      await prepareLinkedInProfileForScrape(tabId);

      const inline = await scrapeLinkedInProfileInline(tabId);
      if (inline?.metadata?.scrapeBlocked) return inline;
      if (extractionHasRoleSignal(inline)) return inline;

      // Scroll again + reinject fresh content.js (versioned)
      try {
        await runOnTab(tabId, () => {
          window.scrollTo(0, 700);
          const exp = document.querySelector('#experience');
          if (exp) exp.scrollIntoView({ block: 'center', behavior: 'instant' });
        });
        await sleepMs(700);
        await runOnTab(tabId, () => window.scrollTo(0, 0));
        await sleepMs(400);
      } catch {
        /* ignore */
      }

      const again = await scrapeLinkedInProfileInline(tabId);
      if (extractionHasRoleSignal(again)) return again;

      let deep = null;
      try {
        // Force content script refresh after extension updates
        await chrome.scripting.executeScript({
          target: { tabId },
          func: () => {
            try {
              delete window.__scoutContentLoaded;
              delete window.__scoutContentVersion;
            } catch {
              /* ignore */
            }
          },
        });
        await chrome.scripting.executeScript({
          target: { tabId },
          files: ['content.js'],
        });
        deep = await chrome.tabs.sendMessage(tabId, { type: 'EXTRACT_PAGE', deep: true, ...opts });
      } catch {
        /* ignore */
      }

      const best = mergeLinkedInExtracted(again || inline, deep);
      return best || again || inline;
    }
  } catch {
    /* fall through */
  }

  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content.js'],
    });
  } catch {
    /* already injected or page not ready */
  }

  try {
    const data = await chrome.tabs.sendMessage(tabId, { type: 'EXTRACT_PAGE', ...opts });
    if (data && !data.error) {
      if (!data.personName && data.title) {
        const fromTitle = nameFromLinkedInTitle(data.title);
        if (fromTitle) data.personName = fromTitle;
      }
      return data;
    }
  } catch {
    /* ignore */
  }

  try {
    return await scrapeLinkedInProfileInline(tabId);
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Could not scrape LinkedIn tab' };
  }
}

function mergeLinkedInExtracted(a, b) {
  if (!a && !b) return null;
  if (!b || b.error) return a;
  if (!a || a.error) return b;

  const isBadDesc = (d) =>
    /activity\d|\bfollowers?\b|\breposted this\b/i.test(String(d || '')) ||
    (/\bfollow/i.test(String(d || '')) && /\b(posts?|comments?|images)/i.test(String(d || '')));

  const pickBetterDesc = (x, y) => {
    const xs = String(x || '').trim();
    const ys = String(y || '').trim();
    if (xs && !isBadDesc(xs) && (!ys || isBadDesc(ys))) return xs;
    if (ys && !isBadDesc(ys) && (!xs || isBadDesc(xs))) return ys;
    if (isBadDesc(xs) && isBadDesc(ys)) return '';
    // Prefer shorter role-like over long feed blobs
    if (xs && ys) {
      const xRole = /\b(executive|manager|director|engineer|sales|account)\b/i.test(xs);
      const yRole = /\b(executive|manager|director|engineer|sales|account)\b/i.test(ys);
      if (xRole && !yRole) return xs;
      if (yRole && !xRole) return ys;
      return xs.length <= ys.length ? xs : ys;
    }
    return xs || ys;
  };

  const pick = (x, y) => {
    const xs = String(x || '').trim();
    const ys = String(y || '').trim();
    if (xs && !isBadDesc(xs)) return xs.length >= ys.length || isBadDesc(ys) ? xs : ys;
    if (ys && !isBadDesc(ys)) return ys;
    return '';
  };

  const sections = {
    about: pick(a.metadata?.sections?.about, b.metadata?.sections?.about),
    experience: pick(a.metadata?.sections?.experience, b.metadata?.sections?.experience),
  };
  const description = pickBetterDesc(a.description, b.description);
  const personName = a.personName || b.personName;
  const currentTitle = pick(a.metadata?.currentTitle, b.metadata?.currentTitle);
  const currentCompany = pick(a.metadata?.currentCompany, b.metadata?.currentCompany);
  const hasRole = extractionHasRoleSignal({
    description,
    metadata: { sections, currentTitle },
  });
  return {
    ...a,
    ...b,
    personName,
    description,
    companyName: a.companyName || b.companyName || currentCompany,
    rawText: pick(a.rawText, b.rawText),
    metadata: {
      ...(b.metadata || {}),
      ...(a.metadata || {}),
      sections,
      currentTitle,
      currentCompany,
      scrapeMode: hasRole ? 'merged-rich' : 'merged-weak',
      scrapeWeak: !hasRole,
    },
  };
}

async function getAuraContextFromTab(tabId) {
  try {
    return await chrome.tabs.sendMessage(tabId, { type: 'GET_AURA_CONTEXT' });
  } catch {
    /* content script may not be ready yet */
  }

  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const m = location.pathname.match(/\/dashboard\/campaigns\/(\d+)/);
      const token =
        localStorage.getItem('auth_token') || sessionStorage.getItem('auth_token') || '';
      let datahubUrl = 'https://app.zequinia.com/zequinia-datahub';
      try {
        const entries = performance.getEntriesByType('resource');
        for (const e of entries) {
          const m = String(e.name).match(/(https?:\/\/[^/]+\/zequinia-datahub)/);
          if (m) {
            datahubUrl = m[1];
            break;
          }
        }
        const userRaw = localStorage.getItem('user') || sessionStorage.getItem('user');
        if (userRaw) {
          const user = JSON.parse(userRaw);
          if (user?.datahub_url) datahubUrl = user.datahub_url;
        }
      } catch {
        /* ignore */
      }
      return {
        campaignId: m ? Number(m[1]) : null,
        isLeadOperator: Boolean(token),
        aura: { token, datahubUrl },
        url: location.href,
      };
    },
  });
  return result?.result ?? null;
}

function broadcastProgress(message) {
  chrome.tabs.query({}, (tabs) => {
    if (chrome.runtime.lastError) return;
    for (const tab of tabs) {
      if (!tab.id) continue;
      chrome.tabs.sendMessage(tab.id, { type: 'SCOUT_AUTOMATION_PROGRESS', message }, () => {
        void chrome.runtime.lastError;
      });
    }
  });
}

function broadcastConfirmQueueUpdated(campaignId) {
  chrome.tabs.query({}, (tabs) => {
    if (chrome.runtime.lastError) return;
    for (const tab of tabs) {
      if (!tab.id) continue;
      chrome.tabs.sendMessage(
        tab.id,
        { type: 'SCOUT_CONFIRM_QUEUE_UPDATED', campaignId },
        () => {
          void chrome.runtime.lastError;
        },
      );
    }
  });
}

async function fetchLeadQueue(campaignId, aura) {
  const res = await fetch(`${API_BASE}/leads/queue/${campaignId}?stage=NOT_ELIGIBLE`, {
    headers: {
      'x-aura-token': aura.authToken,
      'x-datahub-url': aura.datahubBaseUrl,
    },
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `Queue error ${res.status}`);
  return data.queue || [];
}

async function processLeadOnServer(campaignId, lead, extraction, aura, options = {}) {
  const res = await fetch(`${API_BASE}/leads/process`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      campaignId,
      lead: { id: lead.id, ...lead },
      extraction: extraction || undefined,
      autoApply: options.autoApply !== false,
      operatorVerified: Boolean(options.operatorVerified),
      confirmedJobTitle: options.confirmedJobTitle || undefined,
      confirmedCompany: options.confirmedCompany || undefined,
      promoteToQueued: options.promoteToQueued ?? Boolean(options.operatorVerified),
      aura,
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `Process error ${res.status}`);
  return data;
}

/** Puppeteer verify: Aura edit fields + LinkedIn + company website → Ready */
async function verifyLeadPuppeteerOnServer(campaignId, lead, aura, options = {}) {
  const res = await fetch(`${API_BASE}/leads/verify-puppeteer`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      campaignId,
      lead: { id: lead.id, ...lead },
      autoApply: options.autoApply !== false,
      promoteToQueued: options.promoteToQueued !== false,
      aura,
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `Verify error ${res.status}`);
  return data;
}

function checkedLeadKey(campaignId, leadId) {
  return `${campaignId}:${leadId}`;
}

async function listPendingConfirmQueue(campaignId) {
  const data = await chrome.storage.local.get(['scoutPendingScores', 'scoutCheckedLeads']);
  const scores = data.scoutPendingScores && typeof data.scoutPendingScores === 'object' ? data.scoutPendingScores : {};
  const checked = data.scoutCheckedLeads && typeof data.scoutCheckedLeads === 'object' ? data.scoutCheckedLeads : {};
  const items = [];
  for (const [key, value] of Object.entries(scores)) {
    if (key.startsWith('campaign:')) continue;
    if (!value || typeof value !== 'object') continue;
    if (Number(value.campaignId) !== Number(campaignId)) continue;
    const leadId = value.leadId || Number(key);
    if (checked[checkedLeadKey(campaignId, leadId)]) continue;
    const score = typeof value.fitScore === 'number' ? value.fitScore : 0;
    if (score < FIT_SCORE_CONFIRM_THRESHOLD) continue;
    items.push({
      ...value,
      leadId,
      leadName: value.leadName || `Lead #${leadId}`,
      fitScore: value.fitScore,
      jobTitle: value.jobTitle || '',
      company: value.company || '',
      summary: value.summary || '',
      locationOverride: value.locationOverride,
      lead: value.lead,
    });
  }
  items.sort((a, b) => (b.fitScore || 0) - (a.fitScore || 0));
  return items;
}

async function getCheckedLeadsMap() {
  const data = await chrome.storage.local.get(['scoutCheckedLeads']);
  return data.scoutCheckedLeads && typeof data.scoutCheckedLeads === 'object'
    ? data.scoutCheckedLeads
    : {};
}

async function isLeadChecked(campaignId, leadId) {
  const map = await getCheckedLeadsMap();
  return Boolean(map[checkedLeadKey(campaignId, leadId)]);
}

async function markLeadChecked(campaignId, leadId, action) {
  const map = await getCheckedLeadsMap();
  map[checkedLeadKey(campaignId, leadId)] = {
    action: action || 'confirm',
    at: Date.now(),
  };
  await chrome.storage.local.set({ scoutCheckedLeads: map });
}

function crmStubExtraction(lead) {
  const name =
    lead?.name ||
    [lead?.first_name, lead?.last_name].filter(Boolean).join(' ') ||
    `Lead #${lead?.id || '?'}`;
  return {
    url: lead?.linkedinUrl || lead?.linkedin_url || '',
    title: name,
    sourceType: 'linkedin',
    personName: name,
    companyName: lead?.company || lead?.company_name || undefined,
    description: '',
    rawText: '',
    metadata: { scrapeMode: 'crm-only' },
  };
}

function waitForTabLoad(tabId) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }, 20000);

    function listener(id, info) {
      if (id === tabId && info.status === 'complete') {
        clearTimeout(timeout);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }

    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.get(tabId, (t) => {
      if (chrome.runtime.lastError) {
        clearTimeout(timeout);
        chrome.tabs.onUpdated.removeListener(listener);
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (t?.status === 'complete') {
        clearTimeout(timeout);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    });
  });
}

function linkedInTabDetectScript() {
  const path = location.pathname.toLowerCase();
  const host = location.hostname.toLowerCase();
  if (!host.includes('linkedin.com')) return { loggedIn: false, reason: 'not-linkedin' };

  if (/\/login|authwall|checkpoint|signup/.test(path)) {
    return { loggedIn: false, reason: 'auth-page' };
  }

  if (document.querySelector('form.login__form, #username, input[name="session_key"]')) {
    return { loggedIn: false, reason: 'login-form' };
  }

  const signals = [
    'img.global-nav__me-photo',
    'button.global-nav__primary-link-me-menu-trigger',
    '.feed-identity-module',
    '[data-control-name="identity_welcome_message"]',
    'a[href*="/mynetwork/"]',
    'a[href*="/messaging/"]',
    'nav[aria-label="Primary"]',
    'header#global-nav',
    '.scaffold-layout__sidebar',
    '[data-view-name="feed-full-update"]',
    '.share-box-feed-entry',
    'button[aria-label*="Me"]',
    'img[alt*="Photo of"]',
    '.profile-rail-card',
  ];
  if (signals.some((sel) => document.querySelector(sel))) {
    return { loggedIn: true, reason: 'nav-signal' };
  }

  if (/\/feed|\/mynetwork|\/messaging|\/notifications|\/in\//.test(path)) {
    const h1 = (document.querySelector('h1')?.textContent || '').toLowerCase();
    if (!/^(sign in|join linkedin|agree & join)/.test(h1)) {
      return { loggedIn: true, reason: 'logged-in-route' };
    }
  }

  return { loggedIn: false, reason: 'unknown' };
}

async function runOnTab(tabId, func) {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    func,
  });
  return result;
}

async function isTabLinkedInLoggedIn(tabId) {
  try {
    const result = await runOnTab(tabId, linkedInTabDetectScript);
    return Boolean(result?.loggedIn);
  } catch {
    return false;
  }
}

async function findLinkedInTabs() {
  const tabs = await chrome.tabs.query({});
  return tabs.filter((tab) => {
    try {
      const host = new URL(tab.url || '').hostname.toLowerCase();
      return host === 'linkedin.com' || host.endsWith('.linkedin.com');
    } catch {
      return false;
    }
  });
}

async function findLinkedInSessionTab() {
  const tabs = await findLinkedInTabs();
  const preferred = tabs.find((t) =>
    /\/feed|\/mynetwork|\/messaging|\/notifications/.test(t.url || ''),
  );
  const candidates = preferred ? [preferred, ...tabs.filter((t) => t.id !== preferred.id)] : tabs;

  for (const tab of candidates) {
    if (!tab.id) continue;
    if (await isTabLinkedInLoggedIn(tab.id)) return tab;
  }

  // User has LinkedIn open on feed — trust it even if nav selectors changed
  if (preferred?.id) return preferred;
  if (tabs[0]?.id) return tabs[0];
  return null;
}

function namesLooselyMatch(a, b) {
  const norm = (s) =>
    String(s || '')
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  const left = norm(a);
  const right = norm(b);
  if (!left || !right) return false;
  if (left === right) return true;
  if (left.includes(right) || right.includes(left)) return true;
  const la = left.split(' ').filter((w) => w.length > 1);
  const ra = right.split(' ').filter((w) => w.length > 1);
  if (!la.length || !ra.length) return false;
  const overlap = la.filter((w) => ra.includes(w));
  return overlap.length >= Math.min(2, la.length, ra.length);
}

function extractionLooksRich(extraction) {
  if (!extraction?.personName) return false;
  if (extractionHasRoleSignal(extraction)) return true;
  const raw = String(extraction.rawText || '').trim();
  // rawText alone is not enough — LinkedIn chrome can be long without a role
  return raw.length >= 1200 && /EXPERIENCE:|HEADLINE:|CURRENT_TITLE:/i.test(raw);
}

/** Keep user on Aura — LinkedIn worker stays visible in the tab bar only. */
async function stayOnAura() {
  const auraId = automationControl.auraTabId;
  if (!auraId) return;
  try {
    await chrome.tabs.update(auraId, { active: true });
  } catch {
    /* Aura tab may have closed */
  }
}

async function ensureWorkerTab(linkedinUrl) {
  let tabId = automationControl.workerTabId;
  if (tabId) {
    try {
      await chrome.tabs.get(tabId);
    } catch {
      tabId = null;
      automationControl.workerTabId = null;
    }
  }

  // Foreground tab so LinkedIn actually paints the profile (required for scrape)
  if (!tabId) {
    const tab = await chrome.tabs.create({
      url: linkedinUrl,
      active: true,
      openerTabId: automationControl.auraTabId || undefined,
    });
    tabId = tab.id;
    automationControl.workerTabId = tabId;
    if (!tabId) throw new Error('Could not open LinkedIn worker tab');
  } else {
    await chrome.tabs.update(tabId, { url: linkedinUrl, active: true });
  }

  try {
    await chrome.tabs.update(tabId, { autoDiscardable: false });
  } catch {
    /* older chrome */
  }
  return tabId;
}

async function detectLinkedInProfileMissing(tabId) {
  try {
    return await runOnTab(tabId, () => {
      const title = String(document.title || '').toLowerCase();
      const path = location.pathname.toLowerCase();
      const body = (document.body?.innerText || '').slice(0, 2500).toLowerCase();
      if (/\/404|\/unavailable|\/in\/unavailable/.test(path)) return { missing: true, reason: '404 URL' };
      if (/page not found|profile not found|this page doesn.?t exist|we didn.?t find that page|hmm, we didn.?t find/i.test(title + ' ' + body)) {
        return { missing: true, reason: 'profile does not exist' };
      }
      if (/linkedin member|linkedIn member/.test(title) && body.includes("doesn't exist")) {
        return { missing: true, reason: 'profile does not exist' };
      }
      return { missing: false };
    });
  } catch {
    return { missing: false };
  }
}

async function waitForLinkedInProfile(tabId, expectedUrl, expectedLeadName) {
  let lastExtraction = null;
  let bestExtraction = null;

  for (let attempt = 0; attempt < LINKEDIN_MAX_ATTEMPTS; attempt++) {
    assertNotStopped();
    if (attempt > 0) await sleep(LINKEDIN_RETRY_MS);
    else await sleep(LINKEDIN_DELAY_MS);

    // Keep LinkedIn focused while scraping
    try {
      await chrome.tabs.update(tabId, { active: true });
    } catch {
      /* ignore */
    }

    const missing = await detectLinkedInProfileMissing(tabId);
    if (missing?.missing) {
      const err = new Error(`LinkedIn profile does not exist — ${missing.reason || 'skipping'}`);
      err.code = 'PROFILE_MISSING';
      throw err;
    }

    let tabTitle = '';
    let tabUrl = '';
    try {
      const tab = await chrome.tabs.get(tabId);
      tabTitle = tab.title || '';
      tabUrl = tab.url || '';
    } catch {
      /* ignore */
    }

    const titleName = nameFromLinkedInTitle(tabTitle);
    const onProfile = /linkedin\.com\/in\//i.test(tabUrl || expectedUrl || '');

    broadcastProgress(
      `Scraping LinkedIn for ${expectedLeadName || 'lead'}… (${attempt + 1}/${LINKEDIN_MAX_ATTEMPTS})${titleName ? ` — ${titleName}` : ''}`,
    );

    if (expectedLeadName && titleName && !namesLooselyMatch(titleName, expectedLeadName) && attempt < 2) {
      continue;
    }
    if (!onProfile && attempt < 2) continue;

    try {
      await runOnTab(tabId, () => {
        window.scrollTo(0, 700);
        window.scrollTo(0, 1400);
        window.scrollTo(0, 0);
      });
    } catch {
      /* ignore */
    }

    lastExtraction = await extractFromTab(tabId, { deep: true });
    if (lastExtraction?.error) continue;

    if (!lastExtraction.personName && titleName) lastExtraction.personName = titleName;
    if (lastExtraction?.metadata?.scrapeBlocked) {
      throw new Error('LinkedIn auth wall — sign in to LinkedIn, then retry');
    }

    if (lastExtraction?.personName) {
      if (
        !bestExtraction ||
        String(lastExtraction.rawText || '').length > String(bestExtraction.rawText || '').length ||
        (extractionHasRoleSignal(lastExtraction) && !extractionHasRoleSignal(bestExtraction))
      ) {
        bestExtraction = lastExtraction;
      }
      if (extractionHasRoleSignal(lastExtraction) && extractionLooksRich(lastExtraction)) {
        return lastExtraction;
      }
      // Role signal alone is enough to stop early
      if (extractionHasRoleSignal(lastExtraction) && attempt >= 2) {
        return lastExtraction;
      }
    }
  }

  if (bestExtraction) {
    if (!extractionLooksRich(bestExtraction)) {
      bestExtraction.metadata = { ...(bestExtraction.metadata || {}), scrapeWeak: true };
    }
    return bestExtraction;
  }
  return lastExtraction;
}

/** Scrape LinkedIn in a foreground tab, then return focus to Aura. Skip missing profiles fast. */
async function visitLinkedInAndExtract(linkedinUrl, expectedLeadName) {
  assertNotStopped();
  const tabId = await ensureWorkerTab(linkedinUrl);

  await waitForTabLoad(tabId);
  assertNotStopped();
  await sleep(1500);

  // Early missing-profile check
  const earlyMissing = await detectLinkedInProfileMissing(tabId);
  if (earlyMissing?.missing) {
    await stayOnAura();
    const err = new Error(`LinkedIn profile does not exist — skipping`);
    err.code = 'PROFILE_MISSING';
    throw err;
  }

  try {
    const extraction = await waitForLinkedInProfile(tabId, linkedinUrl, expectedLeadName);
    await stayOnAura();

    if (extractionLooksRich(extraction)) {
      if (extraction.metadata) extraction.metadata.scrapeWeak = false;
      return extraction;
    }

    // One more wake + deep scrape
    try {
      await chrome.tabs.update(tabId, { active: true });
      await sleep(2000);
      await runOnTab(tabId, () => {
        window.scrollTo(0, 900);
        window.scrollTo(0, 0);
      });
      const again = await extractFromTab(tabId, { deep: true });
      await stayOnAura();
      if (extractionLooksRich(again)) {
        again.metadata = { ...(again.metadata || {}), scrapeWeak: false };
        return again;
      }
      if (again?.personName) {
        again.metadata = { ...(again.metadata || {}), scrapeWeak: true };
        return again;
      }
    } catch (err) {
      if (err?.code === 'STOPPED' || err?.code === 'PROFILE_MISSING') throw err;
      await stayOnAura();
    }

    if (extraction?.personName) {
      extraction.metadata = { ...(extraction.metadata || {}), scrapeWeak: true };
      return extraction;
    }

    await stayOnAura();
    return {
      url: linkedinUrl,
      title: expectedLeadName || 'LinkedIn',
      sourceType: 'linkedin',
      personName: expectedLeadName || '',
      description: '',
      rawText: '',
      metadata: { scrapeWeak: true, scrapeMode: 'scrape-failed', pageType: 'profile' },
    };
  } catch (err) {
    await stayOnAura();
    throw err;
  }
}

async function closeWorkerTab() {
  const tabId = automationControl.workerTabId;
  if (!tabId) return;
  try {
    await chrome.tabs.remove(tabId);
  } catch {
    /* ignore */
  }
  automationControl.workerTabId = null;
}

/**
 * Enrich LinkedIn profile data using server-side API (Proxycurl/PDL)
 * This adds missing fields like verified email, phone, deeper work history
 */
async function enrichLinkedInProfileData(profileFields) {
  // LinkedIn enrichment removed - now using CRM + Apollo company enrichment only
  // Return original profile fields without enrichment
  console.log('[background] LinkedIn enrichment disabled, using CRM + Apollo approach');
  return profileFields;
}

/**
 * Cache-first LinkedIn field resolution.
 * 1. Checks linkedinProfileCache populated by MutationObserver in linkedin-assist.js.
 * 2. Falls back to extractLinkedInFieldsWaiting (polling) if cache is cold.
 * Returns the same { personName, headline, jsonTitle, jsonCompany, location, expLines } shape.
 */
async function getLinkedInFieldsFromCache(tabId, linkedinUrl) {
  // Derive slug from URL for cache lookup
  const slug = (() => {
    try {
      const m = String(linkedinUrl || '').match(/\/in\/([^/?#]+)/i);
      return m ? m[1].toLowerCase().replace(/\/$/, '') : null;
    } catch { return null; }
  })();

  // Check tab-keyed cache first (most precise)
  const byTab = linkedinProfileCache.get(`tab:${tabId}`);
  if (byTab && Date.now() - byTab.cachedAt < LINKEDIN_CACHE_TTL_MS) {
    console.log(`[scout] cache hit tab:${tabId} slug=${slug}`);
    return byTab.fields;
  }

  // Check slug-keyed cache
  if (slug) {
    const bySlug = linkedinProfileCache.get(slug);
    if (bySlug && Date.now() - bySlug.cachedAt < LINKEDIN_CACHE_TTL_MS) {
      console.log(`[scout] cache hit slug=${slug}`);
      return bySlug.fields;
    }
  }

  // Cache cold — MutationObserver hasn't fired yet (tab just opened).
  // Fall back to polling-based extraction.
  console.log(`[scout] cache miss slug=${slug}, falling back to poll`);
  return extractLinkedInFieldsWaiting(tabId);
}

/**
 * Injects a self-contained polling script into a LinkedIn profile tab.
 * Waits up to 15 s for React to render the top-card, then extracts ONLY
 * targeted text fields — no HTML, no rawText blob. ~50–200 tokens.
 * Uses JSON-LD + og:description as fallbacks for partial renders.
 */
async function extractLinkedInFieldsWaiting(tabId) {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const tx = (el) => (el?.innerText || el?.textContent || '').replace(/\s+/g, ' ').trim();
      return new Promise((resolve) => {
        const DEADLINE = Date.now() + 15000;
        let done = false;
        let timer;
        const finish = (val) => {
          if (done) return;
          done = true;
          clearInterval(timer);
          resolve(val);
        };
        const attempt = () => {
          const path = location.pathname.toLowerCase();
          if (/\/login|authwall|checkpoint|signup/.test(path) ||
              document.querySelector('form.login__form, #username, input[name="session_key"]')) {
            return finish({ blocked: true });
          }
          if (/\/404|\/unavailable/.test(path) ||
              /page not found|profile not found/i.test(document.title || '')) {
            return finish({ missing: true });
          }
          if (!path.includes('/in/')) return;
          const h1 = document.querySelector('h1.text-heading-xlarge') ||
                     document.querySelector('main h1') ||
                     document.querySelector('h1');
          const personName = tx(h1);
          if (!personName || personName.length < 2 || /^(join linkedin|sign in)/i.test(personName)) return;
          let headline = '';
          const hSels = [
            '.pv-text-details__left-panel .text-body-medium.break-words',
            '.ph5 .text-body-medium.break-words',
            '.mt2 .text-body-medium.break-words',
            '[data-anonymize="headline"]',
            '.text-body-medium.break-words',
          ];
          for (const sel of hSels) {
            for (const el of document.querySelectorAll(sel)) {
              if (el.closest('#activity,#experience,#education,footer,nav')) continue;
              const rect = el.getBoundingClientRect();
              if (rect.top + window.scrollY > 1000) continue;
              const txt = tx(el);
              if (txt && txt !== personName && txt.length > 3 && txt.length < 220) {
                headline = txt; break;
              }
            }
            if (headline) break;
          }
          let jsonTitle = '', jsonCompany = '';
          try {
            for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
              let j; try { j = JSON.parse(s.textContent || ''); } catch { continue; }
              for (const n of (Array.isArray(j) ? j : [j])) {
                if (!n || typeof n !== 'object') continue;
                if (!jsonTitle && n.jobTitle) jsonTitle = String(n.jobTitle).trim();
                const wf = n.worksFor;
                if (!jsonCompany && wf) {
                  jsonCompany = String(
                    typeof wf === 'string' ? wf :
                    Array.isArray(wf) ? (wf[0]?.name || '') : (wf.name || '')
                  ).trim();
                }
              }
            }
          } catch { /* ignore */ }
          if (!headline && !jsonTitle) {
            const ogDesc = (document.querySelector('meta[property="og:description"]')?.content || '').trim();
            const ogT = (document.querySelector('meta[property="og:title"]')?.content || '').trim();
            const fromTitle = ogT.replace(/\s*\|\s*LinkedIn\s*$/i, '').replace(personName, '').trim();
            const cand = ogDesc.split(/[|·•]/)[0]?.trim() || fromTitle;
            if (cand && cand !== personName && cand.length > 3 && cand.length < 220 &&
                !/^(sign in|join|feed|home)/i.test(cand)) headline = cand;
          }
          let expLines = [];
          const expSec = document.querySelector('#experience')?.closest('section') ||
                         document.querySelector('#experience')?.parentElement;
          if (expSec) {
            expLines = [...expSec.querySelectorAll('span[aria-hidden="true"]')]
              .map(tx).filter((x) => x && x.length > 2 && x.length < 160).slice(0, 8);
          }
          const locEl =
            document.querySelector('.text-body-small.inline.t-black--light.break-words') ||
            document.querySelector('.text-body-small.inline.t-black--light') ||
            [...document.querySelectorAll('.text-body-small')].find((el) => {
              const txt = tx(el);
              return txt.includes(',') && txt.length < 80 && !/(followers|connections|contact|ago)/i.test(txt);
            });
          const location = tx(locEl);
          if (!headline && !jsonTitle && !expLines.length && Date.now() < DEADLINE) return;
          finish({ personName, headline, jsonTitle, jsonCompany, location, expLines,
                   timedOut: !headline && !jsonTitle && !expLines.length });
        };
        attempt();
        let scrollPhase = 0;
        const scrollSeq = [600, 1400, 2200, 0];
        timer = setInterval(() => {
          if (Date.now() >= DEADLINE) {
            finish({ personName: tx(document.querySelector('h1')) || '',
                     headline: '', jsonTitle: '', jsonCompany: '', location: '',
                     expLines: [], timedOut: true });
            return;
          }
          window.scrollTo(0, scrollSeq[scrollPhase % scrollSeq.length]);
          scrollPhase++;
          attempt();
        }, 500);
      });
    },
  });
  return result;
}


/**
 * Opens a LinkedIn profile tab in the real logged-in browser,
 * waits for React to render, extracts targeted fields,
 * and returns a minimal PageExtraction for the server.
 * Token cost: ~100–300 tokens (no HTML, no rawText blob).
 */
async function scrapeLinkedInTabFields(linkedinUrl, leadName) {
  assertNotStopped();
  const tabId = await ensureWorkerTab(linkedinUrl);
  await waitForTabLoad(tabId);
  assertNotStopped();

  // Early missing-profile check
  const earlyMissing = await detectLinkedInProfileMissing(tabId);
  if (earlyMissing?.missing) {
    await stayOnAura();
    const err = new Error('LinkedIn profile does not exist — skipping');
    err.code = 'PROFILE_MISSING';
    throw err;
  }

  // Small initial pause so SPA bootstrap fires
  await sleepMs(1200);
  assertNotStopped();

  let fields;
  try {
    fields = await extractLinkedInFieldsWaiting(tabId);
  } catch (err) {
    await stayOnAura();
    throw err;
  }

  // Check if DOM extraction failed or returned weak data
  const domFailed = !fields || fields.blocked || fields.missing || !fields.personName || !fields.jsonTitle;
  
  if (domFailed) {
    console.log('[scrapeLinkedInTabFields] DOM extraction failed/weak, trying Proxycurl API fallback');
    
    // Try Proxycurl API as fallback when DOM fails
    try {
      const apiResponse = await fetch(`${API_BASE}/fetch-linkedin-profile`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ profileUrl: linkedinUrl }),
      });
      
      if (apiResponse.ok) {
        const apiData = await apiResponse.json();
        if (apiData.profile) {
          console.log('[scrapeLinkedInTabFields] Successfully fetched profile from Proxycurl API');
          fields = apiData.profile;
          fields.apiFallback = true; // Mark that this came from API fallback
        }
      }
    } catch (apiErr) {
      console.error('[scrapeLinkedInTabFields] Proxycurl API fallback failed:', apiErr);
      // Continue with weak DOM data if API also fails
    }
  }

  // Enrich profile data with Proxycurl/PDL if available
  let enrichedFields = fields;
  try {
    enrichedFields = await enrichLinkedInProfileData(fields);
  } catch (enrichErr) {
    console.error('Enrichment failed, using original fields:', enrichErr);
    // Continue with original fields if enrichment fails
  }

  await stayOnAura();

  if (!fields || fields.blocked) {
    return {
      url: linkedinUrl, title: leadName || 'LinkedIn', sourceType: 'linkedin',
      personName: '', description: '', rawText: '',
      metadata: { scrapeBlocked: true, scrapeMode: 'blocked' },
    };
  }
  if (fields.missing) {
    const err = new Error('LinkedIn profile does not exist — skipping');
    err.code = 'PROFILE_MISSING';
    throw err;
  }

  // Use enriched fields for processing (includes API-enriched data if available)
  const processingFields = enrichedFields;

  // Derive title + company in priority order:
  // 1) JSON-LD (most reliable), 2) headline parse, 3) experience lines
  let currentTitle = processingFields.jsonTitle || '';
  let currentCompany = processingFields.jsonCompany || '';

  if (!currentTitle && processingFields.headline) {
    // "Director of Sales @ Acme" or "Director of Sales at Acme"
    const atM = processingFields.headline.match(/^(.+?)\s+(?:at|@)\s+(.+?)(?:\s*[|·•]|$)/i);
    if (atM) {
      currentTitle = atM[1].trim();
      if (!currentCompany) currentCompany = atM[2].trim();
    } else {
      currentTitle = processingFields.headline.split(/[|·•@]/)[0].trim();
    }
  }

  if (!currentTitle && processingFields.expLines.length) {
    // First non-date, non-junk line in experience is typically the title
    for (const line of processingFields.expLines) {
      if (!/^(full-time|part-time|contract|present|\d{4})/i.test(line) && line.length >= 4) {
        currentTitle = line.split(/[·•@]/)[0].trim();
        break;
      }
    }
    // Line after title is typically the company
    if (currentTitle && !currentCompany) {
      const titleIdx = processingFields.expLines.indexOf(processingFields.expLines.find((l) => l.includes(currentTitle)));
      const next = processingFields.expLines[titleIdx + 1];
      if (next && !/^(full-time|part-time|\d{4}|present)/i.test(next)) {
        currentCompany = next.split(/[·•]/)[0].trim();
      }
    }
  }

  // Build the compact rawText the server's lead-brain reads
  // Include enriched data if available
  const rawText = [
    processingFields.headline     && `HEADLINE:\n${processingFields.headline}`,
    currentTitle        && `CURRENT_TITLE:\n${currentTitle}`,
    currentCompany      && `CURRENT_COMPANY:\n${currentCompany}`,
    processingFields.location     && `LOCATION:\n${processingFields.location}`,
    processingFields.expLines.length && `EXPERIENCE:\n${processingFields.expLines.join('\n')}`,
    processingFields.enrichedEmail && `EMAIL:\n${processingFields.enrichedEmail}`,
    processingFields.enrichedPhone && `PHONE:\n${processingFields.enrichedPhone}`,
    processingFields.about && `ABOUT:\n${processingFields.about}`,
    processingFields.skills && processingFields.skills.length && `SKILLS:\n${processingFields.skills.join(', ')}`,
  ].filter(Boolean).join('\n\n');

  const hasRole = Boolean(currentTitle && currentTitle.length >= 3);
  const personName = processingFields.personName || leadName || '';

  return {
    url: linkedinUrl,
    title: personName,
    sourceType: 'linkedin',
    personName,
    companyName: currentCompany || undefined,
    description: processingFields.headline || currentTitle || '',
    location: processingFields.location || undefined,
    rawText,
    metadata: {
      pageType: 'profile',
      currentTitle,
      currentCompany,
      scrapeMode: hasRole ? 'targeted-rich' : personName ? 'targeted-name-only' : 'targeted-empty',
      scrapeWeak: !hasRole,
      profileLoaded: Boolean(personName),
      enrichmentSource: processingFields.enrichmentSource,
      enrichedEmail: processingFields.enrichedEmail,
      enrichedPhone: processingFields.enrichedPhone,
      verifiedEmail: processingFields.verifiedEmail,
      verifiedPhone: processingFields.verifiedPhone,
      sections: {
        experience: fields.expLines.join('\n'),
      },
    },
  };
}

async function saveLastAutomationResult(result) {
  try {
    await chrome.storage.local.set({
      scoutLastAutomationResult: { ...result, savedAt: Date.now() },
    });
  } catch {
    /* ignore */
  }
}

async function getLastAutomationResult() {
  try {
    const data = await chrome.storage.local.get(['scoutLastAutomationResult']);
    return data.scoutLastAutomationResult || null;
  } catch {
    return null;
  }
}

async function runLeadAutomation(campaignId, aura, options = {}) {
  if (automationControl.running) {
    return { error: 'Automation already running — press Stop first' };
  }

  automationControl.running = true;
  automationControl.stopRequested = false;
  broadcastAutomationState();

  const keepAlive = setInterval(() => {
    try {
      chrome.storage.session?.set?.({ scoutKeepAlive: Date.now() });
    } catch {
      try {
        chrome.storage.local.set({ scoutKeepAlive: Date.now() });
      } catch {
        /* ignore */
      }
    }
  }, 20000);

  const limit = options.limit ?? 50;
  broadcastProgress('Fetching NOT_ELIGIBLE leads…');

  try {
    const queue = await fetchLeadQueue(campaignId, aura);
    const toProcess = queue.slice(0, limit);

    if (!toProcess.length) {
      const empty = {
        processed: 0,
        scored: 0,
        readyCount: 0,
        failed: 0,
        skipped: 0,
        results: [],
        message: 'No Not Eligible leads with LinkedIn URLs',
      };
      await saveLastAutomationResult(empty);
      return empty;
    }

    broadcastProgress(
      `Verifying ${toProcess.length} leads — opening LinkedIn tabs in this browser + LLM ICP scoring. Stay signed in to LinkedIn. Press Stop anytime.`,
    );

    const results = [];
    const toDelete = [];
    let scored = 0;
    let droppedLow = 0;
    let deleted = 0;
    let readyCount = 0;
    let failed = 0;
    let skipped = 0;
    let alreadyChecked = 0;
    let stopped = false;

    const isTransientBrowserError = (text) =>
      /auth wall|sign in to linkedin|not logged in|linkedin.*session|scrape empty|no name|not deleting|page not loaded|could not read enough/i.test(
        String(text || ''),
      );

    for (let i = 0; i < toProcess.length; i++) {
      if (automationControl.stopRequested) {
        stopped = true;
        broadcastProgress(`Stopped after ${i} of ${toProcess.length} leads`);
        break;
      }

      const lead = toProcess[i];
      const name = lead.name || `Lead #${lead.id}`;

      try {
        if (await isLeadChecked(campaignId, lead.id)) {
          const checkedMap = await getCheckedLeadsMap();
          const entry = checkedMap[checkedLeadKey(campaignId, lead.id)];
          if (entry?.action === 'below-threshold' || entry?.action === 'verify-failed') {
            if (!isTransientBrowserError(entry.action)) {
              toDelete.push(lead.id);
              droppedLow++;
              broadcastProgress(`[${i + 1}/${toProcess.length}] ${name}: previously failed — deleting`);
            } else {
              skipped++;
            }
            continue;
          }
          alreadyChecked++;
          skipped++;
          results.push({ leadId: lead.id, leadName: name, skipped: true, skipReason: 'Already checked' });
          broadcastProgress(`[${i + 1}/${toProcess.length}] ${name}: already checked — skip`);
          continue;
        }

        if (!lead.linkedinUrl && !lead.linkedin_url) {
          skipped++;
          results.push({ leadId: lead.id, skipped: true, skipReason: 'No LinkedIn URL' });
          broadcastProgress(`[${i + 1}/${toProcess.length}] ${name}: skipped — no LinkedIn URL`);
          continue;
        }

        const linkedinUrl = lead.linkedinUrl || lead.linkedin_url || '';
        broadcastProgress(`[${i + 1}/${toProcess.length}] ${name}: opening LinkedIn tab…`);
        assertNotStopped();

        // ── Extension-native tab scrape (real logged-in browser) ──────────────
        let extraction;
        try {
          extraction = await scrapeLinkedInTabFields(linkedinUrl, name);
        } catch (scrapeErr) {
          if (scrapeErr?.code === 'PROFILE_MISSING') {
            // Profile deleted/private — skip, do NOT delete the lead automatically
            skipped++;
            results.push({ leadId: lead.id, leadName: name, skipped: true, skipReason: 'LinkedIn profile not found' });
            broadcastProgress(`[${i + 1}/${toProcess.length}] ${name}: LinkedIn profile not found — skipping`);
            await stayOnAura();
            continue;
          }
          throw scrapeErr;
        }

        // Auth wall — stop the run and tell the user to log in
        if (extraction?.metadata?.scrapeBlocked || /sign in to linkedin|auth wall|not logged in/i.test(extraction?.rawText || '')) {
          stopped = true;
          broadcastProgress('Paused — sign into LinkedIn in this browser, then click Run again');
          break;
        }

        // If extraction is completely empty (no name), skip without deleting
        if (!extraction?.personName && !extractionHasRoleSignal(extraction)) {
          skipped++;
          failed++;
          results.push({ leadId: lead.id, leadName: name, skipped: true, skipReason: 'Could not read LinkedIn profile — retry' });
          broadcastProgress(`[${i + 1}/${toProcess.length}] ${name}: could not read LinkedIn — skipping (not deleting)`);
          continue;
        }

        broadcastProgress(`[${i + 1}/${toProcess.length}] ${name}: scoring ICP fit…`);
        assertNotStopped();

        const result = await processLeadOnServer(campaignId, lead, extraction, aura, {
          autoApply: true,
          promoteToQueued: true,
        });
        results.push(result);
        scored++;

        // Detect auth wall in server response (shouldn't happen with extension scrape, but guard anyway)
        const loginNeeded = /auth wall|sign in to linkedin|not logged in/i.test(
          String(result.error || result.summary || ''),
        );
        if (loginNeeded) {
          stopped = true;
          broadcastProgress('Paused — sign into LinkedIn in this browser, then click Run again');
          break;
        }

        const score = typeof result.fitScore === 'number' ? result.fitScore : 0;
        const scoreLabel = `${score}/10`;
        const matched =
          result.fitsIcp ||
          result.stageAfter === 'READY' ||
          result.stageAfter === 'QUEUED' ||
          Boolean(result.applied);

        if (matched) {
          readyCount++;
          await markLeadChecked(campaignId, lead.id, 'verify-ready');
          broadcastProgress(`[${i + 1}/${toProcess.length}] ${name}: ${scoreLabel} ✓ → ${result.stageAfter || 'Ready'}`);
          continue;
        }

        const failReason = result.error || result.summary || `verify failed (${scoreLabel})`;
        if (isTransientBrowserError(failReason)) {
          failed++;
          broadcastProgress(`[${i + 1}/${toProcess.length}] ${name}: skipped delete — ${failReason}`);
          continue;
        }

        droppedLow++;
        toDelete.push(lead.id);
        await markLeadChecked(campaignId, lead.id, 'verify-failed');
        broadcastProgress(`[${i + 1}/${toProcess.length}] ${name}: ${scoreLabel} ✗ — deleting (${failReason})`);
      } catch (err) {
        if (err?.code === 'STOPPED' || /automation stopped/i.test(String(err?.message || ''))) {
          stopped = true;
          broadcastProgress(`Stopped after ${i} of ${toProcess.length} leads`);
          break;
        }
        failed++;
        const errMsg = err instanceof Error ? err.message : 'Failed';
        results.push({ leadId: lead.id, leadName: name, error: errMsg, applied: false });
        broadcastProgress(`[${i + 1}/${toProcess.length}] ${name}: failed — ${errMsg}`);
      }

      if (!stopped && i < toProcess.length - 1) await sleepMs(800);
    }

    if (toDelete.length) {
      broadcastProgress(`Deleting ${toDelete.length} leads that failed verification…`);
      try {
        const delRes = await fetch(`${API_BASE}/leads/delete`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            campaignId,
            leadIds: toDelete,
            aura,
          }),
        });
        const delData = await delRes.json().catch(() => ({}));
        if (!delRes.ok) throw new Error(delData.error || `Delete failed ${delRes.status}`);
        deleted = delData.deleted ?? toDelete.length;
        broadcastProgress(`Deleted ${deleted} leads from campaign`);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : 'Delete failed';
        failed += toDelete.length;
        broadcastProgress(`Could not delete leads: ${errMsg}`);
      }
    }

    try {
      await chrome.storage.local.set({
        scoutAuraSession: { campaignId, aura, updatedAt: Date.now() },
      });
    } catch {
      /* ignore */
    }

    const msg = stopped
      ? `Stopped: ${readyCount} → Ready, ${deleted} deleted`
      : `Done: ${readyCount} → Ready/Queued, ${deleted} deleted, ${failed} failed`;

    broadcastProgress(msg);
    broadcastConfirmQueueUpdated(campaignId);

    const out = {
      processed: results.length,
      scored,
      droppedLow,
      deleted,
      readyCount,
      failed,
      skipped,
      alreadyChecked,
      results,
      stopped,
      message: msg,
    };
    await saveLastAutomationResult(out);
    return out;
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err || 'Automation failed');
    const failed = { error, message: error };
    await saveLastAutomationResult(failed);
    return failed;
  } finally {
    clearInterval(keepAlive);
    automationControl.running = false;
    automationControl.stopRequested = false;
    automationControl.auraTabId = null;
    broadcastAutomationState();
  }
}

async function previewLeadForLinkedIn(profileUrl) {
  const { session, pending } = await getStoredAuraContext();
  const campaignId = session?.campaignId || pending?.campaignId;
  const aura = session?.aura || pending?.aura;
  if (!campaignId || !aura?.authToken) {
    return { skipped: true, reason: 'Open an Aura campaign and click Run automation first' };
  }

  const slug = normalizeLinkedInProfileKey(profileUrl);
  let personName = '';
  try {
    const title = (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.title || '';
    personName = nameFromLinkedInTitle(title);
  } catch {
    /* ignore */
  }

  const resolved = await resolveLeadForProfile(campaignId, aura, {
    linkedinUrl: profileUrl,
    leadId: pending?.leadId,
    personName: pending?.leadName || personName,
  });

  if (!resolved?.found || !resolved.lead) {
    return {
      skipped: true,
      reason: personName
        ? `No campaign lead matched "${personName}"`
        : 'No matching lead for this LinkedIn profile',
    };
  }

  const lead = resolved.lead;
  const leadName = lead.name || leadDisplayNameFallback(lead) || `Lead #${lead.id}`;

  if (await isLeadChecked(campaignId, lead.id)) {
    return {
      skipped: true,
      alreadyChecked: true,
      reason: `${leadName} already checked — not prompting again`,
      leadId: lead.id,
      leadName,
    };
  }

  if (!resolved.processable) {
    return {
      skipped: true,
      reason: `${leadName} is ${resolved.stage || 'not Not Eligible'} — only Not Eligible needs Confirm`,
      leadId: lead.id,
      leadName,
      stage: resolved.stage,
    };
  }

  // Prefer cached score from Run automation
  let cached = null;
  try {
    const data = await chrome.storage.local.get(['scoutPendingScores']);
    cached = data.scoutPendingScores?.[String(lead.id)] || null;
  } catch {
    /* ignore */
  }

  let preview = cached;
  if (!preview || preview.campaignId !== campaignId) {
    const result = await processLeadOnServer(
      campaignId,
      lead,
      crmStubExtraction(lead),
      aura,
      { autoApply: false },
    );
    preview = {
      campaignId,
      leadId: lead.id,
      leadName,
      linkedinUrl: lead.linkedinUrl || lead.linkedin_url || profileUrl,
      jobTitle: result.linkedInRole || lead.jobTitle || lead.job_title || '',
      company: result.linkedInCompany || lead.company || lead.company_name || '',
      fitScore: result.fitScore,
      summary: result.summary,
      locationOverride: result.locationOverride,
      lead,
    };
  }

  const score = typeof preview.fitScore === 'number' ? preview.fitScore : 0;
  if (score < FIT_SCORE_CONFIRM_THRESHOLD) {
    await markLeadChecked(campaignId, lead.id, 'below-threshold');
    try {
      const data = await chrome.storage.local.get(['scoutPendingScores']);
      const map = data.scoutPendingScores || {};
      delete map[String(lead.id)];
      await chrome.storage.local.set({ scoutPendingScores: map });
    } catch {
      /* ignore */
    }
    return {
      skipped: true,
      reason: `${leadName} scored ${score}/10 — below ${FIT_SCORE_CONFIRM_THRESHOLD}, not shown for Confirm`,
      leadId: lead.id,
      leadName,
      fitScore: score,
    };
  }

  return {
    found: true,
    campaignId,
    aura,
    lead,
    leadId: lead.id,
    leadName,
    jobTitle: preview.jobTitle || '',
    company: preview.company || '',
    fitScore: preview.fitScore,
    summary: preview.summary || '',
    locationOverride: preview.locationOverride,
    canConfirm: true,
  };
}

async function verifyAndReadyLead({ campaignId, lead, aura, confirmedJobTitle, confirmedCompany }) {
  if (!campaignId || !lead?.id || !aura?.authToken) {
    throw new Error('Missing campaign, lead, or Aura auth');
  }
  if (await isLeadChecked(campaignId, lead.id)) {
    return {
      skipped: true,
      alreadyChecked: true,
      reason: 'Already checked — not applying again',
      leadId: lead.id,
    };
  }

  const result = await processLeadOnServer(
    campaignId,
    lead,
    crmStubExtraction({ ...lead, job_title: confirmedJobTitle, company_name: confirmedCompany }),
    aura,
    {
      autoApply: true,
      operatorVerified: true,
      confirmedJobTitle,
      confirmedCompany,
      promoteToQueued: true,
    },
  );

  const moved =
    result.stageAfter === 'QUEUED' || result.stageAfter === 'READY' || Boolean(result.applied);
  if (moved) {
    await markLeadChecked(campaignId, lead.id, 'confirm');
    try {
      const data = await chrome.storage.local.get(['scoutPendingScores']);
      const map = data.scoutPendingScores || {};
      delete map[String(lead.id)];
      await chrome.storage.local.set({ scoutPendingScores: map });
    } catch {
      /* ignore */
    }
  }

  return {
    ...result,
    leadName: result.leadName || leadDisplayNameFallback(lead),
    applied: moved,
  };
}


// ─────────────────────────────────────────────────────────────────────────────
// LinkedIn Voyager Scraper — runs in browser context so real cookies are used
// ─────────────────────────────────────────────────────────────────────────────

function inferJobFunction(title, about = '') {
  const blob = `${title} ${about}`.toLowerCase();
  const rules = [
    [/\b(ceo|cto|cfo|coo|cmo|cro|chief[^n])/i, 'Executive'],
    [/\b(founder|co-?founder|owner)\b/i, 'Founder'],
    [/\b(sales|account executive|ae\b|bdr|sdr|business development)\b/i, 'Sales'],
    [/\b(marketing|brand|growth|demand gen|content|comms|communications)\b/i, 'Marketing'],
    [/\b(product manager|pm\b|product management|product owner)\b/i, 'Product Management'],
    [/\b(engineer|developer|software|devops|sre|backend|frontend|fullstack|data scientist|ml |machine learning)\b/i, 'Engineering'],
    [/\b(design|ux|ui\b|creative|visual)\b/i, 'Design'],
    [/\b(finance|financial|accounting|controller|cfo\b|treasury)\b/i, 'Finance'],
    [/\b(human resources|hr\b|people ops|talent|recruiting|recruiter)\b/i, 'Human Resources'],
    [/\b(legal|counsel|attorney|compliance)\b/i, 'Legal'],
    [/\b(operations|ops\b|supply chain|logistics)\b/i, 'Operations'],
    [/\b(it\b|information technology|systems|infrastructure|network|security)\b/i, 'IT'],
    [/\b(customer success|cs\b|customer support|support)\b/i, 'Customer Success'],
    [/\b(data|analytics|analyst|bi\b|business intelligence)\b/i, 'Analytics'],
    [/\b(consulting|advisor|advisory)\b/i, 'Consulting'],
    [/\b(partnerships|alliances|channel)\b/i, 'Partnerships'],
  ];
  for (const [re, fn] of rules) { if (re.test(blob)) return fn; }
  return '';
}

function inferJobLevel(title) {
  const t = title.toLowerCase();
  if (/\b(ceo|cto|cfo|coo|cmo|cro|chief)\b/.test(t)) return 'C-Level';
  if (/\b(founder|co-?founder|owner)\b/.test(t)) return 'Founder / Owner';
  if (/\b(president|evp|svp)\b/.test(t)) return 'Executive VP';
  if (/\b(vp|vice president)\b/.test(t)) return 'VP';
  if (/\b(director|head of|head\b)\b/.test(t)) return 'Director';
  if (/\b(manager|lead\b|principal)\b/.test(t)) return 'Manager';
  if (/\b(senior|sr\.?)\b/.test(t)) return 'Senior IC';
  if (/\b(junior|jr\.?|associate)\b/.test(t)) return 'Junior IC';
  if (/\b(intern)\b/.test(t)) return 'Intern';
  return 'Individual Contributor';
}

function parseLocationParts(location) {
  const parts = (location || '').split(',').map(p => p.trim()).filter(Boolean);
  if (parts.length === 0) return { city: '', state: '', country: '' };
  if (parts.length === 1) return { city: parts[0], state: '', country: '' };
  if (parts.length === 2) return { city: parts[0], state: '', country: parts[1] };
  return { city: parts[0], state: parts[1], country: parts[parts.length - 1] };
}

function parseVoyagerProfileJson(json, slug) {
  const included = Array.isArray(json.included) ? json.included : [];
  const dashElements = Array.isArray(json.data?.elements) ? json.data.elements : [];
  const all = [...included, ...dashElements];

  let profileEl = all.find(el =>
    typeof el.$type === 'string' &&
    (el.$type.includes('Profile') || el.$type.toLowerCase().includes('profile')) &&
    !el.$type.includes('Position') &&
    !el.$type.includes('Education') &&
    el.firstName
  );
  // Fallback: older endpoint puts profile in data.profile
  if (!profileEl && json.data?.profile?.firstName) profileEl = json.data.profile;
  if (!profileEl) return null;

  const firstName = String(profileEl.firstName || '').trim();
  const lastName  = String(profileEl.lastName  || '').trim();
  const headline  = String(profileEl.headline  || '').trim();
  const about     = String(profileEl.summary   || '').trim();

  // Positions
  const positionEls = all.filter(el =>
    typeof el.$type === 'string' &&
    (el.$type.includes('Position') || el.$type.includes('Experience')) &&
    el.title
  );
  const positionViewEls = Array.isArray(json.data?.profile?.positionView?.elements)
    ? json.data.profile.positionView.elements : [];
  const positions = positionEls.length > 0 ? positionEls : positionViewEls;

  const currentPos = positions.find(p => !p.timePeriod?.endDate) || positions[0];
  const currentTitle   = String(currentPos?.title || currentPos?.jobTitle || '').trim();
  const currentCompany = String(currentPos?.companyName || currentPos?.company?.name || '').trim();

  // Geo
  const geoEl = all.find(el =>
    typeof el.$type === 'string' && el.$type.includes('Geo') && el.defaultLocalizedName
  );
  const locationFull = String(
    geoEl?.defaultLocalizedName || profileEl.locationName || profileEl.geoLocationName || ''
  ).trim();

  const { city, state, country } = parseLocationParts(locationFull);
  const jobFunction = inferJobFunction(currentTitle, about);
  const jobLevel    = inferJobLevel(currentTitle);

  return {
    personName: `${firstName} ${lastName}`.trim(),
    firstName, lastName, headline, about,
    currentTitle, currentCompany,
    locationFull, city, state, country,
    jobFunction, jobLevel,
  };
}

async function scrapeLinkedInViaExtension(slug) {
  // ── Get real cookies from the browser ──────────────────────────────────────
  const getCookie = (name) => new Promise(resolve =>
    chrome.cookies.get({ url: 'https://www.linkedin.com', name }, cookie => resolve(cookie?.value || ''))
  );

  const liAt      = await getCookie('li_at');
  let jsessionId  = await getCookie('JSESSIONID');

  if (!liAt) {
    return { error: 'Not logged in to LinkedIn. Please open linkedin.com in this browser and log in, then try again.' };
  }

  // Chrome stores JSESSIONID with surrounding quotes; strip them
  jsessionId = jsessionId.replace(/^"|"$/g, '') ||
    `ajax:${Math.floor(Math.random() * 9_000_000_000) + 1_000_000_000}`;

  const cookieHeader = `li_at=${liAt}; JSESSIONID="${jsessionId}"`;
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    'Accept': 'application/vnd.linkedin.normalized+json+2.1',
    'Accept-Language': 'en-US,en;q=0.9',
    'x-restli-protocol-version': '2.0.0',
    'x-li-lang': 'en_US',
    'x-li-page-instance': 'urn:li:page:d_flagship3_profile_view_base;1',
    'Cookie': cookieHeader,
    'csrf-token': jsessionId,
    'Referer': 'https://www.linkedin.com/',
  };

  const endpoints = [
    `https://www.linkedin.com/voyager/api/identity/profiles/${slug}`,
    `https://www.linkedin.com/voyager/api/identity/dash/profiles?q=memberIdentity&memberIdentity=${encodeURIComponent(slug)}&decorationId=com.linkedin.voyager.dash.deco.identity.profile.FullProfileWithEntities-35`,
  ];

  for (const url of endpoints) {
    try {
      console.log(`[bg:linkedin-scraper] GET ${url.split('?')[0].split('/').slice(-2).join('/')}`);
      const res = await fetch(url, { headers });
      console.log(`[bg:linkedin-scraper] HTTP ${res.status}`);
      if (res.status === 410) { console.log('[bg:linkedin-scraper] 410 deprecated, trying next…'); continue; }
      if (!res.ok) { console.log(`[bg:linkedin-scraper] ${res.status} from endpoint, trying next…`); continue; }

      const json = await res.json();
      const profile = parseVoyagerProfileJson(json, slug);
      if (!profile) { console.log('[bg:linkedin-scraper] No profile element found, trying next…'); continue; }

      console.log(`[bg:linkedin-scraper] ✅ name="${profile.personName}" title="${profile.currentTitle}"`);
      return profile;
    } catch (err) {
      console.warn(`[bg:linkedin-scraper] fetch error: ${err.message}`);
    }
  }

  return { error: `LinkedIn returned no data for "${slug}". The profile may be private, deleted, or your LinkedIn session has expired — log into linkedin.com and try again.` };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'SCRAPE_LINKEDIN_PROFILE') {
    const { slug } = message;
    if (!slug) { sendResponse({ error: 'No slug provided' }); return false; }
    scrapeLinkedInViaExtension(slug).then(sendResponse).catch(err => sendResponse({ error: err.message }));
    return true; // keep channel open for async response
  }
});

// ── MutationObserver push from linkedin-assist.js ──────────────────────────
// When the content script detects that LinkedIn's React has finished rendering,
// it sends LINKEDIN_PROFILE_READY with the extracted fields.
// We cache them by slug so scrapeLinkedInTabFields can read them instantly
// without needing a scripting.executeScript round-trip.
chrome.runtime.onMessage.addListener((message, sender) => {
  if (message.type !== 'LINKEDIN_PROFILE_READY') return;
  const { fields, url, slug } = message;
  if (!slug || !fields) return;
  linkedinProfileCache.set(slug, { fields, url: url || '', cachedAt: Date.now() });
  // Also index by tab so scrapeLinkedInTabFields can look up without slug
  if (sender?.tab?.id) {
    linkedinProfileCache.set(`tab:${sender.tab.id}`, { fields, url: url || '', cachedAt: Date.now() });
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'GET_AURA_CONTEXT') {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs[0];
      if (!tab?.id) {
        sendResponse({ error: 'No active tab' });
        return;
      }
      getAuraContextFromTab(tab.id)
        .then((ctx) => sendResponse(ctx || { error: 'Not on an Aura campaign page' }))
        .catch((err) =>
          sendResponse({ error: err instanceof Error ? err.message : 'Context failed' }),
        );
    });
    return true;
  }
  if (message.type === 'ANALYZE_PAGE') {
    analyzePage(message.data)
      .then(sendResponse)
      .catch((err) => sendResponse({ error: err.message }));
    return true;
  }
  if (message.type === 'EXTRACT_TAB') {
    extractFromTab(message.tabId, {
      deep: message.deep,
      forQuestion: message.forQuestion,
    })
      .then(sendResponse)
      .catch((err) => sendResponse({ error: err.message }));
    return true;
  }
  if (message.type === 'GET_COMPANIES') {
    fetch(`${API_BASE}/companies`)
      .then((r) => r.json())
      .then(sendResponse)
      .catch((err) => sendResponse({ error: err.message }));
    return true;
  }
  if (message.type === 'ASK_PAGE') {
    fetch(`${API_BASE}/ask-page`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        question: message.question,
        url: message.url,
        extraction: message.extraction,
      }),
    })
      .then(async (r) => {
        const data = await r.json();
        if (!r.ok) throw new Error(data.error || `Server error ${r.status}`);
        return data;
      })
      .then(sendResponse)
      .catch((err) => sendResponse({ error: err.message }));
    return true;
  }
  if (message.type === 'ASK') {
    fetch(`${API_BASE}/ask`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: message.question }),
    })
      .then((r) => r.json())
      .then(sendResponse)
      .catch((err) => sendResponse({ error: err.message }));
    return true;
  }
  if (message.type === 'GET_LEAD_QUEUE') {
    fetch(`${API_BASE}/leads/queue/${message.campaignId}?stage=${message.stage || 'NOT_ELIGIBLE'}`, {
      headers: {
        'x-aura-token': message.aura.authToken,
        'x-datahub-url': message.aura.datahubBaseUrl,
      },
    })
      .then(async (r) => {
        const data = await r.json();
        if (!r.ok) throw new Error(data.error || `Server error ${r.status}`);
        return data;
      })
      .then(sendResponse)
      .catch((err) => sendResponse({ error: err.message }));
    return true;
  }
  if (message.type === 'STOP_LEAD_AUTOMATION') {
    requestAutomationStop();
    sendResponse({ ok: true, stopping: true });
    return false;
  }
  if (message.type === 'GET_AUTOMATION_STATUS') {
    sendResponse({
      running: automationControl.running,
      stopRequested: automationControl.stopRequested,
    });
    return false;
  }
  if (message.type === 'GET_LAST_AUTOMATION_RESULT') {
    getLastAutomationResult()
      .then((res) => sendResponse(res || { message: 'No saved result yet' }))
      .catch((err) => sendResponse({ error: err?.message || 'Could not read result' }));
    return true;
  }
  if (message.type === 'RUN_LEAD_AUTOMATION') {
    runLeadAutomation(message.campaignId, message.aura, message.options || {})
      .then((res) => {
        try {
          sendResponse(res);
        } catch {
          /* port may already be closed after long Puppeteer runs */
        }
      })
      .catch(async (err) => {
        const failed = { error: err?.message || 'Automation failed' };
        await saveLastAutomationResult(failed);
        try {
          sendResponse(failed);
        } catch {
          /* ignore */
        }
      });
    return true;
  }
  if (message.type === 'PREVIEW_LEAD_SCORE' || message.type === 'AUTO_PROCESS_LINKEDIN_PROFILE') {
    previewLeadForLinkedIn(message.profileUrl || message.url || '')
      .then(sendResponse)
      .catch((err) => sendResponse({ error: err instanceof Error ? err.message : 'Preview failed' }));
    return true;
  }
  if (message.type === 'VERIFY_AND_READY_LEAD') {
    verifyAndReadyLead({
      campaignId: message.campaignId,
      lead: message.lead,
      aura: message.aura,
      confirmedJobTitle: message.confirmedJobTitle,
      confirmedCompany: message.confirmedCompany,
    })
      .then(sendResponse)
      .catch((err) => sendResponse({ error: err instanceof Error ? err.message : 'Verify failed' }));
    return true;
  }
  if (message.type === 'SKIP_LEAD_CHECK') {
    const campaignId = message.campaignId;
    const leadId = message.leadId;
    if (campaignId && leadId) {
      markLeadChecked(campaignId, leadId, 'skip')
        .then(async () => {
          try {
            const data = await chrome.storage.local.get(['scoutPendingScores']);
            const map = data.scoutPendingScores || {};
            delete map[String(leadId)];
            await chrome.storage.local.set({ scoutPendingScores: map });
          } catch {
            /* ignore */
          }
          sendResponse({ ok: true, skipped: true });
        })
        .catch((err) => sendResponse({ error: err instanceof Error ? err.message : 'Skip failed' }));
      return true;
    }
    sendResponse({ error: 'Missing campaignId or leadId' });
    return false;
  }
  if (message.type === 'GET_PENDING_CONFIRM_QUEUE') {
    listPendingConfirmQueue(message.campaignId)
      .then((items) => sendResponse({ items, campaignId: message.campaignId }))
      .catch((err) => sendResponse({ error: err instanceof Error ? err.message : 'Queue failed' }));
    return true;
  }
  if (message.type === 'OPEN_SIDE_PANEL') {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]?.id) chrome.sidePanel.open({ tabId: tabs[0].id });
    });
    return false;
  }
  if (message.type === 'OPEN_DOCK') {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]?.id) {
        chrome.tabs.sendMessage(tabs[0].id, { type: 'OPEN_DOCK' }, () => {
          void chrome.runtime.lastError;
        });
      }
    });
    return false;
  }
});

async function analyzePage(extraction) {
  const res = await fetch(`${API_BASE}/analyze`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(extraction),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Server error ${res.status}`);
  }
  return res.json();
}
