import { hasAI, chatJson } from './ai.js';
import type { ScrapedSection } from './scraped.js';

export interface BriefChip {
  label: string;
  type: 'hiring' | 'role' | 'skill' | 'company' | 'location' | 'person' | 'signal' | 'other';
}

export interface PageBrief {
  summary: string;
  chips: BriefChip[];
  answer: string;
  highlights: string[];
}

function fallbackBrief(scraped: ScrapedSection[]): PageBrief {
  const text = scraped.map((s) => s.content).join('\n');
  const chips: BriefChip[] = [];

  if (/hiring|intern|recruiting/i.test(text)) chips.push({ label: 'Hiring', type: 'hiring' });

  return {
    summary: scraped[0]?.content.slice(0, 280) || 'No summary available.',
    chips,
    answer: '',
    highlights: scraped.slice(0, 3).map((s) => s.title),
  };
}

export async function generatePageBrief(
  scraped: ScrapedSection[],
  subjectName: string,
  question: string
): Promise<PageBrief> {
  if (!hasAI()) return { ...fallbackBrief(scraped), answer: scraped.map((s) => s.content).join('\n\n') };

  const context = scraped.map((s) => `[${s.title}]\n${s.content}`).join('\n\n---\n\n').slice(0, 14000);

  const parsed = await chatJson(
    `Analyze ONLY this scraped webpage data about "${subjectName}". Do not invent facts.

Scraped data:
${context}

User question: ${question}

Return JSON:
{
  "summary": "2-4 sentence overview for a recruiter or investor — only from scraped data",
  "chips": [{"label": "short tag max 30 chars", "type": "hiring|role|skill|company|location|person|signal|other"}],
  "answer": "Complete answer to the question. Include FULL post/job text when relevant. Do not truncate.",
  "highlights": ["key fact from scraped data", "another fact", "another fact"]
}

Max 8 chips. Every chip label must appear in the scraped data.`,
    0.2
  );

  const fb = fallbackBrief(scraped);
  return {
    summary: (parsed.summary as string) || fb.summary,
    chips: Array.isArray(parsed.chips) ? (parsed.chips as BriefChip[]).slice(0, 10) : fb.chips,
    answer: (parsed.answer as string) || '',
    highlights: Array.isArray(parsed.highlights) ? (parsed.highlights as string[]).slice(0, 5) : fb.highlights,
  };
}
