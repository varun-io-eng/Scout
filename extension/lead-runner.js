const API_BASE = 'http://localhost:3847/api';
const LINKEDIN_DELAY_MS = 2500;
const BETWEEN_LEADS_MS = 1500;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function extractFromTab(tabId, opts = {}) {
  try {
    return await chrome.tabs.sendMessage(tabId, { type: 'EXTRACT_PAGE', ...opts });
  } catch {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
    return await chrome.tabs.sendMessage(tabId, { type: 'EXTRACT_PAGE', ...opts });
  }
}

function broadcastProgress(message) {
  chrome.tabs.query({}, (tabs) => {
    for (const tab of tabs) {
      if (tab.id) {
        chrome.tabs.sendMessage(tab.id, { type: 'SCOUT_AUTOMATION_PROGRESS', message }).catch(() => {});
      }
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

async function processLeadOnServer(campaignId, lead, extraction, aura) {
  const res = await fetch(`${API_BASE}/leads/process`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      campaignId,
      lead: { id: lead.id, ...lead },
      extraction,
      autoApply: true,
      aura,
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `Process error ${res.status}`);
  return data;
}

async function visitLinkedInAndExtract(linkedinUrl) {
  const tab = await chrome.tabs.create({ url: linkedinUrl, active: false });
  const tabId = tab.id;
  if (!tabId) throw new Error('Could not open LinkedIn tab');

  try {
    await waitForTabLoad(tabId);
    await sleep(LINKEDIN_DELAY_MS);
    const extraction = await extractFromTab(tabId, { deep: true, forQuestion: true });
    if (extraction?.error) throw new Error(extraction.error);
    
    // Check if DOM extraction failed or returned weak data
    const domFailed = !extraction || 
                      extraction.error || 
                      !extraction.personName || 
                      !extraction.metadata?.currentTitle;
    
    if (domFailed) {
      console.log('[visitLinkedInAndExtract] DOM extraction failed/weak, trying Proxycurl API fallback');
      
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
            console.log('[visitLinkedInAndExtract] Successfully fetched profile from Proxycurl API');
            // Convert API profile to extraction format
            const apiExtraction = {
              url: linkedinUrl,
              title: apiData.profile.personName || '',
              sourceType: 'linkedin',
              personName: apiData.profile.personName || '',
              companyName: apiData.profile.currentCompany || undefined,
              description: apiData.profile.headline || apiData.profile.currentTitle || '',
              location: apiData.profile.location || undefined,
              rawText: [
                apiData.profile.headline && `HEADLINE:\n${apiData.profile.headline}`,
                apiData.profile.currentTitle && `CURRENT_TITLE:\n${apiData.profile.currentTitle}`,
                apiData.profile.currentCompany && `CURRENT_COMPANY:\n${apiData.profile.currentCompany}`,
                apiData.profile.location && `LOCATION:\n${apiData.profile.location}`,
                apiData.profile.about && `ABOUT:\n${apiData.profile.about}`,
                apiData.profile.skills && apiData.profile.skills.length && `SKILLS:\n${apiData.profile.skills.join(', ')}`,
                apiData.profile.workHistory && apiData.profile.workHistory.length && `EXPERIENCE:\n${apiData.profile.workHistory.map(w => `${w.title} at ${w.company}`).join('\n')}`,
              ].filter(Boolean).join('\n\n'),
              metadata: {
                pageType: 'profile',
                currentTitle: apiData.profile.currentTitle,
                currentCompany: apiData.profile.currentCompany,
                scrapeMode: 'api-fallback',
                scrapeWeak: false,
                profileLoaded: true,
                apiFallback: true,
                enrichmentSource: 'proxycurl',
              },
            };
            return apiExtraction;
          }
        }
      } catch (apiErr) {
        console.error('[visitLinkedInAndExtract] Proxycurl API fallback failed:', apiErr);
        // Continue with weak DOM data if API also fails
      }
    }
    
    // Enrich profile data with Proxycurl/PDL if available
    try {
      const enriched = await enrichProfileData(extraction, linkedinUrl);
      return enriched;
    } catch (enrichErr) {
      console.error('Enrichment failed, using original extraction:', enrichErr);
      return extraction;
    }
  } finally {
    try {
      await chrome.tabs.remove(tabId);
    } catch {
      /* tab may already be closed */
    }
  }
}

async function enrichProfileData(extraction, linkedinUrl) {
  // LinkedIn enrichment removed - now using CRM + Apollo company enrichment only
  // Return original extraction without enrichment
  console.log('[lead-runner] LinkedIn enrichment disabled, using CRM + Apollo approach');
  return extraction;
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

export async function runLeadAutomation(campaignId, aura, options = {}) {
  const limit = options.limit ?? 20;
  broadcastProgress('Fetching NOT_ELIGIBLE leads…');

  const queue = await fetchLeadQueue(campaignId, aura);
  const toProcess = queue.slice(0, limit);

  if (!toProcess.length) {
    return { processed: 0, readyCount: 0, failed: 0, results: [], message: 'No leads in queue' };
  }

  broadcastProgress(`Processing ${toProcess.length} leads via LinkedIn…`);

  const results = [];
  let readyCount = 0;
  let failed = 0;

  for (let i = 0; i < toProcess.length; i++) {
    const lead = toProcess[i];
    const name = lead.name || `Lead #${lead.id}`;
    broadcastProgress(`[${i + 1}/${toProcess.length}] Visiting ${name} on LinkedIn…`);

    try {
      if (!lead.linkedinUrl) {
        results.push({ leadId: lead.id, skipped: true, reason: 'No LinkedIn URL' });
        continue;
      }

      const extraction = await visitLinkedInAndExtract(lead.linkedinUrl);
      broadcastProgress(`[${i + 1}/${toProcess.length}] Analyzing ICP fit for ${name}…`);

      const result = await processLeadOnServer(campaignId, lead, extraction, aura);
      results.push(result);

      if (result.stageAfter === 'READY') readyCount++;
      if (result.error) failed++;

      broadcastProgress(
        `[${i + 1}/${toProcess.length}] ${name}: ${result.summary}${result.stageAfter === 'READY' ? ' → Ready' : ''}`,
      );
    } catch (err) {
      failed++;
      results.push({
        leadId: lead.id,
        leadName: name,
        error: err instanceof Error ? err.message : 'Failed',
        applied: false,
      });
      broadcastProgress(`[${i + 1}/${toProcess.length}] ${name}: failed — ${err.message || err}`);
    }

    if (i < toProcess.length - 1) await sleep(BETWEEN_LEADS_MS);
  }

  return {
    processed: results.length,
    readyCount,
    failed,
    results,
    message: `Automation complete: ${readyCount} leads moved to Ready`,
  };
}
