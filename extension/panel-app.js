const QUICK_PROMPTS = [
  { label: 'Hiring?', q: 'Is this person or company hiring? List every role with full details from scraped posts.' },
  { label: 'Open roles', q: 'What open roles, internships, or positions are mentioned? Quote full post text.' },
  { label: 'Tech stack', q: 'What technologies, skills, or tools are mentioned on this page?' },
  { label: 'Outreach', q: 'Based only on scraped data, what is the best recruiter outreach angle?' },
  { label: 'Company', q: 'Summarize the company: stage, size, industry, and hiring signals.' },
  { label: 'Investor view', q: 'What investment-relevant signals appear in the scraped content?' },
];

const CHIP_COLORS = {
  hiring: 'chip-hiring',
  role: 'chip-role',
  skill: 'chip-skill',
  company: 'chip-company',
  location: 'chip-location',
  person: 'chip-person',
  signal: 'chip-signal',
  other: 'chip-other',
};

const $ = (id) => document.getElementById(id);
let currentPage = null;
let lastBrief = null;
let lastScraped = [];
let reloadTimer;
let contextInvalidated = false;

function isExtensionContextValid() {
  if (contextInvalidated) return false;
  try {
    return Boolean(chrome?.runtime?.id);
  } catch {
    return false;
  }
}

function markContextInvalidated() {
  if (contextInvalidated) return;
  contextInvalidated = true;
  clearTimeout(reloadTimer);
  const msg = 'Scout was reloaded. Close this panel, refresh Aura, then reopen Scout.';
  renderProfile(null, msg);
  setOperatorStatus(msg, true);
  const askBtn = $('askBtn');
  if (askBtn) askBtn.disabled = true;
  const runBtn = $('headerRunAutomation');
  const opBtn = $('operatorRunBtn');
  if (runBtn) runBtn.disabled = true;
  if (opBtn) opBtn.disabled = true;
}

function isInvalidatedError(err) {
  const msg = String(err?.message || err || '');
  return /extension context invalidated/i.test(msg);
}

function sendRuntimeMessage(message) {
  return new Promise((resolve, reject) => {
    if (!isExtensionContextValid()) {
      markContextInvalidated();
      reject(new Error('Extension context invalidated.'));
      return;
    }
    try {
      chrome.runtime.sendMessage(message, (response) => {
        const err = chrome.runtime.lastError;
        if (err) {
          if (isInvalidatedError(err)) markContextInvalidated();
          reject(new Error(err.message || 'Extension message failed'));
          return;
        }
        resolve(response);
      });
    } catch (err) {
      if (isInvalidatedError(err)) markContextInvalidated();
      reject(err);
    }
  });
}

function queryTabs(queryInfo) {
  return new Promise((resolve, reject) => {
    if (!isExtensionContextValid()) {
      markContextInvalidated();
      reject(new Error('Extension context invalidated.'));
      return;
    }
    try {
      chrome.tabs.query(queryInfo, (tabs) => {
        const err = chrome.runtime.lastError;
        if (err) {
          if (isInvalidatedError(err)) markContextInvalidated();
          reject(new Error(err.message || 'Tab query failed'));
          return;
        }
        resolve(tabs);
      });
    } catch (err) {
      if (isInvalidatedError(err)) markContextInvalidated();
      reject(err);
    }
  });
}

function init() {
  window.addEventListener('unhandledrejection', (event) => {
    if (isInvalidatedError(event.reason)) {
      event.preventDefault();
      markContextInvalidated();
    }
  });

  renderQuickPrompts();
  setupResize();
  setupOperatorPanel().catch(() => {});

  $('widenBtn')?.addEventListener('click', () => {
    sendRuntimeMessage({ type: 'OPEN_DOCK' }).catch(() => {});
  });
  $('closeDockBtn')?.addEventListener('click', () => window.parent.postMessage({ type: 'SCOUT_CLOSE_DOCK' }, '*'));

  const askBtn = $('askBtn');
  const copyBtn = $('copyBtn');
  const saveBtn = $('saveBtn');
  const question = $('question');

  askBtn?.addEventListener('click', handleAsk);
  copyBtn?.addEventListener('click', handleCopy);
  saveBtn?.addEventListener('click', handleSave);
  question?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleAsk();
    }
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && isExtensionContextValid()) {
      scheduleReload();
    }
  });

  loadCurrentPage().catch(() => {});
}

function renderQuickPrompts() {
  const el = $('quickPrompts');
  if (!el) return;
  el.innerHTML = QUICK_PROMPTS.map(
    (p) => `<button type="button" class="quick-chip" data-q="${escapeAttr(p.q)}">${escapeHtml(p.label)}</button>`
  ).join('');
  el.querySelectorAll('.quick-chip').forEach((btn) => {
    btn.addEventListener('click', () => {
      $('question').value = btn.dataset.q;
      handleAsk();
    });
  });
}

function setupResize() {
  const handle = $('resizeHandle');
  if (!handle || document.body.dataset.mode !== 'dock') return;
  let startX, startW;
  handle.addEventListener('mousedown', (e) => {
    e.preventDefault();
    startX = e.clientX;
    startW = window.innerWidth;
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
  function onMove(e) {
    const w = Math.min(820, Math.max(360, startW + (startX - e.clientX)));
    window.parent.postMessage({ type: 'SCOUT_RESIZE', width: w }, '*');
  }
  function onUp() {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
  }
}

function scheduleReload() {
  if (!isExtensionContextValid()) {
    markContextInvalidated();
    return;
  }
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(() => {
    if (!isExtensionContextValid()) {
      markContextInvalidated();
      return;
    }
    loadCurrentPage().catch((err) => {
      if (!isInvalidatedError(err)) console.warn('Scout loadCurrentPage:', err);
    });
    setupOperatorPanel().catch((err) => {
      if (!isInvalidatedError(err)) console.warn('Scout setupOperatorPanel:', err);
    });
  }, 300);
}

async function extractFromTab(tabId, opts = {}) {
  return sendRuntimeMessage({ type: 'EXTRACT_TAB', tabId, ...opts });
}

function getSubjectName(extraction) {
  const bad = ['Activity section', 'Unknown', 'This page'];
  const name =
    extraction?.personName ||
    extraction?.companyName ||
    extraction?.title?.split('|')[0]?.trim() ||
    'This page';
  return bad.includes(name) ? extraction?.title?.split('|')[0]?.trim() || 'This page' : name;
}

function buildScrapedSections(extraction) {
  if (!extraction) return [];
  const sections = [];
  const seen = new Set();
  const add = (id, title, content) => {
    const text = (content || '').trim();
    if (text.length < 20 || seen.has(text.slice(0, 200))) return;
    seen.add(text.slice(0, 200));
    sections.push({ id, title, content: text });
  };

  const profileLines = [
    extraction.personName && `Name: ${extraction.personName}`,
    extraction.companyName && `Company: ${extraction.companyName}`,
    extraction.description && `Headline: ${extraction.description}`,
    extraction.industry && `Industry: ${extraction.industry}`,
    extraction.location && `Location: ${extraction.location}`,
    extraction.employeeCount && `Size: ${extraction.employeeCount}`,
  ].filter(Boolean);
  if (profileLines.length) add('profile', 'Profile', profileLines.join('\n'));

  (extraction.metadata?.hiringPosts || []).forEach((p, i, arr) =>
    add(`hiring-${i}`, arr.length > 1 ? `Hiring post ${i + 1}` : 'Hiring post', p.author ? `${p.author}\n\n${p.body}` : p.body)
  );

  let n = 1;
  (extraction.metadata?.posts || []).filter((p) => !p.isHiring).forEach((p) => {
    add(`post-${n}`, `Post ${n}`, p.author ? `${p.author}\n\n${p.body}` : p.body);
    n++;
  });

  const labels = { about: 'About', experience: 'Experience', education: 'Education', skills: 'Skills', activity: 'Activity' };
  for (const [key, value] of Object.entries(extraction.metadata?.sections || {})) {
    add(`section-${key}`, labels[key] || key, String(value));
  }
  if (!sections.length && extraction.rawText?.trim()) {
    add('page', 'Page content', extraction.rawText.trim().slice(0, 8000));
  }
  return sections;
}

function renderProfile(extraction, error) {
  const card = $('profileCard');
  const askBtn = $('askBtn');
  if (!card) return;
  if (error) {
    card.innerHTML = `<p class="error">${escapeHtml(error)}</p>`;
    if (askBtn) askBtn.disabled = true;
    return;
  }
  const name = getSubjectName(extraction);
  card.innerHTML = `
    <div class="profile-top">
      <h1>${escapeHtml(name)}</h1>
      ${extraction.sourceType ? `<span class="source-badge">${escapeHtml(extraction.sourceType)}</span>` : ''}
    </div>
    ${extraction.description ? `<p class="profile-headline">${escapeHtml(extraction.description.slice(0, 200))}</p>` : ''}
  `;
  if (askBtn) askBtn.disabled = false;
}

function renderChips(chips) {
  const row = $('chipRow');
  if (!chips?.length) {
    row.innerHTML = '';
    return;
  }
  row.innerHTML = chips
    .map((c) => `<span class="chip ${CHIP_COLORS[c.type] || 'chip-other'}">${escapeHtml(c.label)}</span>`)
    .join('');
}

function renderSummary(brief) {
  const section = $('summarySection');
  if (!brief?.summary) {
    section.classList.add('hidden');
    return;
  }
  section.classList.remove('hidden');
  $('summaryText').textContent = brief.summary;
  renderChips(brief.chips);
  const hl = $('highlights');
  hl.innerHTML = (brief.highlights || []).map((h) => `<li>${escapeHtml(h)}</li>`).join('');
}

function renderScraped(sections) {
  lastScraped = sections || [];
  $('sourceCount').textContent = String(lastScraped.length);
  const el = $('scrapedContent');
  if (!lastScraped.length) {
    el.innerHTML = '<p class="muted">No sources scraped yet.</p>';
    return;
  }
  el.innerHTML = lastScraped
    .map(
      (s) => `
    <div class="scraped-block">
      <div class="scraped-title">${escapeHtml(s.title)} <span>${s.content.length} chars</span></div>
      <div class="scraped-text">${escapeHtml(s.content)}</div>
    </div>`
    )
    .join('');
}

function renderAnswer(brief) {
  lastBrief = brief;
  const section = $('answerSection');
  if (!brief?.answer) {
    section.classList.add('hidden');
    return;
  }
  section.classList.remove('hidden');
  $('answerText').textContent = brief.answer;
}

function clearResults() {
  lastBrief = null;
  $('answerSection').classList.add('hidden');
  $('summarySection').classList.add('hidden');
  $('answerText').textContent = '';
}

async function loadCurrentPage() {
  if (!isExtensionContextValid()) {
    markContextInvalidated();
    return;
  }
  try {
    clearResults();
    $('profileCard').innerHTML = '<p class="loading">Reading page…</p>';
    $('askBtn').disabled = true;

    const tabs = await queryTabs({ active: true, currentWindow: true });
    const tab = tabs[0];
    if (!tab?.id || tab.url?.startsWith('chrome://')) {
      renderProfile(null, 'Open a webpage to use Scout.');
      return;
    }

    const extraction = await extractFromTab(tab.id);
    if (extraction?.error) {
      renderProfile(null, extraction.error);
      return;
    }

    currentPage = { ...extraction, tabUrl: tab.url };
    renderProfile(extraction);
    renderScraped(buildScrapedSections(extraction));
  } catch (err) {
    if (isInvalidatedError(err)) {
      markContextInvalidated();
      return;
    }
    renderProfile(null, err instanceof Error ? err.message : 'Failed to read page');
  }
}

async function handleAsk() {
  const question = $('question').value.trim();
  if (!question || !currentPage || !isExtensionContextValid()) return;

  try {
    const tabs = await queryTabs({ active: true, currentWindow: true });
    const tab = tabs[0];
    if (!tab?.id) return;

    $('askBtn').disabled = true;
    $('answerText').textContent = 'Thinking…';
    $('answerSection').classList.remove('hidden');

    const fresh = await extractFromTab(tab.id, { forQuestion: true });
    if (fresh?.error) {
      $('answerText').textContent = fresh.error;
      $('askBtn').disabled = false;
      return;
    }

    currentPage = { ...fresh, tabUrl: tab.url };
    renderProfile(fresh);
    renderScraped(buildScrapedSections(fresh));

    const res = await sendRuntimeMessage({
      type: 'ASK_PAGE',
      question,
      url: tab.url,
      extraction: fresh,
    });

    $('askBtn').disabled = false;

    if (res?.error) {
      $('answerText').textContent = res.error;
      return;
    }

    const brief = {
      summary: res.summary,
      chips: res.chips,
      highlights: res.highlights,
      answer: res.answer,
    };

    if (res.scraped?.length) renderScraped(res.scraped);
    renderSummary(brief);
    renderAnswer(brief);
  } catch (err) {
    $('askBtn').disabled = false;
    if (isInvalidatedError(err)) {
      markContextInvalidated();
      return;
    }
    $('answerText').textContent = err instanceof Error ? err.message : 'Ask failed';
    $('answerSection').classList.remove('hidden');
  }
}

async function handleSave() {
  const btn = $('saveBtn');
  if (!isExtensionContextValid()) {
    markContextInvalidated();
    return;
  }
  btn.disabled = true;
  btn.textContent = 'Saving…';
  try {
    const tabs = await queryTabs({ active: true, currentWindow: true });
    const tab = tabs[0];
    const fresh = tab?.id ? await extractFromTab(tab.id, { deep: true }) : currentPage;
    const res = await sendRuntimeMessage({ type: 'ANALYZE_PAGE', data: fresh?.error ? currentPage : fresh });
    btn.textContent = res?.error ? 'Save to knowledge base' : '✓ Saved';
  } catch (err) {
    if (isInvalidatedError(err)) markContextInvalidated();
    btn.textContent = 'Save to knowledge base';
  } finally {
    btn.disabled = false;
  }
}

async function handleCopy() {
  if (!lastBrief && !lastScraped.length) return;
  const subject = getSubjectName(currentPage);
  const parts = [
    `Scout brief — ${subject}`,
    '',
    lastBrief?.summary && `Summary:\n${lastBrief.summary}`,
    lastBrief?.chips?.length && `Tags: ${lastBrief.chips.map((c) => c.label).join(', ')}`,
    '',
    `Q: ${$('question').value.trim()}`,
    '',
    lastBrief?.answer && `Answer:\n${lastBrief.answer}`,
    '',
    'Sources:',
    ...lastScraped.map((s) => `[${s.title}]\n${s.content}`),
  ].filter(Boolean);
  await navigator.clipboard.writeText(parts.join('\n'));
  $('copyBtn').textContent = 'Copied!';
  setTimeout(() => {
    $('copyBtn').textContent = 'Copy brief';
  }, 1500);
}

function escapeHtml(str) {
  if (!str) return '';
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}

function escapeAttr(str) {
  return String(str).replace(/"/g, '&quot;');
}

let operatorCtx = null;
let operatorRunBound = false;

async function runLeadAutomation() {
  if (!operatorCtx?.campaignId || !operatorCtx?.aura?.token) {
    setOperatorStatus('Sign in to Aura on the campaign page first.', true);
    return;
  }

  setPanelRunningUi(true);
  setOperatorStatus('Running LinkedIn automation in background…');

  try {
    const res = await sendRuntimeMessage({
      type: 'RUN_LEAD_AUTOMATION',
      campaignId: operatorCtx.campaignId,
      aura: {
        authToken: operatorCtx.aura.token,
        datahubBaseUrl: operatorCtx.aura.datahubUrl,
      },
      options: { limit: 20 },
    });

    if (res?.error) {
      setOperatorStatus(res.error, true);
      return;
    }
    setOperatorStatus(res.message || `Done: ${res.readyCount ?? 0} → Ready`);
    setTimeout(() => setupOperatorPanel().catch(() => {}), 1500);
  } catch (err) {
    if (isInvalidatedError(err)) {
      markContextInvalidated();
      return;
    }
    setOperatorStatus(err instanceof Error ? err.message : 'Automation failed', true);
  } finally {
    setPanelRunningUi(false);
  }
}

function setPanelRunningUi(running) {
  const runBtn = $('operatorRunBtn');
  const headerBtn = $('headerRunAutomation');
  const stopBtn = $('operatorStopBtn');
  const headerStop = $('headerStopAutomation');
  if (runBtn) {
    runBtn.disabled = running;
    runBtn.style.display = running ? 'none' : '';
  }
  if (headerBtn) {
    headerBtn.disabled = running;
    if (running) {
      headerBtn.style.display = 'none';
    } else if (!headerBtn.classList.contains('hidden')) {
      headerBtn.style.display = '';
    }
  }
  if (stopBtn) stopBtn.style.display = running ? '' : 'none';
  if (headerStop) {
    if (running) {
      headerStop.classList.remove('hidden');
      headerStop.style.display = '';
    } else {
      headerStop.style.display = 'none';
      headerStop.classList.add('hidden');
    }
  }
}

async function stopLeadAutomation() {
  setOperatorStatus('Stopping…');
  try {
    await sendRuntimeMessage({ type: 'STOP_LEAD_AUTOMATION' });
  } catch {
    /* ignore */
  }
}

function setOperatorStatus(text, isError) {
  const status = $('operatorStatus');
  const headerStatus = $('headerRunStatus');
  if (status) {
    status.textContent = text;
    status.style.color = isError ? '#f87171' : '';
  }
  if (headerStatus) {
    headerStatus.textContent = text;
    headerStatus.classList.remove('hidden');
    headerStatus.style.color = isError ? '#f87171' : '';
  }
}

async function setupOperatorPanel() {
  if (!isExtensionContextValid()) {
    markContextInvalidated();
    return;
  }

  const section = $('operatorSection');
  const runBtn = $('operatorRunBtn');
  const headerBtn = $('headerRunAutomation');
  const headerStatus = $('headerRunStatus');

  try {
    const ctx = await sendRuntimeMessage({ type: 'GET_AURA_CONTEXT' });
    if (!ctx?.campaignId || ctx.error) {
      operatorCtx = null;
      section?.classList.add('hidden');
      headerBtn?.classList.add('hidden');
      headerStatus?.classList.add('hidden');
      return;
    }

    operatorCtx = ctx;
    section?.classList.remove('hidden');
    headerBtn?.classList.remove('hidden');
    headerStatus?.classList.remove('hidden');

    $('panelTagline').textContent = 'Lead operator brain';
    $('operatorCampaign').textContent = `Campaign #${ctx.campaignId} — NOT_ELIGIBLE → Ready`;

    if (!ctx.aura?.token) {
      setOperatorStatus('Sign in to Aura to connect Scout.', true);
      if (runBtn) runBtn.disabled = true;
      if (headerBtn) headerBtn.disabled = true;
      return;
    }

    const queueRes = await sendRuntimeMessage({
      type: 'GET_LEAD_QUEUE',
      campaignId: ctx.campaignId,
      stage: 'NOT_ELIGIBLE',
      aura: { authToken: ctx.aura.token, datahubBaseUrl: ctx.aura.datahubUrl },
    });

    const queue = queueRes?.queue || [];
    const queueEl = $('operatorQueue');
    if (queueEl) {
      if (!queue.length) {
        queueEl.innerHTML = '<p class="muted">No NOT_ELIGIBLE leads with LinkedIn URLs in queue.</p>';
        if (runBtn) runBtn.disabled = true;
        if (headerBtn) headerBtn.disabled = true;
        setOperatorStatus('No NOT_ELIGIBLE leads to process.');
      } else {
        const iconUrl = isExtensionContextValid() ? chrome.runtime.getURL('icons/linkedin.svg') : '';
        queueEl.innerHTML = queue
          .slice(0, 8)
          .map(
            (lead) => `
        <div class="operator-lead-row">
          ${iconUrl ? `<img src="${iconUrl}" width="14" height="14" alt="" />` : ''}
          <span>${escapeHtml(lead.name)}</span>
          <span class="muted">${escapeHtml(lead.jobTitle || '')}</span>
        </div>`,
          )
          .join('');
        if (queue.length > 8) {
          queueEl.innerHTML += `<p class="muted">+${queue.length - 8} more</p>`;
        }
        if (runBtn) runBtn.disabled = false;
        if (headerBtn) headerBtn.disabled = false;
        setOperatorStatus(`${queue.length} NOT_ELIGIBLE lead(s) — click Run automation`);
      }
    }

    if (!operatorRunBound) {
      operatorRunBound = true;
      runBtn?.addEventListener('click', runLeadAutomation);
      headerBtn?.addEventListener('click', runLeadAutomation);
      $('operatorStopBtn')?.addEventListener('click', stopLeadAutomation);
      $('headerStopAutomation')?.addEventListener('click', stopLeadAutomation);
    }
  } catch (err) {
    if (isInvalidatedError(err)) {
      markContextInvalidated();
      return;
    }
    setOperatorStatus(err instanceof Error ? err.message : 'Failed to load operator panel', true);
  }
}

init();
