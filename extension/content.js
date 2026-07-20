(function () {
  const SCOUT_CONTENT_VERSION = '1.5.10';
  // Allow reinjection after extension reload (old guard blocked updates on open tabs)
  if (window.__scoutContentVersion === SCOUT_CONTENT_VERSION) return;
  window.__scoutContentVersion = SCOUT_CONTENT_VERSION;
  window.__scoutContentLoaded = true;

  function detectSourceType(url, hostname) {
    if (hostname.includes('linkedin.com')) return 'linkedin';
    if (hostname.includes('crunchbase.com')) return 'crunchbase';
    if (hostname.includes('techcrunch.com') || hostname.includes('bloomberg.com')) return 'news';
    return 'website';
  }

  function textOf(el) {
    return el?.textContent?.replace(/\s+/g, ' ').trim() || '';
  }

  async function scrollToLoad() {
    const steps = 6;
    for (let i = 0; i < steps; i++) {
      window.scrollBy(0, window.innerHeight * 0.85);
      await new Promise((r) => setTimeout(r, 350));
    }
    window.scrollTo(0, 0);
    await new Promise((r) => setTimeout(r, 200));
  }

  function findSectionByHeading(names) {
    const roots = [
      document.querySelector('main'),
      document.querySelector('[data-member-id]'),
      document.querySelector('.scaffold-layout__main'),
      document.querySelector('#profile-content'),
    ].filter(Boolean);

    const searchRoots = roots.length ? roots : [document.body];

    for (const root of searchRoots) {
      const candidates = root.querySelectorAll(
        'section, .artdeco-card, [data-view-name*="profile"], div.pvs-list__container',
      );

      for (const el of candidates) {
        if (el.closest('footer, nav.global-nav, [role="contentinfo"], .global-footer')) continue;
        const preview = textOf(el).slice(0, 300).toLowerCase();
        if (
          names.some(
            (n) =>
              preview.startsWith(n.toLowerCase()) || preview.includes(`\n${n.toLowerCase()}`),
          )
        ) {
          return textOf(el).slice(0, 5000);
        }
      }

      for (const name of names) {
        const heading = [...root.querySelectorAll('h2, h3, span.t-bold, .pvs-header__title')].find(
          (h) => textOf(h).toLowerCase() === name.toLowerCase(),
        );
        if (heading) {
          if (heading.closest('footer, nav.global-nav, [role="contentinfo"], .global-footer')) continue;
          const container =
            heading.closest('section') ||
            heading.closest('.artdeco-card') ||
            heading.closest('[data-view-name]') ||
            heading.parentElement?.parentElement?.parentElement;
          if (container && !container.closest('footer, nav.global-nav, [role="contentinfo"]')) {
            return textOf(container).slice(0, 5000);
          }
        }
      }
    }

    return '';
  }

  function isLinkedInAuthOrBlocked() {
    const path = location.pathname.toLowerCase();
    if (path.includes('/authwall') || path.includes('/checkpoint') || path.includes('/login')) {
      return true;
    }

    const loginForm = document.querySelector(
      'form.login__form, #username, input[name="session_key"], button[data-litms-control-urn="login-submit"]',
    );
    if (loginForm && path.includes('/in/')) return true;

    const h1 = textOf(document.querySelector('h1')).toLowerCase();
    if (path.includes('/in/') && /^(join linkedin|sign in|agree & join)/.test(h1)) {
      return true;
    }

    return false;
  }

  function getProfileName() {
    const title = String(document.title || '').trim();
    const titleMatch = title.match(/^(.+?)\s*\|\s*(LinkedIn|Professional|Profile)/i);
    if (titleMatch?.[1]) {
      const n = titleMatch[1].trim();
      if (n.length >= 2 && n.length <= 120 && !/^(sign in|join|feed|home)/i.test(n)) return n;
    }

    const candidates = [
      document.querySelector('h1.text-heading-xlarge'),
      document.querySelector('main h1'),
      document.querySelector('.pv-text-details__left-panel h1'),
      document.querySelector('[data-view-name="profile-top-card-verified-badge"] h1'),
      document.querySelector('[data-anonymize="person-name"]'),
      document.querySelector('.artdeco-entity-lockup__title'),
      document.querySelector('section.artdeco-card h1'),
      document.querySelector('h1'),
    ];
    for (const el of candidates) {
      const name = textOf(el);
      if (!name || name.length < 2 || name.length > 120) continue;
      if (/^(sign in|join linkedin|agree & join|linkedin)/i.test(name)) continue;
      return name;
    }
    return '';
  }

  function isActivityOrFeedBlob(t) {
    const s = String(t || '');
    if (!s) return false;
    if (/activity\d|^\s*activity\b/i.test(s)) return true;
    if (/\b(followers?|reposted this|suggested for you|view my profile|people also viewed)\b/i.test(s)) {
      return true;
    }
    if (/\bfollow(ers?)?\b/i.test(s) && /\b(posts?|comments?|images)\b/i.test(s)) return true;
    if (/reposted this/i.test(s)) return true;
    if (/\b\d(st|nd|rd|th)\+/i.test(s)) return true;
    if (/\d+\s*(mo|mos|w|wk|d|h|yr)\b/i.test(s) || /\d(mo|w|d|h)\b/i.test(s)) return true;
    if (/using the power of|transform business/i.test(s)) return true;
    if (/\d(st|nd|rd|th)\+[A-Za-z]/i.test(s)) return true;
    return false;
  }

  function isLikelyJobHeadline(t) {
    const s = String(t || '').replace(/\s+/g, ' ').trim();
    if (!s || s.length < 3 || s.length > 140) return false;
    if (isActivityOrFeedBlob(s) || isEducationText(s)) return false;
    if (/^(message|connect|follow|pending|contact info|about|experience|activity)$/i.test(s)) return false;
    if (/^\d[\d,+]*\s*\+?\s*(followers?|connections?)$/i.test(s)) return false;
    if (/^[A-Za-zÀ-ÿ .'-]+,\s*[A-Za-zÀ-ÿ .'-]+/.test(s) && !/[|@]/.test(s) && !/\b(head|director|manager|executive|sales|account|engineer|communications|marketing)\b/i.test(s)) {
      return false;
    }
    if (/[|@]/.test(s)) return true;
    return /\b(director|manager|engineer|founder|head|lead|vp|chief|officer|executive|account|sales|product|marketing|analyst|consultant|specialist|president|services|communications|communication)\b/i.test(
      s,
    );
  }

  function getHeadlineDirectlyUnderName() {
    const h1 =
      document.querySelector('main h1.text-heading-xlarge') ||
      document.querySelector('.pv-text-details__left-panel h1') ||
      document.querySelector('main h1') ||
      document.querySelector('h1');
    if (!h1) return '';
    const name = textOf(h1);

    // A) Classic LinkedIn headline class near top of page (most reliable)
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
      // Must be in upper profile area
      if (rect.top + window.scrollY > 1100) continue;
      const t = textOf(el);
      if (t && t !== name && isLikelyJobHeadline(t)) return t;
    }

    // B) Top-card innerText lines after name
    const card =
      h1.closest('.pv-top-card') ||
      h1.closest('.ph5') ||
      h1.closest('section.artdeco-card') ||
      h1.closest('section') ||
      h1.parentElement?.parentElement;
    if (card) {
      const lines = String(card.innerText || '')
        .split('\n')
        .map((l) => l.replace(/\s+/g, ' ').trim())
        .filter(Boolean);
      const nameIdx = lines.findIndex((l) => l === name || l.startsWith(name));
      const start = nameIdx >= 0 ? nameIdx + 1 : 0;
      for (let i = start; i < Math.min(lines.length, start + 10); i++) {
        if (isLikelyJobHeadline(lines[i])) return lines[i];
      }
    }

    // C) Sibling walk
    let sib = h1.nextElementSibling;
    for (let i = 0; i < 8 && sib; i++, sib = sib.nextElementSibling) {
      const t = textOf(sib);
      if (isLikelyJobHeadline(t)) return t;
      for (const el of sib.querySelectorAll('.text-body-medium, span[aria-hidden="true"]')) {
        const inner = textOf(el);
        if (isLikelyJobHeadline(inner)) return inner;
      }
    }

    return '';
  }

  function getProfileHeadline() {
    const direct = getHeadlineDirectlyUnderName();
    if (direct) return direct;

    const isJunk = (t) =>
      !t ||
      isActivityOrFeedBlob(t) ||
      /sign in|join linkedin|privacy|help center|linkedin corporation|cookie|accessibility|skip to|people also viewed|contact info/i.test(
        t,
      ) ||
      /^(message|connect|follow|pending|accept|activity|posts|comments)$/i.test(t) ||
      /^\d[\d,+]*\s*\+?\s*(followers?|connections?)$/i.test(t);

    const scoreHeadline = (t) => {
      if (!t || isJunk(t) || t.length < 3 || t.length > 220) return -1;
      if (/^about\b/i.test(t) || /\bmy expertise\b/i.test(t)) return -1;
      if (/\b(university|institute|college|school|iit\b|iim\b|bachelor|master|mba|ph\.?d|urbana-?champaign)\b/i.test(t)) {
        return -1;
      }
      if (isActivityOrFeedBlob(t)) return -1;
      if (t.length > 120 && (t.match(/\./g) || []).length >= 1) return -1;
      let score = 100 - Math.min(60, Math.abs(t.length - 45));
      if (
        /\b(at|@|director|manager|engineer|founder|head|lead|vp|chief|officer|product|marketing|sales|designer|analyst|executive|account executive|pci)\b/i.test(
          t,
        )
      ) {
        score += 50;
      }
      if (/[|@]/.test(t) && t.length < 100) score += 30;
      if (/followers?|connections?|message|connect|follow|reposted|activity/i.test(t)) score -= 100;
      if ((t.match(/\s/g) || []).length >= 1) score += 10;
      if (t.length <= 90) score += 25;
      return score;
    };

    const candidates = [];
    const h1 = document.querySelector('main h1, h1.text-heading-xlarge, .pv-text-details__left-panel h1, h1');
    const topCard =
      h1?.closest('section') ||
      h1?.closest('.artdeco-card') ||
      h1?.closest('[data-view-name*="profile"]') ||
      h1?.closest('.pv-top-card') ||
      h1?.parentElement?.parentElement?.parentElement;

    const scope = topCard || document.querySelector('.pv-top-card') || null;
    const scopedSelectors = [
      '.text-body-medium.break-words',
      '.text-body-medium',
      '[data-generated-suggestion-target]',
      '[data-anonymize="headline"]',
      '.top-card-layout__headline',
      '.profile-topcard-person-entity__headline',
      '.artdeco-entity-lockup__subtitle',
      'div.mt2 .text-body-medium',
      '.ph5 .text-body-medium',
    ];

    if (scope) {
      for (const sel of scopedSelectors) {
        for (const el of scope.querySelectorAll(sel)) {
          if (el.closest('#experience, #activity, #about, #education, footer, nav')) continue;
          const t = textOf(el);
          const s = scoreHeadline(t);
          if (s > 0) candidates.push({ t, s: s + 40, src: `top:${sel}` });
        }
      }
    }

    for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
      try {
        const data = JSON.parse(script.textContent || '');
        const stack = Array.isArray(data) ? [...data] : [data];
        while (stack.length) {
          const node = stack.pop();
          if (!node || typeof node !== 'object') continue;
          if (Array.isArray(node['@graph'])) stack.push(...node['@graph']);
          if (node.mainEntity) stack.push(node.mainEntity);
          if (node.jobTitle) {
            const company = node.worksFor?.name || (typeof node.worksFor === 'string' ? node.worksFor : '');
            const t = company ? `${node.jobTitle} at ${company}` : String(node.jobTitle);
            const s = scoreHeadline(t) + 50;
            if (s > 0) candidates.push({ t, s, src: 'json-ld' });
          }
        }
      } catch {
        /* ignore */
      }
    }

    const ogDesc =
      document.querySelector('meta[property="og:description"]')?.content?.trim() ||
      document.querySelector('meta[name="description"]')?.content?.trim() ||
      '';
    if (ogDesc && !isActivityOrFeedBlob(ogDesc)) {
      const cleaned = ogDesc.replace(/\s*View\s+.+$/i, '').split(/[·•]/)[0]?.trim();
      const s = scoreHeadline(cleaned);
      if (s > 0) candidates.push({ t: cleaned, s: s + 25, src: 'og' });
    }

    candidates.sort((a, b) => b.s - a.s);
    return candidates[0]?.t || '';
  }

  function isLinkedInProfileReady() {
    if (isLinkedInAuthOrBlocked()) return false;
    // Name alone is enough — LinkedIn UI changes often break headline selectors
    return Boolean(getProfileName());
  }

  function expandTruncatedContent() {
    document
      .querySelectorAll(
        'button.feed-shared-inline-show-more-text, .feed-shared-inline-show-more-text__see-more-less-toggle, button[aria-label*="see more" i]'
      )
      .forEach((btn) => {
        try {
          btn.click();
        } catch {
          /* ignore */
        }
      });
  }

  function scrollToActivity() {
    const targets = [
      document.querySelector('#content_collections'),
      document.querySelector('[componentkey*="Activity"]'),
      ...document.querySelectorAll('h2, .pvs-header__title'),
    ].find((el) => /activity/i.test(textOf(el)));

    const section =
      targets?.closest?.('section') ||
      targets?.parentElement?.parentElement ||
      document.querySelector('.scaffold-finite-scroll__content');

    if (section) section.scrollIntoView({ behavior: 'instant', block: 'start' });
  }

  function extractAllPostBodies() {
    expandTruncatedContent();

    const posts = [];
    const seen = new Set();

    const selectors = [
      '.feed-shared-update-v2__description',
      '.update-components-text',
      '.feed-shared-inline-show-more-text',
      '.update-components-update-v2__commentary',
      '[data-ad-preview="message"]',
    ];

    for (const sel of selectors) {
      for (const el of document.querySelectorAll(sel)) {
        const body = textOf(el);
        if (body.length < 40 || seen.has(body)) continue;
        if (/^(Like|Comment|Repost|Send|\d+ (comments?|reposts?))$/i.test(body)) continue;

        seen.add(body);
        const root = el.closest('.feed-shared-update-v2, [data-urn*="activity"], article');
        const author =
          textOf(root?.querySelector('.update-components-actor__title span')) ||
          textOf(root?.querySelector('.update-components-actor__name')) ||
          textOf(root?.querySelector('a[href*="/in/"] span[aria-hidden="true"]')) ||
          'Unknown';

        posts.push({
          author,
          body: body.slice(0, 6000),
          isHiring: /hiring|intern|internship|recruiting|open role|join (our|my) team|we.re hiring|looking for/i.test(body),
        });
      }
    }

    // Profile activity section — often contains full posts even when feed selectors miss
    const activity = findSectionByHeading(['Activity', 'Recent activity']);
    if (activity && activity.length > 80) {
      const chunks = activity
        .split(/(?=\d+[hdw]\s*(?:•|·)|\d+\s+(?:comments?|reposts?|likes?))/i)
        .map((c) => c.trim())
        .filter((c) => c.length > 60);

      for (const chunk of chunks) {
        if (seen.has(chunk)) continue;
        seen.add(chunk);
        posts.push({
          author: 'Activity section',
          body: chunk.slice(0, 6000),
          isHiring: /hiring|intern|internship|recruiting|open role|join (our|my) team|we.re hiring|looking for/i.test(chunk),
        });
      }

      if (/hiring|intern/i.test(activity) && !chunks.length) {
        posts.push({
          author: 'Activity section',
          body: activity.slice(0, 6000),
          isHiring: true,
        });
      }
    }

    return posts;
  }

  function extractVisiblePosts() {
    return extractAllPostBodies();
  }

  function formatPostsBlock(posts, label = 'VISIBLE POSTS') {
    if (!posts.length) return '';
    return `${label}:\n${posts.map((p) => `[${p.author}]\n${p.body}`).join('\n\n---\n\n')}`;
  }

  function mergePostsIntoResult(result, { allowDescriptionFromPosts = false, includePostsInRaw = true } = {}) {
    if (!includePostsInRaw) {
      return result;
    }
    const posts = extractVisiblePosts();
    const hiringPosts = posts.filter((p) => p.isHiring);
    const structuredParts = [];

    if (hiringPosts.length) {
      structuredParts.push(formatPostsBlock(hiringPosts, 'HIRING POSTS (read these first)'));
    }
    if (posts.length) {
      structuredParts.push(formatPostsBlock(posts));
    }

    const existingRaw = result.rawText || '';
    const rawText = [existingRaw, ...structuredParts].filter(Boolean).join('\n\n').slice(0, 20000);

    const primary = posts[0] || hiringPosts[0];
    const postDesc = primary?.body?.slice(0, 300) || '';
    const usePostDesc =
      allowDescriptionFromPosts &&
      !result.description &&
      postDesc &&
      !isActivityOrFeedBlob(postDesc);

    return {
      ...result,
      personName: result.personName || undefined,
      description: result.description || (usePostDesc ? postDesc : ''),
      rawText,
      metadata: {
        ...result.metadata,
        posts,
        hiringPosts,
      },
    };
  }

  function findHiringSignals() {
    const fromPosts = extractVisiblePosts()
      .filter((p) => p.isHiring)
      .map((p) => p.body);
    if (fromPosts.length) return fromPosts;

    const signals = [];
    const patterns = [
      /hiring/i,
      /#\s*hiring/i,
      /open role/i,
      /we're hiring/i,
      /we are hiring/i,
      /looking for.{0,40}(intern|engineer|developer|designer|manager)/i,
      /internship/i,
      /join (our|my) team/i,
      /open to work/i,
      /recruiting/i,
    ];

    const blocks = document.querySelectorAll(
      'main article, .feed-shared-update-v2, [data-urn*="activity"], .update-components-text'
    );

    for (const block of blocks) {
      const t = textOf(block);
      if (t.length < 20 || t.length > 3000) continue;
      for (const p of patterns) {
        if (p.test(t) && !signals.includes(t)) {
          signals.push(t.slice(0, 800));
          break;
        }
      }
    }

    const badges = [...document.querySelectorAll('span, div, a')].filter((el) => {
      const t = textOf(el);
      return t.length < 80 && /hiring|open to work|#hiring/i.test(t);
    });
    for (const b of badges) {
      const t = textOf(b);
      // Skip badge-only signals — they mislead the AI without real post content
      if (t.length < 30 && /^#?hiring$/i.test(t.trim())) continue;
      if (!signals.includes(t)) signals.push(t);
    }

    return signals.slice(0, 10);
  }

  function isEducationText(t) {
    return /\b(university|universit[aá]|institute of technology|institute|college|school of|high school|polytechnic|academy|bachelor|master'?s?\b|mba\b|b\.?\s?tech|m\.?\s?tech|ph\.?\s?d|alumn|undergraduate|graduate student|campus|iit\b|iim\b|stanford|harvard|mit\b|oxford|cambridge|urbana-?champaign)\b/i.test(
      String(t || ''),
    );
  }

  function looksLikeJobTitle(t) {
    const s = String(t || '').trim();
    if (!s || s.length < 2 || s.length > 160) return false;
    if (isEducationText(s) || isActivityOrFeedBlob(s)) return false;
    if (/^about\b/i.test(s) || /\bmy expertise\b/i.test(s)) return false;
    if (/^(experience|education|about|skills|activity|posts|comments)$/i.test(s)) return false;
    if (
      /\b(director|vice[\s-]?president|evp|svp|avp|vp\b|president|manager|engineer|founder|co-?founder|head of|\bhead\b|lead\b|chief|officer|executive|account executive|analyst|consultant|specialist|product|marketing|sales|developer|designer|partner|owner|ceo|cto|cfo|coo|cmo|cro|business development)\b/i.test(
        s,
      )
    ) {
      return true;
    }
    return s.length >= 6 && s.length <= 90 && !/^[A-Za-z .'-]+,\s*[A-Za-z .'-]+$/.test(s);
  }

  function parseHeadlineRole(headline) {
    const h = String(headline || '').trim();
    if (!h || isActivityOrFeedBlob(h) || isEducationText(h)) return { title: '', company: '' };
    // "Services Account Executive | PCI @ SAP"
    const atCompany = h.match(/@\s*([^|·•]+)/);
    const company = atCompany?.[1]?.trim() || '';
    const beforeAt = h.split('@')[0].trim();
    const title = (beforeAt.split(/[|·•]/)[0] || beforeAt).trim();
    if (!looksLikeJobTitle(title)) return { title: '', company: '' };
    return { title, company: isEducationText(company) ? '' : company };
  }

  function extractExperienceSection() {
    // Wake lazy-loaded experience
    try {
      const expAnchor = document.querySelector('#experience');
      if (expAnchor) expAnchor.scrollIntoView({ block: 'center', behavior: 'instant' });
    } catch {
      /* ignore */
    }

    const direct =
      document.querySelector('#experience')?.closest('section') ||
      document.querySelector('#experience')?.parentElement ||
      document.querySelector('[data-section="experience"]') ||
      document.querySelector('[componentkey*="Experience"]')?.closest('section') ||
      [...document.querySelectorAll('section, div')].find((el) => {
        const h = el.querySelector('h2, .pvs-header__title');
        return h && /^experience$/i.test(textOf(h));
      });

    const multiline = (el) =>
      String(el?.innerText || el?.textContent || '')
        .replace(/\r/g, '')
        .trim()
        .slice(0, 5000);

    if (direct && !direct.closest('#activity') && !/#activity/i.test(direct.id || '')) {
      const lines = multiline(direct)
        .split('\n')
        .map((l) => l.replace(/\s+/g, ' ').trim())
        .filter((t) => t && t.length >= 2 && t.length < 180 && !isActivityOrFeedBlob(t));
      const unique = [];
      for (const line of lines) {
        if (!unique.includes(line)) unique.push(line);
      }
      if (unique.length >= 1) return unique.join('\n').slice(0, 5000);

      const ariaLines = [...direct.querySelectorAll('span[aria-hidden="true"]')]
        .map(textOf)
        .filter((t) => t && t.length >= 2 && t.length < 180 && !isActivityOrFeedBlob(t));
      for (const line of ariaLines) {
        if (!unique.includes(line)) unique.push(line);
      }
      if (unique.length >= 1) return unique.join('\n').slice(0, 5000);

      const full = multiline(direct);
      if (full && !isActivityOrFeedBlob(full)) return full;
    }

    const byHeading = findSectionByHeading(['Experience']);
    if (byHeading && !isActivityOrFeedBlob(byHeading)) return byHeading;
    return '';
  }

  function extractLinkedInProfile() {
    const blocked = isLinkedInAuthOrBlocked();
    const name = getProfileName();
    let headline = getProfileHeadline();
    if (
      headline &&
      (isActivityOrFeedBlob(headline) ||
        /^about\b/i.test(headline) ||
        isEducationText(headline) ||
        (headline.length > 120 && (headline.match(/\./g) || []).length >= 1))
    ) {
      headline = '';
    }
    const experience = extractExperienceSection();
    const parsed = parseHeadlineRole(headline);

    let currentTitle = parsed.title;
    let currentCompany = parsed.company;

    // Experience — split blobs; never schools/activity
    if (!currentTitle && experience) {
      const lines = experience
        .split(/\n+|(?:\s*[·|•]\s*)/)
        .map((l) => l.replace(/\s+/g, ' ').trim())
        .filter(
          (l) =>
            l.length > 2 &&
            l.length < 160 &&
            !/^experience$/i.test(l) &&
            !isActivityOrFeedBlob(l) &&
            !isEducationText(l),
        );
      // If still one huge line, regex-extract job titles
      if (lines.length <= 1 && experience.length > 160) {
        const re =
          /((?:Senior |Junior |Lead |Principal |Staff |Head of |Vice President |VP |Director of |Director |Executive |Account )?[\w/&+-]*(?:Manager|Director|Executive|Engineer|Founder|Officer|President|Consultant|Analyst|Specialist|Lead|Head)(?:\s+[\w/&+-]+){0,6})/gi;
        let m;
        while ((m = re.exec(experience)) && lines.length < 6) {
          const t = m[1].replace(/\s+/g, ' ').trim();
          if (t.length >= 4 && t.length <= 120 && !lines.includes(t)) lines.push(t);
        }
      }
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (/^\d|present|yr|mo|full-time|part-time/i.test(line) && !/ at /i.test(line) && !looksLikeJobTitle(line)) {
          continue;
        }
        const role = parseHeadlineRole(line);
        if (role.title) {
          currentTitle = role.title;
          currentCompany = role.company || currentCompany;
          break;
        }
        const at = line.match(/^(.+?)\s+at\s+(.+)$/i);
        if (at) {
          if (!looksLikeJobTitle(at[1]) || isEducationText(at[2])) continue;
          currentTitle = at[1].trim();
          currentCompany = at[2].split('·')[0].trim();
          break;
        }
        const candidate = line.split('·')[0].trim();
        if (!looksLikeJobTitle(candidate)) continue;
        currentTitle = candidate;
        const next = lines[i + 1];
        if (next && !isEducationText(next) && !isActivityOrFeedBlob(next) && !/^\d|present|yr|mo|full-time|part-time/i.test(next)) {
          currentCompany = next.split('·')[0].trim();
        }
        break;
      }
    }

    const location =
      textOf(document.querySelector('.text-body-small.inline.t-black--light.break-words')) ||
      textOf(document.querySelector('.text-body-small.inline.t-black--light')) ||
      [...document.querySelectorAll('.text-body-small')].map(textOf).find((t) => t.includes(',') && t.length < 80);

    let about = findSectionByHeading(['About']) || '';
    about = about.replace(/^About\s*/i, '').trim();
    if (isActivityOrFeedBlob(about)) about = '';
    const education = findSectionByHeading(['Education']);
    const skills = findSectionByHeading(['Skills']);
    const activity = findSectionByHeading(['Activity', 'Recent activity']);
    const certifications = findSectionByHeading(['Licenses & certifications', 'Certifications']);
    const hiringSignals = blocked ? [] : findHiringSignals();

    const sections = { about, experience, education, skills, activity, certifications };
    const description =
      (headline && looksLikeJobTitle(parseHeadlineRole(headline).title || headline.split(/[|·@]/)[0].trim())
        ? headline
        : '') ||
      (currentTitle ? (currentCompany ? `${currentTitle} at ${currentCompany}` : currentTitle) : '');

    const structuredParts = [];
    if (description) structuredParts.push(`HEADLINE:\n${description}`);
    if (currentTitle) structuredParts.push(`CURRENT_TITLE:\n${currentTitle}`);
    if (currentCompany) structuredParts.push(`CURRENT_COMPANY:\n${currentCompany}`);
    if (about) structuredParts.push(`ABOUT:\n${about}`);
    if (experience) structuredParts.push(`EXPERIENCE:\n${experience}`);
    if (education) structuredParts.push(`EDUCATION:\n${education}`);
    if (skills) structuredParts.push(`SKILLS:\n${skills}`);
    // Intentionally omit Activity from rawText — it poisons job-title extraction
    if (certifications) structuredParts.push(`CERTIFICATIONS:\n${certifications}`);
    if (hiringSignals.length) {
      structuredParts.push(`HIRING SIGNALS:\n${hiringSignals.join('\n---\n')}`);
    }

    // Do NOT append full main text — Activity feed poisons role extraction
    // Prefer a tight top-card slice: name + next few lines only
    const topCardText = (() => {
      const h1 = document.querySelector('main h1, h1');
      if (!h1) return '';
      const name = textOf(h1);
      const card =
        h1.closest('.pv-top-card') ||
        h1.closest('section.artdeco-card') ||
        h1.closest('section') ||
        h1.parentElement?.parentElement;
      if (!card) return '';
      const lines = String(card.innerText || '')
        .split('\n')
        .map((l) => l.replace(/\s+/g, ' ').trim())
        .filter(Boolean);
      const nameIdx = lines.findIndex((l) => l === name || l.startsWith(name));
      const slice = (nameIdx >= 0 ? lines.slice(nameIdx, nameIdx + 6) : lines.slice(0, 6)).filter(
        (l) => !isActivityOrFeedBlob(l),
      );
      return slice.join('\n').slice(0, 800);
    })();
    const rawText = [...structuredParts, topCardText && `TOP_CARD:\n${topCardText}`]
      .filter(Boolean)
      .join('\n\n')
      .slice(0, 12000);
    const hasRole = Boolean(currentTitle && looksLikeJobTitle(currentTitle));

    return {
      personName: name,
      companyName: currentCompany && !isEducationText(currentCompany) ? currentCompany : undefined,
      description,
      location,
      metadata: {
        sections,
        hiringSignals,
        currentTitle: hasRole ? currentTitle : '',
        currentCompany: currentCompany && !isEducationText(currentCompany) ? currentCompany : '',
        pageType: 'profile',
        scrapeBlocked: blocked,
        profileLoaded: !blocked && isLinkedInProfileReady(),
        scrapeMode: hasRole ? 'content-rich' : name ? 'content-name-only' : 'content-empty',
        scrapeWeak: Boolean(name) && !hasRole && !blocked,
        headlineSource: headline && hasRole ? 'headline' : currentTitle ? 'experience' : '',
      },
      rawText,
    };
  }

  function extractLinkedInCompany() {
    const name =
      document.querySelector('h1')?.textContent?.trim() ||
      document.querySelector('[data-test-id="about-us__title"]')?.textContent?.trim() ||
      document.querySelector('.org-top-card-summary__title')?.textContent?.trim();

    const desc =
      document.querySelector('.org-top-card-summary__tagline')?.textContent?.trim() ||
      document.querySelector('[data-test-id="about-us__description"]')?.textContent?.trim();

    const industry =
      document.querySelector('.org-top-card-summary__industry')?.textContent?.trim() ||
      textOf(document.querySelector('[class*="industry"]'));

    const size =
      document.querySelector('.org-about-company-module__company-staff-count-range')?.textContent?.trim() ||
      textOf(document.querySelector('[class*="staff-count"]'));

    const location =
      document.querySelector('.org-top-card-summary__headquarter')?.textContent?.trim() ||
      textOf(document.querySelector('[class*="headquarter"]'));

    const about = findSectionByHeading(['About', 'Overview']) || desc;
    const jobs = findSectionByHeading(['Jobs', 'Recent job openings']);
    const posts = findSectionByHeading(['Posts', 'Activity']);
    const people = findSectionByHeading(['People', 'Associated members']);
    const hiringSignals = findHiringSignals();

    const structuredParts = [];
    if (about) structuredParts.push(`ABOUT:\n${about}`);
    if (jobs) structuredParts.push(`JOBS:\n${jobs}`);
    if (posts) structuredParts.push(`POSTS:\n${posts}`);
    if (people) structuredParts.push(`PEOPLE:\n${people}`);
    if (hiringSignals.length) structuredParts.push(`HIRING SIGNALS:\n${hiringSignals.join('\n---\n')}`);

    const mainText = textOf(document.querySelector('main')) || getVisibleText(12000);
    const rawText = [...structuredParts, mainText].join('\n\n').slice(0, 18000);

    return {
      companyName: name,
      description: desc || about?.slice(0, 300),
      industry,
      employeeCount: size,
      location,
      metadata: { about, jobs, posts, hiringSignals, pageType: 'company' },
      rawText,
      personName: undefined,
    };
  }

  function extractLinkedInFeed() {
    const posts = extractVisiblePosts();
    const hiringPosts = posts.filter((p) => p.isHiring);
    const primary = hiringPosts[0] || posts[0];

    const structuredParts = [];
    if (hiringPosts.length) {
      structuredParts.push(formatPostsBlock(hiringPosts, 'HIRING POSTS (read these first)'));
    }
    if (posts.length) structuredParts.push(formatPostsBlock(posts));

    const mainText = textOf(document.querySelector('main')) || getVisibleText(12000);
    const rawText = [...structuredParts, mainText].join('\n\n').slice(0, 20000);

    return {
      personName: primary?.author?.split('·')[0]?.trim(),
      companyName: primary?.author,
      description: primary?.body?.slice(0, 300),
      metadata: { posts, hiringPosts, pageType: 'feed' },
      rawText,
    };
  }

  function extractLinkedIn() {
    const isCompany = location.pathname.includes('/company/');
    const isProfile = location.pathname.includes('/in/');
    const isFeed = location.pathname.includes('/feed');

    if (isFeed) return extractLinkedInFeed();

    let result = {};
    if (isCompany) result = extractLinkedInCompany();
    else if (isProfile) {
      result = extractLinkedInProfile();
      // Never attach Activity posts into profile rawText (they poison job-title mining)
      return mergePostsIntoResult(result, { allowDescriptionFromPosts: false, includePostsInRaw: false });
    } else if (extractVisiblePosts().length) return extractLinkedInFeed();

    return mergePostsIntoResult(result, { allowDescriptionFromPosts: true, includePostsInRaw: true });
  }

  function extractGeneric() {
    const ogTitle = document.querySelector('meta[property="og:title"]')?.content;
    const ogDesc = document.querySelector('meta[property="og:description"]')?.content;
    const metaDesc = document.querySelector('meta[name="description"]')?.content;
    const h1 = document.querySelector('h1')?.textContent?.trim();

    const jsonLd = [...document.querySelectorAll('script[type="application/ld+json"]')]
      .map((s) => {
        try {
          return JSON.parse(s.textContent);
        } catch {
          return null;
        }
      })
      .filter(Boolean);

    let companyName, description, industry, location;

    for (const item of jsonLd.flat()) {
      const data = Array.isArray(item) ? item : [item];
      for (const d of data) {
        if (d['@type'] === 'Organization' || d['@type'] === 'Corporation') {
          companyName = d.name || companyName;
          description = d.description || description;
          industry = d.industry || industry;
          location = d.address?.addressLocality || location;
        }
      }
    }

    return {
      companyName: companyName || ogTitle || h1,
      description: description || ogDesc || metaDesc,
      industry,
      location,
    };
  }

  function getVisibleText(limit = 8000) {
    const clone = document.body.cloneNode(true);
    clone.querySelectorAll('script, style, nav, footer, iframe, noscript').forEach((el) => el.remove());
    return (clone.textContent || '').replace(/\s+/g, ' ').trim().slice(0, limit);
  }

  function extractTechnologies(sections) {
    const skills = sections?.skills;
    if (!skills) return [];
    return skills
      .split(/[,·•\n|]/)
      .map((s) => s.trim())
      .filter((s) => s.length > 1 && s.length < 50)
      .slice(0, 25);
  }

  function buildExtraction() {
    if (location.hostname.includes('linkedin.com')) {
      expandTruncatedContent();
    }

    const hostname = location.hostname;
    const sourceType = detectSourceType(location.href, hostname);
    const linkedin = hostname.includes('linkedin.com') ? extractLinkedIn() : {};
    const generic = extractGeneric();
    const rawText = linkedin.rawText || getVisibleText(10000);
    const merged = { ...generic, ...linkedin };

    return {
      url: location.href,
      title: document.title,
      sourceType,
      companyName: merged.companyName,
      personName: merged.personName,
      description: merged.description,
      industry: merged.industry,
      location: merged.location,
      employeeCount: merged.employeeCount,
      funding: merged.funding,
      technologies: extractTechnologies(merged.metadata?.sections),
      rawText,
      metadata: {
        hostname,
        path: location.pathname,
        ...(merged.metadata || {}),
        scrapedAt: new Date().toISOString(),
      },
    };
  }

  window.scoutExtract = function scoutExtract() {
    return buildExtraction();
  };

  window.scoutExtractDeep = async function scoutExtractDeep() {
    await scrollToLoad();
    return buildExtraction();
  };

  window.scoutExtractForQuestion = async function scoutExtractForQuestion() {
    expandTruncatedContent();
    scrollToActivity();
    await new Promise((r) => setTimeout(r, 400));
    expandTruncatedContent();
    return buildExtraction();
  };

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.type === 'EXTRACT_PAGE') {
      (async () => {
        try {
          let data;
          if (message.forQuestion) {
            data = await window.scoutExtractForQuestion();
          } else if (message.deep) {
            data = await window.scoutExtractDeep();
          } else {
            data = window.scoutExtract();
          }
          sendResponse(data);
        } catch (err) {
          sendResponse({ error: err.message });
        }
      })();
      return true;
    }
  });
})();
