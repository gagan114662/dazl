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
import { nameBound, GENERIC_LOCAL } from '../lib/outreach/contact-route.ts'
import { publishedCandidateRowsForLeads, selectPublishedCandidate, publishedNameKey } from '../lib/people/email-pattern.ts'
import { sameSite } from '../lib/connectors/sitecrawl.ts'

export interface MatrixThresholds { ready_leads_min: number; named_contact_min_pct: number; dated_source_min_pct: number; location_category_match_min_pct: number; per_case_confirm_cap_usd: number }
export interface MatrixCase { id: string; label: string; seller?: string; offer?: string; query: string; expect: { location_keywords: string[]; category_keywords: string[] } }
export interface CaseMetrics {
  candidates: number; leads: number; ready: number; named_pct: number; email_pct: number; email_guess_pct: number; email_role_pct: number; dated_pct: number; match_pct: number
  held: Record<string, number>   // why the leads that are not ready are not: the product's own hold words, with counts
}
export interface CaseResult extends CaseMetrics { id: string; label: string; status: string; error: string | null; seconds: number; usd: number | null; pass: boolean; why: string[] }

const pct = (n: number, d: number) => (d === 0 ? 0 : Math.round((n / d) * 100))

type LeadRow = Record<string, unknown> & { id: string; name: string | null; company: string | null; contact: string | null; signal: string | null; evidence_excerpt: string | null; source_url: string | null; company_domain: string | null; event_date: string | null; event_date_proof: string | null; signal_kind: string | null; quarantined_at: number | null }

// #1250: the email column scores PER PERSON. A lead counts only when a named person on it (the lead's own name or a person the
// crawl found on the company's site) has their OWN address on the company's own domain (leads.company_domain, the site the crawl
// confirmed): printed on that site and filed under that person by the crawl (email_candidates tier 'published', one address per
// person or none), or an address on the lead whose local part carries that person's name (contact-route's nameBound). A role inbox
// never stands in for a person. 'guess' (a named person with only a pattern guess) and 'role' (a role inbox only) are shown apart and
// never counted toward the column.
type EmailClass = 'person' | 'guess' | 'role' | 'none'
function guessedRowsForLeads(db: Database.Database, tenantId: string, leadIds: string[]): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  if (!leadIds.length) return out
  try {
    const rows = db.prepare(`SELECT lead_id, person FROM email_candidates WHERE tenant_id = ? AND lead_id IN (${leadIds.map(() => '?').join(',')}) AND tier = 'guessed'`).all(tenantId, ...leadIds) as { lead_id: string; person: string }[]
    for (const r of rows) (out[r.lead_id] ??= []).push(r.person)
  } catch (e) { if (!/no such table/i.test(String((e as Error)?.message))) throw e }
  return out
}
function emailClass(l: LeadRow, e: Enrichment[], published: ReturnType<typeof publishedCandidateRowsForLeads>[string], guessed: string[]): EmailClass {
  const company = (l.company ?? '').trim()
  const own = (l.name ?? '').split(',')[0].trim()
  const names = [...(own && own !== company ? [own] : []), ...e.filter(x => x.kind === 'person').map(x => x.value.split(',')[0].trim())].filter(Boolean)
  const addrs = [l.contact ?? '', ...e.filter(x => x.kind === 'email').map(x => x.value)].map(a => a.trim().toLowerCase()).filter(a => a.includes('@'))
  const site = (l.company_domain ?? '').trim().toLowerCase().replace(/^www\./, '')
  const onSite = (a: string) => !!site && sameSite((a.split('@')[1] ?? '').replace(/\.$/, ''), site)
  if (names.some(n => { const p = selectPublishedCandidate(published ?? [], n); return !!p && onSite(p.address.toLowerCase()) })) return 'person'
  if (addrs.some(a => onSite(a) && names.some(n => nameBound(a.split('@')[0], n)))) return 'person'
  const keys = new Set(names.map(publishedNameKey).filter(Boolean))
  if (guessed.some(p => keys.has(publishedNameKey(p.split(',')[0] ?? '')))) return 'guess'
  if (addrs.some(a => GENERIC_LOCAL.test(a.split('@')[0].split('+')[0].replace(/[._-]/g, '')))) return 'role'
  return 'none'
}

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
  const published = publishedCandidateRowsForLeads(db, tenantId, leads.map(l => l.id)), guessed = guessedRowsForLeads(db, tenantId, leads.map(l => l.id))
  let named = 0, email = 0, guess = 0, role = 0, dated = 0, match = 0
  // one verdict per COMPANY, matched the way Home's tile and "seen before" match: the same domain OR the same normalised name
  // (a lead with a domain and one without, both "Smile Dental", are one company); ready wins
  const byKey = new Map<string, { ready: boolean; why: string | null }>(), companies: { ready: boolean; why: string | null }[] = []
  for (const l of leads) {
    const e = enr[l.id] ?? []
    const company = (l.company ?? '').trim()
    if ((l.name ?? '').trim() && (l.name ?? '').trim() !== company) named++
    else if (e.some(x => x.kind === 'person' && x.value.trim())) named++
    const ec = emailClass(l, e, published[l.id], guessed[l.id] ?? [])
    if (ec === 'person') email++; else if (ec === 'guess') guess++; else if (ec === 'role') role++
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
  return { candidates: Number(job.candidates ?? 0), leads: leads.length, ready, named_pct: pct(named, leads.length), email_pct: pct(email, leads.length), email_guess_pct: pct(guess, leads.length), email_role_pct: pct(role, leads.length), dated_pct: pct(dated, leads.length), match_pct: pct(match, leads.length), held }
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
  'named/email/dated/match %: of the leads the scan listed (not of ready ones); named = a person on the lead or on the company\'s own site; email = a named person with their own address on the company\'s own domain (printed on its site, or carrying their name), never a role inbox or a guess; guess% = a named person with only a pattern guess; role% = a role inbox only (both shown, never counted); dated = a proven event day (event_date_proof) with a source URL; match = a place AND a category keyword in the lead\'s text (a proxy: staging opens the source pages)',
  'usd: settled model and paid-vendor calls (refused calls excluded); TinyFish search/fetch inside its free allowance is priced at 0 and is not in it',
  'icp: inferred by the runner from the query (staging runs with the profile reviewed in the UI), so queries can differ from a staging run',
]
// The line a builder on contacts (root cause 4) must read: which mode ran, and whether Apollo/PDL contacts can appear at all.
export const CONTACTS_LINE = {
  budget: 'contacts: this run gave each case a run budget (max_usd), which switches the paid contact pass OFF, so Apollo/PDL contacts never appear here; named/email come from the lead, the company site and people search only. Run with --contacts to measure the contact pass',
  contacts: (keys: string[]) => `contacts: --contacts mode, no run dollar limit on the job (as in the staging matrix), so the paid contact pass runs; provider keys saved for the cases: ${keys.length ? keys.join(', ') : 'NONE (set MATRIX_PDL_KEY / MATRIX_APOLLO_KEY), so the pass has nothing to call'}; the cap is the scan spend ledger's per-scan cap plus the runner's stop`,
}

export function matrixTable(rows: CaseResult[], t: MatrixThresholds, meta: { commit: string; date: string; contacts?: string[] | null }): string {
  const pass = rows.filter(r => r.pass).length
  const head = `MATRIX local @ ${meta.commit} ${meta.date}: ${pass}/${rows.length} PASS (per case: >=${t.ready_leads_min} ready, >=${t.named_contact_min_pct}% named, >=${t.dated_source_min_pct}% dated, >=${t.location_category_match_min_pct}% in place and category; cap US$${t.per_case_confirm_cap_usd}/case)`
  const cols = ['case', 'status', 'cand', 'leads', 'ready', 'named%', 'email%', 'guess%', 'role%', 'dated%', 'match%', 'secs', 'usd', 'verdict']
  const body = rows.map(r => [r.id, r.status, r.candidates, r.leads, r.ready, r.named_pct, r.email_pct, r.email_guess_pct, r.email_role_pct, r.dated_pct, r.match_pct, r.seconds, r.usd == null ? '?' : r.usd.toFixed(3), r.pass ? 'PASS' : 'FAIL'].map(String))
  const w = cols.map((c, i) => Math.max(c.length, ...body.map(b => b[i].length)))
  const line = (cells: string[]) => cells.map((c, i) => c.padEnd(w[i])).join('  ')
  const held = rows.filter(r => !r.pass).map(r => `  ${r.id}: ${r.error ? `${r.error}; ` : ''}${r.why.join('; ')}${Object.keys(r.held).length ? ` | held: ${Object.entries(r.held).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(', ')}` : ''}`)
  return [head, line(cols), line(w.map(n => '-'.repeat(n))), ...body.map(line), '', ...held, '', 'definitions:', ...[...DEFINITIONS, meta.contacts ? CONTACTS_LINE.contacts(meta.contacts) : CONTACTS_LINE.budget].map(d => `  ${d}`)].join('\n')
}
