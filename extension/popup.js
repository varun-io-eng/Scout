const scoutBtn = document.getElementById('scoutBtn');
const panelBtn = document.getElementById('panelBtn');
const status = document.getElementById('status');
const result = document.getElementById('result');

function setStatus(text, type = 'idle') {
  status.textContent = text;
  status.className = `status ${type}`;
}

async function extractFromTab(tabId, deep = false) {
  try {
    const extraction = await chrome.tabs.sendMessage(tabId, { type: 'EXTRACT_PAGE', deep });
    if (extraction?.error) throw new Error(extraction.error);
    return extraction;
  } catch {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content.js'],
    });
    const extraction = await chrome.tabs.sendMessage(tabId, { type: 'EXTRACT_PAGE', deep });
    if (extraction?.error) throw new Error(extraction.error);
    return extraction;
  }
}

scoutBtn.addEventListener('click', async () => {
  scoutBtn.disabled = true;
  setStatus('Scraping page…', 'loading');

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new Error('No active tab');

    const extraction = await extractFromTab(tab.id, true);
    if (!extraction) throw new Error('Could not extract page data');

    setStatus('Building profile with AI…', 'loading');

    const response = await chrome.runtime.sendMessage({
      type: 'ANALYZE_PAGE',
      data: extraction,
    });

    if (response.error) throw new Error(response.error);

    const c = response.company;
    setStatus(`✓ ${c.name} saved to knowledge base`, 'success');
    result.classList.remove('hidden');
    result.innerHTML = `
      <h3>${escapeHtml(c.name)}</h3>
      <p>${escapeHtml(c.description || 'No description')}</p>
      ${c.industry ? `<span class="tag">${escapeHtml(c.industry)}</span>` : ''}
      ${c.competitors?.length ? `<p class="meta">${c.competitors.length} competitors detected</p>` : ''}
    `;
  } catch (err) {
    setStatus(err.message, 'error');
    result.classList.add('hidden');
  } finally {
    scoutBtn.disabled = false;
  }
});

panelBtn.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'OPEN_DOCK' });
  window.close();
});

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
