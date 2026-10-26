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

export function bestPeople(db: Database.Database, rows: { lead_id: string; job_id: string }[]): Map<string, BestPerson> {
  const out = new Map<string, BestPerson>()
  const rolesByJob = new Map<string, string>()
  const q = db.prepare("SELECT kind, value, label, source_url, connector FROM lead_enrichments WHERE lead_id = ? AND kind IN ('contact', 'person')")
  for (const r of rows) {
    if (!rolesByJob.has(r.job_id)) rolesByJob.set(r.job_id, buyerRoles(db, r.job_id))
    let enr: { kind: string; value: string; label: string | null; source_url: string; connector: string }[] = []
    try { enr = q.all(r.lead_id) as typeof enr } catch { /* no enrichment table yet */ }
    const top = contactsFromEnrichments(enr, rolesByJob.get(r.job_id)!)[0]
    out.set(r.lead_id, top ? { best_person: top.name, best_person_title: top.title ?? '', best_person_link: top.linkedin ?? top.source ?? '', best_person_found_via: PEOPLE_SOURCE[top.connector] ?? top.connector } : EMPTY)
  }
  return out
}
