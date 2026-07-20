import './load-env.js';
import OpenAI from 'openai';
import type { PageExtraction, CompanyProfile, Competitor } from './types.js';

type Provider = 'groq' | 'openai' | 'none';

function resolveProvider(): Provider {
  const groqKey = process.env.GROQ_API_KEY;
  if (groqKey && !groqKey.startsWith('gsk_your')) return 'groq';
  const openaiKey = process.env.OPENAI_API_KEY;
  if (openaiKey && !openaiKey.startsWith('sk-your')) return 'openai';
  return 'none';
}

const provider = resolveProvider();

const llm =
  provider === 'groq'
    ? new OpenAI({
        apiKey: process.env.GROQ_API_KEY,
        baseURL: 'https://api.groq.com/openai/v1',
      })
    : provider === 'openai'
      ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
      : null;

const model =
  provider === 'groq'
    ? process.env.GROQ_MODEL || 'llama-3.3-70b-versatile'
    : process.env.OPENAI_MODEL || 'gpt-4o-mini';

const embeddingModel = process.env.EMBEDDING_MODEL || 'text-embedding-3-small';

export function hasAI(): boolean {
  return provider !== 'none';
}

/** @deprecated use hasAI */
export const hasOpenAI = hasAI;

export function getProvider(): Provider {
  return provider;
}

export async function embedText(text: string): Promise<number[] | null> {
  // Groq has no embeddings API — only OpenAI supports this
  if (provider !== 'openai' || !llm) return null;
  const res = await llm.embeddings.create({
    model: embeddingModel,
    input: text.slice(0, 8000),
  });
  return res.data[0].embedding;
}

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0,
    na = 0,
    nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) + 1e-8);
}

export async function semanticSearch(
  query: string,
  chunks: Array<{ id: string; content: string; embedding?: number[] }>,
  limit = 8
): Promise<string[]> {
  const queryEmbedding = await embedText(query);
  if (!queryEmbedding) return chunks.slice(0, limit).map((c) => c.content);

  const scored = chunks
    .filter((c) => c.embedding?.length)
    .map((c) => ({
      content: c.content,
      score: cosineSimilarity(queryEmbedding, c.embedding!),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  return scored.map((s) => s.content);
}

export async function chatJson(prompt: string, temperature = 0.3): Promise<Record<string, unknown>> {
  const res = await llm!.chat.completions.create({
    model,
    messages: [{ role: 'user', content: prompt }],
    response_format: { type: 'json_object' },
    temperature,
  });
  const text = res.choices[0]?.message?.content || '{}';
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

async function chatText(system: string, user: string, temperature = 0.3): Promise<string> {
  const res = await llm!.chat.completions.create({
    model,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    temperature,
  });
  return res.choices[0]?.message?.content || 'Unable to generate an answer.';
}

export async function buildProfileFromExtraction(
  extraction: PageExtraction,
  existingContext?: string
): Promise<Partial<CompanyProfile> & { name: string }> {
  if (!hasAI()) {
    return fallbackProfile(extraction);
  }

  const prompt = `You are Scout, an AI research assistant for investors and recruiters.
Analyze this web page extraction and build a structured company/person profile.

Page data:
${JSON.stringify(extraction, null, 2)}

${existingContext ? `Existing knowledge:\n${existingContext}` : ''}

Return JSON only with this shape:
{
  "name": "company or person name",
  "domain": "website domain if known",
  "industry": "industry sector",
  "description": "2-3 sentence summary",
  "location": "hq location",
  "employeeCount": "size estimate",
  "funding": "funding info if any",
  "technologies": ["tech1", "tech2"],
  "investmentInsights": ["insight for investors"],
  "hiringInsights": ["insight for recruiters"]
}`;

  const parsed = await chatJson(prompt);
  return {
    name: (parsed.name as string) || extraction.companyName || extraction.title || 'Unknown',
    domain: parsed.domain as string | undefined,
    industry: (parsed.industry as string) || extraction.industry,
    description: (parsed.description as string) || extraction.description,
    location: (parsed.location as string) || extraction.location,
    employeeCount: (parsed.employeeCount as string) || extraction.employeeCount,
    funding: (parsed.funding as string) || extraction.funding,
    technologies: (parsed.technologies as string[]) || extraction.technologies || [],
    investmentInsights: (parsed.investmentInsights as string[]) || [],
    hiringInsights: (parsed.hiringInsights as string[]) || [],
    competitors: [],
    sources: [],
  };
}

function fallbackProfile(
  extraction: PageExtraction
): Partial<CompanyProfile> & { name: string } {
  const name =
    extraction.companyName ||
    extraction.personName ||
    extraction.title.split('|')[0].trim() ||
    'Unknown Entity';

  const insights: string[] = [];
  if (extraction.funding) insights.push(`Funding signal: ${extraction.funding}`);
  if (extraction.employeeCount) insights.push(`Team size: ${extraction.employeeCount}`);
  if (extraction.industry) insights.push(`Operates in ${extraction.industry}`);

  return {
    name,
    industry: extraction.industry,
    description: extraction.description || extraction.rawText.slice(0, 500),
    location: extraction.location,
    employeeCount: extraction.employeeCount,
    funding: extraction.funding,
    technologies: extraction.technologies || [],
    investmentInsights: insights,
    hiringInsights: extraction.technologies?.length
      ? [`Hiring likely needs: ${extraction.technologies.slice(0, 5).join(', ')}`]
      : [],
    competitors: [],
    sources: [],
  };
}

export async function detectCompetitors(
  profile: CompanyProfile,
  allCompanies: CompanyProfile[]
): Promise<Competitor[]> {
  if (!hasAI()) {
    return fallbackCompetitors(profile, allCompanies);
  }

  const others = allCompanies
    .filter((c) => c.id !== profile.id)
    .map((c) => ({ name: c.name, industry: c.industry, description: c.description }))
    .slice(0, 30);

  const prompt = `Given this company profile, identify 3-5 likely competitors from the list (or suggest new ones if none match).

Target: ${JSON.stringify({ name: profile.name, industry: profile.industry, description: profile.description, technologies: profile.technologies })}

Known companies in KB: ${JSON.stringify(others)}

Return JSON: { "competitors": [{ "name": "...", "reason": "...", "confidence": 0.0-1.0 }] }`;

  const parsed = await chatJson(prompt, 0.4);
  return (parsed.competitors as Competitor[]) || [];
}

function fallbackCompetitors(
  profile: CompanyProfile,
  allCompanies: CompanyProfile[]
): Competitor[] {
  return allCompanies
    .filter(
      (c) =>
        c.id !== profile.id &&
        c.industry &&
        profile.industry &&
        c.industry.toLowerCase() === profile.industry.toLowerCase()
    )
    .slice(0, 5)
    .map((c) => ({
      name: c.name,
      reason: `Same industry: ${c.industry}`,
      confidence: 0.6,
    }));
}

export async function answerPageQuestion(
  question: string,
  contextChunks: string[],
  subjectName: string
): Promise<string> {
  if (!hasAI()) {
    return contextChunks.join('\n\n---\n\n');
  }

  const context = contextChunks.join('\n\n---\n\n').slice(0, 16000);

  return chatText(
    `You are Scout. The user asked a question about "${subjectName}".
You are given SCRAPED DATA copied directly from the webpage — this is the only source of truth.

Rules:
- Answer using ONLY what appears in the scraped data below
- Quote relevant phrases verbatim when answering
- Do not invent roles, companies, skills, or facts not present in the scraped data
- Do not use a fixed template — write naturally based on what was actually scraped
- If the scraped data does not contain enough to answer, say exactly what was found and what was missing`,
    `Scraped data from the page:\n${context}\n\nQuestion: ${question}`
  );
}

export async function answerQuestion(
  question: string,
  contextChunks: string[],
  companyNames: string[]
): Promise<string> {
  if (!hasAI()) {
    return `Based on your research (${companyNames.length} companies, ${contextChunks.length} sources):\n\n${contextChunks.slice(0, 3).join('\n\n---\n\n')}\n\n(Add GROQ_API_KEY or OPENAI_API_KEY for natural language answers)`;
  }

  const context = contextChunks.join('\n\n---\n\n').slice(0, 12000);

  return chatText(
    `You are Scout, an AI research copilot for investors and recruiters.
Answer questions using ONLY the provided research context. Cite specific facts.
If context is insufficient, say what additional research would help.
Companies in KB: ${companyNames.join(', ')}`,
    `Context:\n${context}\n\nQuestion: ${question}`
  );
}
