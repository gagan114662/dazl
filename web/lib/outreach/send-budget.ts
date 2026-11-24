import type Database from 'better-sqlite3'

// One rolling 24-hour budget across manual first touches, warm follow-ups and cold
// sequence steps. In-flight/unknown sends reserve a slot too. Claims are synchronous
// SQLite writes, so each sender checks this immediately AFTER claiming its slot.
export const ACCOUNT_SEND_CAP = 20
export function tableExists(db: Database.Database, name: string): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name)
}
// #1618: the cap on emails a person sends by hand, by the age of the account, to protect their Gmail. 20 a day for the
// first 14 days, then 10 more a day for each further week, up to 50. An account whose age cannot be read counts as new.
// Automated senders (follow-ups, sequence steps, autopilot) keep ACCOUNT_SEND_CAP over a rolling 24 hours, whatever the age.
export const NEW_ACCOUNT_DAYS = 14
export const SEND_CAP_STEP = 10
export const SEND_CAP_MAX = 50
export function sendCapForAge(ageS: number | null): number {
  if (ageS === null || !(ageS >= NEW_ACCOUNT_DAYS * 86400)) return ACCOUNT_SEND_CAP
  return Math.min(SEND_CAP_MAX, ACCOUNT_SEND_CAP + SEND_CAP_STEP * (1 + Math.floor((ageS - NEW_ACCOUNT_DAYS * 86400) / (7 * 86400))))
}
// When the account (the workspace, else its founding user) was created; null when neither row says.
export function accountCreatedAt(db: Database.Database, tenant: string): number | null {
  for (const table of ['organizations', 'users']) {
    // a store without the table or the column (an older schema) says nothing about age: the account then counts as new
    if (!tableExists(db, table) || !(db.pragma(`table_info(${table})`) as { name: string }[]).some(c => c.name === 'created_at')) continue
    const at = (db.prepare(`SELECT created_at FROM ${table} WHERE id = ?`).get(tenant) as { created_at: number | null } | undefined)?.created_at
    if (typeof at === 'number' && at > 0) return at
  }
  return null
}
// OUTREACH_DAILY_CAP, when the operator sets it, is a ceiling on every account; it never raises a cap.
export function manualSendCap(db: Database.Database, tenant: string, now: number, env: Record<string, string | undefined> = process.env): number {
  const created = accountCreatedAt(db, tenant)
  const cap = sendCapForAge(created === null ? null : now - created)
  const ceiling = Number(env.OUTREACH_DAILY_CAP)
  return env.OUTREACH_DAILY_CAP && Number.isFinite(ceiling) && ceiling >= 0 ? Math.min(cap, Math.floor(ceiling)) : cap
}
// The sending day is the Toronto calendar day (#1618, as the trial allowance #1621): the count starts again at midnight there.
const torontoClock = new Intl.DateTimeFormat('en-GB', { timeZone: 'America/Toronto', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
export function sendDayStart(now: number): number {
  const p = Object.fromEntries(torontoClock.formatToParts(new Date(now * 1000)).map(x => [x.type, Number(x.value)]))
  return now - (p.hour * 3600 + p.minute * 60 + p.second) // exact but for the two clock-change days a year, when it is an hour out
}
// `since`: the start of the window counted. The default is the rolling 24 hours the automated senders use; a person's own
// sends are counted from sendDayStart(now).
export function accountSendCount(db: Database.Database, tenant: string, now: number, since = now - 86400): number {
  let count = (db.prepare("SELECT count(*) AS n FROM outreach_messages WHERE tenant_id = ? AND status IN ('sent','sending','uncertain') AND COALESCE(claimed_at,sent_at,created_at) >= ?").get(tenant, since) as { n: number }).n
  if (tableExists(db, 'followup_messages')) count += (db.prepare("SELECT count(*) AS n FROM followup_messages WHERE tenant_id = ? AND status IN ('sent','sending','uncertain') AND created_at >= ?").get(tenant, since) as { n: number }).n
  if (tableExists(db, 'sequence_steps')) count += (db.prepare("SELECT count(*) AS n FROM sequence_steps WHERE tenant_id = ? AND step > 1 AND status IN ('sent','sending','uncertain') AND COALESCE(claimed_at,sent_at,created_at) >= ?").get(tenant, since) as { n: number }).n
  // A re-open keeps its claim time in sent_at while 'approved' (no schema change), and the delivery time once sent.
  if (tableExists(db, 'reopen_messages')) count += (db.prepare("SELECT count(*) AS n FROM reopen_messages WHERE tenant_id = ? AND status IN ('sent','approved') AND COALESCE(sent_at,created_at) >= ?").get(tenant, since) as { n: number }).n
  return count
}
export function anyUncertainSend(db: Database.Database, tenant: string): boolean {
  for (const table of ['outreach_messages','followup_messages','sequence_steps']) {
    if (tableExists(db, table) && db.prepare(`SELECT 1 FROM ${table} WHERE tenant_id = ? AND status = 'uncertain'`).get(tenant)) return true
  }
  // A re-open has no 'uncertain' state: 'approved' is its in-flight claim, and a claim whose outcome was never
  // recorded stays 'approved'. Read-only here (no migration); the table may not exist yet.
  if (tableExists(db, 'reopen_messages') && db.prepare("SELECT 1 FROM reopen_messages WHERE tenant_id = ? AND status = 'approved'").get(tenant)) return true
  return false
}
