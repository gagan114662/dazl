// Intent-signal enrichment from free public sources, no paid APIs:
//   funding  - SEC EDGAR full-text search for Form D filings by company name
//              (efts.sec.gov; descriptive User-Agent is required by SEC fair-access rules)
//   hiring   - public job-board APIs: Greenhouse, Lever, Ashby (keyless, read-only)
// Results land in lead_enrichments (source URL + source date required) and never
// change the lead itself. Every failure is silent: signals are a bonus, not the bar.
import type Database from 'better-sqlite3'
import { randomBytes } from 'node:crypto'
import { addEnrichment, audit } from '../connectors/store.ts'
import { companyKey, recordCompanyEvent } from '../events/store.ts'
import { listLeads } from '../scan/store.ts'
import { classifyEntityMatch, domainSlug, withinEventWindow } from './entity-match.ts'

const TIMEOUT = 8000
const MAX_LEADS = 10
const EDGAR_UA = process.env.SEC_USER_AGENT || 'dazl/1.0 (contact: support@dazl.ai)'
const SUFFIXES = new Set(['inc', 'llc', 'ltd', 'corp', 'corporation', 'company', 'co', 'gmbh', 'sarl', 'sas', 'plc', 'lp', 'llp', 'group', 'technologies', 'technology', 'labs', 'ai', 'io'])

export function nameTokens(name: string): string[] {
  return name.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(t => t.length > 1 && !SUFFIXES.has(t))
}

export interface FundingSignal { date: string; entity: string; url: string }
export interface HiringSignal { board: string; openRoles: number; titles: string[]; url: string; via: 'domain' | 'name' }

// Latest Form D (or D/A) filing for the company within the last 18 months, but only
// when the filing entity IS the company (exact name after suffix stripping - the search
// index matches loosely, so a one-token name must not attach a same-named fund's filing).
export async function edgarFunding(company: string, fetchImpl: typeof fetch = fetch): Promise<FundingSignal | null> {
  const start = new Date(Date.now() - 548 * 86400_000).toISOString().slice(0, 10)
  const url = `https://efts.sec.gov/LATEST/search-index?q=${encodeURIComponent(`"${company.slice(0, 80)}"`)}&forms=D&dateRange=custom&startdt=${start}`
  try {
    const res = await fetchImpl(url, { headers: { 'user-agent': EDGAR_UA, accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT) })
    if (!res.ok) return null
    const data = await res.json() as { hits?: { hits?: { _id?: string; _source?: { display_names?: string[]; file_date?: string; adsh?: string; ciks?: string[] } }[] } }
    const hits = data.hits?.hits ?? []
    let best: { date: string; entity: string; url: string } | null = null
    for (const h of hits.slice(0, 20)) {
      const src = h._source
      const entity = (src?.display_names?.[0] ?? '').replace(/\s*\(CIK[^)]*\)\s*$/, '').trim()
      const date = src?.file_date ?? ''
      if (date && date < start) continue // startdt is not reliably honoured server-side
      const adsh = src?.adsh?.replace(/-/g, '') ?? ''
      const cik = String(Number(src?.ciks?.[0] ?? '')) // strip leading zeros
      const file = h._id?.split(':')[1] ?? ''
      if (!entity || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !adsh || !cik || cik === 'NaN' || !file) continue
      if (classifyEntityMatch(company, entity) !== 'heuristic') continue
      if (!best || date > best.date) best = { date, entity, url: `https://www.sec.gov/Archives/edgar/data/${cik}/${adsh}/${file}` }
    }
    return best
  } catch { return null }
}

function slugCandidates(company: string, domain: string | null): string[] {
  const out: string[] = []
  const fromDomain = (domain ?? '').toLowerCase().split('.')[0]?.replace(/[^a-z0-9]/g, '')
  if (fromDomain && fromDomain.length >= 3) out.push(fromDomain)
  const fromName = company.toLowerCase().replace(/[^a-z0-9]/g, '')
  if (fromName && fromName.length >= 3 && fromName !== fromDomain) out.push(fromName)
  return out.slice(0, 2)
}

// Job boards list the same role once per location/team, so the first three raw
// postings are often one title repeated. Dedupe case-insensitively, then cap at
// three distinct examples - the open-role count still reflects every posting.
export function topTitles<T>(jobs: T[], pick: (j: T) => string): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const j of jobs) {
    const t = pick(j).trim().slice(0, 80)
    const k = t.toLowerCase()
    if (!t || seen.has(k)) continue
    seen.add(k)
    out.push(t)
    if (out.length === 3) break
  }
  return out
}

export { withinEventWindow } from './entity-match.ts'

const get = async (url: string, fetchImpl: typeof fetch) => {
  const res = await fetchImpl(url, { headers: { 'user-agent': 'dazl/1.0', accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(TIMEOUT) })
  if (!res.ok) return null
  try { return await res.json() } catch { return null }
}

// Public job boards. Board slug guessed from the company domain (then name): a 404
// just means "no board under that slug" - no signal is recorded, nothing is faked.
export async function atsHiring(company: string, domain: string | null, fetchImpl: typeof fetch = fetch): Promise<HiringSignal | null> {
  const dom = domainSlug(domain)
  for (const slug of slugCandidates(company, domain)) {
    const via: 'domain' | 'name' = dom && slug === dom ? 'domain' : 'name'
    const gh = await get(`https://boards-api.greenhouse.io/v1/boards/${slug}/jobs`, fetchImpl)
    if (Array.isArray(gh?.jobs) && gh.jobs.length > 0) {
      const jobs = gh.jobs.filter((j: { title?: string }) => typeof j?.title === 'string')
      if (jobs.length) return { board: 'greenhouse', openRoles: jobs.length, titles: topTitles(jobs, (j: { title: string }) => j.title), url: jobs[0].absolute_url || `https://boards.greenhouse.io/${slug}`, via }
    }
    const lever = await get(`https://api.lever.co/v0/postings/${slug}?mode=json`, fetchImpl)
    if (Array.isArray(lever) && lever.length > 0) {
      const jobs = lever.filter((j: { text?: string }) => typeof j?.text === 'string')
      if (jobs.length) return { board: 'lever', openRoles: jobs.length, titles: topTitles(jobs, (j: { text: string }) => j.text), url: jobs[0].hostedUrl || `https://jobs.lever.co/${slug}`, via }
    }
    const ashby = await get(`https://api.ashbyhq.com/posting-api/job-board/${slug}`, fetchImpl)
    if (Array.isArray(ashby?.jobs) && ashby.jobs.length > 0) {
      const jobs = ashby.jobs.filter((j: { title?: string }) => typeof j?.title === 'string')
      if (jobs.length) return { board: 'ashby', openRoles: jobs.length, titles: topTitles(jobs, (j: { title: string }) => j.title), url: jobs[0].jobUrl || `https://api.ashbyhq.com/posting-api/job-board/${slug}`, via }
    }
  }
  return null
}

// Post-scan pass over a job's verified leads. Bounded, parallel within a lead,
// never throws into the runner. Audited per connector for the settings page.
export async function enrichJobSignals(db: Database.Database, tenantId: string, jobId: string, deps: { fetchImpl?: typeof fetch; creditEnrichment?: boolean } = {}): Promise<void> {
  if (process.env.SIGNALS_ENRICH === '0') return
  const fetchImpl = deps.fetchImpl ?? fetch
  const leads = (listLeads(db, tenantId, jobId, MAX_LEADS) as { id: string; company: string; company_domain: string | null }[]).filter(l => l.company)
  const { fundingNews, fundingRoundFor } = await import('./funding-round.ts')
  const news = process.env.SIGNALS_FUNDING_RSS === '0' ? [] : await fundingNews(fetchImpl).catch(() => [])
  const jinaLeft = { n: 2 }
  let funding = 0, hiring = 0, rounds = 0
  const today = new Date().toISOString().slice(0, 10)
  const now = Math.floor(Date.now() / 1000)
  for (const lead of leads) {
    // Company event write-through: the same fact, stored once per company for account-level
    // history. Skipped when no reliable company key exists - never guessed.
    const ck = companyKey(lead.company_domain, lead.id)
    const [f0, h] = await Promise.all([
      edgarFunding(lead.company, fetchImpl).catch(() => null),
      atsHiring(lead.company, lead.company_domain, fetchImpl).catch(() => null),
    ])
    // A filing far from the claimed round date is a real fact about the entity but not
    // corroboration of THIS raise (fund filings and stale filings both collide here).
    const f = f0 && withinEventWindow(f0.date, (lead as { event_date?: string | null }).event_date ?? null) ? f0 : null
    if (f) {
      addEnrichment(db, tenantId, lead.id, { connector: 'signals:sec-edgar', kind: 'funding', value: `SEC Form D filed ${f.date}`, label: f.entity.slice(0, 120), confidence: 80, source_url: f.url, source_date: f.date, retrieved_at: now })
      if (ck) recordCompanyEvent(db, tenantId, { companyKey: ck, companyName: lead.company, scope: 'account', leadId: lead.id, eventType: 'sec_filing', summary: `SEC Form D filed ${f.date}`, detail: f.entity.slice(0, 120), sourceUrl: f.url, sourcePublishedAt: f.date, retrievedAt: now, confidence: 80 })
      funding++
    }
    if (h && h.via === 'domain') {
      addEnrichment(db, tenantId, lead.id, { connector: `signals:${h.board}`, kind: 'hiring', value: `${h.openRoles} open role${h.openRoles === 1 ? '' : 's'}`, label: h.titles.join('; ').slice(0, 200) || null, confidence: 70, source_url: h.url, source_date: today, retrieved_at: now })
      if (ck) recordCompanyEvent(db, tenantId, { companyKey: ck, companyName: lead.company, scope: 'account', leadId: lead.id, eventType: 'hiring_surge', summary: `${h.openRoles} open role${h.openRoles === 1 ? '' : 's'}`, detail: h.titles.join('; ').slice(0, 200) || null, sourceUrl: h.url, sourcePublishedAt: null, retrievedAt: now, confidence: 70 })
      hiring++
    }
    const r = await fundingRoundFor(lead.company, news, { fetchImpl, jinaLeft }).catch(() => null)
    if (r && classifyEntityMatch(lead.company, r.matched) === 'heuristic') {
      const what = [r.amount, r.stage].filter(Boolean).join(' ') || 'funding'
      addEnrichment(db, tenantId, lead.id, { connector: 'signals:funding-round', kind: 'funding', value: `Funding report: ${what} (published ${r.date}; event day unknown)`.slice(0, 254), label: `${r.matched} (reported ${r.date})`.slice(0, 200), confidence: 75, source_url: r.url, source_date: r.date, retrieved_at: now })
      if (ck) recordCompanyEvent(db, tenantId, { companyKey: ck, companyName: lead.company, scope: 'account', leadId: lead.id, eventType: 'funding_round', summary: `Funding report: ${what} (published ${r.date}; event day unknown)`.slice(0, 300), detail: r.matched.slice(0, 120), sourceUrl: r.url, sourcePublishedAt: r.date, retrievedAt: now, confidence: 75 })
      rounds++
    }
  }
  audit(db, { tenantId, connector: 'signals:sec-edgar', jobId, lookup: `${leads.length} leads`, status: funding ? 'ok' : 'empty', results: funding })
  audit(db, { tenantId, connector: 'signals:ats', jobId, lookup: `${leads.length} leads`, status: hiring ? 'ok' : 'empty', results: hiring })
  audit(db, { tenantId, connector: 'signals:funding-round', jobId, lookup: `${leads.length} leads, ${news.length} raise reports`, status: rounds ? 'ok' : 'empty', results: rounds })
  // BYOK contact/firmographic pass: runs only with the tenant's own Apollo/PDL key.
  // A per-run budget control can skip this paid-credit pass for a specific run.
  if (deps.creditEnrichment !== false) {
    const { enrichLeadContacts } = await import('../enrich/index.ts')
    await enrichLeadContacts(db, tenantId, jobId, leads, { fetchImpl }).catch(() => {})
  }
}

export function newId(): string { return randomBytes(12).toString('hex') }
