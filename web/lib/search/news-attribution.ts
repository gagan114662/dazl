// Per-lead GDELT attribution, read from the discovery ledger (lead_sources, collector 'news:gdelt'), tenant-scoped.
// A lead GDELT surfaced is shown (and exported) with the citation and link its terms require. Not a currentness,
// identity or event-date claim: it says only which index surfaced the page.
import type Database from 'better-sqlite3'
import type { Db } from '../db/client.ts'
import { GDELT_ATTRIBUTION, GDELT_URL, NEWS_SOURCE } from './news.ts'

export interface LeadAttribution { text: string; link: string }
const ATTRIBUTED_SQL = `SELECT 1 AS x FROM lead_sources s JOIN leads l ON l.id = s.lead_id JOIN scan_jobs j ON j.id = l.scan_job_id
      WHERE s.lead_id = ? AND s.collector = ? AND j.user_id = ?`
export function gdeltAttribution(db: Database.Database, tenantId: string, leadIds: string[]): Map<string, LeadAttribution> {
  const out = new Map<string, LeadAttribution>()
  if (leadIds.length === 0) return out
  try {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='lead_sources'").get()) return out
    const q = db.prepare(ATTRIBUTED_SQL)
    for (const id of leadIds) if (q.get(id, NEWS_SOURCE, tenantId)) out.set(id, { text: GDELT_ATTRIBUTION, link: GDELT_URL })
  } catch { /* attribution is display-only; never fails a read */ }
  return out
}

// gdeltAttribution on the Db layer (SQLite or Postgres): the same query per lead. Every table exists there (getDb runs
// every migration), so there is no table check.
export async function readGdeltAttribution(db: Db, tenantId: string, leadIds: string[]): Promise<Map<string, LeadAttribution>> {
  const out = new Map<string, LeadAttribution>()
  try {
    for (const id of leadIds) if (await db.get(ATTRIBUTED_SQL, [id, NEWS_SOURCE, tenantId])) out.set(id, { text: GDELT_ATTRIBUTION, link: GDELT_URL })
  } catch { /* attribution is display-only; never fails a read */ }
  return out
}
