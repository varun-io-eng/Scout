/**
 * Aura CRM Content Script
 * Extracts lead data from Aura leads page and provides enrichment functionality
 */

// Check if we're on the Aura leads page
if (window.location.hostname.includes('aura') || window.location.pathname.includes('/leads')) {
  console.log('[aura-assist] Aura leads page detected');

  // Wait for the page to load
  function waitForLeadData() {
    return new Promise((resolve) => {
      const checkInterval = setInterval(() => {
        const leadData = extractLeadData();
        if (leadData.name || leadData.companyName) {
          clearInterval(checkInterval);
          resolve(leadData);
        }
      }, 500);

      // Timeout after 10 seconds
      setTimeout(() => {
        clearInterval(checkInterval);
        resolve(extractLeadData());
      }, 10000);
    });
  }

  // Extract lead data from Aura page DOM
  function extractLeadData() {
    const data = {
      name: '',
      companyName: '',
      linkedinUrl: '',
      jobTitle: '',
      jobLevel: '',
      jobFunction: '',
      leadId: '',
      campaignId: '',
    };

    // Try to extract name from various selectors
    const nameSelectors = [
      '[data-field="name"]',
      '[data-field="first_name"]',
      '[data-field="last_name"]',
      '.lead-name',
      '.person-name',
      'h1.lead-title',
      'h2.lead-title',
    ];

    for (const selector of nameSelectors) {
      const element = document.querySelector(selector);
      if (element) {
        const text = element.textContent?.trim() || element.value?.trim() || '';
        if (text && text.length > 1) {
          data.name = text;
          break;
        }
      }
    }

    // Try to extract company name
    const companySelectors = [
      '[data-field="company_name"]',
      '[data-field="company"]',
      '.company-name',
      '.lead-company',
    ];

    for (const selector of companySelectors) {
      const element = document.querySelector(selector);
      if (element) {
        const text = element.textContent?.trim() || element.value?.trim() || '';
        if (text && text.length > 1) {
          data.companyName = text;
          break;
        }
      }
    }

    // Try to extract LinkedIn URL
    const linkedinSelectors = [
      '[data-field="linkedin_url"]',
      '[data-field="linkedin"]',
      'a[href*="linkedin.com/in/"]',
      '.linkedin-url',
    ];

    for (const selector of linkedinSelectors) {
      const element = document.querySelector(selector);
      if (element) {
        const href = element.href || element.textContent?.trim() || element.value?.trim() || '';
        if (href && href.includes('linkedin.com/in/')) {
          data.linkedinUrl = href;
          break;
        }
      }
    }

    // Try to extract job title
    const titleSelectors = [
      '[data-field="job_title"]',
      '[data-field="title"]',
      '.job-title',
      '.lead-title',
    ];

    for (const selector of titleSelectors) {
      const element = document.querySelector(selector);
      if (element) {
        const text = element.textContent?.trim() || element.value?.trim() || '';
        if (text && text.length > 1) {
          data.jobTitle = text;
          break;
        }
      }
    }

    // Try to extract lead ID from URL
    const urlMatch = window.location.pathname.match(/\/leads\/(\d+)/);
    if (urlMatch) {
      data.leadId = urlMatch[1];
    }

    // Try to extract campaign ID from URL
    const campaignMatch = window.location.pathname.match(/\/campaigns\/(\d+)/);
    if (campaignMatch) {
      data.campaignId = campaignMatch[1];
    }

    return data;
  }

  // Add enrichment button to the page
  function addEnrichmentButton() {
    // Check if button already exists
    if (document.querySelector('#scout-enrich-btn')) {
      return;
    }

    // Create button
    const button = document.createElement('button');
    button.id = 'scout-enrich-btn';
    button.textContent = '🚀 Enrich Lead';
    button.style.cssText = `
      position: fixed;
      top: 20px;
      right: 20px;
      z-index: 10000;
      padding: 12px 20px;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: white;
      border: none;
      border-radius: 8px;
      font-weight: 600;
      cursor: pointer;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
      transition: all 0.3s ease;
    `;

    button.addEventListener('mouseenter', () => {
      button.style.transform = 'translateY(-2px)';
      button.style.boxShadow = '0 6px 16px rgba(0, 0, 0, 0.2)';
    });

    button.addEventListener('mouseleave', () => {
      button.style.transform = 'translateY(0)';
      button.style.boxShadow = '0 4px 12px rgba(0, 0, 0, 0.15)';
    });

    button.addEventListener('click', handleEnrichmentClick);

    document.body.appendChild(button);
    console.log('[aura-assist] Enrichment button added');
  }

  // Handle enrichment button click
  async function handleEnrichmentClick() {
    const button = document.querySelector('#scout-enrich-btn');
    if (!button) return;

    button.textContent = '⏳ Extracting...';
    button.disabled = true;

    try {
      // Extract lead data from page
      const leadData = extractLeadData();
      console.log('[aura-assist] Extracted lead data:', leadData);

      if (!leadData.leadId) {
        button.textContent = '❌ No Lead ID';
        setTimeout(() => {
          button.textContent = '🚀 Enrich Lead';
          button.disabled = false;
        }, 2000);
        return;
      }

      button.textContent = '⏳ Getting credentials...';

      // Automatically extract Aura credentials from the page
      const auraConfig = await extractAuraCredentials();
      
      if (!auraConfig.auraDatahubUrl || !auraConfig.auraAuthToken) {
        button.textContent = '⚠️ Not Logged In';
        showNotification('Please log into Aura to use enrichment', 'warning');
        setTimeout(() => {
          button.textContent = '🚀 Enrich Lead';
          button.disabled = false;
        }, 2000);
        return;
      }

      // Store credentials for future use
      await chrome.storage.local.set(auraConfig);
      console.log('[aura-assist] Aura credentials stored:', {
        datahubUrl: auraConfig.auraDatahubUrl,
        hasToken: !!auraConfig.auraAuthToken
      });

      button.textContent = '⏳ Enriching...';

      // Call enrichment API
      const response = await fetch('http://localhost:3847/api/enrich-lead', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          campaignId: parseInt(leadData.campaignId) || 0,
          leadId: parseInt(leadData.leadId),
          aura: {
            datahubBaseUrl: auraConfig.auraDatahubUrl,
            authToken: auraConfig.auraAuthToken,
          },
        }),
      });

      const result = await response.json();
      console.log('[aura-assist] Enrichment result:', result);

      if (result.success) {
        button.textContent = '✅ Ready!';
        button.style.background = 'linear-gradient(135deg, #11998e 0%, #38ef7d 100%)';
        
        // Show success message
        showNotification(`Lead enriched successfully via ${result.source}`, 'success');
        
        // Refresh the page after 2 seconds to show updated data
        setTimeout(() => {
          window.location.reload();
        }, 2000);
      } else {
        button.textContent = '⚠️ Manual Edit';
        button.style.background = 'linear-gradient(135deg, #f093fb 0%, #f5576c 100%)';
        
        // Show missing fields
        const missingFields = result.missing_fields || [];
        showNotification(`Missing ${missingFields.length} fields: ${missingFields.join(', ')}`, 'warning');
        
        setTimeout(() => {
          button.textContent = '🚀 Enrich Lead';
          button.style.background = 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)';
          button.disabled = false;
        }, 3000);
      }
    } catch (error) {
      console.error('[aura-assist] Enrichment error:', error);
      button.textContent = '❌ Error';
      button.style.background = 'linear-gradient(135deg, #eb3349 0%, #f45c43 100%)';
      
      showNotification('Enrichment failed. Check console for details.', 'error');
      
      setTimeout(() => {
        button.textContent = '🚀 Enrich Lead';
        button.style.background = 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)';
        button.disabled = false;
      }, 2000);
    }
  }

  // Automatically extract Aura credentials from the page
  async function extractAuraCredentials() {
    let auraDatahubUrl = '';
    let auraAuthToken = '';

    // Extract auth token from localStorage
    try {
      auraAuthToken = localStorage.getItem('auth_token') || sessionStorage.getItem('auth_token') || '';
      console.log('[aura-assist] Auth token found:', !!auraAuthToken);
    } catch (e) {
      console.warn('[aura-assist] Could not access localStorage:', e);
    }

    // Determine backend URL from the page
    try {
      // Try to get from window environment variables
      if (window.__NEXT_DATA__?.props?.pageProps?.env?.NEXT_PUBLIC_BACKEND_BASE_URL) {
        auraDatahubUrl = window.__NEXT_DATA__.props.pageProps.env.NEXT_PUBLIC_BACKEND_BASE_URL;
      } else if (window.__NEXT_DATA__?.props?.pageProps?.env?.NEXT_PUBLIC_API_BASE_URL) {
        auraDatahubUrl = window.__NEXT_DATA__.props.pageProps.env.NEXT_PUBLIC_API_BASE_URL;
      } else if (window.__NEXT_DATA__?.props?.pageProps?.env?.NEXT_PUBLIC_DATAHUB_BASE_URL) {
        auraDatahubUrl = window.__NEXT_DATA__.props.pageProps.env.NEXT_PUBLIC_DATAHUB_BASE_URL;
      }
      
      // If not found in Next.js data, infer from current URL
      if (!auraDatahubUrl) {
        const currentUrl = window.location.origin;
        if (currentUrl.includes('localhost') || currentUrl.includes('127.0.0.1')) {
          auraDatahubUrl = 'http://localhost:6019';
        } else if (currentUrl.includes('zequinia.com')) {
          auraDatahubUrl = 'https://app.zequinia.com/svc-backend';
        } else {
          // Default to current origin with /svc-backend suffix
          auraDatahubUrl = `${currentUrl}/svc-backend`;
        }
      }

      console.log('[aura-assist] Backend URL:', auraDatahubUrl);
    } catch (e) {
      console.warn('[aura-assist] Could not determine backend URL:', e);
      // Fallback to default
      auraDatahubUrl = 'http://localhost:6019';
    }

    return {
      auraDatahubUrl,
      auraAuthToken,
    };
  }

  // Show notification
  function showNotification(message, type = 'info') {
    const notification = document.createElement('div');
    notification.style.cssText = `
      position: fixed;
      top: 80px;
      right: 20px;
      z-index: 10001;
      padding: 16px 24px;
      background: ${type === 'success' ? '#10b981' : type === 'warning' ? '#f59e0b' : type === 'error' ? '#ef4444' : '#3b82f6'};
      color: white;
      border-radius: 8px;
      font-weight: 500;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
      max-width: 400px;
      word-wrap: break-word;
    `;
    notification.textContent = message;
    document.body.appendChild(notification);

    setTimeout(() => {
      notification.style.opacity = '0';
      notification.style.transition = 'opacity 0.3s ease';
      setTimeout(() => notification.remove(), 300);
    }, 4000);
  }

  // Initialize
  function init() {
    console.log('[aura-assist] Initializing Aura assist');
    addEnrichmentButton();
  }

  // Wait for page to be ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // Also initialize when URL changes (SPA navigation)
  let lastUrl = location.href;
  new MutationObserver(() => {
    const currentUrl = location.href;
    if (currentUrl !== lastUrl) {
      lastUrl = currentUrl;
      console.log('[aura-assist] URL changed, reinitializing');
      setTimeout(init, 1000);
    }
  }).observe(document.body, { subtree: true, childList: true });
}
