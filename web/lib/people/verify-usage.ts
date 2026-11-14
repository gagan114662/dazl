// #1036: what Settings > Enrichment says about the mailbox verifier: how many checks this workspace used today and this month, the caps,
// what is left, and, when nothing can run, WHY (off, no verifier, a cap of 0, a spent allowance). Read-only: it counts what the caps
// themselves count (email-pattern.ts reserveVerifySlot: the tenant's checks today in email_candidates and work_email_lookups, and the
// verifier's checks this UTC month across the database in the operator ledger email_verify_usage), so the number shown is the number
// the cap enforces. No setting, no key and no provider call. On the Db layer (SQLite or Postgres), tenant scoped, indexed reads
// (email_candidates_tenant_checked, work_email_lookups_mailbox_checked, the ledger's primary key).
import type { Db } from '../db/client.ts'
import { emailGuessEnabled, verifierFromEnv, verifyDailyCap, verifyMonthlyCap } from './email-pattern.ts'

export type MailboxCheckState = 'off' | 'no_verifier' | 'daily_cap_zero' | 'monthly_cap_zero' | 'day_spent' | 'month_spent' | 'active'
export interface MailboxCheckUsage {
  state: MailboxCheckState
  // the verifier's own name ('zerobounce'; the staging fake says so), or null when none is configured
  verifier: string | null
  day: { used: number; cap: number; remaining: number }
  month: { used: number; cap: number; remaining: number; scope: 'all workspaces on this database' }
  note: string
}

// A store where the finder never ran has no such table: that is zero checks, not an error (SQLite and Postgres wordings).
const noTable = (e: unknown) => /no such (?:table|column)|does not exist/i.test(String((e as Error)?.message))
async function count(db: Db, sql: string, args: (string | number)[]): Promise<number> {
  try { return Number((await db.get<{ n: number | string }>(sql, args))?.n ?? 0) } catch (e) { if (noTable(e)) return 0; throw e }
}

export async function mailboxCheckUsage(db: Db, tenantId: string, env: Record<string, string | undefined> = process.env, nowS: number = Math.floor(Date.now() / 1000)): Promise<MailboxCheckUsage> {
  const dayStart = nowS - (nowS % 86_400), monthKey = new Date(nowS * 1000).toISOString().slice(0, 7)
  const verifier = verifierFromEnv(env)
  const vname = verifier ? verifier.name.slice(0, 40) : null
  const dayUsed = await count(db, 'SELECT count(*) AS n FROM email_candidates WHERE tenant_id = ? AND checked_at >= ?', [tenantId, dayStart])
    + await count(db, 'SELECT count(*) AS n FROM work_email_lookups WHERE tenant_id = ? AND mailbox_checked_at >= ?', [tenantId, dayStart])
  const monthUsed = vname ? await count(db, 'SELECT n FROM email_verify_usage WHERE verifier = ? AND month = ?', [vname, monthKey]) : 0
  const dayCap = verifyDailyCap(env), monthCap = verifyMonthlyCap(env)
  const day = { used: dayUsed, cap: dayCap, remaining: Math.max(0, dayCap - dayUsed) }
  const month = { used: monthUsed, cap: monthCap, remaining: Math.max(0, monthCap - monthUsed), scope: 'all workspaces on this database' as const }
  let state: MailboxCheckState = 'active', note = 'Mailbox checks run on guessed or provider-found addresses of US companies, up to these limits.'
  if (!emailGuessEnabled(env)) { state = 'off'; note = 'Off: address guessing is not turned on for this deployment, so no mailbox check runs and none is counted.' }
  else if (!verifier) { state = 'no_verifier'; note = 'No mailbox verifier is configured, so no check runs. Nothing is counted.' }
  else if (dayCap === 0) { state = 'daily_cap_zero'; note = 'The daily limit is 0 (no check is allowed until the operator sets one).' }
  else if (monthCap === 0) { state = 'monthly_cap_zero'; note = 'The monthly limit is 0 (no check is allowed).' }
  else if (monthUsed >= monthCap) { state = 'month_spent'; note = 'The verifier\'s monthly allowance is used up (counted across every workspace on this database); checks resume next month.' }
  else if (dayUsed >= dayCap) { state = 'day_spent'; note = 'This workspace has used today\'s checks; more are allowed after 00:00 UTC.' }
  return { state, verifier: vname, day, month, note }
}
