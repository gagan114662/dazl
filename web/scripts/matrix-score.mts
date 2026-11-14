// The location x category matrix's numbers, measured from a finished scan's stored rows: the columns Hermes's staging matrix
// prints (candidates, ready, named %, email %, dated %, location+category %, time) against the same thresholds
// (~/work/scorecard/matrix.json). The DEFINITIONS are the product's, not matrix.py's (see DEFINITIONS below): compare a local
// row with a local row, before and after a change. "Ready" is the product's own rule (lib/outreach/lead-hold.ts, the one Home and the
// Leads page use), so a change to what ready means moves this table with it. A dev tool on the runner's own throwaway SQLite store (scripts/, outside the Postgres port audit like scoreboard.mts); web/scripts/matrix-local.mts runs it.
import type Database from 'better-sqlite3'
import { listLeads } from '../lib/scan/store.ts'
import { enrichmentsForLeads, type Enrichment } from '../lib/connectors/store.ts'
import { companyKey } from '../lib/scan/evidence.ts'
import { eventDayVerified } from '../lib/scan/scoreboard.ts'
import { leadHoldReason, timingOptsFor } from '../lib/outreach/lead-hold.ts'

export interface MatrixThresholds { ready_leads_min: number; named_contact_min_pct: number; dated_source_min_pct: number; location_category_match_min_pct: number; per_case_confirm_cap_usd: number }
export interface MatrixCase { id: string; label: string; seller?: string; offer?: string; query: string; expect: { location_keywords: string[]; category_keywords: string[] } }
export interface CaseMetrics {
  candidates: number; leads: number; ready: number; named_pct: number; email_pct: number; dated_pct: number; match_pct: number
  held: Record<string, number>   // why the leads that are not ready are not: the product's own hold words, with counts
}
// Where the scan's candidates went, read from the run report the scan wrote with the job (lib/scan/run-report.ts): queries sent,
// search hits, URLs selected and walled, evidence with page text, extracted candidates and each one's fate with its reason.
// null = the report was not recorded for this job (never a fabricated zero).
export interface Funnel {
  queries: number | null; query_source: string | null; searches_ok: string | null; hits_unique_urls: number | null; urls: number | null; selected: number | null; walled: number | null
  evidence_items: number | null; with_page_text: number | null; extracted: number | null; verified: number | null; needs_review: number | null; dropped: number | null
  review_reasons: Record<string, number>; drop_reasons: Record<string, number>; verifier_drops: Record<string, number>; stop: string | null
  candidates: { company: string; url: string; outcome: string; reason: string | null }[]
}
export interface CaseResult extends CaseMetrics { funnel?: Funnel | null; id: string; label: string; status: string; error: string | null; seconds: number; usd: number | null; pass: boolean; why: string[] }

export function funnelOf(db: Database.Database, jobId: string): Funnel | null {
  let row: { report: string } | undefined
  try { row = db.prepare('SELECT report FROM scan_run_report WHERE job_id = ? ORDER BY attempt DESC LIMIT 1').get(jobId) as { report: string } | undefined } catch { return null }
  if (!row) return null
  let r: Record<string, any>
  try { r = JSON.parse(row.report) } catch { return null }
  const n = (v: unknown) => (typeof v === 'number' ? v : null)
  const urls = Array.isArray(r.urls) ? r.urls : []
  const f = r.funnel ?? {}
  return {
    queries: Array.isArray(r.queries) ? r.queries.length : null, query_source: r.query_source ?? null,
    searches_ok: r.search && n(r.search.attempted) !== null ? `${r.search.ok ?? '?'}/${r.search.attempted}` : null, hits_unique_urls: n(r.search?.hits_unique_urls),
    urls: urls.length || null, selected: urls.length ? urls.filter((u: any) => u.selected).length : null, walled: urls.length ? urls.filter((u: any) => u.walled).length : null,
    evidence_items: n(r.evidence?.items), with_page_text: n(r.evidence?.with_page_text),
    extracted: n(r.extracted_candidates), verified: n(f.verified), needs_review: n(f.needs_review), dropped: n(f.dropped),
    review_reasons: f.review_reasons ?? {}, drop_reasons: f.drop_reasons ?? {}, verifier_drops: f.verifier_drop_counts ?? {}, stop: r.stop?.code ?? null,
    candidates: (Array.isArray(r.candidates) ? r.candidates : []).slice(0, 40).map((c: any) => ({ company: String(c.company ?? ''), url: String(c.url ?? ''), outcome: String(c.outcome ?? ''), reason: c.reason ?? null })),
  }
}

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
  // one verdict per COMPANY, matched the way Home's tile and "seen before" match: the same domain OR the same normalised name
  // (a lead with a domain and one without, both "Smile Dental", are one company); ready wins
  const byKey = new Map<string, { ready: boolean; why: string | null }>(), companies: { ready: boolean; why: string | null }[] = []
  for (const l of leads) {
    const e = enr[l.id] ?? []
    const company = (l.company ?? '').trim()
    if ((l.name ?? '').trim() && (l.name ?? '').trim() !== company) named++
    else if (e.some(x => x.kind === 'person' && x.value.trim())) named++
    if ((l.contact ?? '').includes('@') || e.some(x => x.kind === 'email' && x.value.includes('@'))) email++
    if (l.source_url && eventDayVerified({ event_date: l.event_date, event_date_proof: l.event_date_proof, signal: l.signal, signal_kind: l.signal_kind }, { now: at })) dated++
    const text = `${l.company ?? ''} ${l.name ?? ''} ${l.signal ?? ''} ${l.evidence_excerpt ?? ''} ${l.source_url ?? ''} ${l.company_domain ?? ''}`.toLowerCase()
    if (loc.some(k => text.includes(k)) && cat.some(k => text.includes(k))) match++
    const keys = [l.company_domain ? `d:${l.company_domain.trim().toLowerCase()}` : '', company ? `n:${companyKey(company)}` : ''].filter(k => k.length > 2)
    if (!keys.length) keys.push(`id:${l.id}`)
    const why = leadHoldReason(db, tenantId, l, e, timing, at)
    let v = keys.map(k => byKey.get(k)).find(Boolean)
    if (!v) { v = { ready: why === null, why }; companies.push(v) } else if (why === null && !v.ready) { v.ready = true; v.why = null }
    for (const k of keys) byKey.set(k, v)
  }
  const held: Record<string, number> = {}
  for (const v of companies) if (!v.ready && v.why !== null) held[v.why] = (held[v.why] ?? 0) + 1
  const ready = companies.filter(v => v.ready).length
  return { candidates: Number(job.candidates ?? 0), leads: leads.length, ready, named_pct: pct(named, leads.length), email_pct: pct(email, leads.length), dated_pct: pct(dated, leads.length), match_pct: pct(match, leads.length), held }
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

export const DEFINITIONS = [
  'ready: companies (one per domain or normalised name) the product shows ready (lib/outreach/lead-hold.ts, the rule Home and Leads use); staging counts leads with no review reason',
  'named/email/dated/match %: of the leads the scan listed (not of ready ones); named = a person on the lead or on the company\'s own site; dated = a proven event day (event_date_proof) with a source URL; match = a place AND a category keyword in the lead\'s text (a proxy: staging opens the source pages)',
  'usd: settled model and paid-vendor calls (refused calls excluded); TinyFish search/fetch inside its free allowance is priced at 0 and is not in it',
  'icp: inferred by the runner from the query (staging runs with the profile reviewed in the UI), so queries can differ from a staging run',
]

export function matrixTable(rows: CaseResult[], t: MatrixThresholds, meta: { commit: string; date: string }): string {
  const pass = rows.filter(r => r.pass).length
  const head = `MATRIX local @ ${meta.commit} ${meta.date}: ${pass}/${rows.length} PASS (per case: >=${t.ready_leads_min} ready, >=${t.named_contact_min_pct}% named, >=${t.dated_source_min_pct}% dated, >=${t.location_category_match_min_pct}% in place and category; cap US$${t.per_case_confirm_cap_usd}/case)`
  const cols = ['case', 'status', 'cand', 'leads', 'ready', 'named%', 'email%', 'dated%', 'match%', 'secs', 'usd', 'verdict']
  const body = rows.map(r => [r.id, r.status, r.candidates, r.leads, r.ready, r.named_pct, r.email_pct, r.dated_pct, r.match_pct, r.seconds, r.usd == null ? '?' : r.usd.toFixed(3), r.pass ? 'PASS' : 'FAIL'].map(String))
  const w = cols.map((c, i) => Math.max(c.length, ...body.map(b => b[i].length)))
  const line = (cells: string[]) => cells.map((c, i) => c.padEnd(w[i])).join('  ')
  const held = rows.filter(r => !r.pass).map(r => `  ${r.id}: ${r.error ? `${r.error}; ` : ''}${r.why.join('; ')}${Object.keys(r.held).length ? ` | held: ${Object.entries(r.held).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(', ')}` : ''}`)
  const kv = (o: Record<string, number>) => Object.entries(o).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'
  const funnel = rows.filter(r => r.funnel !== undefined).map(r => {
    const f = r.funnel
    if (!f) return `  ${r.id}: run report not recorded`
    return `  ${r.id}: ${f.queries ?? '?'} queries (${f.query_source ?? '?'}); search ok ${f.searches_ok ?? '?'}, ${f.hits_unique_urls ?? '?'} unique urls, ${f.selected ?? '?'} selected, ${f.walled ?? '?'} walled; evidence ${f.evidence_items ?? '?'} (${f.with_page_text ?? '?'} with page text); extracted ${f.extracted ?? '?'} -> verified ${f.verified ?? '?'}, review ${f.needs_review ?? '?'}, dropped ${f.dropped ?? '?'}${f.stop ? `; stop ${f.stop}` : ''}\n      review: ${kv(f.review_reasons)} | drops: ${kv(f.drop_reasons)} | verifier: ${kv(f.verifier_drops)}`
  })
  return [head, line(cols), line(w.map(n => '-'.repeat(n))), ...body.map(line), '', ...held, ...(funnel.length ? ['', 'funnel (where the candidates went, from each scan\'s run report):', ...funnel] : []), '', 'definitions:', ...DEFINITIONS.map(d => `  ${d}`)].join('\n')
}
