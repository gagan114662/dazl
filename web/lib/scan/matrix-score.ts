// The location x category matrix's own numbers, measured from a finished scan's stored rows: the same columns Hermes's staging
// matrix prints (candidates, ready, named %, email %, dated %, location+category %, time) and the same pass rule
// (~/work/scorecard/matrix.json thresholds). "Ready" is the product's own rule (lib/outreach/lead-hold.ts, the one Home and the
// Leads page use), so a change to what ready means moves this table with it. Relative imports only: web/scripts/matrix-local.mts runs it.
import type Database from 'better-sqlite3'
import { listLeads } from './store.ts'
import { enrichmentsForLeads, type Enrichment } from '../connectors/store.ts'
import { companyKey } from './evidence.ts'
import { eventDayVerified } from './scoreboard.ts'
import { leadHoldReason, timingOptsFor } from '../outreach/lead-hold.ts'

export interface MatrixThresholds { ready_leads_min: number; named_contact_min_pct: number; dated_source_min_pct: number; location_category_match_min_pct: number; per_case_confirm_cap_usd: number }
export interface MatrixCase { id: string; label: string; seller?: string; offer?: string; query: string; expect: { location_keywords: string[]; category_keywords: string[] } }
export interface CaseMetrics {
  candidates: number; leads: number; ready: number; named_pct: number; email_pct: number; dated_pct: number; match_pct: number
  held: Record<string, number>   // why the leads that are not ready are not: the product's own hold words, with counts
}
export interface CaseResult extends CaseMetrics { id: string; label: string; status: string; error: string | null; seconds: number; usd: number | null; pass: boolean; why: string[] }

const pct = (n: number, d: number) => (d === 0 ? 0 : Math.round((n / d) * 100))

type LeadRow = Record<string, unknown> & { id: string; name: string | null; company: string | null; contact: string | null; signal: string | null; evidence_excerpt: string | null; source_url: string | null; company_domain: string | null; event_date: string | null; event_date_proof: string | null; signal_kind: string | null; quarantined_at: number | null }

// Percentages are of the leads the scan listed (the Leads page's own list: a poor fit is hidden, a review-lane lead is
// counted, a rejected one is not), so a scan that found nothing reads 0%, never blank. Ready counts COMPANIES (one per
// domain or normalised name, ready wins), like Home's tile.
export function measureCase(db: Database.Database, tenantId: string, jobId: string, c: Pick<MatrixCase, 'expect'>, at: Date = new Date()): CaseMetrics {
  const job = db.prepare('SELECT query, icp, candidates FROM scan_jobs WHERE id = ? AND user_id = ?').get(jobId, tenantId) as { query: string | null; icp: string | null; candidates: number | null } | undefined
  if (!job) throw new Error(`matrix: no scan ${jobId} for tenant ${tenantId}`)
  const timing = timingOptsFor(job)
  const leads = (listLeads(db, tenantId, jobId, 500, false) as LeadRow[]).filter(l => !l.quarantined_at)
  const enr = enrichmentsForLeads(db, tenantId, leads.map(l => l.id)) as Record<string, Enrichment[]>
  const loc = c.expect.location_keywords.map(k => k.toLowerCase()), cat = c.expect.category_keywords.map(k => k.toLowerCase())
  let named = 0, email = 0, dated = 0, match = 0
  const ready = new Set<string>(), seen = new Map<string, string | null>()   // company key -> first hold reason (null = ready)
  for (const l of leads) {
    const e = enr[l.id] ?? []
    const company = (l.company ?? '').trim()
    if ((l.name ?? '').trim() && (l.name ?? '').trim() !== company) named++
    else if (e.some(x => x.kind === 'person' && x.value.trim())) named++
    if ((l.contact ?? '').includes('@') || e.some(x => x.kind === 'email' && x.value.includes('@'))) email++
    if (l.source_url && eventDayVerified({ event_date: l.event_date, event_date_proof: l.event_date_proof, signal: l.signal, signal_kind: l.signal_kind }, { now: at })) dated++
    const text = `${l.company ?? ''} ${l.name ?? ''} ${l.signal ?? ''} ${l.evidence_excerpt ?? ''} ${l.source_url ?? ''} ${l.company_domain ?? ''}`.toLowerCase()
    if (loc.some(k => text.includes(k)) && cat.some(k => text.includes(k))) match++
    const key = l.company_domain ? `d:${l.company_domain.trim().toLowerCase()}` : `n:${companyKey(company) || l.id}`
    const why = leadHoldReason(db, tenantId, l, e, timing, at)
    if (why === null) { ready.add(key); seen.set(key, null) } else if (!seen.has(key)) seen.set(key, why)
  }
  const held: Record<string, number> = {}
  for (const [key, why] of seen) if (why !== null && !ready.has(key)) held[why] = (held[why] ?? 0) + 1
  return { candidates: Number(job.candidates ?? 0), leads: leads.length, ready: ready.size, named_pct: pct(named, leads.length), email_pct: pct(email, leads.length), dated_pct: pct(dated, leads.length), match_pct: pct(match, leads.length), held }
}

// The pass rule, with its reasons in the words the staging table uses.
export function verdict(m: CaseMetrics, t: MatrixThresholds): { pass: boolean; why: string[] } {
  const why: string[] = []
  if (m.ready < t.ready_leads_min) why.push(`${m.ready} ready, needs >=${t.ready_leads_min}`)
  if (m.named_pct < t.named_contact_min_pct) why.push(`${m.named_pct}% named, needs >=${t.named_contact_min_pct}%`)
  if (m.dated_pct < t.dated_source_min_pct) why.push(`${m.dated_pct}% dated, needs >=${t.dated_source_min_pct}%`)
  if (m.match_pct < t.location_category_match_min_pct) why.push(`${m.match_pct}% in place and category, needs >=${t.location_category_match_min_pct}%`)
  return { pass: why.length === 0, why }
}

export function matrixTable(rows: CaseResult[], t: MatrixThresholds, meta: { commit: string; date: string }): string {
  const pass = rows.filter(r => r.pass).length
  const head = `MATRIX local @ ${meta.commit} ${meta.date}: ${pass}/${rows.length} PASS (per case: >=${t.ready_leads_min} ready, >=${t.named_contact_min_pct}% named, >=${t.dated_source_min_pct}% dated, >=${t.location_category_match_min_pct}% in place and category; cap US$${t.per_case_confirm_cap_usd}/case)`
  const cols = ['case', 'status', 'cand', 'leads', 'ready', 'named%', 'email%', 'dated%', 'match%', 'secs', 'usd', 'verdict']
  const body = rows.map(r => [r.id, r.status, r.candidates, r.leads, r.ready, r.named_pct, r.email_pct, r.dated_pct, r.match_pct, r.seconds, r.usd == null ? '?' : r.usd.toFixed(3), r.pass ? 'PASS' : 'FAIL'].map(String))
  const w = cols.map((c, i) => Math.max(c.length, ...body.map(b => b[i].length)))
  const line = (cells: string[]) => cells.map((c, i) => c.padEnd(w[i])).join('  ')
  const held = rows.filter(r => !r.pass).map(r => `  ${r.id}: ${r.error ? `${r.error}; ` : ''}${r.why.join('; ')}${Object.keys(r.held).length ? ` | held: ${Object.entries(r.held).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(', ')}` : ''}`)
  return [head, line(cols), line(w.map(n => '-'.repeat(n))), ...body.map(line), '', ...held].join('\n')
}
