// Cross-play outreach cooldowns (#364): a play that found a person, or a company, another play already emailed does not
// email them again on its own. Applied where a first touch is drafted and again where it is sent (lib/outreach/service.ts),
// for every play and every sender of the tenant. Follow-ups and sequence steps continue the thread that was started, so
// they are not first touches and are not held here.
//   recipient - the same address was emailed (sent, being sent, or with an unknown outcome) from another lead within
//               DAZL_RECIPIENT_COOLDOWN_DAYS (default 90).
//   account   - someone at the same canonical account (lib/accounts/graph.ts) was emailed from a lead of another play
//               within DAZL_ACCOUNT_COOLDOWN_DAYS (default 30). Only a lead linked to an account counts: a quarantined
//               or not yet linked lead is held by the recipient rule alone, never guessed onto an account.
// A message with an unknown outcome counts as sent: it may have gone out.
// Raw SQLite (the send path's handle); tenant scope: every statement is keyed by the tenant id.
import type Database from 'better-sqlite3'

const days = (v: string | undefined, dflt: number) => { const n = Number(v); return v !== undefined && v !== '' && Number.isFinite(n) && n >= 0 ? n : dflt }
export function cooldownDays(env: Record<string, string | undefined> = process.env) {
  return { recipient: days(env.DAZL_RECIPIENT_COOLDOWN_DAYS, 90), account: days(env.DAZL_ACCOUNT_COOLDOWN_DAYS, 30) }
}
const CONTACTED = "status IN ('sending','sent','uncertain')"
const AT = 'COALESCE(sent_at, claimed_at, created_at)'

export type CooldownHold = 'recipient_contacted_recently' | 'account_contacted_recently'

export function crossPlayHold(db: Database.Database, tenantId: string, leadId: string, toEmail: string, o: { now?: number; env?: Record<string, string | undefined> } = {}): CooldownHold | null {
  const now = o.now ?? Math.floor(Date.now() / 1000)
  const cd = cooldownDays(o.env)
  const email = toEmail.trim().toLowerCase()
  if (cd.recipient > 0 && db.prepare(`SELECT 1 FROM outreach_messages WHERE tenant_id = ? AND lead_id <> ? AND lower(trim(to_email)) = ? AND ${CONTACTED} AND ${AT} >= ? LIMIT 1`)
    .get(tenantId, leadId, email, now - cd.recipient * 86400)) return 'recipient_contacted_recently'
  if (cd.account > 0) {
    const link = db.prepare("SELECT account_id, job_id FROM tenant_lead_links WHERE tenant_id = ? AND lead_id = ? AND status = 'linked'").get(tenantId, leadId) as { account_id: string; job_id: string } | undefined
    if (link && db.prepare(`SELECT 1 FROM outreach_messages m JOIN tenant_lead_links k ON k.tenant_id = m.tenant_id AND k.lead_id = m.lead_id
        WHERE m.tenant_id = ? AND k.account_id = ? AND k.status = 'linked' AND k.job_id <> ? AND m.lead_id <> ? AND m.status IN ('sending','sent','uncertain') AND COALESCE(m.sent_at, m.claimed_at, m.created_at) >= ? LIMIT 1`)
      .get(tenantId, link.account_id, link.job_id, leadId, now - cd.account * 86400)) return 'account_contacted_recently'
  }
  return null
}
