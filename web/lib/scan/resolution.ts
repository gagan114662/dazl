// CODE decides when a scan is "done", not the model. After enrichment every candidate is checked against three facts, read from what the scan stored:
//   date      - an event date inside the window (found) / dated but outside it (stale) / none (missing)
//   identity  - the company is confirmed (a domain the crawl bound to the company by name + place) / unconfirmed / in conflict (a contact page of a different company was refused)
//   contact   - a named person with a published route attached / missing / refused
// A candidate with all three is resolved. Any other carries an explicit, SPECIFIC reason ("no dated evidence on 2 sources tried: ...", "contact page is a different company: ..."), and
// unresolved candidates get more targeted lookups, bounded: at most MAX_ATTEMPTS per candidate, never the same lookup twice, then a hard stop with the reason.
// The one targeted lookup here is the date: the company's OWN pages (home, /events, /news) are read for a date the page declares as structured data about THIS event (the #307 resolver and its
// identity rules, unchanged). A date found this late is stored as evidence beside the lead; it does not re-qualify a lead the gates already held - the reason says so.
import type Database from 'better-sqlite3'
import { addEnrichment } from '../connectors/store.ts'
import { resolveStructuredDate } from './structured-date.ts'
import { NOT_A_FOUNDER_ROUTE, personMatchesRole, whoOf } from './actionable.ts'
import { windowStatus } from './window.ts'
import { parseWindowDays } from './window.ts'
import { isFail, type FetchFail, type Page } from './fetch-page.ts'

export const MAX_ATTEMPTS = 3
export const RESOLUTION_CONNECTOR = 'scan:resolution'
export interface CandidateResolution {
  lead_id: string; company: string
  date: 'found' | 'stale' | 'missing' | 'invalid' | 'future' | 'unconfirmed'; identity: 'confirmed' | 'unconfirmed' | 'conflict'; contact: 'attached' | 'missing' | 'refused'
  resolved: boolean; reasons: string[]; tried: string[]; fallbacks: string[]   // fallbacks: sources used instead of a blocked page (e.g. other press)
  late_date?: { date: string; url: string }
  skipped?: string   // the own-site date lookup was not (fully) run: why (deadline / cancelled / scan-wide cap)
}
export interface ResolutionSummary { candidates: number; resolved: number; unresolved: number; by_reason: Record<string, number>; leads: CandidateResolution[]; interrupted: string | null; lookups: number }
type JobLike = { id: string; user_id: string; query?: string | null; icp?: string | null }
type Row = { id: string; company: string; company_domain: string | null; event_date: string | null; review_reason: string | null; signal: string; evidence_excerpt: string | null }
const DATE_REASONS = new Set(['outside_window_undated', 'outside_window', 'event_date_future_date', 'event_date_bad_date', 'event_timing_unconfirmed'])
const CONFLICT = new Set(['contact_location_mismatch', 'contact_domain_mismatch', 'contact_address_mismatch'])

function dateState(d: string | null, reason: string | null, windowDays: number | null, now: Date): CandidateResolution['date'] {
  if (reason === 'event_date_bad_date') return 'invalid'
  if (reason === 'event_date_future_date') return 'future'
  if (!d) return reason === 'event_timing_unconfirmed' ? 'unconfirmed' : 'missing'
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d), t = m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])) : null
  if (!m || !t || t.getUTCFullYear() !== +m[1] || t.getUTCMonth() !== +m[2] - 1 || t.getUTCDate() !== +m[3]) return 'invalid'
  if (d > now.toISOString().slice(0, 10)) return 'future'   // calendar days, like the window gate: tomorrow is already in the future (no time-of-day tolerance)
  if (reason === 'outside_window' || reason === 'outside_window_undated' || (windowDays && windowStatus(d, windowDays, now) !== 'inside')) return 'stale'
  return 'found'
}
export function resolveFacts(db: Database.Database, job: JobLike, tried: Map<string, string[]> = new Map(), now = new Date()): CandidateResolution[] {
  const leads = db.prepare("SELECT id, company, company_domain, event_date, review_reason, signal, evidence_excerpt FROM leads WHERE scan_job_id = ? AND company <> '' AND human_confirmed_at IS NULL AND quarantined_at IS NULL AND (source_kind IS NULL OR source_kind != 'test') ORDER BY score DESC").all(job.id) as Row[]
  const enr = db.prepare('SELECT connector, kind, value, label FROM lead_enrichments WHERE lead_id = ? AND tenant_id = ?')
  const windowDays = parseWindowDays(job.query ?? '') ?? (() => { try { const w = JSON.parse(job.icp ?? 'null')?.window_days; return typeof w === 'number' ? w : null } catch { return null } })()
  return leads.map(l => {
    const rows = enr.all(l.id, job.user_id) as { connector: string; kind: string; value: string; label: string | null }[]
    const t = tried.get(l.id) ?? []
    const reasons: string[] = []
    // date: a real calendar day, not in the future, and (with a window) inside it - whatever the request's window, a malformed or future date is never "found"
    const date = dateState(l.event_date, l.review_reason, windowDays, now)
    if (date === 'missing') reasons.push(`no dated evidence${t.length ? ` on ${t.length} source${t.length === 1 ? '' : 's'} tried: ${t.join(', ')}` : ''}`)
    if (date === 'stale') reasons.push(`the only dated evidence (${l.event_date}) is outside the window`)
    if (date === 'invalid') reasons.push(`the event date "${l.event_date}" is not a real calendar date`)
    if (date === 'future') reasons.push(`the event date ${l.event_date} is in the future`)
    if (date === 'unconfirmed') reasons.push('event timing is unconfirmed (a season or "soon", no dated evidence)')
    // identity
    const codes = [...new Set(rows.filter(r => r.kind === 'contact_rejected' && r.label && CONFLICT.has(r.label)).map(r => r.label!))]
    const identity: CandidateResolution['identity'] = codes.length > 0 && !l.company_domain ? 'conflict' : l.company_domain ? 'confirmed' : 'unconfirmed'
    if (identity === 'conflict') reasons.push(`contact page is a different company (${codes.join(', ')})`)
    if (identity === 'unconfirmed') reasons.push('company identity not confirmed: no domain agrees with the company name and place')
    // contact
    const who = whoOf(job.icp) || 'founder'
    const people = rows.filter(r => r.kind === 'person' && r.connector === 'sitecrawl')
    const person = people.some(p => personMatchesRole(p.value, who))                       // the requested role (or a founder-level one), not just any named person
    const wrongRole = !person && people.length > 0
    const route = rows.some(r => r.connector === 'sitecrawl' && (r.kind === 'phone' || (r.kind === 'email' && !NOT_A_FOUNDER_ROUTE.test(r.value.split('@')[0].replace(/[._-]/g, '')))))
    const refused = rows.some(r => r.kind === 'contact_rejected')
    const contact: CandidateResolution['contact'] = person && route ? 'attached' : refused && !person && !route ? 'refused' : 'missing'
    if (contact === 'refused') reasons.push(`every contact found was refused (${[...new Set(rows.filter(r => r.kind === 'contact_rejected').map(r => r.label))].join(', ')})`)
    if (contact === 'missing') reasons.push(person ? 'a person is named but no route is published' : wrongRole ? `the named person (${people[0].value}) is not the requested role (${who})` : route ? 'a route is published but no named decision-maker' : 'no named decision-maker with a published route')
    const fallbacks = rows.filter(r => r.connector === 'scan:fallback').map(r => r.value)
    return { lead_id: l.id, company: l.company, date, identity, contact, resolved: reasons.length === 0, reasons, tried: t, fallbacks }
  })
}

// The company's own pages, in order. Each is read at most once; per candidate the cap is MAX_ATTEMPTS, per scan MAX_FETCHES, and ONE overall deadline covers every lookup (the worker is never held
// by the sum of many candidates' pages). A cancellation (deps.signal) or the deadline stops new requests AND destroys the one in flight; work that was not done is recorded as skipped, never as tried.
const OWN_PAGES = ['/', '/events', '/news', '/press']
export const MAX_FETCHES = 12, DEADLINE_MS = 15_000
export async function resolveBounded(
  db: Database.Database, job: JobLike,
  deps: { fetchPage: (url: string, signal?: AbortSignal) => Promise<Page | FetchFail | null>; where?: string[]; signal?: AbortSignal; deadlineMs?: number; maxFetches?: number; now?: Date },
): Promise<ResolutionSummary> {
  const tried = new Map<string, string[]>(), late = new Map<string, { date: string; url: string }>(), skipped = new Map<string, string>()
  const ctrl = new AbortController()
  const st: { why: 'cancelled' | 'deadline' | null } = { why: null }
  const stop = (r: 'cancelled' | 'deadline') => { st.why ??= r; ctrl.abort() }
  const onCancel = () => stop('cancelled')
  if (deps.signal?.aborted) onCancel(); else deps.signal?.addEventListener('abort', onCancel, { once: true })
  const timer = setTimeout(() => stop('deadline'), deps.deadlineMs ?? DEADLINE_MS)
  const aborted = new Promise<null>(res => ctrl.signal.addEventListener('abort', () => res(null), { once: true }))
  const cache = new Map<string, Promise<Page | FetchFail | null>>()
  let fetches = 0
  const get = (u: string) => { if (!cache.has(u)) { fetches++; cache.set(u, Promise.race([deps.fetchPage(u, ctrl.signal).catch(() => null), aborted])) } return cache.get(u)! }   // never the same call twice
  const cap = deps.maxFetches ?? MAX_FETCHES
  const meta = new Map((db.prepare("SELECT id, company, company_domain, event_date, review_reason, signal, evidence_excerpt FROM leads WHERE scan_job_id = ?").all(job.id) as Row[]).map(r => [r.id, r]))
  try {
    for (const r of resolveFacts(db, job, tried, deps.now)) {
      if (r.date !== 'missing' || r.identity !== 'confirmed') continue            // the date lookup needs a confirmed company domain: identity first
      const l = meta.get(r.lead_id)!
      const t: string[] = []
      for (const path of OWN_PAGES) {
        if (t.length >= MAX_ATTEMPTS) break                                        // hard stop per candidate
        const url = `https://${l.company_domain}${path}`
        const halt = st.why ?? (!cache.has(url) && fetches >= cap ? 'scan-wide cap' : null)
        if (halt) { skipped.set(l.id, halt === 'cancelled' ? 'the scan was cancelled' : halt === 'deadline' ? `the overall lookup deadline (${(deps.deadlineMs ?? DEADLINE_MS) / 1000}s) was reached` : `the scan-wide limit of ${cap} page reads was reached`); break }
        t.push(url); const page = await get(url)
        if (st.why) { t.pop(); skipped.set(l.id, st.why === 'cancelled' ? 'the scan was cancelled' : `the overall lookup deadline (${(deps.deadlineMs ?? DEADLINE_MS) / 1000}s) was reached`); break }   // interrupted in flight: not counted as tried
        if (!page || isFail(page)) continue
        const hit = resolveStructuredDate(page.structured, l.company, `${l.signal} ${l.evidence_excerpt ?? ''}`, deps.where ?? [])
        if (hit) { late.set(l.id, { date: hit.date, url }); break }
      }
      tried.set(l.id, t)
    }
  } finally { clearTimeout(timer); deps.signal?.removeEventListener('abort', onCancel); ctrl.abort() }
  const out = resolveFacts(db, job, tried, deps.now)
  for (const r of out) { const sk = skipped.get(r.lead_id); if (sk) { r.skipped = sk; r.reasons.push(`own-site date lookup not completed: ${sk}`) } }
  const ins = (r: CandidateResolution) => {
    const l = late.get(r.lead_id); if (l) { r.late_date = l; r.reasons = r.reasons.map(x => x.startsWith('no dated evidence') ? `an event date (${l.date}) was found on ${l.url} (structured data) after the window gate held this lead - it is stored as evidence; rerun the scan to qualify it` : x) }
    try {
      db.prepare('DELETE FROM lead_enrichments WHERE lead_id = ? AND tenant_id = ? AND connector = ?').run(r.lead_id, job.user_id, RESOLUTION_CONNECTOR)
      addEnrichment(db, job.user_id, r.lead_id, { connector: RESOLUTION_CONNECTOR, kind: 'resolution', value: (r.resolved ? 'Resolved: dated, company confirmed, contact attached' : `Unresolved: ${r.reasons.join('; ')}`).slice(0, 254), label: r.resolved ? 'resolved' : 'unresolved', confidence: null, source_url: l?.url ?? 'https://invalid.example/', source_date: new Date().toISOString().slice(0, 10), retrieved_at: Math.floor(Date.now() / 1000) })
    } catch { /* an old schema never blocks the scan */ }
  }
  out.forEach(ins)
  const by_reason: Record<string, number> = {}
  for (const r of out) for (const x of r.reasons) { const k = x.replace(/\s*\(.*$/, '').replace(/ on \d+ sources? tried.*/, '').slice(0, 80); by_reason[k] = (by_reason[k] ?? 0) + 1 }
  return { candidates: out.length, resolved: out.filter(r => r.resolved).length, unresolved: out.filter(r => !r.resolved).length, by_reason, leads: out, interrupted: st.why, lookups: fetches }
}
