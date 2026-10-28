import type { Db } from '../db/client.ts'

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

// On the Db layer (SQLite or Postgres). A scan with no finished_at counts as ending now (the caller's clock, epoch
// seconds); same-second scans are tie-broken by insert_seq, the order rowid gave.
export async function openKeyRejection(db: Db, tenantId: string, nowS = Math.floor(Date.now() / 1000)): Promise<KeyEvidence | null> {
  const keys = await db.all<{ validated_at: number }>('SELECT validated_at FROM tenant_llm_keys WHERE tenant_id = ?', [tenantId])
  if (!keys.length) return null
  const oldestAcceptance = Math.min(...keys.map(k => Number(k.validated_at)))
  const f = await db.get<{ error: KeyEvidence['error'] }>(`SELECT error FROM scan_jobs
    WHERE user_id = ? AND status = 'failed' AND error IN ('key_rejected', 'key_unreadable') AND funded_by != 'trial'
      AND COALESCE(finished_at, ?) >= ?
    ORDER BY created_at DESC, insert_seq DESC LIMIT 1`, [tenantId, nowS, oldestAcceptance])
  return f ? { error: f.error } : null
}
