// Per-lead GDELT attribution, read from the discovery ledger (lead_sources, collector 'news:gdelt'), tenant-scoped.
// A lead GDELT surfaced is shown (and exported) with the citation and link its terms require. Not a currentness,
// identity or event-date claim: it says only which index surfaced the page.
import type Database from 'better-sqlite3'
import { GDELT_ATTRIBUTION, GDELT_URL, NEWS_SOURCE } from './news.ts'

export interface LeadAttribution { text: string; link: string }
export function gdeltAttribution(db: Database.Database, tenantId: string, leadIds: string[]): Map<string, LeadAttribution> {
  const out = new Map<string, LeadAttribution>()
  if (leadIds.length === 0) return out
  try {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='lead_sources'").get()) return out
    const q = db.prepare(`SELECT 1 FROM lead_sources s JOIN leads l ON l.id = s.lead_id JOIN scan_jobs j ON j.id = l.scan_job_id
      WHERE s.lead_id = ? AND s.collector = ? AND j.user_id = ?`)
    for (const id of leadIds) if (q.get(id, NEWS_SOURCE, tenantId)) out.set(id, { text: GDELT_ATTRIBUTION, link: GDELT_URL })
  } catch { /* attribution is display-only; never fails a read */ }
  return out
}
