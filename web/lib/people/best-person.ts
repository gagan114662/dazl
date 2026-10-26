// The one person to reach first for each lead, for exports (the leads page shows the full ranked list). Same ranking
// as the page: contactsFromEnrichments ordered by the scan ICP's buyer roles. Nothing is invented: a lead with no
// found person gets empty fields.
import type Database from 'better-sqlite3'
import { contactsFromEnrichments, PEOPLE_SOURCE } from './rank.ts'

export interface BestPerson { best_person: string; best_person_title: string; best_person_link: string; best_person_found_via: string }
const EMPTY: BestPerson = { best_person: '', best_person_title: '', best_person_link: '', best_person_found_via: '' }

function buyerRoles(db: Database.Database, jobId: string): string {
  try {
    const j = db.prepare('SELECT icp FROM scan_jobs WHERE id = ?').get(jobId) as { icp: string | null } | undefined
    const who = j?.icp ? (JSON.parse(j.icp) as { who?: unknown }).who : null
    return Array.isArray(who) ? who.filter((x): x is string => typeof x === 'string').join('; ') : ''
  } catch { return '' }
}

// A title that says the role is over ("Former HR Manager", "Previously CEO") is never a person to reach first.
// Only the title text is checked here; a contradictory CURRENT employer is #193's parser job, not detectable here.
const FORMER = /\b(former|formerly|previous|previously|past|ex|retired|emeritus)\b/i

// Tenant-scoped on both sides: the enrichment row must carry the tenant AND its lead must belong to a job that tenant
// owns and not be quarantined, so a malformed/cross-tenant row is never selected. The table is checked before
// preparing (an older/no-connector schema has none), so an empty or legacy export falls back to empty fields.
export function bestPeople(db: Database.Database, tenantId: string, rows: { lead_id: string; job_id: string }[]): Map<string, BestPerson> {
  const out = new Map<string, BestPerson>()
  const rolesByJob = new Map<string, string>()
  const hasTable = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'lead_enrichments'").get()
  const q = hasTable ? db.prepare(
    `SELECT e.kind, e.value, e.label, e.source_url, e.connector FROM lead_enrichments e
     JOIN leads l ON l.id = e.lead_id JOIN scan_jobs j ON j.id = l.scan_job_id
     WHERE e.lead_id = ? AND e.tenant_id = ? AND j.user_id = ? AND l.quarantined_at IS NULL AND e.kind IN ('contact', 'person')`) : null
  for (const r of rows) {
    if (!rolesByJob.has(r.job_id)) rolesByJob.set(r.job_id, buyerRoles(db, r.job_id))
    let enr: { kind: string; value: string; label: string | null; source_url: string; connector: string }[] = []
    if (q) enr = q.all(r.lead_id, tenantId, tenantId) as typeof enr
    const top = contactsFromEnrichments(enr, rolesByJob.get(r.job_id)!).find(c => !FORMER.test(c.title ?? ''))
    out.set(r.lead_id, top ? { best_person: top.name, best_person_title: top.title ?? '', best_person_link: top.linkedin ?? top.source ?? '', best_person_found_via: PEOPLE_SOURCE[top.connector] ?? top.connector } : EMPTY)
  }
  return out
}
