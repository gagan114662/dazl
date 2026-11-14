// #1102: the grounded named-person step of a scan. For the leads that still name nobody after the crawl and the profile search, ONE
// grounded lookup each (lib/people/contact-research.ts: at most 2 searches, 1 page read, 1 Haiku call; every field checked in code
// against the text of a source that was shown). A person is stored only when the lookup keeps one, with the source it was read from.
// Only a lead with a CONFIRMED website is looked up: off the company's own site a source must name that website to count (Hermes decision
// on #1164), so a lead with no website can never keep a person and no search or model call is spent on it (counted: no_website). The website
// is the lead's confirmed one, or the site its own source page is on (sourceOwnSite). A site that refused the scan's fetch is searched, never read.
// A lead with no website at all is still looked up when the page it was found on can be read (a press release, a news story): only that page, no search.
// Inside the scan's own caps: at most MAX_LEADS leads, one lookup per company, a wall-clock deadline, and the scan's spend ledger
// still binds every search and model call (a refusal stops the pass, it is not an error).
import type Database from 'better-sqlite3'
import { addEnrichment } from '../connectors/store.ts'
import { SpendAccountingFailed, SpendRefused } from '../llm/spend-guard.ts'
import type { Provider } from '../llm/provider.ts'
import { companyKey } from '../scan/evidence.ts'
import { domainConfirmed } from '../signals/domain-basis.ts'
import { findCompanySitesWithBasis } from '../connectors/sitecrawl.ts'
import { leadPerson } from './lead-person.ts'
import { researchContact, MAX_READS, MAX_SEARCHES, type ResearchResult } from './contact-research.ts'
import { limits } from '../search/tinyfish.ts'
import { NOT_GRADED_OUT, ROWS_SQL, SEARCHABLE_SQL } from './people-search.ts'

// The lead's SOURCE page is on the company's own site (the page the lead was found on is hosted on a domain named after the company): that site is
// the company's, by the same test the crawl uses for its strongest basis (evidence_own_domain). Nothing is guessed and nothing is fetched to decide
// it. The crawl records no website when that page blocked it (blocked_by_site / needs_javascript), which left such a lead with no way to a person.
// "&" in a name is "and" in a host name ("HD Roofing & Repairs" at hdroofingandrepairs.com).
export function sourceOwnSite(company: string, sourceUrl: string | null): string | null {
  if (!sourceUrl) return null
  const flat = (x: string) => x.toLowerCase().replace(/[^a-z0-9]+/g, '')
  for (const name of [company, company.replace(/\s*&\s*/g, ' and ')]) {
    const own = findCompanySitesWithBasis(name, '', sourceUrl).find(o => o.basis === 'evidence_own_domain')
    // EXACTLY the company's name, never a shorter word it starts with: "Greenhouse Cafe" found on boards.greenhouse.io, "Fortune Dental" in a
    // fortune.com story and "Breezy Bakery" on breezybakery.breezy.hr are on someone else's site (the crawl's looser match is checked against the
    // homepage afterwards; nothing is fetched here, so the name must match whole).
    if (own && flat(own.site.split('.')[0]) === flat(name)) return own.site
  }
  return null
}
const BLOCKED = new Set(['blocked_by_site', 'needs_javascript'])
// The lead's own source page can be read for the person it names (a press release, a news story) unless it is a social network (never requested:
// LinkedIn above all) or it already refused the scan.
const NEVER_READ = /(?:^|\.)(?:(?:linkedin|facebook|instagram|twitter|x|tiktok|youtube)\.com|lnkd\.in|youtu\.be|t\.co|fb\.me)$/i
// ... and only for a ready lead or one held for its DATE: any other hold (the quote not confirmed, a source awaiting review, a login wall) means the
// page is not yet established as this lead's evidence, so it is neither read again nor trusted to name the person.
const EVIDENCE_OK = (hold: string | null) => hold === null || /^(?:outside_window|event_)/.test(hold)
export const readableSource = (url: string | null, hold: string | null): string | null => { try { const u = new URL(url ?? ''); return (u.protocol === 'https:' || u.protocol === 'http:') && !NEVER_READ.test(u.hostname.toLowerCase().replace(/\.+$/, '')) && EVIDENCE_OK(hold) ? u.toString() : null } catch { return null } }

export const GROUNDED_CONNECTOR = 'research:person'
export const GROUNDED_LABEL = 'quoted from a public source the lookup read (not verified as current staff)'
export const MAX_LEADS = 5          // lookups per scan, best leads first
export const CONCURRENCY = 3
export const DEADLINE_MS = 100_000  // the whole pass; a scan must finish in minutes

export interface GroundedStats { eligible: number; own_source: number; source_page: number; no_website: number; looked_up: number; found: number; none: number; refused: Record<string, number>; failed: Record<string, number> }
export const newGroundedStats = (): GroundedStats => ({ eligible: 0, own_source: 0, source_page: 0, no_website: 0, looked_up: 0, found: 0, none: 0, refused: {}, failed: {} })
export interface GroundedOpts { provider: Provider; apiKey: string; env?: Record<string, string | undefined>; fetchImpl?: typeof fetch; now?: number; maxLeads?: number; deadlineMs?: number; alive?: () => boolean; stats?: GroundedStats; onStop?: (why: string) => void }

export async function findGroundedPeople(db: Database.Database, tenantId: string, jobId: string, deps: GroundedOpts): Promise<number> {
  let stored = 0
  const stats = deps.stats ?? newGroundedStats()
  try {
    const j = db.prepare('SELECT icp FROM scan_jobs WHERE id = ? AND user_id = ?').get(jobId, tenantId) as { icp: string | null } | undefined
    const who = j?.icp ? (JSON.parse(j.icp) as { who?: unknown; where?: unknown }) : null
    const strs = (v: unknown) => Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
    const roles = strs(who?.who), where = strs(who?.where)
    if (roles.length === 0) return 0
    const roleText = roles.join('; ')
    const now = deps.now ?? Date.now()
    const leads = db.prepare(`SELECT id, company, company_domain, source_url, review_reason FROM leads WHERE scan_job_id = ? AND scan_job_id IN (SELECT id FROM scan_jobs WHERE user_id = ?) AND ${SEARCHABLE_SQL} AND quarantined_at IS NULL AND company <> '' ${NOT_GRADED_OUT} ORDER BY (review_reason IS NOT NULL), COALESCE(fit, 0) DESC, id`).all(jobId, tenantId) as { id: string; company: string; company_domain: string | null; source_url: string | null; review_reason: string | null }[]
    const rowsOf = db.prepare(ROWS_SQL)
    const seen = new Set<string>()
    const todo: { id: string; company: string; domain: string | null; confirmed: boolean; evidence: string | null; read: boolean }[] = []
    for (const l of leads) {
      const ck = companyKey(l.company); if (seen.has(ck)) continue   // one lookup per company; claimed only by a lead that is looked up (below)
      if (leadPerson(rowsOf.all(l.id, tenantId), roleText, now)) continue   // already names its person: nothing to look up
      const confirmed = l.company_domain && domainConfirmed(db, tenantId, l.id, l.company_domain) ? l.company_domain : null
      const domain = confirmed ?? sourceOwnSite(l.company, l.source_url)
      // No website: the page the lead was found on is still its own evidence, and may name the person (one page read, one model call, no search).
      const evidence = readableSource(l.source_url, l.review_reason)
      if (!domain && !evidence) { stats.no_website++; continue }
      if (todo.length >= (deps.maxLeads ?? MAX_LEADS)) continue
      seen.add(ck)
      if (!domain) stats.source_page++; else if (!confirmed) stats.own_source++
      // A lead held because its page refused the scan's fetch: its site is searched, and no page of it is requested again.
      todo.push({ id: l.id, company: l.company, domain, confirmed: !!confirmed, evidence, read: !(l.review_reason !== null && BLOCKED.has(l.review_reason)) })
    }
    stats.eligible = todo.length
    const deadline = Date.now() + (deps.deadlineMs ?? DEADLINE_MS)
    let stop: string | null = null, next = 0, expired = false
    // ONE count for the whole pass (as the people search has): at most 2 searches and 1 read per lookup, and never more than an operator's own
    // per-scan TinyFish limits when those are set. The tenant / global daily caps, the per-minute rate and the scan's spend ledger bind as always.
    const env = deps.env ?? process.env, n = Math.max(1, todo.length)
    const budget = { spent: { searches: 0, fetches: 0 },
      searches: env.TINYFISH_SEARCHES_PER_SCAN !== undefined ? Math.min(n * MAX_SEARCHES, limits(env).searchesPerScan) : n * MAX_SEARCHES,
      fetches: env.TINYFISH_FETCHES_PER_SCAN !== undefined ? Math.min(n * MAX_READS, limits(env).fetchesPerScan) : n * MAX_READS }
    const one = async (l: (typeof todo)[number]) => {
      stats.looked_up++
      let r: ResearchResult
      try { r = await researchContact({ company: l.company, domain: l.domain, domainConfirmed: l.confirmed, roles, where, evidenceUrl: l.evidence }, { db, tenantId, provider: deps.provider, apiKey: deps.apiKey, env: deps.env, fetchImpl: deps.fetchImpl, readPages: l.read, budget, signal: AbortSignal.timeout(Math.max(1_000, deadline - Date.now())) }) }
      catch (e) {
        if (e instanceof SpendRefused) { stop ??= `spend:${e.reason}`; stats.failed[`spend_${e.reason}`] = (stats.failed[`spend_${e.reason}`] ?? 0) + 1; return }
        if (e instanceof SpendAccountingFailed) { stop ??= 'spend_unsaved'; stats.failed.spend_unsaved = (stats.failed.spend_unsaved ?? 0) + 1; return }   // a cost that could not be saved: no further paid call in this pass
        stats.failed.error = (stats.failed.error ?? 0) + 1; return
      }
      if (expired) return   // the pass ended while this lookup was in flight (its model call has its own, longer timeout): nothing is written late
      if (r.status === 'found' && r.person) {
        if (deps.alive && !deps.alive()) { stop ??= 'ownership_lost'; return }   // re-checked before the write: another process may hold the job now
        const p = r.person
        addEnrichment(db, tenantId, l.id, { connector: GROUNDED_CONNECTOR, kind: 'person', value: `${p.name}, ${p.title}`.slice(0, 120), label: GROUNDED_LABEL, confidence: null, source_url: (p.linkedin ?? p.source_url).split('?')[0].slice(0, 500), source_date: new Date(now).toISOString().slice(0, 10), retrieved_at: Math.floor(now / 1000) })
        stored++; stats.found++
      } else if (r.status === 'none') stats.none++
      else if (r.status === 'not_grounded') stats.refused[r.refused ?? 'other'] = (stats.refused[r.refused ?? 'other'] ?? 0) + 1
      else stats.failed[r.refused ?? r.status] = (stats.failed[r.refused ?? r.status] ?? 0) + 1
    }
    const worker = async () => { for (;;) { if (stop || Date.now() >= deadline) { stop ??= 'deadline'; return } if (deps.alive && !deps.alive()) { stop ??= 'ownership_lost'; return } const l = todo[next++]; if (!l) return; await one(l) } }
    // The deadline bounds the PASS: a lookup still in flight then is left behind (never awaited further, never written; expired).
    let timer: ReturnType<typeof setTimeout> | undefined
    await Promise.race([Promise.all(Array.from({ length: Math.min(CONCURRENCY, todo.length) }, worker)), new Promise<void>(res => { timer = setTimeout(() => { expired = true; stop ??= 'deadline'; res() }, Math.max(0, deadline - Date.now()) + 2_000) })]).finally(() => clearTimeout(timer))
    if (stop) deps.onStop?.(stop)
    return stored
  } catch (e) {
    console.error('grounded people failed', e instanceof Error ? e.message : 'error')
    deps.onStop?.('error')
    return stored
  }
}

// Whether the scan runs the step at all, and why not (the runner's trace note). Kill switch GROUNDED_PEOPLE_ENABLED=0; no search provider; the
// operator's first-play people-search switch at 0; a scan on another vendor's key (the lookup asks for an Anthropic model); a free-trial scan.
export function groundedPeopleSkip(o: { env?: Record<string, string | undefined>; searchEnabled: boolean; peopleCap: number | null; vendor: string; trial: boolean }): string | null {
  if ((o.env ?? process.env).GROUNDED_PEOPLE_ENABLED === '0') return 'GROUNDED_PEOPLE_ENABLED=0'
  if (!o.searchEnabled) return 'TinyFish search is not configured: no lookup can run'
  if (o.peopleCap === 0) return 'DAZL_FIRST_PLAY_PEOPLE_SEARCHES=0: no people lookups on the first play / trial scans'
  if (o.vendor !== 'anthropic') return 'the grounded lookup runs on an Anthropic key and this scan uses another vendor'
  if (o.trial) return 'free-trial scans keep their reserve for the checks after the scan'
  return null
}
