// Quarantine a lead (owner request, 2026-10-26; the wrong-company Smile Avenue lead of issue #197). The lead and ALL its
// evidence stay exactly as they are (nothing deleted, reversible), but it can no longer be drafted, sent, picked by
// autopilot or exported. The send-time gate (outreach/service.ts domainReviewStatus) treats a quarantined lead as held,
// which covers every send path that already passes through that gate.
import type Database from 'better-sqlite3'

export const QUARANTINE_REASON_MAX = 300
export type QuarantineResult = { status: 'quarantined' | 'released' | 'not_found' | 'unchanged' }

export function setQuarantine(db: Database.Database, tenantId: string, leadId: string, action: 'quarantine' | 'release', reason = '', now = Date.now()): QuarantineResult {
  const lead = db.prepare('SELECT l.id, l.quarantined_at FROM leads l JOIN scan_jobs j ON j.id = l.scan_job_id WHERE l.id = ? AND j.user_id = ?').get(leadId, tenantId) as { id: string; quarantined_at: number | null } | undefined
  if (!lead) return { status: 'not_found' }
  if (action === 'release') {
    if (lead.quarantined_at == null) return { status: 'unchanged' }
    db.prepare('UPDATE leads SET quarantined_at = NULL, quarantine_reason = NULL WHERE id = ?').run(lead.id)
    return { status: 'released' }
  }
  const why = reason.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, QUARANTINE_REASON_MAX) || 'Quarantined by you'
  db.prepare('UPDATE leads SET quarantined_at = ?, quarantine_reason = ? WHERE id = ?').run(Math.floor(now / 1000), why, lead.id)
  return { status: 'quarantined' }
}

// Missing column (an older schema) reads as not quarantined only where the caller cannot act on it; send paths fail
// closed through domainReviewStatus's own unreadable handling.
export function isQuarantined(db: Database.Database, leadId: string): boolean {
  const r = db.prepare('SELECT quarantined_at FROM leads WHERE id = ?').get(leadId) as { quarantined_at: number | null } | undefined
  return r?.quarantined_at != null
}
