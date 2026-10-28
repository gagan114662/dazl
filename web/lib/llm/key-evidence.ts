import type Database from 'better-sqlite3'

// Server-only, read-only. Whether the account's saved AI keys have open negative evidence: a scan that stopped because
// its key was rejected (key_rejected) or could not be read (key_unreadable), with no positive acceptance since.
//
// What the records can and cannot say:
// - Trial-funded scans (funded_by 'trial') ran on the shared free-search key and are never evidence about the user's.
// - Which of the user's keys a scan used is NOT recorded. The runner picks the newest key when an attempt runs, so a key
//   added, re-saved or deleted while the scan was queued or retrying changes it, and a deleted key leaves no trace.
//   So a rejection is never attributed to a particular key, and a later finished scan proves nothing about which key
//   it used.
// - The only positive acceptance recorded is the provider check when a key is saved (validated_at). A rejection stays
//   open until every key saved now was saved (and accepted) strictly after that scan ended; a same-second save, a
//   cancelled or failed scan, a done scan or saving only one of several keys does not clear it.
export interface KeyEvidence { error: 'key_rejected' | 'key_unreadable' }

export function openKeyRejection(db: Database.Database, tenantId: string): KeyEvidence | null {
  const keys = db.prepare('SELECT validated_at FROM tenant_llm_keys WHERE tenant_id = ?').all(tenantId) as { validated_at: number }[]
  if (!keys.length) return null
  const oldestAcceptance = Math.min(...keys.map(k => k.validated_at))
  const f = db.prepare(`SELECT error FROM scan_jobs
    WHERE user_id = ? AND status = 'failed' AND error IN ('key_rejected', 'key_unreadable') AND funded_by != 'trial'
      AND COALESCE(finished_at, CAST(strftime('%s','now') AS INTEGER)) >= ?
    ORDER BY created_at DESC, rowid DESC LIMIT 1`).get(tenantId, oldestAcceptance) as { error: KeyEvidence['error'] } | undefined
  return f ? { error: f.error } : null
}
