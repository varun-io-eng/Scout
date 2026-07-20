(function () {
  const EXT_ID = (() => {
    try {
      return chrome?.runtime?.id || '';
    } catch {
      return '';
    }
  })();

  // After extension reload, old script is dead — allow re-init if id changed or missing
  if (window.__scoutAuraOperatorExtId && window.__scoutAuraOperatorExtId === EXT_ID && EXT_ID) {
    return;
  }
  window.__scoutAuraOperatorExtId = EXT_ID;
  window.__scoutAuraOperatorLoaded = true;

  const AURA_CAMPAIGN_RE = /\/dashboard\/campaigns\/(\d+)/;
  const DATAHUB_DEFAULT = 'https://app.zequinia.com/zequinia-datahub';
  const RELOAD_MSG = 'Scout was reloaded — click Refresh, then Run again.';

  let contextDead = !EXT_ID;

  function isExtensionAlive() {
    if (contextDead) return false;
    try {
      if (!chrome?.runtime?.id) {
        contextDead = true;
        return false;
      }
      return true;
    } catch {
      contextDead = true;
      return false;
    }
  }

  function markContextDead() {
    contextDead = true;
    setRunningUi(false);
    setStatus(RELOAD_MSG, true);
    const refreshBtn = document.getElementById('scout-refresh-page');
    if (refreshBtn) refreshBtn.style.display = 'inline-block';
    const runBtn = document.getElementById('scout-run-automation');
    if (runBtn) {
      runBtn.disabled = true;
      runBtn.style.opacity = '0.5';
    }
  }

  /** Safe messaging — never throws "Extension context invalidated" to the console. */
  function safeSendMessage(message, callback) {
    if (!isExtensionAlive()) {
      markContextDead();
      if (callback) callback({ error: RELOAD_MSG });
      return;
    }
    try {
      chrome.runtime.sendMessage(message, (res) => {
        const err = chrome.runtime.lastError?.message || '';
        if (/invalidated|context/i.test(err)) {
          markContextDead();
          if (callback) callback({ error: RELOAD_MSG });
          return;
        }
        if (err && (res === undefined || res === null)) {
          // Long Puppeteer runs often close the message port — not always a real failure
          if (/message port closed|receiving end does not exist|asynchronous response/i.test(err)) {
            if (callback) {
              callback({
                error: `Connection dropped during long run (${err}). Check Scout status / server logs — automation may still be running.`,
                portClosed: true,
              });
            }
            return;
          }
          if (callback) callback({ error: err });
          return;
        }
        if (callback) callback(res);
      });
    } catch (err) {
      const msg = String(err?.message || err || '');
      if (/invalidated|context/i.test(msg)) {
        markContextDead();
        if (callback) callback({ error: RELOAD_MSG });
        return;
      }
      setStatus(msg || 'Extension error', true);
      setRunningUi(false);
      if (callback) callback({ error: msg });
    }
  }

  function detectDatahubUrlFromPage() {
    try {
      const entries = performance.getEntriesByType('resource');
      for (const e of entries) {
        const m = String(e.name).match(/(https?:\/\/[^/]+\/zequinia-datahub)/);
        if (m) return m[1];
      }
      for (const e of entries) {
        const m = String(e.name).match(/(https?:\/\/localhost:\d+\/zequinia-datahub)/);
        if (m) return m[1];
      }
    } catch {
      /* ignore */
    }
    return null;
  }

  function getAuraAuth() {
    const token =
      localStorage.getItem('auth_token') || sessionStorage.getItem('auth_token') || '';
    let datahubUrl = detectDatahubUrlFromPage() || DATAHUB_DEFAULT;
    try {
      const userRaw = localStorage.getItem('user') || sessionStorage.getItem('user');
      if (userRaw) {
        const user = JSON.parse(userRaw);
        if (user?.datahub_url) datahubUrl = user.datahub_url;
      }
    } catch {
      /* ignore */
    }
    return { token, datahubUrl };
  }

  function isAuraHost() {
    const h = location.hostname;
    return (
      h === 'localhost' ||
      h === '127.0.0.1' ||
      h.includes('zequinia') ||
      h.includes('aura')
    );
  }

  function getCampaignIdFromUrl() {
    const m = location.pathname.match(AURA_CAMPAIGN_RE);
    return m ? Number(m[1]) : null;
  }

  function isLeadOperator() {
    const token =
      localStorage.getItem('auth_token') || sessionStorage.getItem('auth_token') || '';
    if (token) return true;
    try {
      const kc =
        localStorage.getItem('keycloak') ||
        sessionStorage.getItem('keycloak') ||
        localStorage.getItem('dev_client');
      if (!kc) return true;
      const parsed = typeof kc === 'string' && kc.startsWith('{') ? JSON.parse(kc) : null;
      const client = parsed?.client || kc;
      return String(client).toUpperCase().includes('LEAD_OPERATOR');
    } catch {
      return true;
    }
  }

  function removeScoutLinkedInIcons() {
    document.querySelectorAll('.scout-li-icon').forEach((el) => el.remove());
  }

  function setRunningUi(running) {
    const runBtn = document.getElementById('scout-run-automation');
    const stopBtn = document.getElementById('scout-stop-automation');
    if (runBtn) {
      runBtn.disabled = running || contextDead;
      runBtn.style.opacity = running || contextDead ? '0.5' : '1';
      runBtn.style.display = running ? 'none' : 'inline-block';
    }
    if (stopBtn) {
      stopBtn.style.display = running ? 'inline-block' : 'none';
    }
  }

  function injectOperatorBanner() {
    if (!isAuraHost()) return;
    const campaignId = getCampaignIdFromUrl();
    if (!campaignId) return;

    // Replace stale banner from a previous extension version
    const existing = document.getElementById('scout-operator-banner');
    if (existing) existing.remove();

    const banner = document.createElement('div');
    banner.id = 'scout-operator-banner';
    banner.style.cssText =
      'position:fixed;top:16px;left:50%;transform:translateX(-50%);z-index:2147483640;background:#0a0e14;border:1px solid #1d9bf055;border-radius:10px;padding:8px;box-shadow:0 8px 24px rgba(0,0,0,0.4);font-family:Segoe UI,system-ui,sans-serif;color:#e8ecf1;width:360px;max-height:calc(100vh - 32px);overflow:auto;user-select:none;';

    banner.innerHTML = `
      <div id="scout-banner-drag" title="Drag to move" style="display:flex;align-items:center;gap:8px;margin-bottom:6px;cursor:grab;padding:2px 2px 6px;border-bottom:1px solid #1a2332;">
        <span style="color:#6b7c93;font-size:14px;letter-spacing:1px;line-height:1;">⋮⋮</span>
        <span style="color:#3b9eff;font-size:11px;font-weight:600;flex:1;">Scout</span>
        <span style="color:#6b7c93;font-size:10px;">drag</span>
      </div>
      <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;">
        <button id="scout-run-automation" title="Puppeteer: verify Aura Edit fields vs LinkedIn + company website → Ready" style="background:#1d9bf0;color:#fff;border:none;padding:7px 12px;border-radius:8px;font-size:12px;font-weight:600;cursor:pointer;">
          Run automation
        </button>
        <button id="scout-stop-automation" title="Stop" style="display:none;background:#dc2626;color:#fff;border:none;padding:7px 12px;border-radius:8px;font-size:12px;font-weight:600;cursor:pointer;">
          Stop
        </button>
        <button id="scout-refresh-page" title="Refresh after Scout reload" style="display:none;background:#f59e0b;color:#111;border:none;padding:7px 12px;border-radius:8px;font-size:12px;font-weight:600;cursor:pointer;">
          Refresh
        </button>
        <button id="scout-enrich-ready" title="Scrape LinkedIn → fill all lead fields → move to READY" style="background:#7c3aed;color:#fff;border:none;padding:7px 12px;border-radius:8px;font-size:12px;font-weight:600;cursor:pointer;">
          🔗 Enrich &amp; Ready
        </button>
        <button id="scout-open-panel" title="Open Scout panel" style="background:#141c28;color:#3b9eff;border:1px solid #243044;padding:7px 12px;border-radius:8px;font-size:12px;cursor:pointer;">
          Open panel
        </button>
        <button id="scout-dismiss-banner" title="Hide" style="background:transparent;color:#6b7c93;border:none;padding:7px 8px;font-size:11px;cursor:pointer;">
          Hide
        </button>
      </div>
      <div id="scout-automation-status" style="display:none;font-size:11px;color:#6b7c93;margin-top:6px;"></div>
      <div id="scout-confirm-queue" style="display:none;margin-top:10px;border-top:1px solid #243044;padding-top:8px;"></div>
      <div id="scout-enrich-panel" style="display:none;margin-top:10px;border-top:1px solid #1a2332;padding-top:8px;font-size:11px;"></div>
    `;

    document.body.appendChild(banner);
    makeBannerDraggable(banner);
    restoreBannerPosition(banner);

    document.getElementById('scout-run-automation')?.addEventListener('click', () => {
      if (!isExtensionAlive()) {
        markContextDead();
        return;
      }
      const auth = getAuraAuth();
      if (!auth.token) {
        setStatus('Sign in to Aura first.', true);
        return;
      }
      setRunningUi(true);
      setStatus('Verifying leads (Puppeteer + LLM)…');
      safeSendMessage(
        {
          type: 'RUN_LEAD_AUTOMATION',
          campaignId,
          aura: { authToken: auth.token, datahubBaseUrl: auth.datahubUrl },
        },
        (res) => {
          if (res?.portClosed) {
            // Keep UI in running state and poll for completion
            setStatus(res.error || 'Long run in progress — waiting for result…', false);
            pollAutomationUntilDone(campaignId);
            return;
          }
          setRunningUi(false);
          if (!res || res.error) {
            const msg = res?.error || 'Automation failed (no response from extension — reload Scout)';
            setStatus(msg, true);
            if (/reloaded|refresh/i.test(msg)) markContextDead();
            return;
          }
          setStatus(res?.message || `Done: ${res.readyCount ?? 0} Ready, ${res.deleted ?? 0} deleted`);
          renderConfirmQueue();
        },
      );
    });

    document.getElementById('scout-stop-automation')?.addEventListener('click', () => {
      setStatus('Stopping…');
      safeSendMessage({ type: 'STOP_LEAD_AUTOMATION' });
    });

    document.getElementById('scout-refresh-page')?.addEventListener('click', () => {
      location.reload();
    });

    document.getElementById('scout-open-panel')?.addEventListener('click', () => {
      safeSendMessage({ type: 'OPEN_DOCK' });
    });

    document.getElementById('scout-dismiss-banner')?.addEventListener('click', () => {
      banner.remove();
    });

    document.getElementById('scout-enrich-ready')?.addEventListener('click', () => {
      if (!isExtensionAlive()) { markContextDead(); return; }
      enrichAndReadyLead();
    });

    if (!isExtensionAlive()) {
      markContextDead();
      return;
    }

    safeSendMessage({ type: 'GET_AUTOMATION_STATUS' }, (res) => {
      if (res?.running) setRunningUi(true);
    });

    persistAuraSession();
    renderConfirmQueue();
  }

  function applyBannerPosition(banner, left, top) {
    const maxLeft = Math.max(8, window.innerWidth - banner.offsetWidth - 8);
    const maxTop = Math.max(8, window.innerHeight - 48);
    const x = Math.min(Math.max(8, left), maxLeft);
    const y = Math.min(Math.max(8, top), maxTop);
    banner.style.left = `${x}px`;
    banner.style.top = `${y}px`;
    banner.style.right = 'auto';
    banner.style.transform = 'none';
    return { left: x, top: y };
  }

  function saveBannerPosition(left, top) {
    try {
      chrome.storage.local.set({ scoutBannerPos: { left, top, updatedAt: Date.now() } });
    } catch {
      /* ignore */
    }
  }

  function restoreBannerPosition(banner) {
    try {
      chrome.storage.local.get(['scoutBannerPos'], (data) => {
        const pos = data?.scoutBannerPos;
        if (!pos || typeof pos.left !== 'number' || typeof pos.top !== 'number') return;
        applyBannerPosition(banner, pos.left, pos.top);
      });
    } catch {
      /* keep default center-top */
    }
  }

  function makeBannerDraggable(banner) {
    const handle = banner.querySelector('#scout-banner-drag') || banner;
    let dragging = false;
    let startX = 0;
    let startY = 0;
    let originLeft = 0;
    let originTop = 0;

    const onMove = (e) => {
      if (!dragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      applyBannerPosition(banner, originLeft + dx, originTop + dy);
    };

    const onUp = () => {
      if (!dragging) return;
      dragging = false;
      handle.style.cursor = 'grab';
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      const left = parseFloat(banner.style.left) || 0;
      const top = parseFloat(banner.style.top) || 0;
      saveBannerPosition(left, top);
    };

    handle.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      // Don't start drag from buttons inside handle (none currently)
      if (e.target.closest('button')) return;
      e.preventDefault();
      dragging = true;
      handle.style.cursor = 'grabbing';

      // Convert centered transform position to absolute left/top before drag
      const rect = banner.getBoundingClientRect();
      originLeft = rect.left;
      originTop = rect.top;
      applyBannerPosition(banner, originLeft, originTop);

      startX = e.clientX;
      startY = e.clientY;
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  }

  function pollAutomationUntilDone(campaignId) {
    let tries = 0;
    const tick = () => {
      tries += 1;
      safeSendMessage({ type: 'GET_AUTOMATION_STATUS' }, (st) => {
        if (st?.running) {
          if (tries < 120) setTimeout(tick, 5000);
          else {
            setRunningUi(false);
            setStatus('Still running or stuck — check Scout server terminal / Stop and retry', true);
          }
          return;
        }
        safeSendMessage({ type: 'GET_LAST_AUTOMATION_RESULT' }, (res) => {
          setRunningUi(false);
          if (res?.error) {
            setStatus(res.error, true);
          } else {
            setStatus(res?.message || 'Automation finished');
          }
          renderConfirmQueue();
        });
      });
    };
    setTimeout(tick, 3000);
  }

  function escapeHtml(s) {
    return String(s || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function renderConfirmQueue() {
    const campaignId = getCampaignIdFromUrl();
    const queueEl = document.getElementById('scout-confirm-queue');
    if (!campaignId || !queueEl) return;

    safeSendMessage({ type: 'GET_PENDING_CONFIRM_QUEUE', campaignId }, (res) => {
      if (!res || res.error) {
        queueEl.style.display = 'none';
        return;
      }
      const items = res.items || [];
      if (!items.length) {
        queueEl.style.display = 'none';
        queueEl.innerHTML = '';
        return;
      }

      const auth = getAuraAuth();
      queueEl.style.display = 'block';
      queueEl.innerHTML = `
        <div style="font-size:11px;color:#3b9eff;font-weight:600;margin-bottom:8px;">
          Confirm ${items.length} scored lead${items.length === 1 ? '' : 's'} → Ready → Queued
        </div>
        <div id="scout-confirm-list"></div>
      `;
      const list = document.getElementById('scout-confirm-list');
      if (!list) return;

      for (const item of items) {
        const row = document.createElement('div');
        row.id = `scout-confirm-row-${item.leadId}`;
        row.style.cssText =
          'padding:8px 0;border-bottom:1px solid #1a2332;';
        const score = item.fitScore != null ? `${item.fitScore}/10` : '—';
        const scoreColor =
          typeof item.fitScore === 'number' && item.fitScore >= 8 ? '#4ade80' : '#fbbf24';
        const roleLine = [item.jobTitle, item.company].filter(Boolean).join(' · ');
        row.innerHTML = `
          <div style="display:flex;justify-content:space-between;gap:8px;align-items:flex-start;">
            <div style="min-width:0;flex:1;">
              <div style="font-size:12px;font-weight:600;color:#e8ecf1;">${escapeHtml(item.leadName)}</div>
              <div style="font-size:11px;color:#8b9cb3;margin-top:2px;">${escapeHtml(roleLine || 'CRM role')}</div>
            </div>
            <span style="color:${scoreColor};font-weight:700;font-size:12px;white-space:nowrap;">${escapeHtml(score)}</span>
          </div>
          <div style="display:flex;gap:6px;margin-top:8px;">
            <button data-action="confirm" style="flex:1;background:#1d9bf0;color:#fff;border:none;padding:6px 10px;border-radius:7px;font-size:11px;font-weight:600;cursor:pointer;">Confirm</button>
            <button data-action="skip" style="background:#141c28;color:#8b9cb3;border:1px solid #243044;padding:6px 10px;border-radius:7px;font-size:11px;cursor:pointer;">Skip</button>
          </div>
          <div data-status style="font-size:10px;color:#6b7c93;margin-top:4px;min-height:12px;"></div>
        `;

        const statusEl = row.querySelector('[data-status]');
        row.querySelector('[data-action="confirm"]')?.addEventListener('click', () => {
          if (!auth.token) {
            if (statusEl) {
              statusEl.textContent = 'Sign in to Aura first';
              statusEl.style.color = '#f87171';
            }
            return;
          }
          if (statusEl) {
            statusEl.textContent = 'Saving Ready → Queued…';
            statusEl.style.color = '#6b7c93';
          }
          safeSendMessage(
            {
              type: 'VERIFY_AND_READY_LEAD',
              campaignId,
              lead: item.lead || { id: item.leadId },
              aura: { authToken: auth.token, datahubBaseUrl: auth.datahubUrl },
              confirmedJobTitle: item.jobTitle || '',
              confirmedCompany: item.company || '',
            },
            (r) => {
              if (!r || r.error) {
                if (statusEl) {
                  statusEl.textContent = r?.error || 'Confirm failed';
                  statusEl.style.color = '#f87171';
                }
                return;
              }
              if (statusEl) {
                statusEl.textContent = `→ ${r.stageAfter || 'saved'}`;
                statusEl.style.color = '#4ade80';
              }
              setTimeout(() => {
                row.remove();
                if (!document.querySelector('#scout-confirm-list [id^="scout-confirm-row-"]')) {
                  renderConfirmQueue();
                }
              }, 600);
            },
          );
        });

        row.querySelector('[data-action="skip"]')?.addEventListener('click', () => {
          safeSendMessage(
            { type: 'SKIP_LEAD_CHECK', campaignId, leadId: item.leadId },
            () => {
              row.remove();
              if (!document.querySelector('#scout-confirm-list [id^="scout-confirm-row-"]')) {
                renderConfirmQueue();
              }
            },
          );
        });

        list.appendChild(row);
      }
    });
  }

  function setStatus(text, isError) {
    const el = document.getElementById('scout-automation-status');
    if (!el) return;
    el.style.display = text ? 'block' : 'none';
    el.textContent = text;
    el.style.color = isError ? '#f87171' : '#6b7c93';
  }

  function persistAuraSession() {
    const campaignId = getCampaignIdFromUrl();
    const auth = getAuraAuth();
    if (!campaignId || !auth.token) return;
    try {
      chrome.storage.local.set({
        scoutAuraSession: {
          campaignId,
          aura: { authToken: auth.token, datahubBaseUrl: auth.datahubUrl },
          updatedAt: Date.now(),
          url: location.href,
        },
      });
    } catch {
      /* ignore */
    }
  }

  function stashPendingLinkedInLead(linkedinUrl, extra = {}) {
    const campaignId = getCampaignIdFromUrl();
    const auth = getAuraAuth();
    if (!campaignId || !auth.token || !linkedinUrl) return;
    try {
      chrome.storage.local.set({
        scoutPendingLinkedInLead: {
          linkedinUrl,
          campaignId,
          leadId: extra.leadId || null,
          leadName: extra.leadName || null,
          lead: extra.lead || null,
          aura: { authToken: auth.token, datahubBaseUrl: auth.datahubUrl },
          stashedAt: Date.now(),
        },
        scoutAuraSession: {
          campaignId,
          aura: { authToken: auth.token, datahubBaseUrl: auth.datahubUrl },
          updatedAt: Date.now(),
          url: location.href,
        },
      });
    } catch {
      /* ignore */
    }
  }

  function guessLeadContextNear(el) {
    const row =
      el.closest('tr') ||
      el.closest('[role="row"]') ||
      el.closest('[class*="lead"]') ||
      el.closest('li') ||
      el.closest('[data-lead-id]') ||
      el.parentElement;
    if (!row) return { leadId: null, leadName: null };

    let leadId = null;
    const idAttr =
      row.getAttribute?.('data-lead-id') ||
      row.getAttribute?.('data-id') ||
      row.querySelector?.('[data-lead-id]')?.getAttribute('data-lead-id');
    if (idAttr && /^\d+$/.test(idAttr)) leadId = Number(idAttr);

    if (!leadId) {
      const hrefs = [...(row.querySelectorAll?.('a[href]') || [])].map((a) => a.getAttribute('href') || '');
      for (const href of hrefs) {
        const m =
          href.match(/\/leads?\/(\d+)/i) ||
          href.match(/[?&]leadId=(\d+)/i) ||
          href.match(/[?&]id=(\d+)/i);
        if (m) {
          leadId = Number(m[1]);
          break;
        }
      }
    }

    const text = (row.innerText || '').split('\n').map((l) => l.trim()).filter(Boolean);
    const leadName =
      text.find(
        (l) =>
          l.length >= 3 &&
          l.length <= 80 &&
          !/linkedin|http|not eligible|ready|eligible|campaign|message/i.test(l),
      ) || null;

    return { leadId, leadName };
  }

  function installLinkedInClickCapture() {
    if (window.__scoutLiClickCapture) return;
    window.__scoutLiClickCapture = true;
    document.addEventListener(
      'click',
      (event) => {
        const a = event.target?.closest?.('a[href*="linkedin.com/in/"]');
        if (!a?.href) return;
        const ctx = guessLeadContextNear(a);
        stashPendingLinkedInLead(a.href, {
          leadId: ctx.leadId,
          leadName: ctx.leadName,
        });
      },
      true,
    );
  }

  // ── LinkedIn Enrichment ─────────────────────────────────────────────────────

  const SCOUT_API_BASE = 'http://localhost:3847/api';

  /** Scan the current Aura page for any LinkedIn /in/ URL. */
  function findLinkedInUrlOnPage() {
    // 1. Anchor tags
    for (const a of document.querySelectorAll('a[href*="linkedin.com/in/"]')) {
      const url = (a.href || '').split('?')[0].trim();
      if (/linkedin\.com\/in\/[a-z0-9_%.-]+/i.test(url)) return url;
    }
    // 2. Input / textarea values
    for (const el of document.querySelectorAll('input, textarea')) {
      const v = (el.value || '').trim();
      if (/linkedin\.com\/in\//i.test(v)) return v.split('?')[0];
    }
    // 3. data-linkedin-url attributes
    for (const el of document.querySelectorAll('[data-linkedin-url],[data-linkedin]')) {
      const v = el.getAttribute('data-linkedin-url') || el.getAttribute('data-linkedin') || '';
      if (v) return v;
    }
    // 4. Text content scan
    const m = (document.body?.innerText || '').match(
      /https?:\/\/(?:www\.)?linkedin\.com\/in\/([a-z0-9_%.-]+)/i,
    );
    if (m) return m[0].split('?')[0];
    return null;
  }

  /** Try to extract a numeric lead ID from the page URL or DOM. */
  function findLeadIdFromPage() {
    const pm =
      location.pathname.match(/\/leads?\/(\d+)/i) ||
      location.pathname.match(/\/people\/(\d+)/i) ||
      location.pathname.match(/\/contacts?\/(\d+)/i);
    if (pm) return Number(pm[1]);
    for (const k of ['leadId', 'lead_id', 'id', 'contactId']) {
      const v = new URLSearchParams(location.search).get(k);
      if (v && /^\d+$/.test(v)) return Number(v);
    }
    const el = document.querySelector('[data-lead-id]');
    if (el) {
      const v = el.getAttribute('data-lead-id');
      if (v && /^\d+$/.test(v)) return Number(v);
    }
    return null;
  }

  function showEnrichPanel(html) {
    const panel = document.getElementById('scout-enrich-panel');
    if (!panel) return;
    panel.style.display = 'block';
    if (html !== undefined) panel.innerHTML = html;
  }

  function hideEnrichPanel() {
    const panel = document.getElementById('scout-enrich-panel');
    if (panel) { panel.style.display = 'none'; panel.innerHTML = ''; }
  }

  /**
   * Main enrichment flow:
   * 1. Find LinkedIn URL on current Aura page
   * 2. Resolve the lead in the campaign (get leadId + current fields)
   * 3. Scrape LinkedIn via Apify / Voyager
   * 4. Apply all scraped fields + stage=READY to Aura
   */
  async function enrichAndReadyLead() {
    const campaignId = getCampaignIdFromUrl();
    const auth = getAuraAuth();

    if (!campaignId) {
      setStatus('Cannot detect campaign ID — navigate to a campaign page.', true);
      return;
    }
    if (!auth.token) {
      setStatus('Sign in to Aura first.', true);
      return;
    }

    const linkedinUrl = findLinkedInUrlOnPage();
    if (!linkedinUrl) {
      setStatus("No LinkedIn URL found. Open the lead's edit panel first.", true);
      showEnrichPanel(`
        <div style="color:#f87171;">
          ⚠ No LinkedIn URL visible on this page.<br>
          <span style="color:#6b7c93;font-size:10px;">Open the lead edit panel (so the LinkedIn field is visible) then click again.</span>
        </div>
      `);
      return;
    }

    const pageLeadId = findLeadIdFromPage();
    const btn = document.getElementById('scout-enrich-ready');

    // Lock button
    if (btn) { btn.disabled = true; btn.style.opacity = '0.5'; btn.textContent = '⟳ Working…'; }

    try {
      // ── Step 1: Resolve lead in campaign ───────────────────────────────────
      setStatus('Looking up lead in campaign…');
      showEnrichPanel('<div style="color:#6b7c93;">⟳ Resolving lead…</div>');

      let lead = { id: pageLeadId || 0, linkedin_url: linkedinUrl };
      try {
        const resolveParams = new URLSearchParams({ linkedinUrl });
        if (pageLeadId) resolveParams.set('leadId', String(pageLeadId));
        const resolveRes = await fetch(
          `${SCOUT_API_BASE}/leads/resolve/${campaignId}?${resolveParams}`,
          { headers: { 'x-aura-token': auth.token, 'x-datahub-url': auth.datahubUrl } },
        );
        if (resolveRes.ok) {
          const resolved = await resolveRes.json();
          if (resolved.lead) lead = resolved.lead;
        }
      } catch { /* use fallback lead */ }

      // ── Step 2: Scrape LinkedIn ─────────────────────────────────────────────
      const slug = linkedinUrl.replace(/.*\/in\//i, '').replace(/\/.*/, '');
      setStatus(`🔍 Scraping linkedin.com/in/${slug}…`);
      showEnrichPanel('<div style="color:#6b7c93;">🔍 Scraping LinkedIn profile via Apify…</div>');

      const scrapeRes = await fetch(`${SCOUT_API_BASE}/leads/scrape-linkedin`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ campaignId, lead }),
      });
      const scrapeData = await scrapeRes.json();

      if (!scrapeRes.ok) {
        throw new Error(scrapeData.error || `Scrape failed (HTTP ${scrapeRes.status})`);
      }
      if (!scrapeData.scraped?.personName) {
        throw new Error(
          scrapeData.scraped?.error ||
          'LinkedIn returned no data — profile may be private or URL is wrong.',
        );
      }

      const s = scrapeData.scraped;
      const edits = scrapeData.suggestedEdits || {};

      // ── Step 3: Apply fields + READY ───────────────────────────────────────
      setStatus(`💾 Saving ${s.personName} → READY…`);
      showEnrichPanel('<div style="color:#6b7c93;">💾 Updating Aura fields + setting stage to READY…</div>');

      const applyRes = await fetch(`${SCOUT_API_BASE}/leads/apply-linkedin-edits`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          campaignId,
          leadId: scrapeData.leadId || lead.id || pageLeadId || 0,
          edits: {
            ...edits,
            stage: 'READY',
            lead_icp_status: 'VALID',
          },
          aura: { datahubBaseUrl: auth.datahubUrl, authToken: auth.token },
        }),
      });
      const applyData = await applyRes.json();
      if (!applyRes.ok) {
        throw new Error(applyData.error || `Apply failed (HTTP ${applyRes.status})`);
      }

      // ── Step 4: Show success summary ────────────────────────────────────────
      const updatedCount = (applyData.updatedFields || Object.keys(edits)).length;
      setStatus(`✅ ${s.personName} — ${updatedCount} fields saved → READY`);

      const locParts = [edits.company_city, edits.company_state, edits.company_country].filter(Boolean);
      const summaryRows = [
        edits.first_name
          ? ['Name', `${edits.first_name} ${edits.last_name || ''}`.trim()]
          : null,
        edits.job_title ? ['Title', edits.job_title] : null,
        edits.company_name ? ['Company', edits.company_name] : null,
        edits.job_function ? ['Function', edits.job_function] : null,
        edits.job_level ? ['Level', edits.job_level] : null,
        locParts.length ? ['Location', locParts.join(', ')] : null,
      ].filter(Boolean);

      showEnrichPanel(`
        <div style="color:#4ade80;font-weight:600;margin-bottom:6px;">
          ✅ Enriched &amp; READY &middot; ${updatedCount} fields updated
        </div>
        <div style="display:grid;grid-template-columns:72px 1fr;gap:2px 8px;">
          ${summaryRows
            .map(
              ([k, v]) =>
                `<span style="color:#6b7c93;">${escapeHtml(k)}</span><span style="color:#e8ecf1;">${escapeHtml(v)}</span>`,
            )
            .join('')}
        </div>
        <div style="margin-top:6px;color:#a78bfa;font-size:10px;">
          scraped via ${escapeHtml(scrapeData.provider || 'apify')}
        </div>
        <button id="scout-enrich-close" style="margin-top:8px;background:transparent;border:none;color:#6b7c93;font-size:10px;cursor:pointer;padding:0;">× close</button>
      `);
      document.getElementById('scout-enrich-close')
        ?.addEventListener('click', hideEnrichPanel);

    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setStatus(msg, true);
      showEnrichPanel(`
        <div style="color:#f87171;">⚠ ${escapeHtml(msg)}</div>
        <div style="color:#6b7c93;font-size:10px;margin-top:4px;">
          Ensure Scout server is running: <code style="background:#111;padding:1px 4px;border-radius:3px;">npm run dev</code> in the server folder.
        </div>
      `);
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.style.opacity = '1';
        btn.innerHTML = '🔗 Enrich &amp; Ready';
      }
    }
  }

  // ── End LinkedIn Enrichment ──────────────────────────────────────────────────

  function init() {
    if (!isAuraHost()) return;

    removeScoutLinkedInIcons();
    persistAuraSession();
    installLinkedInClickCapture();
    injectOperatorBanner();
  }

  try {
    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      if (!isExtensionAlive()) return false;
      if (msg.type === 'GET_AURA_CONTEXT') {
        sendResponse({
          campaignId: getCampaignIdFromUrl(),
          isLeadOperator: isLeadOperator(),
          aura: getAuraAuth(),
          url: location.href,
        });
        return false;
      }
      if (msg.type === 'SCOUT_AUTOMATION_PROGRESS') {
        setStatus(msg.message || '');
        return false;
      }
      if (msg.type === 'SCOUT_AUTOMATION_STATE') {
        setRunningUi(Boolean(msg.running));
        if (!msg.running) {
          renderConfirmQueue();
        }
        return false;
      }
      if (msg.type === 'SCOUT_AUTOMATION_DONE') {
        setRunningUi(false);
        setStatus(`Done: ${msg.scored ?? msg.readyCount ?? 0} scored — Confirm below`);
        renderConfirmQueue();
        return false;
      }
      if (msg.type === 'SCOUT_CONFIRM_QUEUE_UPDATED') {
        renderConfirmQueue();
        return false;
      }
    });
  } catch {
    contextDead = true;
  }

  // Swallow unhandled extension-context errors from this page
  window.addEventListener('unhandledrejection', (event) => {
    const msg = String(event.reason?.message || event.reason || '');
    if (/extension context invalidated/i.test(msg)) {
      event.preventDefault();
      markContextDead();
    }
  });
  window.addEventListener('error', (event) => {
    const msg = String(event.message || event.error?.message || '');
    if (/extension context invalidated/i.test(msg)) {
      event.preventDefault();
      markContextDead();
    }
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // Aura is an SPA — keep campaign session + banner in sync
  let lastAuraPath = location.pathname;
  setInterval(() => {
    if (!isAuraHost()) return;
    if (location.pathname === lastAuraPath) {
      persistAuraSession();
      return;
    }
    lastAuraPath = location.pathname;
    init();
  }, 2000);
})();
