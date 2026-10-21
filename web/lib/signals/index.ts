// Intent-signal enrichment from free public sources, no paid APIs:
//   funding  - SEC EDGAR full-text search for Form D filings by company name
//              (efts.sec.gov; descriptive User-Agent is required by SEC fair-access rules)
//   hiring   - public job-board APIs: Greenhouse, Lever, Ashby (keyless, read-only)
// Results land in lead_enrichments (source URL + source date required) and never
// change the lead itself. Every failure is silent: signals are a bonus, not the bar.
import type Database from 'better-sqlite3'
import { randomBytes } from 'node:crypto'
import { addEnrichment, audit } from '../connectors/store.ts'
import { listLeads } from '../scan/store.ts'

const TIMEOUT = 8000
const MAX_LEADS = 10
const EDGAR_UA = process.env.SEC_USER_AGENT || 'dazl/1.0 (contact: support@dazl.ai)'
const SUFFIXES = new Set(['inc', 'llc', 'ltd', 'corp', 'corporation', 'company', 'co', 'gmbh', 'sarl', 'sas', 'plc', 'lp', 'llp', 'group', 'technologies', 'technology', 'labs', 'ai', 'io'])

export function nameTokens(name: string): string[] {
  return name.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(t => t.length > 1 && !SUFFIXES.has(t))
}

function tokensMatch(company: string, entityName: string): boolean {
  const want = nameTokens(company)
  if (!want.length) return false
  const have = new Set(nameTokens(entityName))
  return want.every(t => have.has(t))
}

export interface FundingSignal { date: string; entity: string; url: string }
export interface HiringSignal { board: string; openRoles: number; titles: string[]; url: string }

// Latest Form D (or D/A) filing for the company within the last 18 months, if the
// entity name actually matches (token overlap - the search index matches loosely).
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
      const adsh = src?.adsh?.replace(/-/g, '') ?? ''
      const cik = String(Number(src?.ciks?.[0] ?? '')) // strip leading zeros
      const file = h._id?.split(':')[1] ?? ''
      if (!entity || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !adsh || !cik || cik === 'NaN' || !file) continue
      if (!tokensMatch(company, entity)) continue
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

const get = async (url: string, fetchImpl: typeof fetch) => {
  const res = await fetchImpl(url, { headers: { 'user-agent': 'dazl/1.0', accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(TIMEOUT) })
  if (!res.ok) return null
  try { return await res.json() } catch { return null }
}

// Public job boards. Board slug guessed from the company domain (then name): a 404
// just means "no board under that slug" - no signal is recorded, nothing is faked.
export async function atsHiring(company: string, domain: string | null, fetchImpl: typeof fetch = fetch): Promise<HiringSignal | null> {
  for (const slug of slugCandidates(company, domain)) {
    const gh = await get(`https://boards-api.greenhouse.io/v1/boards/${slug}/jobs`, fetchImpl)
    if (Array.isArray(gh?.jobs) && gh.jobs.length > 0) {
      const jobs = gh.jobs.filter((j: { title?: string }) => typeof j?.title === 'string')
      if (jobs.length) return { board: 'greenhouse', openRoles: jobs.length, titles: jobs.slice(0, 3).map((j: { title: string }) => j.title.slice(0, 80)), url: jobs[0].absolute_url || `https://boards.greenhouse.io/${slug}` }
    }
    const lever = await get(`https://api.lever.co/v0/postings/${slug}?mode=json`, fetchImpl)
    if (Array.isArray(lever) && lever.length > 0) {
      const jobs = lever.filter((j: { text?: string }) => typeof j?.text === 'string')
      if (jobs.length) return { board: 'lever', openRoles: jobs.length, titles: jobs.slice(0, 3).map((j: { text: string }) => j.text.slice(0, 80)), url: jobs[0].hostedUrl || `https://jobs.lever.co/${slug}` }
    }
    const ashby = await get(`https://api.ashbyhq.com/posting-api/job-board/${slug}`, fetchImpl)
    if (Array.isArray(ashby?.jobs) && ashby.jobs.length > 0) {
      const jobs = ashby.jobs.filter((j: { title?: string }) => typeof j?.title === 'string')
      if (jobs.length) return { board: 'ashby', openRoles: jobs.length, titles: jobs.slice(0, 3).map((j: { title: string }) => j.title.slice(0, 80)), url: jobs[0].jobUrl || `https://api.ashbyhq.com/posting-api/job-board/${slug}` }
    }
  }
  return null
}

// Post-scan pass over a job's verified leads. Bounded, parallel within a lead,
// never throws into the runner. Audited per connector for the settings page.
export async function enrichJobSignals(db: Database.Database, tenantId: string, jobId: string, deps: { fetchImpl?: typeof fetch } = {}): Promise<void> {
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
    const [f, h] = await Promise.all([
      edgarFunding(lead.company, fetchImpl).catch(() => null),
      atsHiring(lead.company, lead.company_domain, fetchImpl).catch(() => null),
    ])
    if (f) {
      addEnrichment(db, tenantId, lead.id, { connector: 'signals:sec-edgar', kind: 'funding', value: `SEC Form D filed ${f.date}`, label: f.entity.slice(0, 120), confidence: 80, source_url: f.url, source_date: f.date, retrieved_at: now })
      funding++
    }
    if (h) {
      addEnrichment(db, tenantId, lead.id, { connector: `signals:${h.board}`, kind: 'hiring', value: `${h.openRoles} open role${h.openRoles === 1 ? '' : 's'}`, label: h.titles.join('; ').slice(0, 200) || null, confidence: 70, source_url: h.url, source_date: today, retrieved_at: now })
      hiring++
    }
    const r = await fundingRoundFor(lead.company, news, { fetchImpl, jinaLeft }).catch(() => null)
    if (r) {
      const what = [r.amount, r.stage].filter(Boolean).join(' ') || 'funding'
      addEnrichment(db, tenantId, lead.id, { connector: 'signals:funding-round', kind: 'funding', value: `Raised ${what} ${r.daysAgo} day${r.daysAgo === 1 ? '' : 's'} ago`.slice(0, 254), label: `reported ${r.date}`, confidence: 75, source_url: r.url, source_date: r.date, retrieved_at: now })
      rounds++
    }
  }
  audit(db, { tenantId, connector: 'signals:sec-edgar', jobId, lookup: `${leads.length} leads`, status: funding ? 'ok' : 'empty', results: funding })
  audit(db, { tenantId, connector: 'signals:ats', jobId, lookup: `${leads.length} leads`, status: hiring ? 'ok' : 'empty', results: hiring })
  audit(db, { tenantId, connector: 'signals:funding-round', jobId, lookup: `${leads.length} leads, ${news.length} raise reports`, status: rounds ? 'ok' : 'empty', results: rounds })
}

export function newId(): string { return randomBytes(12).toString('hex') }
