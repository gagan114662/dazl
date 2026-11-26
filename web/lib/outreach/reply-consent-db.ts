import { randomBytes } from 'node:crypto'
import type { Db } from '../db/client.ts'

type ConsentTable = 'mail_read_consent' | 'mail_bounce_scan_consent'

/** Returns true only when the tenant newly accepts this version. */
export function recordReplyConsent(db: Db, table: ConsentTable, tenantId: string, version: string): Promise<boolean> {
  const acceptedAt = Math.floor(Date.now() / 1000)
  return db.tx(function* (tx) {
    const result = yield* tx.run(
      `INSERT INTO ${table} (tenant_id, version, accepted_at) VALUES (?, ?, ?)
       ON CONFLICT (tenant_id) DO UPDATE SET version = excluded.version, accepted_at = excluded.accepted_at
       WHERE ${table}.version <> excluded.version`,
      [tenantId, version, acceptedAt],
    )
    if (result.changes === 0) {
      yield* tx.run(`UPDATE ${table} SET accepted_at = ? WHERE tenant_id = ?`, [acceptedAt, tenantId])
    }
    return result.changes > 0
  })
}

export function removeReplyConsent(db: Db, table: ConsentTable, tenantId: string): Promise<boolean> {
  return db.tx(function* (tx) {
    const result = yield* tx.run(`DELETE FROM ${table} WHERE tenant_id = ?`, [tenantId])
    if (table === 'mail_read_consent') {
      yield* tx.run('UPDATE autopilot_settings SET followups_enabled = 0 WHERE tenant_id = ?', [tenantId])
    }
    return result.changes > 0
  })
}

/** Records every request in the autopilot audit and reports whether the setting changed. */
export function disableReplyFollowups(db: Db, tenantId: string): Promise<boolean> {
  return db.tx(function* (tx) {
    const result = yield* tx.run(
      'UPDATE autopilot_settings SET followups_enabled = 0 WHERE tenant_id = ? AND followups_enabled <> 0',
      [tenantId],
    )
    yield* tx.run(
      'INSERT INTO autopilot_audit (id, tenant_id, action, created_at) VALUES (?, ?, ?, ?)',
      [randomBytes(12).toString('hex'), tenantId, 'followups_off', Math.floor(Date.now() / 1000)],
    )
    return result.changes > 0
  })
}
