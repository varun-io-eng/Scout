import type { PageExtraction } from './types.js';

export interface ScrapedSection {
  id: string;
  title: string;
  content: string;
}

export function buildScrapedSections(extraction: PageExtraction): ScrapedSection[] {
  const sections: ScrapedSection[] = [];
  const seen = new Set<string>();

  function add(id: string, title: string, content: string | undefined) {
    const text = (content || '').trim();
    if (text.length < 20) return;
    const key = text.slice(0, 200);
    if (seen.has(key)) return;
    seen.add(key);
    sections.push({ id, title, content: text });
  }

  const profileLines = [
    extraction.personName && `Name: ${extraction.personName}`,
    extraction.companyName && `Company: ${extraction.companyName}`,
    extraction.description && `Headline: ${extraction.description}`,
    extraction.industry && `Industry: ${extraction.industry}`,
    extraction.location && `Location: ${extraction.location}`,
    extraction.employeeCount && `Size: ${extraction.employeeCount}`,
    extraction.funding && `Funding: ${extraction.funding}`,
  ].filter(Boolean) as string[];

  if (profileLines.length) add('profile', 'Profile', profileLines.join('\n'));

  const hiringPosts =
    (extraction.metadata?.hiringPosts as Array<{ author: string; body: string }>) || [];
  for (let i = 0; i < hiringPosts.length; i++) {
    const p = hiringPosts[i];
    add(
      `hiring-${i}`,
      hiringPosts.length > 1 ? `Hiring post ${i + 1}` : 'Hiring post',
      p.author ? `${p.author}\n\n${p.body}` : p.body
    );
  }

  const posts =
    (extraction.metadata?.posts as Array<{ author: string; body: string; isHiring?: boolean }>) || [];
  let postNum = 1;
  for (const p of posts.filter((x) => !x.isHiring)) {
    add(
      `post-${postNum}`,
      posts.filter((x) => !x.isHiring).length > 1 ? `Post ${postNum}` : 'Post',
      p.author ? `${p.author}\n\n${p.body}` : p.body
    );
    postNum++;
  }

  const namedSections = extraction.metadata?.sections as Record<string, string> | undefined;
  if (namedSections) {
    const labels: Record<string, string> = {
      about: 'About',
      experience: 'Experience',
      education: 'Education',
      skills: 'Skills',
      activity: 'Activity',
      certifications: 'Certifications',
      jobs: 'Jobs',
      posts: 'Posts',
      people: 'People',
    };
    for (const [key, value] of Object.entries(namedSections)) {
      add(`section-${key}`, labels[key] || key, value);
    }
  }

  if (!sections.length && extraction.rawText?.trim()) {
    add('page-text', 'Page content', extraction.rawText.trim().slice(0, 8000));
  }

  return sections;
}

export function scrapedSectionsToContext(sections: ScrapedSection[]): string[] {
  return sections.map((s) => `[${s.title}]\n${s.content}`);
}
