(function () {
  if (!location.hostname.includes('linkedin.com')) return;

  const EXT_ID = (() => {
    try {
      return chrome?.runtime?.id || '';
    } catch {
      return '';
    }
  })();

  if (window.__scoutLinkedInAssistExtId && window.__scoutLinkedInAssistExtId === EXT_ID && EXT_ID) {
    return;
  }
  window.__scoutLinkedInAssistExtId = EXT_ID;

  let lastTriggeredUrl = '';
  let inFlight = false;
  let lastPath = location.pathname;
  let currentPreview = null;

  function isAlive() {
    try {
      return Boolean(chrome?.runtime?.id);
    } catch {
      return false;
    }
  }

  function profileSlug() {
    const m = location.pathname.match(/\/in\/([^/]+)/i);
    return m ? m[1].toLowerCase().replace(/\/$/, '') : '';
  }

  function escapeHtml(s) {
    return String(s || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function removePanel() {
    document.getElementById('scout-li-verify')?.remove();
  }

  function showToast(message, kind) {
    removePanel();
    let el = document.getElementById('scout-li-toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'scout-li-toast';
      el.style.cssText =
        'position:fixed;top:72px;right:20px;z-index:2147483646;max-width:360px;padding:12px 14px;border-radius:12px;background:#0a0e14;border:1px solid #1d9bf055;color:#e8ecf1;font:12px/1.45 Segoe UI,system-ui,sans-serif;box-shadow:0 8px 28px rgba(0,0,0,0.4);';
      document.documentElement.appendChild(el);
    }
    const color =
      kind === 'error' ? '#f87171' : kind === 'success' ? '#4ade80' : kind === 'warn' ? '#fbbf24' : '#8b9cb3';
    el.innerHTML = `<strong style="color:#3b9eff;display:block;margin-bottom:4px;">Scout</strong><span style="color:${color}">${escapeHtml(message)}</span>`;
    el.style.display = 'block';
    setTimeout(() => {
      if (el) el.style.display = 'none';
    }, 8000);
  }

  function showVerifyPanel(preview) {
    removePanel();
    document.getElementById('scout-li-toast')?.remove();
    currentPreview = preview;

    const el = document.createElement('div');
    el.id = 'scout-li-verify';
    el.style.cssText =
      'position:fixed;top:72px;right:16px;z-index:2147483646;width:340px;padding:14px;border-radius:12px;background:#0a0e14;border:1px solid #1d9bf055;color:#e8ecf1;font:12px/1.45 Segoe UI,system-ui,sans-serif;box-shadow:0 8px 28px rgba(0,0,0,0.45);';

    const score = preview.fitScore != null ? `${preview.fitScore}/10` : '—';
    const scoreColor =
      typeof preview.fitScore === 'number' && preview.fitScore >= 8 ? '#4ade80' : '#fbbf24';
    const loc = preview.locationOverride
      ? [preview.locationOverride.company_city, preview.locationOverride.company_state, preview.locationOverride.company_country]
          .filter(Boolean)
          .join(', ')
      : '';

    el.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
        <strong style="color:#3b9eff;font-size:13px;">Scout — Confirm</strong>
        <span style="color:${scoreColor};font-weight:700;">${escapeHtml(score)}</span>
      </div>
      <div style="color:#e8ecf1;font-weight:600;margin-bottom:4px;">${escapeHtml(preview.leadName || 'Lead')}</div>
      <div style="color:#8b9cb3;margin-bottom:10px;font-size:11px;">${escapeHtml(preview.summary || 'Check title/company against this LinkedIn page')}</div>
      <label style="display:block;color:#6b7c93;font-size:10px;margin-bottom:2px;">Job title</label>
      <input id="scout-verify-title" value="${escapeHtml(preview.jobTitle || '')}" style="width:100%;box-sizing:border-box;margin-bottom:8px;padding:7px 8px;border-radius:8px;border:1px solid #243044;background:#141c28;color:#e8ecf1;font-size:12px;" />
      <label style="display:block;color:#6b7c93;font-size:10px;margin-bottom:2px;">Company</label>
      <input id="scout-verify-company" value="${escapeHtml(preview.company || '')}" style="width:100%;box-sizing:border-box;margin-bottom:10px;padding:7px 8px;border-radius:8px;border:1px solid #243044;background:#141c28;color:#e8ecf1;font-size:12px;" />
      ${loc ? `<div style="color:#8b9cb3;font-size:11px;margin-bottom:10px;">Location override → ${escapeHtml(loc)}</div>` : ''}
      <div style="display:flex;gap:8px;flex-wrap:wrap;">
        <button id="scout-verify-confirm" style="flex:1;background:#1d9bf0;color:#fff;border:none;padding:8px 12px;border-radius:8px;font-size:12px;font-weight:600;cursor:pointer;">Confirm</button>
        <button id="scout-verify-skip" style="background:#141c28;color:#8b9cb3;border:1px solid #243044;padding:8px 12px;border-radius:8px;font-size:12px;cursor:pointer;">Skip</button>
      </div>
      <div style="color:#6b7c93;font-size:10px;margin-top:8px;">C = Confirm · S = Skip · once checked, won’t ask again</div>
      <div id="scout-verify-status" style="color:#6b7c93;font-size:11px;margin-top:6px;min-height:14px;"></div>
    `;

    document.documentElement.appendChild(el);

    const setStatus = (text, isError) => {
      const s = document.getElementById('scout-verify-status');
      if (!s) return;
      s.textContent = text;
      s.style.color = isError ? '#f87171' : '#6b7c93';
    };

    document.getElementById('scout-verify-confirm')?.addEventListener('click', () => {
      const title = document.getElementById('scout-verify-title')?.value?.trim() || '';
      const company = document.getElementById('scout-verify-company')?.value?.trim() || '';
      setStatus('Saving Ready → Queued…');
      chrome.runtime.sendMessage(
        {
          type: 'VERIFY_AND_READY_LEAD',
          campaignId: preview.campaignId,
          lead: preview.lead,
          aura: preview.aura,
          confirmedJobTitle: title,
          confirmedCompany: company,
        },
        (res) => {
          const err = chrome.runtime.lastError?.message || '';
          if (/invalidated|context/i.test(err)) {
            showToast('Scout was reloaded — refresh this page.', 'error');
            return;
          }
          if (!res || res.error) {
            setStatus(res?.error || err || 'Confirm failed', true);
            return;
          }
          if (res.alreadyChecked || res.skipped) {
            showToast(res.reason || 'Already checked', 'warn');
            return;
          }
          const stage = res.stageAfter || 'saved';
          showToast(
            `${res.leadName || preview.leadName} · ${res.fitScore ?? '?'}/10 → ${stage}`,
            stage === 'QUEUED' || stage === 'READY' ? 'success' : 'warn',
          );
          currentPreview = null;
        },
      );
    });

    document.getElementById('scout-verify-skip')?.addEventListener('click', () => {
      chrome.runtime.sendMessage(
        {
          type: 'SKIP_LEAD_CHECK',
          campaignId: preview.campaignId,
          leadId: preview.leadId || preview.lead?.id,
        },
        () => {
          void chrome.runtime.lastError;
          showToast(`${preview.leadName || 'Lead'} skipped — won’t ask again`, 'warn');
          currentPreview = null;
        },
      );
    });
  }

  function onHotkey(e) {
    if (!currentPreview || !document.getElementById('scout-li-verify')) return;
    const tag = (e.target && e.target.tagName) || '';
    if (tag === 'INPUT' || tag === 'TEXTAREA' || e.target?.isContentEditable) return;
    if (e.key === 'c' || e.key === 'C') {
      e.preventDefault();
      document.getElementById('scout-verify-confirm')?.click();
    } else if (e.key === 's' || e.key === 'S') {
      e.preventDefault();
      document.getElementById('scout-verify-skip')?.click();
    }
  }

  async function triggerPreview() {
    if (!isAlive() || inFlight) return;
    const slug = profileSlug();
    if (!slug) return;

    const urlKey = `https://www.linkedin.com/in/${slug}`;
    if (urlKey === lastTriggeredUrl) return;

    inFlight = true;
    lastTriggeredUrl = urlKey;

    try {
      chrome.runtime.sendMessage({ type: 'PREVIEW_LEAD_SCORE', profileUrl: location.href }, (res) => {
        inFlight = false;
        const err = chrome.runtime.lastError?.message || '';
        if (/invalidated|context/i.test(err)) {
          showToast('Scout was reloaded — refresh this page.', 'error');
          return;
        }
        if (!res || res.error) {
          showToast(res?.error || err || 'Could not load lead', 'error');
          lastTriggeredUrl = '';
          return;
        }
        if (res.skipped || res.alreadyChecked) {
          // Silent for already-checked; soft toast for other skips
          if (!res.alreadyChecked) {
            showToast(res.reason || 'Skipped', 'warn');
          }
          if (/campaign|Run automation|matched/i.test(res.reason || '')) {
            lastTriggeredUrl = '';
          }
          return;
        }
        if (res.found) {
          showVerifyPanel(res);
        }
      });
    } catch {
      inFlight = false;
      showToast('Scout extension error — reload Scout and refresh.', 'error');
    }
  }

  function onMaybeNavigated() {
    if (location.pathname === lastPath) return;
    lastPath = location.pathname;
    currentPreview = null;
    removePanel();
    if (profileSlug()) {
      lastTriggeredUrl = '';
      void triggerPreview();
    }
  }

  // ─── MutationObserver: reads DOM exactly when LinkedIn finishes rendering ────
  // This is the correct fix for the lazy-render race condition.
  // Instead of guessing a timeout, we watch the DOM and fire the moment
  // h1 (name) + headline + experience are all present.

  const tx = (el) => (el ? (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim() : '');

  function isProfileReady() {
    if (!location.pathname.toLowerCase().includes('/in/')) return false;
    const h1 = document.querySelector('h1.text-heading-xlarge, main h1, h1');
    const name = tx(h1);
    if (!name || name.length < 2 || /^(join linkedin|sign in)/i.test(name)) return false;
    // Need at least one of: headline, JSON-LD jobTitle, or experience section
    const hasHeadline = !!document.querySelector(
      '.pv-text-details__left-panel .text-body-medium.break-words, ' +
      '.ph5 .text-body-medium.break-words, ' +
      '[data-anonymize="headline"], ' +
      '.text-body-medium.break-words, ' +
      '.pv-text-details__right-panel, ' +
      '.mt2.relative'
    );
    const hasExp = !!document.querySelector('#experience, [data-section="experience"], section[data-view-name="profile-v1"]');
    const hasJsonLd = [...document.querySelectorAll('script[type="application/ld+json"]')]
      .some((s) => { try { return JSON.parse(s.textContent || '').jobTitle; } catch { return false; } });
    return hasHeadline || hasExp || hasJsonLd;
  }

  function extractProfileFields() {
    const h1 = document.querySelector('h1.text-heading-xlarge, main h1, h1');
    const personName = tx(h1);

    // Headline - more robust selectors
    let headline = '';
    const hSels = [
      '.pv-text-details__left-panel .text-body-medium.break-words',
      '.ph5 .text-body-medium.break-words',
      '.mt2 .text-body-medium.break-words',
      '[data-anonymize="headline"]',
      '.text-body-medium.break-words',
      '.pv-text-details__right-panel',
      '.mt2.relative',
      '.text-body-medium',
      'div[data-anonymize="person-pill"]',
    ];
    for (const sel of hSels) {
      for (const el of document.querySelectorAll(sel)) {
        if (el.closest('#activity,#experience,#education,footer,nav')) continue;
        const rect = el.getBoundingClientRect();
        if (rect.top + window.scrollY > 1000) continue;
        const t = tx(el);
        if (t && t !== personName && t.length > 3 && t.length < 220) { headline = t; break; }
      }
      if (headline) break;
    }

    // JSON-LD
    let jsonTitle = '', jsonCompany = '';
    for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
      try {
        const j = JSON.parse(s.textContent || '');
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
      } catch { /* ignore */ }
    }

    // og:description fallback for headline
    if (!headline && !jsonTitle) {
      const ogDesc = (document.querySelector('meta[property="og:description"]')?.content || '').trim();
      const ogT = (document.querySelector('meta[property="og:title"]')?.content || '').trim();
      const fromTitle = ogT.replace(/\s*\|\s*LinkedIn\s*$/i, '').replace(personName, '').trim();
      const cand = ogDesc.split(/[|·•]/)[0]?.trim() || fromTitle;
      if (cand && cand !== personName && cand.length > 3 && cand.length < 220 &&
          !/^(sign in|join|feed|home)/i.test(cand)) headline = cand;
    }

    // Experience top lines
    let expLines = [];
    const expSec = document.querySelector('#experience')?.closest('section') ||
                   document.querySelector('#experience')?.parentElement;
    if (expSec) {
      expLines = [...expSec.querySelectorAll('span[aria-hidden="true"]')]
        .map(tx).filter((x) => x && x.length > 2 && x.length < 160).slice(0, 8);
    }

    // Location
    const locEl =
      document.querySelector('.text-body-small.inline.t-black--light.break-words') ||
      document.querySelector('.text-body-small.inline.t-black--light') ||
      [...document.querySelectorAll('.text-body-small')].find((el) => {
        const t = tx(el);
        return t.includes(',') && t.length < 80 && !/(followers|connections|contact|ago)/i.test(t);
      });
    const location = tx(locEl);

    // Extract comprehensive profile data for enrichment
    const profileData = {
      personName,
      headline,
      jsonTitle,
      jsonCompany,
      location,
      expLines,
      // Additional fields for API enrichment
      profileUrl: window.location.href,
      currentCompany: jsonCompany || '',
      currentTitle: jsonTitle || headline || '',
      // Contact info (if visible in DOM)
      email: extractContactInfo('email'),
      phone: extractContactInfo('phone'),
      // Work history
      workHistory: extractWorkHistory(),
      // Education
      education: extractEducation(),
      // Skills
      skills: extractSkills(),
      // Profile summary/about
      about: extractAboutSection(),
      // Connections count
      connections: extractConnectionsCount(),
    };

    return profileData;
  }

  function extractContactInfo(type) {
    // LinkedIn rarely shows email/phone in DOM, but we check contact info section
    const contactSection = document.querySelector('[data-anonymize="contact-info"]') ||
                          document.querySelector('.pv-contact-info');
    if (!contactSection) return '';

    if (type === 'email') {
      const emailEl = contactSection.querySelector('a[href^="mailto:"]') ||
                     [...contactSection.querySelectorAll('*')].find(el => 
                       el.textContent && /[\w.-]+@[\w.-]+\.\w+/.test(el.textContent)
                     );
      return emailEl ? tx(emailEl).match(/[\w.-]+@[\w.-]+\.\w+/)?.[0] || '' : '';
    }

    if (type === 'phone') {
      const phoneEl = contactSection.querySelector('a[href^="tel:"]') ||
                     [...contactSection.querySelectorAll('*')].find(el => 
                       el.textContent && /[\d\s\-\(\)\+]{10,}/.test(el.textContent) &&
                       !/linkedin/i.test(el.textContent)
                     );
      return phoneEl ? tx(phoneEl).match(/[\d\s\-\(\)\+]{10,}/)?.[0] || '' : '';
    }

    return '';
  }

  function extractWorkHistory() {
    const experiences = [];
    const expSection = document.querySelector('#experience')?.closest('section');
    if (!expSection) return experiences;

    const expItems = expSection.querySelectorAll('[data-anonymize="job-title"], .pvs-list__item');
    expItems.forEach(item => {
      const title = item.querySelector('[data-anonymize="job-title"]') ||
                   item.querySelector('.t-bold');
      const company = item.querySelector('[data-anonymize="company-name"]') ||
                      item.querySelector('.t-normal');
      const duration = item.querySelector('[data-anonymize="duration"]') ||
                      item.querySelector('.t-black--light');
      
      if (title || company) {
        experiences.push({
          title: tx(title) || '',
          company: tx(company) || '',
          duration: tx(duration) || '',
        });
      }
    });

    return experiences.slice(0, 5); // Limit to most recent 5
  }

  function extractEducation() {
    const education = [];
    const eduSection = document.querySelector('#education')?.closest('section');
    if (!eduSection) return education;

    const eduItems = eduSection.querySelectorAll('[data-anonymize="school-name"], .pvs-list__item');
    eduItems.forEach(item => {
      const school = item.querySelector('[data-anonymize="school-name"]') ||
                    item.querySelector('.t-bold');
      const degree = item.querySelector('[data-anonymize="degree"]') ||
                    item.querySelector('.t-normal');
      const field = item.querySelector('[data-anonymize="field-of-study"]');
      
      if (school) {
        education.push({
          school: tx(school) || '',
          degree: tx(degree) || '',
          field: tx(field) || '',
        });
      }
    });

    return education.slice(0, 3); // Limit to most recent 3
  }

  function extractSkills() {
    const skills = [];
    const skillsSection = document.querySelector('#skills')?.closest('section');
    if (!skillsSection) return skills;

    const skillItems = skillsSection.querySelectorAll('[data-anonymize="skill-name"], .pvs-list__item');
    skillItems.forEach(item => {
      const skill = item.querySelector('[data-anonymize="skill-name"]') ||
                   item.querySelector('.t-bold');
      if (skill) {
        const skillText = tx(skill);
        if (skillText && skillText.length > 2) {
          skills.push(skillText);
        }
      }
    });

    return skills.slice(0, 10); // Limit to top 10 skills
  }

  function extractAboutSection() {
    const aboutSection = document.querySelector('#about')?.closest('section');
    if (!aboutSection) return '';

    const aboutText = aboutSection.querySelector('[data-anonymize="summary"]') ||
                     aboutSection.querySelector('.pv-about__summary-text') ||
                     aboutSection.querySelector('.pv-shared-text-with-see-more');
    
    return tx(aboutText) || '';
  }

  function extractConnectionsCount() {
    const connEl = document.querySelector('[data-anonymize="connection-count"]') ||
                  document.querySelector('.t-black--light') ||
                  [...document.querySelectorAll('*')].find(el => 
                    el.textContent && /(\d+,?\d*)\s*connections?/i.test(el.textContent)
                  );
    
    if (connEl) {
      const match = tx(connEl).match(/(\d+,?\d*)\s*connections?/i);
      return match ? match[1] : '';
    }
    return '';
  }

  let observerArmed = false;
  let profileReadySent = new Set(); // track slugs already sent to avoid duplicate messages

  function armMutationObserver() {
    if (observerArmed) return;
    observerArmed = true;

    // If page is already ready when the script loads, read immediately
    if (isProfileReady()) {
      sendProfileReady();
      return;
    }

    const observer = new MutationObserver(() => {
      if (!isProfileReady()) return;
      observer.disconnect();
      observerArmed = false;
      sendProfileReady();
    });
    observer.observe(document.body, { childList: true, subtree: true });

    // Safety net: if MutationObserver never fires (e.g. profile blocked), give up after 20s
    setTimeout(() => {
      observer.disconnect();
      observerArmed = false;
    }, 20000);
  }

  function sendProfileReady() {
    if (!isAlive()) return;
    const slug = profileSlug();
    if (!slug) return;
    if (profileReadySent.has(slug)) return;
    profileReadySent.add(slug);

    const fields = extractProfileFields();
    if (!fields.personName && !fields.headline && !fields.jsonTitle && !fields.expLines.length) return;

    try {
      chrome.runtime.sendMessage({
        type: 'LINKEDIN_PROFILE_READY',
        fields,
        url: location.href,
        slug,
      }, () => { void chrome.runtime.lastError; }); // swallow "no receiver" error if bg is idle
    } catch { /* extension context may be invalidated */ }
  }

  // Re-arm on SPA navigation (LinkedIn navigates without full page reload)
  const _origOnMaybeNavigated = onMaybeNavigated;
  function onMaybeNavigatedWithObserver() {
    _origOnMaybeNavigated();
    if (profileSlug()) {
      observerArmed = false; // allow re-arming for the new profile
      armMutationObserver();
    }
  }

  document.addEventListener('keydown', onHotkey);

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      setTimeout(() => void triggerPreview(), 600);
      armMutationObserver();
    });
  } else {
    setTimeout(() => void triggerPreview(), 600);
    armMutationObserver();
  }

  setInterval(onMaybeNavigatedWithObserver, 800);
  window.addEventListener('popstate', () => {
    lastPath = '';
    onMaybeNavigatedWithObserver();
  });
})();
