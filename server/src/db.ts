import fs from 'fs';
import path from 'path';
import { v4 as uuid } from 'uuid';
import type { CompanyProfile, KnowledgeChunk, SourceRef } from './types.js';

const dbPath = process.env.DATABASE_PATH || './data/scout.json';
const dir = path.dirname(dbPath);
if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

interface Store {
  companies: CompanyProfile[];
  chunks: KnowledgeChunk[];
}

function load(): Store {
  if (!fs.existsSync(dbPath)) return { companies: [], chunks: [] };
  try {
    return JSON.parse(fs.readFileSync(dbPath, 'utf-8')) as Store;
  } catch {
    return { companies: [], chunks: [] };
  }
}

function save(store: Store): void {
  fs.writeFileSync(dbPath, JSON.stringify(store, null, 2));
}

export function findCompanyByName(name: string): CompanyProfile | null {
  const store = load();
  return store.companies.find((c) => c.name.toLowerCase() === name.trim().toLowerCase()) ?? null;
}

export function findCompanyById(id: string): CompanyProfile | null {
  const store = load();
  return store.companies.find((c) => c.id === id) ?? null;
}

export function listCompanies(): CompanyProfile[] {
  return load().companies.sort(
    (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
  );
}

export function upsertCompany(
  profile: Omit<CompanyProfile, 'id' | 'createdAt' | 'updatedAt'> & { id?: string }
): CompanyProfile {
  const store = load();
  const now = new Date().toISOString();
  const existing = store.companies.find(
    (c) => c.name.toLowerCase() === profile.name.trim().toLowerCase()
  );

  if (existing) {
    const merged: CompanyProfile = {
      ...existing,
      domain: profile.domain || existing.domain,
      industry: profile.industry || existing.industry,
      description: profile.description || existing.description,
      location: profile.location || existing.location,
      employeeCount: profile.employeeCount || existing.employeeCount,
      funding: profile.funding || existing.funding,
      technologies: [...new Set([...existing.technologies, ...profile.technologies])],
      competitors: profile.competitors.length ? profile.competitors : existing.competitors,
      investmentInsights: profile.investmentInsights.length
        ? profile.investmentInsights
        : existing.investmentInsights,
      hiringInsights: profile.hiringInsights.length ? profile.hiringInsights : existing.hiringInsights,
      sources: [...existing.sources, ...profile.sources],
      updatedAt: now,
    };
    store.companies = store.companies.map((c) => (c.id === existing.id ? merged : c));
    save(store);
    return merged;
  }

  const created: CompanyProfile = {
    id: profile.id || uuid(),
    name: profile.name,
    domain: profile.domain,
    industry: profile.industry,
    description: profile.description,
    location: profile.location,
    employeeCount: profile.employeeCount,
    funding: profile.funding,
    technologies: profile.technologies,
    competitors: profile.competitors,
    investmentInsights: profile.investmentInsights,
    hiringInsights: profile.hiringInsights,
    sources: profile.sources,
    createdAt: now,
    updatedAt: now,
  };
  store.companies.push(created);
  save(store);
  return created;
}

export function addKnowledgeChunk(
  chunk: Omit<KnowledgeChunk, 'id' | 'createdAt'>
): KnowledgeChunk {
  const store = load();
  const id = uuid();
  const createdAt = new Date().toISOString();
  const created: KnowledgeChunk = { ...chunk, id, createdAt };
  store.chunks.push(created);
  save(store);
  return created;
}

export function getAllChunks(): KnowledgeChunk[] {
  return load().chunks.sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  );
}

export function searchChunksKeyword(query: string, limit = 10): KnowledgeChunk[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const all = getAllChunks();
  return all
    .map((chunk) => {
      const text = chunk.content.toLowerCase();
      const score = terms.reduce((s, t) => s + (text.includes(t) ? 1 : 0), 0);
      return { chunk, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => x.chunk);
}

export function addSourceToCompany(companyId: string, source: SourceRef): void {
  const store = load();
  const company = store.companies.find((c) => c.id === companyId);
  if (!company) return;
  company.sources.push(source);
  company.updatedAt = new Date().toISOString();
  save(store);
}
