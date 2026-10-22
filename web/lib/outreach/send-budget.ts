import type Database from 'better-sqlite3'

// One rolling 24-hour budget across manual first touches, warm follow-ups and cold
// sequence steps. In-flight/unknown sends reserve a slot too. Claims are synchronous
// SQLite writes, so each sender checks this immediately AFTER claiming its slot.
export const ACCOUNT_SEND_CAP = 20
export function tableExists(db: Database.Database, name: string): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name)
}
export function accountSendCount(db: Database.Database, tenant: string, now: number): number {
  let count = (db.prepare("SELECT count(*) AS n FROM outreach_messages WHERE tenant_id = ? AND status IN ('sent','sending','uncertain') AND COALESCE(claimed_at,sent_at,created_at) >= ?").get(tenant, now - 86400) as { n: number }).n
  if (tableExists(db, 'followup_messages')) count += (db.prepare("SELECT count(*) AS n FROM followup_messages WHERE tenant_id = ? AND status IN ('sent','sending','uncertain') AND created_at >= ?").get(tenant, now - 86400) as { n: number }).n
  if (tableExists(db, 'sequence_steps')) count += (db.prepare("SELECT count(*) AS n FROM sequence_steps WHERE tenant_id = ? AND step > 1 AND status IN ('sent','sending','uncertain') AND COALESCE(claimed_at,sent_at,created_at) >= ?").get(tenant, now - 86400) as { n: number }).n
  return count
}
export function anyUncertainSend(db: Database.Database, tenant: string): boolean {
  for (const table of ['outreach_messages','followup_messages','sequence_steps']) {
    if (tableExists(db, table) && db.prepare(`SELECT 1 FROM ${table} WHERE tenant_id = ? AND status = 'uncertain'`).get(tenant)) return true
  }
  return false
}
