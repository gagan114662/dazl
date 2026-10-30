import type Database from 'better-sqlite3'

// Lookalike signals: does a lead resemble the tenant's OWN past leads that graded
// fit 4+ or drew an 'interested' reply? The reference cohort is those past leads -
// NOT customers, NOT proven buyers - and the UI must say so. Heuristic only.
//
// Honesty rules baked in:
// - Reference cohort excludes synthetic/test rows, opted-out contacts, and the
//   candidate leads themselves.
// - A cohort under MIN_COHORT yields an explicit 'insufficient' state, never a
//   quiet zero or an invented score.
// - Tenant-scoped throughout: no row ever crosses tenants.
// - Read-only: pure SELECTs over existing tables, no fetches, no model calls.

export const MIN_COHORT = 3

export interface LookalikeSignal {
  state: 'insufficient' | 'scored'
  cohort_size: number
  matches: number          // cohort members this lead resembles (0 when insufficient)
  matched_on: string[]     // which dimensions matched, e.g. ['signal keywords','location']
}

const STOP = new Set(('this,that,with,from,have,has,been,were,they,their,them,will,would,could,should,about,into,over,after,before,more,most,other,these,those,when,where,which,while,who,whom,why,how,what,all,any,each,few,than,too,very,just,also,not,but,and,for,are,was,its,our,out,can,now,new,use,used,using,hiring,hired,hire,role,roles,team,company,companies,job,jobs,post,posts,posting,postings,page,pages').split(','))

export function tokens(text: string): Set<string> {
  const out = new Set<string>()
  for (const w of text.toLowerCase().split(/[^a-z0-9]+/)) if (w.length >= 4 && !STOP.has(w)) out.add(w)
  return out
}

interface CohortRow { id: string; signal: string; industry: string | null; location: string | null }

// The reference cohort: the tenant's own past leads graded fit 4+ or with an
// 'interested' classified reply, minus test rows, opted-out contacts, and the leads
// being scored right now.
// A lead the tenant rejected (#385, active feedback) never trains the cohort either, whatever its fit grade.
export function referenceCohort(db: Database.Database, tenantId: string, excludeLeadIds: string[]): CohortRow[] {
  const exclude = new Set(excludeLeadIds)
  let rejected = new Set<string>()
  try { rejected = new Set((db.prepare("SELECT lead_id FROM lead_feedback WHERE tenant_id = ? AND verdict = 'reject' AND reset_at IS NULL AND lead_id IS NOT NULL").all(tenantId) as { lead_id: string }[]).map(r => r.lead_id)) } catch { /* no feedback table: nothing was rejected */ }
  const rows = db.prepare(
    `SELECT DISTINCT l.id, l.signal, j.industry, j.location
     FROM leads l JOIN scan_jobs j ON j.id = l.scan_job_id
     LEFT JOIN suppressions s ON s.tenant_id = j.user_id AND s.email = lower(trim(l.contact))
     WHERE j.user_id = ?
       AND (l.source_kind IS NULL OR l.source_kind <> 'test')
       AND l.company NOT LIKE '%(test only)%'
       AND s.email IS NULL
       AND (l.fit >= 4 OR l.id IN (SELECT lead_id FROM inbound_messages WHERE tenant_id = ? AND classification = 'positive' AND lead_id IS NOT NULL))
     LIMIT 200`
  ).all(tenantId, tenantId) as CohortRow[]
  return rows.filter(r => !exclude.has(r.id) && !rejected.has(r.id))
}

export function lookalikeSignals(db: Database.Database, tenantId: string, leads: { id: string; signal: string; industry?: string | null; location?: string | null }[]): Map<string, LookalikeSignal> {
  const out = new Map<string, LookalikeSignal>()
  if (leads.length === 0) return out
  const cohort = referenceCohort(db, tenantId, leads.map(l => l.id))
  const cohortTok = cohort.map(c => ({ row: c, tok: tokens(c.signal) }))
  for (const l of leads) {
    if (cohort.length < MIN_COHORT) { out.set(l.id, { state: 'insufficient', cohort_size: cohort.length, matches: 0, matched_on: [] }); continue }
    const lt = tokens(l.signal)
    let matches = 0
    const on = new Set<string>()
    for (const c of cohortTok) {
      let hit = false
      let shared = 0
      for (const t of lt) if (c.tok.has(t)) shared++
      if (shared >= 2) { hit = true; on.add('signal keywords') }
      if (l.industry && c.row.industry && l.industry === c.row.industry) { hit = true; on.add('industry') }
      if (l.location && c.row.location && l.location === c.row.location) { hit = true; on.add('location') }
      if (hit) matches++
    }
    out.set(l.id, { state: 'scored', cohort_size: cohort.length, matches, matched_on: [...on] })
  }
  return out
}
