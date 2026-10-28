// The one person to reach first for each lead, for exports (the leads page shows the full ranked list). Same ranking
// as the page: contactsFromEnrichments ordered by the scan ICP's buyer roles. Nothing is invented: a lead with no
// found person gets empty fields.
import type { Db } from '../db/client.ts'
import { contactsFromEnrichments, PEOPLE_SOURCE, roleContradicted } from './rank.ts'

export interface BestPerson { best_person: string; best_person_title: string; best_person_link: string; best_person_found_via: string }
const EMPTY: BestPerson = { best_person: '', best_person_title: '', best_person_link: '', best_person_found_via: '' }

async function buyerRoles(db: Db, jobId: string): Promise<string> {
  try {
    const j = await db.get<{ icp: string | null }>('SELECT icp FROM scan_jobs WHERE id = ?', [jobId])
    const who = j?.icp ? (JSON.parse(j.icp) as { who?: unknown }).who : null
    return Array.isArray(who) ? who.filter((x): x is string => typeof x === 'string').join('; ') : ''
  } catch { return '' }
}

// Recommendation, not scoring: a person whose title explicitly contradicts the buyer role (past, retired, negated,
// assistant-to; roleContradicted, the same rule as the opportunity card's recommendedPerson) is never Best Person, for any
// connector, with or without an ICP. If every stored person is contradicted the export fields are empty. A contradictory
// CURRENT employer is the people-search parser's job, not detectable here.

// Tenant-scoped on both sides: the enrichment row must carry the tenant AND its lead must belong to a job that tenant
// owns and not be quarantined, so a malformed/cross-tenant row is never selected. On the Db layer (SQLite or Postgres).
// The table is probed first (an older/no-connector schema has none), so an empty or legacy export falls back to empty
// fields. Enrichments are read in insertion order (made explicit: the raw query relied on it), so ranking ties resolve
// as before.
export async function bestPeople(db: Db, tenantId: string, rows: { lead_id: string; job_id: string }[]): Promise<Map<string, BestPerson>> {
  const out = new Map<string, BestPerson>()
  const rolesByJob = new Map<string, string>()
  if (rows.length === 0) return out
  const hasTable = await db.get('SELECT 1 AS x FROM lead_enrichments LIMIT 0').then(() => true, () => false)
  for (const r of rows) {
    if (!rolesByJob.has(r.job_id)) rolesByJob.set(r.job_id, await buyerRoles(db, r.job_id))
    const enr = !hasTable ? [] : await db.all<{ kind: string; value: string; label: string | null; source_url: string; connector: string }>(
      `SELECT e.kind, e.value, e.label, e.source_url, e.connector FROM lead_enrichments e
       JOIN leads l ON l.id = e.lead_id JOIN scan_jobs j ON j.id = l.scan_job_id
       WHERE e.lead_id = ? AND e.tenant_id = ? AND j.user_id = ? AND l.quarantined_at IS NULL AND e.kind IN ('contact', 'person')
       ORDER BY e.insert_seq`, [r.lead_id, tenantId, tenantId])
    const top = contactsFromEnrichments(enr, rolesByJob.get(r.job_id)!).find(c => !c.title || !roleContradicted(c.title, rolesByJob.get(r.job_id)!))
    out.set(r.lead_id, top ? { best_person: top.name, best_person_title: top.title ?? '', best_person_link: top.linkedin ?? top.source ?? '', best_person_found_via: PEOPLE_SOURCE[top.connector] ?? top.connector } : EMPTY)
  }
  return out
}
