import { useState, useEffect, useCallback } from 'react';
import {
  fetchCompanies,
  askQuestion,
  scrapeLinkedIn,
  applyLinkedInEdits,
  type Company,
  type AskResult,
  type LeadFields,
  type EnrichmentResult,
  type AuraConfig,
} from './api';

// ─── Types ────────────────────────────────────────────────────────────────────

type Tab = 'companies' | 'enrichment';

// ─── Main App ─────────────────────────────────────────────────────────────────

export default function App() {
  const [activeTab, setActiveTab] = useState<Tab>('enrichment');
  const [companies, setCompanies] = useState<Company[]>([]);
  const [selected, setSelected] = useState<Company | null>(null);
  const [search, setSearch] = useState('');
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState<AskResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      setError('');
      const data = await fetchCompanies();
      setCompanies(data);
      if (selected) {
        const updated = data.find((c) => c.id === selected.id);
        if (updated) setSelected(updated);
      }
    } catch {
      setError('Cannot reach Scout API. Run npm run dev:server');
    } finally {
      setLoading(false);
    }
  }, [selected]);

  useEffect(() => {
    load();
    const interval = setInterval(load, 10000);
    return () => clearInterval(interval);
  }, [load]);

  const filtered = companies.filter(
    (c) =>
      !search ||
      c.name.toLowerCase().includes(search.toLowerCase()) ||
      c.industry?.toLowerCase().includes(search.toLowerCase()),
  );

  async function handleAsk(e: React.FormEvent) {
    e.preventDefault();
    if (!question.trim()) return;
    setAsking(true);
    setAnswer(null);
    try {
      const result = await askQuestion(question);
      setAnswer(result);
    } catch {
      setError('Failed to get answer');
    } finally {
      setAsking(false);
    }
  }

  return (
    <div className="app">
      {/* ── Sidebar ─────────────────────────────────────────────────────────── */}
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-icon">🔭</span>
          <div>
            <h1>Scout</h1>
            <p>Operator Dashboard</p>
          </div>
        </div>

        {/* Nav tabs */}
        <div className="nav-tabs">
          <button
            className={`nav-tab ${activeTab === 'enrichment' ? 'active' : ''}`}
            onClick={() => setActiveTab('enrichment')}
          >
            <span>🔗</span> Lead Enrichment
          </button>
          <button
            className={`nav-tab ${activeTab === 'companies' ? 'active' : ''}`}
            onClick={() => setActiveTab('companies')}
          >
            <span>🏢</span> Companies
          </button>
        </div>

        {activeTab === 'companies' && (
          <>
            <input
              className="search-input"
              placeholder="Search companies…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <div className="company-list">
              {loading && <p className="muted">Loading…</p>}
              {error && <p className="error">{error}</p>}
              {!loading && !filtered.length && (
                <p className="muted empty-state">
                  No companies yet. Install the browser extension and scout a page.
                </p>
              )}
              {filtered.map((c) => (
                <button
                  key={c.id}
                  className={`company-item ${selected?.id === c.id ? 'active' : ''}`}
                  onClick={() => setSelected(c)}
                >
                  <strong>{c.name}</strong>
                  {c.industry && <span>{c.industry}</span>}
                </button>
              ))}
            </div>
            <div className="sidebar-footer">
              {companies.length} {companies.length === 1 ? 'company' : 'companies'} researched
            </div>
          </>
        )}
      </aside>

      {/* ── Main ────────────────────────────────────────────────────────────── */}
      <main className="main">
        {activeTab === 'enrichment' ? (
          <LeadEnrichmentPanel />
        ) : (
          <>
            {selected ? (
              <CompanyDetail company={selected} />
            ) : (
              <div className="hero">
                <h2>Your research, connected</h2>
                <p>
                  Scout builds company profiles, detects competitors, and generates investment &
                  hiring insights as you browse.
                </p>
                <div className="hero-stats">
                  <div className="stat">
                    <span className="stat-num">{companies.length}</span>
                    <span className="stat-label">Profiles</span>
                  </div>
                  <div className="stat">
                    <span className="stat-num">
                      {companies.reduce((n, c) => n + c.sources.length, 0)}
                    </span>
                    <span className="stat-label">Sources</span>
                  </div>
                  <div className="stat">
                    <span className="stat-num">
                      {companies.reduce((n, c) => n + c.competitors.length, 0)}
                    </span>
                    <span className="stat-label">Competitors</span>
                  </div>
                </div>
              </div>
            )}

            <section className="ask-section">
              <h3>Ask Scout</h3>
              <form onSubmit={handleAsk} className="ask-form">
                <input
                  value={question}
                  onChange={(e) => setQuestion(e.target.value)}
                  placeholder="Which companies are hiring for AI roles? Who are Stripe's competitors?"
                />
                <button type="submit" disabled={asking}>
                  {asking ? 'Thinking…' : 'Ask'}
                </button>
              </form>

              {answer && (
                <div className="answer-card">
                  <p className="answer-text">{answer.answer}</p>
                  {answer.sources.length > 0 && (
                    <div className="answer-sources">
                      <h4>Sources</h4>
                      {answer.sources.map((s, i) => (
                        <a key={i} href={s.url} target="_blank" rel="noreferrer">
                          {s.title}
                        </a>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </section>
          </>
        )}
      </main>
    </div>
  );
}

// ─── Lead Enrichment Panel ────────────────────────────────────────────────────

const JOB_FUNCTIONS = [
  '', 'Sales', 'Marketing', 'Engineering', 'Product Management', 'Design',
  'Finance', 'Human Resources', 'Legal', 'Operations', 'IT', 'Customer Success',
  'Analytics', 'Consulting', 'Partnerships', 'Executive', 'Founder', 'Other',
];

const JOB_LEVELS = [
  '', 'Intern', 'Junior IC', 'Individual Contributor', 'Senior IC',
  'Manager', 'Director', 'VP', 'Executive VP', 'C-Level', 'Founder / Owner',
];

interface EditRow {
  field: string;
  label: string;
  current: string;
  suggested: string;
  edited: string;
  type?: 'text' | 'select';
  options?: string[];
}

function LeadEnrichmentPanel() {
  // ── Aura connection ─────────────────────────────────────────────────────
  const [datahubUrl, setDatahubUrl] = useState(
    () => localStorage.getItem('scout_datahub_url') || '',
  );
  const [authToken, setAuthToken] = useState(
    () => localStorage.getItem('scout_auth_token') || '',
  );
  const [campaignId, setCampaignId] = useState(
    () => localStorage.getItem('scout_campaign_id') || '',
  );

  // ── Lead input ───────────────────────────────────────────────────────────
  const [leadId, setLeadId] = useState('');
  const [linkedinUrl, setLinkedinUrl] = useState('');

  // ── Additional lead fields (manual or from Aura) ─────────────────────────
  const [leadJson, setLeadJson] = useState('');

  // ── State ─────────────────────────────────────────────────────────────────
  const [scraping, setScraping] = useState(false);
  const [applying, setApplying] = useState(false);
  const [result, setResult] = useState<EnrichmentResult | null>(null);
  const [editRows, setEditRows] = useState<EditRow[]>([]);
  const [scrapeError, setScrapeError] = useState('');
  const [applySuccess, setApplySuccess] = useState('');
  const [applyError, setApplyError] = useState('');

  // Persist aura settings
  useEffect(() => { localStorage.setItem('scout_datahub_url', datahubUrl); }, [datahubUrl]);
  useEffect(() => { localStorage.setItem('scout_auth_token', authToken); }, [authToken]);
  useEffect(() => { localStorage.setItem('scout_campaign_id', campaignId); }, [campaignId]);

  function buildEditRows(r: EnrichmentResult): EditRow[] {
    const fields: Array<{ field: string; label: string; type?: 'text' | 'select'; options?: string[] }> = [
      { field: 'first_name', label: 'First Name' },
      { field: 'last_name', label: 'Last Name' },
      { field: 'job_title', label: 'Job Title' },
      { field: 'company_name', label: 'Company Name' },
      { field: 'job_function', label: 'Job Function', type: 'select', options: JOB_FUNCTIONS },
      { field: 'job_level', label: 'Job Level', type: 'select', options: JOB_LEVELS },
      { field: 'company_city', label: 'Company City' },
      { field: 'company_state', label: 'Company State' },
      { field: 'company_country', label: 'Company Country' },
      { field: 'company_revenue_size', label: 'Revenue Size' },
      { field: 'company_employee_size', label: 'Employee Size' },
    ];
    return fields.map(({ field, label, type = 'text', options }) => ({
      field,
      label,
      current: r.currentValues[field] ?? '',
      suggested: r.suggestedEdits[field] ?? '',
      edited: r.suggestedEdits[field] ?? r.currentValues[field] ?? '',
      type,
      options,
    }));
  }

  async function handleScrape() {
    setScrapeError('');
    setApplySuccess('');
    setApplyError('');
    setResult(null);
    setScraping(true);

    try {
      // Build lead object
      let lead: LeadFields = { id: Number(leadId) || 0 };
      if (linkedinUrl) lead.linkedin_url = linkedinUrl;

      // Merge any extra JSON the operator pasted
      if (leadJson.trim()) {
        try {
          const extra = JSON.parse(leadJson);
          lead = { ...extra, ...lead };
          if (!lead.linkedin_url && extra.linkedin_url) lead.linkedin_url = extra.linkedin_url;
        } catch {
          setScrapeError('Lead JSON is not valid JSON — fix it and try again.');
          setScraping(false);
          return;
        }
      }

      if (!lead.linkedin_url) {
        setScrapeError('Enter the lead\'s LinkedIn URL (or paste full lead JSON with linkedin_url).');
        setScraping(false);
        return;
      }

      const r = await scrapeLinkedIn(lead, campaignId ? Number(campaignId) : undefined);
      setResult(r);
      setEditRows(buildEditRows(r));
    } catch (err) {
      setScrapeError(err instanceof Error ? err.message : 'Scrape failed');
    } finally {
      setScraping(false);
    }
  }

  function updateRow(field: string, value: string) {
    setEditRows((rows) =>
      rows.map((r) => (r.field === field ? { ...r, edited: value } : r)),
    );
  }

  async function handleApply() {
    if (!result) return;
    setApplySuccess('');
    setApplyError('');
    setApplying(true);

    try {
      const edits: Record<string, string> = {};
      for (const row of editRows) {
        if (row.edited && row.edited !== row.current) {
          edits[row.field] = row.edited;
        }
      }

      if (!Object.keys(edits).length) {
        setApplyError('No changes to apply — all edited values match the current Aura values.');
        setApplying(false);
        return;
      }

      if (!datahubUrl || !authToken) {
        setApplyError('Enter your Aura Datahub URL and Auth Token above to apply changes.');
        setApplying(false);
        return;
      }

      const aura: AuraConfig = { datahubBaseUrl: datahubUrl, authToken };
      const r = await applyLinkedInEdits(
        Number(campaignId) || result.leadId,
        result.leadId,
        edits,
        aura,
      );

      setApplySuccess(
        `✓ Updated ${r.updatedFields.length} field${r.updatedFields.length !== 1 ? 's' : ''} in Aura: ${r.updatedFields.join(', ')}`,
      );
    } catch (err) {
      setApplyError(err instanceof Error ? err.message : 'Apply failed');
    } finally {
      setApplying(false);
    }
  }

  return (
    <div className="enrichment-panel">
      <div className="enrichment-header">
        <h2>🔗 Lead LinkedIn Enrichment</h2>
        <p className="enrichment-sub">
          Scrape a lead's LinkedIn profile to auto-fill and correct fields, then apply changes to Aura.
        </p>
      </div>

      {/* ── Setup ─────────────────────────────────────────────────────────── */}
      <div className="enrichment-section">
        <h3 className="section-label">Aura Connection <span className="badge-optional">optional — needed to apply edits</span></h3>
        <div className="form-grid-3">
          <div className="form-field">
            <label>Datahub URL</label>
            <input
              type="url"
              placeholder="https://app.zequinia.com/zequinia-datahub"
              value={datahubUrl}
              onChange={(e) => setDatahubUrl(e.target.value)}
              className="input-mono"
            />
          </div>
          <div className="form-field">
            <label>Auth Token</label>
            <input
              type="password"
              placeholder="Bearer token from Aura"
              value={authToken}
              onChange={(e) => setAuthToken(e.target.value)}
              className="input-mono"
            />
          </div>
          <div className="form-field">
            <label>Campaign ID</label>
            <input
              type="number"
              placeholder="e.g. 42"
              value={campaignId}
              onChange={(e) => setCampaignId(e.target.value)}
            />
          </div>
        </div>
      </div>

      {/* ── Lead Input ────────────────────────────────────────────────────── */}
      <div className="enrichment-section">
        <h3 className="section-label">Lead to Enrich</h3>
        <div className="form-grid-2">
          <div className="form-field">
            <label>Lead ID</label>
            <input
              type="number"
              placeholder="e.g. 12345"
              value={leadId}
              onChange={(e) => setLeadId(e.target.value)}
            />
          </div>
          <div className="form-field">
            <label>LinkedIn URL</label>
            <input
              type="url"
              placeholder="https://linkedin.com/in/johndoe"
              value={linkedinUrl}
              onChange={(e) => setLinkedinUrl(e.target.value)}
            />
          </div>
        </div>
        <div className="form-field mt-8">
          <label>
            Paste Lead JSON <span className="label-hint">(optional — paste the full lead object from Aura to pre-fill current values)</span>
          </label>
          <textarea
            className="lead-json-input"
            placeholder={'{ "id": 123, "linkedin_url": "...", "job_title": "...", ... }'}
            value={leadJson}
            onChange={(e) => setLeadJson(e.target.value)}
            rows={3}
          />
        </div>

        <button
          className={`btn-scrape ${scraping ? 'loading' : ''}`}
          onClick={handleScrape}
          disabled={scraping}
        >
          {scraping ? (
            <><span className="spinner" /> Scraping LinkedIn…</>
          ) : (
            <><span>🔍</span> Scrape LinkedIn Profile</>
          )}
        </button>

        {scrapeError && (
          <div className="alert alert-error">
            <strong>Error:</strong> {scrapeError}
            {scrapeError.includes('APIFY_API_TOKEN') || scrapeError.includes('LINKEDIN_LI_AT') ? (
              <div className="alert-help">
                <p><strong>To fix:</strong> Add credentials to <code>server/.env</code>:</p>
                <ul>
                  <li><strong>Option A (Apify):</strong> Sign up free at <a href="https://apify.com" target="_blank" rel="noreferrer">apify.com</a> → Settings → Integrations → API token → add <code>APIFY_API_TOKEN=apify_api_...</code></li>
                  <li><strong>Option B (Free cookie):</strong> Log into LinkedIn → Browser DevTools → Application → Cookies → copy <code>li_at</code> value → add <code>LINKEDIN_LI_AT=AQE...</code></li>
                </ul>
                <p>Restart the Scout server after editing <code>.env</code>.</p>
              </div>
            ) : null}
          </div>
        )}
      </div>

      {/* ── Results ───────────────────────────────────────────────────────── */}
      {result && (
        <>
          <div className="enrichment-section">
            <div className="result-meta">
              <h3 className="section-label">
                Results for <strong>{result.scraped.personName || result.linkedinUrl}</strong>
              </h3>
              <span className={`provider-badge provider-${result.provider.replace('-', '_')}`}>
                via {result.provider}
              </span>
            </div>

            {result.scraped.headline && (
              <p className="scraped-headline">"{result.scraped.headline}"</p>
            )}
            {result.scraped.about && (
              <p className="scraped-about">{result.scraped.about}</p>
            )}
          </div>

          {/* ── Field comparison table ───────────────────────────────────── */}
          <div className="enrichment-section">
            <h3 className="section-label">
              Field Comparison &amp; Edit
              <span className="label-hint"> — orange = changed from LinkedIn, green = matches LinkedIn</span>
            </h3>

            <div className="field-table">
              <div className="field-table-header">
                <span>Field</span>
                <span>Current in Aura</span>
                <span>Scraped from LinkedIn</span>
                <span>Apply Value</span>
              </div>

              {editRows.map((row) => {
                const hasChange = row.current !== row.suggested && row.suggested;
                const editChanged = row.edited !== row.current;
                return (
                  <div
                    key={row.field}
                    className={`field-row ${hasChange ? 'row-changed' : 'row-same'}`}
                  >
                    <span className="field-label">{row.label}</span>
                    <span className={`field-current ${hasChange ? 'value-old' : ''}`}>
                      {row.current || <em className="empty-val">—</em>}
                    </span>
                    <span className={`field-suggested ${hasChange ? 'value-new' : ''}`}>
                      {row.suggested || <em className="empty-val">—</em>}
                    </span>
                    <div className={`field-edit ${editChanged ? 'edit-modified' : ''}`}>
                      {row.type === 'select' ? (
                        <select
                          value={row.edited}
                          onChange={(e) => updateRow(row.field, e.target.value)}
                        >
                          {(row.options ?? []).map((o) => (
                            <option key={o} value={o}>{o || '— keep current —'}</option>
                          ))}
                        </select>
                      ) : (
                        <input
                          type="text"
                          value={row.edited}
                          onChange={(e) => updateRow(row.field, e.target.value)}
                          placeholder="Edit value…"
                        />
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* ── Apply ──────────────────────────────────────────────────────── */}
          <div className="enrichment-section apply-section">
            <button
              className={`btn-apply ${applying ? 'loading' : ''}`}
              onClick={handleApply}
              disabled={applying}
            >
              {applying ? (
                <><span className="spinner" /> Applying to Aura…</>
              ) : (
                <><span>✓</span> Apply Changes to Aura</>
              )}
            </button>

            {applySuccess && (
              <div className="alert alert-success">{applySuccess}</div>
            )}
            {applyError && (
              <div className="alert alert-error">{applyError}</div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

// ─── Company Detail ───────────────────────────────────────────────────────────

function CompanyDetail({ company }: { company: Company }) {
  return (
    <article className="detail">
      <header className="detail-header">
        <h2>{company.name}</h2>
        {company.industry && <span className="badge">{company.industry}</span>}
      </header>

      {company.description && <p className="description">{company.description}</p>}

      <div className="detail-grid">
        {company.location && (
          <div className="detail-item">
            <label>Location</label>
            <span>{company.location}</span>
          </div>
        )}
        {company.employeeCount && (
          <div className="detail-item">
            <label>Size</label>
            <span>{company.employeeCount}</span>
          </div>
        )}
        {company.funding && (
          <div className="detail-item">
            <label>Funding</label>
            <span>{company.funding}</span>
          </div>
        )}
        {company.domain && (
          <div className="detail-item">
            <label>Domain</label>
            <span>{company.domain}</span>
          </div>
        )}
      </div>

      {company.technologies.length > 0 && (
        <section className="detail-section">
          <h3>Technologies</h3>
          <div className="tags">
            {company.technologies.map((t) => (
              <span key={t} className="tag">
                {t}
              </span>
            ))}
          </div>
        </section>
      )}

      {company.competitors.length > 0 && (
        <section className="detail-section">
          <h3>Competitors</h3>
          <ul className="insight-list">
            {company.competitors.map((c) => (
              <li key={c.name}>
                <strong>{c.name}</strong>
                <span>{c.reason}</span>
                <em>{Math.round(c.confidence * 100)}% confidence</em>
              </li>
            ))}
          </ul>
        </section>
      )}

      {company.investmentInsights.length > 0 && (
        <section className="detail-section">
          <h3>Investment insights</h3>
          <ul className="bullet-list">
            {company.investmentInsights.map((insight, i) => (
              <li key={i}>{insight}</li>
            ))}
          </ul>
        </section>
      )}

      {company.hiringInsights.length > 0 && (
        <section className="detail-section">
          <h3>Hiring insights</h3>
          <ul className="bullet-list">
            {company.hiringInsights.map((insight, i) => (
              <li key={i}>{insight}</li>
            ))}
          </ul>
        </section>
      )}

      {company.sources.length > 0 && (
        <section className="detail-section">
          <h3>Sources ({company.sources.length})</h3>
          <ul className="source-list">
            {company.sources.map((s, i) => (
              <li key={i}>
                <a href={s.url} target="_blank" rel="noreferrer">
                  {s.title}
                </a>
                <span className="source-type">{s.sourceType}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </article>
  );
}
