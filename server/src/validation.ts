/**
 * Lead Field Validation
 * Validates that all required fields are present and meet quality standards
 */

export interface ValidatedLead {
  is_valid: boolean;
  missing_fields: string[];
  confidence: number;
  data: {
    name: string;
    job_level: string;
    job_function: string;
    job_title: string;
    company_name: string;
    revenue: string;
    company_location: string;
    country: string;
    city: string;
    state: string;
  };
}

export interface LeadData {
  name?: string;
  first_name?: string;
  last_name?: string;
  job_level?: string;
  job_function?: string;
  job_title?: string;
  title?: string;
  company_name?: string;
  company?: string;
  revenue?: string;
  company_location?: string;
  location?: string;
  country?: string;
  city?: string;
  state?: string;
}

/**
 * Validate lead data against required fields
 */
export function validateLeadData(data: LeadData): ValidatedLead {
  const requiredFields = [
    'name',
    'job_level',
    'job_function',
    'job_title',
    'company_name',
    'revenue',
    'company_location',
    'country',
    'city',
    'state',
  ];

  const missingFields: string[] = [];
  const validatedData: any = {};

  // Normalize name
  const name = data.name || (data.first_name && data.last_name ? `${data.first_name} ${data.last_name}` : '');
  if (!name || name.trim().length < 2) {
    missingFields.push('name');
  } else {
    validatedData.name = name.trim();
  }

  // Normalize job title
  const jobTitle = data.job_title || data.title || '';
  if (!jobTitle || jobTitle.trim().length < 2) {
    missingFields.push('job_title');
  } else {
    validatedData.job_title = jobTitle.trim();
  }

  // Validate job level
  const jobLevel = data.job_level || '';
  if (!jobLevel || jobLevel.trim().length < 2) {
    missingFields.push('job_level');
  } else {
    validatedData.job_level = jobLevel.trim();
  }

  // Validate job function
  const jobFunction = data.job_function || '';
  if (!jobFunction || jobFunction.trim().length < 2) {
    missingFields.push('job_function');
  } else {
    validatedData.job_function = jobFunction.trim();
  }

  // Validate company name
  const companyName = data.company_name || data.company || '';
  if (!companyName || companyName.trim().length < 2) {
    missingFields.push('company_name');
  } else {
    validatedData.company_name = companyName.trim();
  }

  // Validate revenue
  const revenue = data.revenue || '';
  if (!revenue || revenue.trim().length < 1) {
    missingFields.push('revenue');
  } else {
    validatedData.revenue = revenue.trim();
  }

  // Validate company location
  const companyLocation = data.company_location || data.location || '';
  if (!companyLocation || companyLocation.trim().length < 2) {
    missingFields.push('company_location');
  } else {
    validatedData.company_location = companyLocation.trim();
  }

  // Validate country
  const country = data.country || '';
  if (!country || country.trim().length < 2) {
    missingFields.push('country');
  } else {
    validatedData.country = country.trim();
  }

  // Validate city
  const city = data.city || '';
  if (!city || city.trim().length < 2) {
    missingFields.push('city');
  } else {
    validatedData.city = city.trim();
  }

  // Validate state
  const state = data.state || '';
  if (!state || state.trim().length < 2) {
    missingFields.push('state');
  } else {
    validatedData.state = state.trim();
  }

  // Calculate confidence based on missing fields
  const confidence = 1 - (missingFields.length / requiredFields.length);

  return {
    is_valid: missingFields.length === 0,
    missing_fields: missingFields,
    confidence: Math.max(0, confidence),
    data: validatedData,
  };
}

/**
 * Check if lead data is fresh enough (not stale)
 */
export function isDataFresh(lastVerified: string | undefined, maxAgeDays: number = 90): boolean {
  if (!lastVerified) return false;
  
  const verifiedDate = new Date(lastVerified);
  const now = new Date();
  const daysSinceVerification = (now.getTime() - verifiedDate.getTime()) / (1000 * 60 * 60 * 24);
  
  return daysSinceVerification <= maxAgeDays;
}
