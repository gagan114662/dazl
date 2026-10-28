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
import { NOT_A_FOUNDER_ROUTE } from './actionable.ts'
import { windowStatus } from './window.ts'
import { parseWindowDays } from './window.ts'
import { isFail, type FetchFail, type Page } from './fetch-page.ts'

export const MAX_ATTEMPTS = 3
export const RESOLUTION_CONNECTOR = 'scan:resolution'
export interface CandidateResolution {
  lead_id: string; company: string
  date: 'found' | 'stale' | 'missing'; identity: 'confirmed' | 'unconfirmed' | 'conflict'; contact: 'attached' | 'missing' | 'refused'
  resolved: boolean; reasons: string[]; tried: string[]; fallbacks: string[]   // fallbacks: sources used instead of a blocked page (e.g. other press)
  late_date?: { date: string; url: string }
}
export interface ResolutionSummary { candidates: number; resolved: number; unresolved: number; by_reason: Record<string, number>; leads: CandidateResolution[] }
type JobLike = { id: string; user_id: string; query?: string | null; icp?: string | null }
type Row = { id: string; company: string; company_domain: string | null; event_date: string | null; review_reason: string | null; signal: string; evidence_excerpt: string | null }
const DATE_REASONS = new Set(['outside_window_undated', 'outside_window', 'event_date_future_date', 'event_date_bad_date', 'event_timing_unconfirmed'])
const CONFLICT = new Set(['contact_location_mismatch', 'contact_domain_mismatch', 'contact_address_mismatch'])

export function resolveFacts(db: Database.Database, job: JobLike, tried: Map<string, string[]> = new Map()): CandidateResolution[] {
  const leads = db.prepare("SELECT id, company, company_domain, event_date, review_reason, signal, evidence_excerpt FROM leads WHERE scan_job_id = ? AND company <> '' AND human_confirmed_at IS NULL AND quarantined_at IS NULL AND (source_kind IS NULL OR source_kind != 'test') ORDER BY score DESC").all(job.id) as Row[]
  const enr = db.prepare('SELECT connector, kind, value, label FROM lead_enrichments WHERE lead_id = ? AND tenant_id = ?')
  const windowDays = parseWindowDays(job.query ?? '') ?? (() => { try { const w = JSON.parse(job.icp ?? 'null')?.window_days; return typeof w === 'number' ? w : null } catch { return null } })()
  return leads.map(l => {
    const rows = enr.all(l.id, job.user_id) as { connector: string; kind: string; value: string; label: string | null }[]
    const t = tried.get(l.id) ?? []
    const reasons: string[] = []
    // date
    const dateHeld = l.review_reason !== null && DATE_REASONS.has(l.review_reason)
    const date: CandidateResolution['date'] = !l.event_date ? 'missing' : dateHeld || (windowDays && windowStatus(l.event_date, windowDays) !== 'inside') ? 'stale' : 'found'
    if (date === 'missing') reasons.push(`no dated evidence${t.length ? ` on ${t.length} source${t.length === 1 ? '' : 's'} tried: ${t.join(', ')}` : ''}`)
    if (date === 'stale') reasons.push(`the only dated evidence (${l.event_date}) is outside the window`)
    // identity
    const codes = [...new Set(rows.filter(r => r.kind === 'contact_rejected' && r.label && CONFLICT.has(r.label)).map(r => r.label!))]
    const identity: CandidateResolution['identity'] = codes.length > 0 && !l.company_domain ? 'conflict' : l.company_domain ? 'confirmed' : 'unconfirmed'
    if (identity === 'conflict') reasons.push(`contact page is a different company (${codes.join(', ')})`)
    if (identity === 'unconfirmed') reasons.push('company identity not confirmed: no domain agrees with the company name and place')
    // contact
    const person = rows.some(r => r.kind === 'person' && r.connector === 'sitecrawl')
    const route = rows.some(r => r.connector === 'sitecrawl' && (r.kind === 'phone' || (r.kind === 'email' && !NOT_A_FOUNDER_ROUTE.test(r.value.split('@')[0].replace(/[._-]/g, '')))))
    const refused = rows.some(r => r.kind === 'contact_rejected')
    const contact: CandidateResolution['contact'] = person && route ? 'attached' : refused && !person && !route ? 'refused' : 'missing'
    if (contact === 'refused') reasons.push(`every contact found was refused (${[...new Set(rows.filter(r => r.kind === 'contact_rejected').map(r => r.label))].join(', ')})`)
    if (contact === 'missing') reasons.push(person ? 'a person is named but no route is published' : route ? 'a route is published but no named decision-maker' : 'no named decision-maker with a published route')
    const fallbacks = rows.filter(r => r.connector === 'scan:fallback').map(r => r.value)
    return { lead_id: l.id, company: l.company, date, identity, contact, resolved: reasons.length === 0, reasons, tried: t, fallbacks }
  })
}

// The company's own pages, in order. Each is read at most once per candidate; the cap is MAX_ATTEMPTS.
const OWN_PAGES = ['/', '/events', '/news', '/press']
export async function resolveBounded(
  db: Database.Database, job: JobLike,
  deps: { fetchPage: (url: string) => Promise<Page | FetchFail | null>; where?: string[] },
): Promise<ResolutionSummary> {
  const tried = new Map<string, string[]>(), late = new Map<string, { date: string; url: string }>()
  const cache = new Map<string, Promise<Page | FetchFail | null>>()
  const get = (u: string) => { if (!cache.has(u)) cache.set(u, deps.fetchPage(u).catch(() => null)); return cache.get(u)! }   // never the same call twice
  const byId = (rows: Row[]) => new Map(rows.map(r => [r.id, r]))
  const leadRows = db.prepare("SELECT id, company, company_domain, event_date, review_reason, signal, evidence_excerpt FROM leads WHERE scan_job_id = ?").all(job.id) as Row[]
  const meta = byId(leadRows)
  for (const r of resolveFacts(db, job, tried)) {
    if (r.date !== 'missing' || r.identity !== 'confirmed') continue            // the date lookup needs a confirmed company domain: identity first
    const l = meta.get(r.lead_id)!
    const t: string[] = []
    for (const path of OWN_PAGES) {
      if (t.length >= MAX_ATTEMPTS) break                                          // hard stop
      const url = `https://${l.company_domain}${path}`
      t.push(url); const page = await get(url)
      if (!page || isFail(page)) continue
      const hit = resolveStructuredDate(page.structured, l.company, `${l.signal} ${l.evidence_excerpt ?? ''}`, deps.where ?? [])
      if (hit) { late.set(l.id, { date: hit.date, url }); break }
    }
    tried.set(l.id, t)
  }
  const out = resolveFacts(db, job, tried)
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
  return { candidates: out.length, resolved: out.filter(r => r.resolved).length, unresolved: out.filter(r => !r.resolved).length, by_reason, leads: out }
}
