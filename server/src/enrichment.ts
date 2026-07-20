import type { LinkedInProfileData, EnrichedProfileData } from './types.js';

const PROXYCURL_API_KEY = process.env.PROXYCURL_API_KEY || '';
const PDL_API_KEY = process.env.PDL_API_KEY || '';
const APIFY_API_TOKEN = process.env.APIFY_API_TOKEN || '';
const LINKEDIN_LI_AT = process.env.LINKEDIN_LI_AT || '';

/**
 * Enrich LinkedIn profile data using Proxycurl or People Data Labs API
 * Falls back gracefully if API keys are not configured
 */
export async function enrichLinkedInProfile(
  profileData: LinkedInProfileData
): Promise<EnrichedProfileData> {
  const enriched: EnrichedProfileData = {
    ...profileData,
    enrichmentSource: 'dom',
    enrichmentTimestamp: new Date().toISOString(),
  };

  // Try Proxycurl first if API key is available
  if (PROXYCURL_API_KEY) {
    try {
      const proxycurlData = await enrichWithProxycurl(profileData.profileUrl);
      if (proxycurlData) {
        Object.assign(enriched, proxycurlData);
        enriched.enrichmentSource = 'proxycurl';
        return enriched;
      }
    } catch (error) {
      console.error('Proxycurl enrichment failed:', error);
    }
  }

  // Fallback to PDL if Proxycurl fails or no key
  if (PDL_API_KEY) {
    try {
      const pdlData = await enrichWithPDL(profileData);
      if (pdlData) {
        Object.assign(enriched, pdlData);
        enriched.enrichmentSource = 'pdl';
        return enriched;
      }
    } catch (error) {
      console.error('PDL enrichment failed:', error);
    }
  }

  // Return DOM-only data if no enrichment succeeded
  console.log('Profile enrichment: using DOM data only (no API keys or enrichment failed)');
  return enriched;
}

/**
 * Enrich using Proxycurl LinkedIn Profile API
 */
async function enrichWithProxycurl(profileUrl: string): Promise<Partial<EnrichedProfileData> | null> {
  try {
    const response = await fetch(`https://api.proxycurl.com/v2/linkedin?url=${encodeURIComponent(profileUrl)}`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${PROXYCURL_API_KEY}`,
      },
    });

    if (!response.ok) {
      if (response.status === 401) {
        console.error('Proxycurl: Invalid API key');
      } else if (response.status === 429) {
        console.error('Proxycurl: Rate limit exceeded');
      }
      return null;
    }

    const data = await response.json();
    
    return {
      enrichedEmail: data.email || data.work_email || undefined,
      enrichedPhone: data.phone_number || data.mobile_number || undefined,
      enrichedWorkHistory: data.experiences?.map((exp: any) => ({
        title: exp.title || '',
        company: exp.company || '',
        duration: exp.duration || '',
        startDate: exp.starts_at?.date || undefined,
        endDate: exp.ends_at?.date || undefined,
      })) || [],
      enrichedEducation: data.education?.map((edu: any) => ({
        school: edu.school || '',
        degree: edu.degree_name || '',
        field: edu.field_of_study || '',
        startDate: edu.starts_at?.date || undefined,
        endDate: edu.ends_at?.date || undefined,
      })) || [],
      enrichedSkills: data.skills || [],
      verifiedEmail: !!data.email,
      verifiedPhone: !!data.phone_number,
    };
  } catch (error) {
    console.error('Proxycurl API error:', error);
    return null;
  }
}

/**
 * Enrich using People Data Labs Person Enrichment API
 */
async function enrichWithPDL(profileData: LinkedInProfileData): Promise<Partial<EnrichedProfileData> | null> {
  try {
    // Extract LinkedIn username from profile URL
    const linkedinMatch = profileData.profileUrl.match(/\/in\/([^\/]+)/);
    if (!linkedinMatch) {
      console.error('Could not extract LinkedIn username from URL');
      return null;
    }

    const linkedinUsername = linkedinMatch[1];

    const response = await fetch('https://api.peopledatalabs.com/person/enrich', {
      method: 'POST',
      headers: {
        'X-API-Key': PDL_API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        profile: [
          { linkedin: { username: linkedinUsername } },
        ],
      }),
    });

    if (!response.ok) {
      if (response.status === 401) {
        console.error('PDL: Invalid API key');
      } else if (response.status === 429) {
        console.error('PDL: Rate limit exceeded');
      }
      return null;
    }

    const data = await response.json();
    
    if (!data || data.status === 'error') {
      console.error('PDL API returned error:', data?.error?.message || 'Unknown error');
      return null;
    }

    const person = data.data;
    
    return {
      enrichedEmail: person.work_email || person.email || undefined,
      enrichedPhone: person.phone_number || undefined,
      enrichedWorkHistory: person.experience?.map((exp: any) => ({
        title: exp.title?.name || '',
        company: exp.company?.name || '',
        duration: exp.duration || '',
        startDate: exp.start_date || undefined,
        endDate: exp.end_date || undefined,
      })) || [],
      enrichedEducation: person.education?.map((edu: any) => ({
        school: edu.school?.name || '',
        degree: edu.degree?.name || '',
        field: edu.majors?.join(', ') || '',
        startDate: edu.start_date || undefined,
        endDate: edu.end_date || undefined,
      })) || [],
      enrichedSkills: person.skills || [],
      verifiedEmail: !!person.work_email,
      verifiedPhone: !!person.phone_number,
    };
  } catch (error) {
    console.error('PDL API error:', error);
    return null;
  }
}

/**
 * Fetch LinkedIn profile data using user's authenticated LinkedIn session (cookie-based)
 * This is the most reliable method as it uses the user's actual LinkedIn login
 */
export async function fetchLinkedInProfileWithCookie(profileUrl: string): Promise<LinkedInProfileData | null> {
  if (!LINKEDIN_LI_AT) {
    console.log('[linkedin-cookie] No LI_AT cookie configured, cannot use authenticated API');
    return null;
  }

  try {
    // Extract LinkedIn public ID from URL
    const publicIdMatch = profileUrl.match(/\/in\/([^\/\?]+)/);
    if (!publicIdMatch) {
      console.error('[linkedin-cookie] Could not extract public ID from URL');
      return null;
    }

    const publicId = publicIdMatch[1];
    console.log('[linkedin-cookie] Fetching profile using authenticated API for:', publicId);

    // Use LinkedIn's internal API with user's cookie
    const response = await fetch(`https://www.linkedin.com/voyager/api/identity/profiles/${publicId}/profileView`, {
      method: 'GET',
      headers: {
        'Cookie': `li_at=${LINKEDIN_LI_AT}`,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
        'Accept': 'application/vnd.linkedin.normalized+json+2.1',
        'X-RestLi-Protocol-Version': '2.0.0',
        'csrf-Token': LINKEDIN_LI_AT,
      },
    });

    if (!response.ok) {
      if (response.status === 401) {
        console.error('[linkedin-cookie] Invalid or expired cookie. Please update LINKEDIN_LI_AT');
      } else if (response.status === 403) {
        console.error('[linkedin-cookie] LinkedIn blocked the request. Cookie may be invalid');
      } else {
        console.error('[linkedin-cookie] API error:', response.status, response.statusText);
      }
      return null;
    }

    const data = await response.json();
    console.log('[linkedin-cookie] Successfully fetched profile data from LinkedIn API');

    // Parse LinkedIn's Voyager API response
    const included = data.included || [];
    const profileData: LinkedInProfileData = {
      personName: '',
      headline: '',
      jsonTitle: '',
      jsonCompany: '',
      location: '',
      profileUrl: profileUrl,
      currentCompany: '',
      currentTitle: '',
      email: '',
      phone: '',
      workHistory: [],
      education: [],
      skills: [],
      about: '',
      connections: '',
    };

    // Extract profile information from Voyager API response
    for (const item of included) {
      if (item.$type === 'com.linkedin.voyager.identity.profile.Profile') {
        profileData.personName = `${item.firstName} ${item.lastName}`.trim();
        profileData.headline = item.headline || '';
        profileData.location = item.locationName || '';
        profileData.connections = item.connections?.toLocaleString() || '';
      }
      
      if (item.$type === 'com.linkedin.voyager.identity.shared.LocalizedLabel') {
        // Handle localized labels
      }
      
      if (item.$type === 'com.linkedin.voyager.identity.profile.Position' && profileData.workHistory) {
        profileData.workHistory.push({
          title: item.title || '',
          company: item.companyName || '',
          duration: item.timePeriod?.startDate ? `${item.timePeriod.startDate.year}-${item.timePeriod.endDate?.year || 'present'}` : '',
        });
      }
      
      if (item.$type === 'com.linkedin.voyager.identity.profile.Education' && profileData.education) {
        profileData.education.push({
          school: item.schoolName || '',
          degree: item.degreeName || '',
          field: item.fieldOfStudy || '',
        });
      }
      
      if (item.$type === 'com.linkedin.voyager.identity.profile.Skill' && profileData.skills) {
        profileData.skills.push(item.name || '');
      }
    }

    // Set current title and company from most recent work experience
    if (profileData.workHistory && profileData.workHistory.length > 0) {
      profileData.currentTitle = profileData.workHistory[0].title;
      profileData.currentCompany = profileData.workHistory[0].company;
      profileData.jsonTitle = profileData.currentTitle;
      profileData.jsonCompany = profileData.currentCompany;
    }

    return profileData;
  } catch (error) {
    console.error('[linkedin-cookie] Fetch error:', error);
    return null;
  }
}

/**
 * Retry function with exponential backoff for API calls
 */
async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  maxRetries: number = 3,
  baseDelay: number = 1000
): Promise<T> {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (attempt === maxRetries - 1) throw error;
      
      const delay = baseDelay * Math.pow(2, attempt);
      console.log(`[retry] Attempt ${attempt + 1}/${maxRetries} failed, retrying in ${delay}ms...`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  throw new Error('Max retries exceeded');
}

/**
 * Fetch LinkedIn profile data directly from Proxycurl using only the URL
 * This is used when DOM extraction fails or is blocked
 */
export async function fetchLinkedInProfileFromProxycurl(profileUrl: string): Promise<LinkedInProfileData | null> {
  if (!PROXYCURL_API_KEY) {
    console.log('[proxycurl] No API key configured, cannot fetch directly');
    return null;
  }

  try {
    console.log('[proxycurl] Fetching profile directly:', profileUrl);
    
    const response = await retryWithBackoff(async () => {
      return await fetch(`https://api.proxycurl.com/v2/linkedin?url=${encodeURIComponent(profileUrl)}`, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${PROXYCURL_API_KEY}`,
        },
      });
    });

    if (!response.ok) {
      if (response.status === 401) {
        console.error('[proxycurl] Invalid API key');
      } else if (response.status === 429) {
        console.error('[proxycurl] Rate limit exceeded');
      } else {
        console.error('[proxycurl] API error:', response.status, response.statusText);
      }
      return null;
    }

    const data = await response.json();
    console.log('[proxycurl] Successfully fetched profile data');

    // Convert Proxycurl response to our LinkedInProfileData format
    const profileData: LinkedInProfileData = {
      personName: data.full_name || data.first_name + ' ' + data.last_name || '',
      headline: data.headline || '',
      jsonTitle: data.job_title || '',
      jsonCompany: data.company_name || '',
      location: data.location || '',
      profileUrl: profileUrl,
      currentCompany: data.company_name || '',
      currentTitle: data.job_title || '',
      email: data.email || data.work_email || '',
      phone: data.phone_number || data.mobile_number || '',
      workHistory: data.experiences?.map((exp: any) => ({
        title: exp.title || '',
        company: exp.company || '',
        duration: exp.duration || '',
      })) || [],
      education: data.education?.map((edu: any) => ({
        school: edu.school || '',
        degree: edu.degree_name || '',
        field: edu.field_of_study || '',
      })) || [],
      skills: data.skills || [],
      about: data.summary || '',
      connections: data.connections || '',
    };

    return profileData;
  } catch (error) {
    if (error instanceof Error && error.message.includes('ENOTFOUND')) {
      console.error('[proxycurl] Network error - DNS resolution failed. Proxycurl API may be blocked or unreachable.');
    } else if (error instanceof Error && error.message.includes('ECONNREFUSED')) {
      console.error('[proxycurl] Network error - Connection refused. Proxycurl API may be down.');
    } else {
      console.error('[proxycurl] Fetch error:', error);
    }
    return null;
  }
}

/**
 * Fetch LinkedIn profile data directly from PDL using only the URL
 * This is used as fallback when Proxycurl fails
 */
export async function fetchLinkedInProfileFromPDL(profileUrl: string): Promise<LinkedInProfileData | null> {
  if (!PDL_API_KEY) {
    console.log('[pdl] No API key configured, cannot fetch directly');
    return null;
  }

  try {
    // Extract LinkedIn username from profile URL
    const linkedinMatch = profileUrl.match(/\/in\/([^\/]+)/);
    if (!linkedinMatch) {
      console.error('[pdl] Could not extract LinkedIn username from URL');
      return null;
    }

    const linkedinUsername = linkedinMatch[1];
    console.log('[pdl] Fetching profile directly for username:', linkedinUsername);

    const response = await fetch('https://api.peopledatalabs.com/person/enrich', {
      method: 'POST',
      headers: {
        'X-API-Key': PDL_API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        profile: [
          { linkedin: { username: linkedinUsername } },
        ],
      }),
    });

    if (!response.ok) {
      if (response.status === 401) {
        console.error('[pdl] Invalid API key');
      } else if (response.status === 429) {
        console.error('[pdl] Rate limit exceeded');
      } else {
        console.error('[pdl] API error:', response.status, response.statusText);
      }
      return null;
    }

    const data = await response.json();
    
    if (!data || data.status === 'error') {
      console.error('[pdl] API returned error:', data?.error?.message || 'Unknown error');
      return null;
    }

    const person = data.data;
    console.log('[pdl] Successfully fetched profile data');

    // Convert PDL response to our LinkedInProfileData format
    const profileData: LinkedInProfileData = {
      personName: person.full_name || '',
      headline: person.job_title || '',
      jsonTitle: person.job_title || '',
      jsonCompany: person.company_name || '',
      location: person.location?.name || '',
      profileUrl: profileUrl,
      currentCompany: person.company_name || '',
      currentTitle: person.job_title || '',
      email: person.work_email || person.email || '',
      phone: person.phone_number || '',
      workHistory: person.experience?.map((exp: any) => ({
        title: exp.title?.name || '',
        company: exp.company?.name || '',
        duration: exp.duration || '',
      })) || [],
      education: person.education?.map((edu: any) => ({
        school: edu.school?.name || '',
        degree: edu.degree?.name || '',
        field: edu.majors?.join(', ') || '',
      })) || [],
      skills: person.skills || [],
      about: person.summary || '',
      connections: '',
    };

    return profileData;
  } catch (error) {
    if (error instanceof Error && error.message.includes('ENOTFOUND')) {
      console.error('[pdl] Network error - DNS resolution failed. PDL API may be blocked or unreachable.');
    } else if (error instanceof Error && error.message.includes('ECONNREFUSED')) {
      console.error('[pdl] Network error - Connection refused. PDL API may be down.');
    } else {
      console.error('[pdl] Fetch error:', error);
    }
    return null;
  }
}

/**
 * Fetch LinkedIn profile data directly from Apify using only the URL
 * This is used as final fallback when Proxycurl and PDL fail
 */
export async function fetchLinkedInProfileFromApify(profileUrl: string): Promise<LinkedInProfileData | null> {
  if (!APIFY_API_TOKEN) {
    console.log('[apify] No API token configured, cannot fetch directly');
    return null;
  }

  try {
    console.log('[apify] Fetching profile directly:', profileUrl);
    
    // Use Apify's LinkedIn Profile Scraper actor
    const response = await fetch('https://api.apify.com/v2/acts/bebity~linkedin-profile-scraper/run-sync-get-dataset-items', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${APIFY_API_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        url: profileUrl,
      }),
    });

    if (!response.ok) {
      if (response.status === 401) {
        console.error('[apify] Invalid API token');
      } else if (response.status === 429) {
        console.error('[apify] Rate limit exceeded');
      } else {
        console.error('[apify] API error:', response.status, response.statusText);
      }
      return null;
    }

    const data = await response.json();
    
    if (!data || data.length === 0) {
      console.error('[apify] No data returned from API');
      return null;
    }

    const profile = data[0]; // Apify returns array, take first item
    console.log('[apify] Successfully fetched profile data');

    // Convert Apify response to our LinkedInProfileData format
    const profileData: LinkedInProfileData = {
      personName: profile.fullName || profile.firstName + ' ' + profile.lastName || '',
      headline: profile.headline || '',
      jsonTitle: profile.jobTitle || '',
      jsonCompany: profile.companyName || '',
      location: profile.location || '',
      profileUrl: profileUrl,
      currentCompany: profile.companyName || '',
      currentTitle: profile.jobTitle || '',
      email: profile.email || '',
      phone: profile.phone || '',
      workHistory: profile.experiences?.map((exp: any) => ({
        title: exp.title || '',
        company: exp.companyName || '',
        duration: exp.duration || '',
      })) || [],
      education: profile.education?.map((edu: any) => ({
        school: edu.schoolName || '',
        degree: edu.degreeName || '',
        field: edu.fieldOfStudy || '',
      })) || [],
      skills: profile.skills || [],
      about: profile.about || profile.summary || '',
      connections: profile.connectionsCount || '',
    };

    return profileData;
  } catch (error) {
    if (error instanceof Error && error.message.includes('ENOTFOUND')) {
      console.error('[apify] Network error - DNS resolution failed. Apify API may be blocked or unreachable.');
    } else if (error instanceof Error && error.message.includes('ECONNREFUSED')) {
      console.error('[apify] Network error - Connection refused. Apify API may be down.');
    } else {
      console.error('[apify] Fetch error:', error);
    }
    return null;
  }
}

/**
 * Check if enrichment APIs are configured
 */
export function isEnrichmentConfigured(): boolean {
  return !!(PROXYCURL_API_KEY || PDL_API_KEY || APIFY_API_TOKEN);
}

/**
 * Get configured enrichment provider
 */
export function getEnrichmentProvider(): 'proxycurl' | 'pdl' | 'apify' | 'none' {
  if (PROXYCURL_API_KEY) return 'proxycurl';
  if (PDL_API_KEY) return 'pdl';
  if (APIFY_API_TOKEN) return 'apify';
  return 'none';
}
