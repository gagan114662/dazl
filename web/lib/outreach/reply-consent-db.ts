import { randomBytes } from 'node:crypto'
import type { Db, Tx } from '../db/client.ts'

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

function auditFollowupSetting(tx: Tx, tenantId: string, on: boolean) {
  return tx.run(
    'INSERT INTO autopilot_audit (id, tenant_id, action, created_at) VALUES (?, ?, ?, ?)',
    [randomBytes(12).toString('hex'), tenantId, on ? 'followups_on' : 'followups_off', Math.floor(Date.now() / 1000)],
  )
}

/** Records every request in the autopilot audit and reports whether the setting changed. */
export function disableReplyFollowups(db: Db, tenantId: string): Promise<boolean> {
  return db.tx(function* (tx) {
    const result = yield* tx.run(
      'UPDATE autopilot_settings SET followups_enabled = 0 WHERE tenant_id = ? AND followups_enabled <> 0',
      [tenantId],
    )
    yield* auditFollowupSetting(tx, tenantId, false)
    return result.changes > 0
  })
}

export function enableReplyFollowups(db: Db, tenantId: string, consent: {
  replyVersion: string
  autopilotVersion: string
  autopilotAvailable: boolean
}): Promise<'read_required' | 'unavailable' | 'autopilot_required' | 'enabled' | 'already_enabled'> {
  return db.tx(function* (tx) {
    // PostgreSQL locks the consent row first, matching reply revocation. SQLite takes its write lock at transaction start.
    const lock = tx.kind === 'pg' ? ' FOR UPDATE' : ''
    const reply = yield* tx.get<{ version: string }>('SELECT version FROM mail_read_consent WHERE tenant_id = ?' + lock, [tenantId])
    const account = yield* tx.get<{ read_granted: number }>('SELECT read_granted FROM gmail_accounts WHERE tenant_id = ?' + lock, [tenantId])
    if (reply?.version !== consent.replyVersion || account?.read_granted !== 1) return 'read_required'
    if (!consent.autopilotAvailable) return 'unavailable'
    const settings = yield* tx.get<{ enabled: number; consent_version: string | null; followups_enabled: number }>(
      'SELECT enabled, consent_version, followups_enabled FROM autopilot_settings WHERE tenant_id = ?' + lock,
      [tenantId],
    )
    if (settings?.enabled !== 1 || settings.consent_version !== consent.autopilotVersion) return 'autopilot_required'
    yield* tx.run('UPDATE autopilot_settings SET followups_enabled = 1 WHERE tenant_id = ?', [tenantId])
    yield* auditFollowupSetting(tx, tenantId, true)
    return settings.followups_enabled === 1 ? 'already_enabled' : 'enabled'
  })
}
