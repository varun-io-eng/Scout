/**
 * Apollo.io Enrichment API Integration
 * Uses Apollo.io's database for lead enrichment instead of scraping LinkedIn
 * This is compliant, reliable, and avoids LinkedIn ToS violations
 */

const APOLLO_API_KEY = process.env.APOLLO_API_KEY || '';

export interface ApolloLeadData {
  id?: string;
  first_name?: string;
  last_name?: string;
  full_name?: string;
  title?: string;
  job_level?: string;
  job_function?: string;
  company_name?: string;
  company_id?: string;
  company_revenue?: string;
  company_employee_count?: string;
  company_location?: string;
  country?: string;
  city?: string;
  state?: string;
  linkedin_url?: string;
  email?: string;
  phone?: string;
  confidence_score?: number;
  last_verified?: string;
}

/**
 * Enrich lead data using Apollo.io API
 * @param query - Search query (name, company, or LinkedIn URL)
 * @returns Enriched lead data or null if not found
 */
export async function enrichWithApollo(query: {
  name?: string;
  company?: string;
  linkedin_url?: string;
}): Promise<ApolloLeadData | null> {
  if (!APOLLO_API_KEY) {
    console.log('[apollo] No API key configured, cannot enrich');
    return null;
  }

  try {
    console.log('[apollo] Enriching lead with query:', query);

    // Build Apollo search query
    const searchParams = new URLSearchParams();
    
    if (query.name) {
      searchParams.append('q_person_titles', query.name);
    }
    if (query.company) {
      searchParams.append('q_organization_name', query.company);
    }
    if (query.linkedin_url) {
      searchParams.append('q_person_linkedin', query.linkedin_url);
    }

    // Apollo API endpoint for person search
    const response = await fetch('https://api.apollo.io/v1/mixed_people/search', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Api-Key': APOLLO_API_KEY,
      },
      body: JSON.stringify({
        q_keywords: query.name || query.company || '',
        page: 1,
        per_page: 5,
      }),
    });

    if (!response.ok) {
      if (response.status === 401) {
        console.error('[apollo] Invalid API key');
      } else if (response.status === 429) {
        console.error('[apollo] Rate limit exceeded');
      } else {
        console.error('[apollo] API error:', response.status, response.statusText);
      }
      return null;
    }

    const data = await response.json();
    
    if (!data.people || data.people.length === 0) {
      console.log('[apollo] No results found');
      return null;
    }

    // Take the first result (highest confidence)
    const person = data.people[0];
    console.log('[apollo] Successfully enriched lead:', person.first_name, person.last_name);

    // Convert Apollo response to our format
    const enrichedData: ApolloLeadData = {
      id: person.id,
      first_name: person.first_name,
      last_name: person.last_name,
      full_name: `${person.first_name} ${person.last_name}`.trim(),
      title: person.title,
      job_level: person.job_level || person.seniority,
      job_function: person.job_function || person.department,
      company_name: person.organization?.name,
      company_id: person.organization?.id,
      company_revenue: person.organization?.revenue,
      company_employee_count: person.organization?.employee_count,
      company_location: person.organization?.city ? `${person.organization.city}, ${person.organization.state}` : '',
      country: person.organization?.country,
      city: person.organization?.city,
      state: person.organization?.state,
      linkedin_url: person.linkedin_url,
      email: person.email,
      phone: person.phone_number,
      confidence_score: 0.8, // Apollo doesn't provide this, using default
      last_verified: new Date().toISOString(),
    };

    return enrichedData;
  } catch (error) {
    console.error('[apollo] Enrichment error:', error);
    return null;
  }
}

/**
 * Check if Apollo API is configured
 */
export function isApolloConfigured(): boolean {
  return !!APOLLO_API_KEY;
}
