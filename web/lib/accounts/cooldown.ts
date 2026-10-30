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
// crossPlayHold is on the raw SQLite handle (the send path's, inside its checks); accountHold is on the Db layer, for
// either engine: the account links are read from the graph's store and the emails from the outreach store, which are the
// same SQLite file today and may be Postgres and SQLite while outreach is being ported (#354). Tenant scope: every
// statement is keyed by the tenant id.
import type Database from 'better-sqlite3'
import { asDb, sqliteDb, getDb, type Db, type DbLike, type Param } from '../db/client.ts'
import { resolveLead } from './graph.ts'

const days = (v: string | undefined, dflt: number) => { const n = Number(v); return v !== undefined && v !== '' && Number.isFinite(n) && n >= 0 ? n : dflt }
export function cooldownDays(env: Record<string, string | undefined> = process.env) {
  return { recipient: days(env.DAZL_RECIPIENT_COOLDOWN_DAYS, 90), account: days(env.DAZL_ACCOUNT_COOLDOWN_DAYS, 30) }
}
const CONTACTED = "status IN ('sending','sent','uncertain')"
const AT = 'COALESCE(sent_at, claimed_at, created_at)'

export type CooldownHold = 'recipient_contacted_recently' | 'account_contacted_recently'
export type IdentityHold = 'identity_review_required' | 'identity_unresolved'

export function crossPlayHold(db: Database.Database, tenantId: string, leadId: string, toEmail: string, o: { now?: number; env?: Record<string, string | undefined> } = {}): CooldownHold | 'identity_unresolved' | null {
  // An unreadable store cannot prove there is no cooldown: it holds, like an unresolved identity.
  try { return crossPlayHoldOf(db, tenantId, leadId, toEmail, o) } catch { return 'identity_unresolved' }
}
function crossPlayHoldOf(db: Database.Database, tenantId: string, leadId: string, toEmail: string, o: { now?: number; env?: Record<string, string | undefined> }): CooldownHold | null {
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

// The account rule on the Db layer. graph: the store holding tenant_lead_links (lib/accounts/graph.ts); outreach: the
// store holding outreach_messages. Lead ids are global, so the two may be different stores.
export async function accountHold(graph: DbLike, outreach: DbLike, tenantId: string, leadId: string, o: { now?: number; env?: Record<string, string | undefined> } = {}): Promise<'account_contacted_recently' | null> {
  const days = cooldownDays(o.env).account
  if (days <= 0) return null
  const g = asDb(graph), out = asDb(outreach)
  const link = await g.get<{ account_id: string; job_id: string }>("SELECT account_id, job_id FROM tenant_lead_links WHERE tenant_id = ? AND lead_id = ? AND status = 'linked'", [tenantId, leadId])
  if (!link) return null
  const peers = (await g.all<{ lead_id: string }>("SELECT lead_id FROM tenant_lead_links WHERE tenant_id = ? AND account_id = ? AND status = 'linked' AND job_id <> ? AND lead_id <> ? ORDER BY lead_id", [tenantId, link.account_id, link.job_id, leadId])).map(r => r.lead_id)
  const since = (o.now ?? Math.floor(Date.now() / 1000)) - days * 86400
  for (let i = 0; i < peers.length; i += 400) {
    const ids = peers.slice(i, i + 400)
    const hit = await out.get(`SELECT 1 AS hit FROM outreach_messages WHERE tenant_id = ? AND lead_id IN (${ids.map(() => '?').join(',')}) AND ${CONTACTED} AND ${AT} >= ? LIMIT 1`, [tenantId, ...ids, since] as Param[])
    if (hit) return 'account_contacted_recently'
  }
  return null
}

// The graph's store for a route: the shared store when the app runs on Postgres, else the route's own SQLite handle (the
// same file getDb() opens), so drafts, sends and bookings read and write one graph.
export function graphStore(raw: Database.Database, env: Record<string, string | undefined> = process.env): Promise<Db> {
  return env.DATABASE_URL ? getDb() : Promise.resolve(sqliteDb(raw))
}

// Before a first touch (the draft and send routes): resolve THIS lead's identity first, whatever backlog a bounded sync
// left, then apply the account rule. A lead whose identity is held for a person (quarantined) is held too, and so is one
// whose identity could not be decided (the store failed): an unresolved identity is never treated as "no account".
// null: no hold (a lead that is not the tenant's is left to the caller's own not-found).
export async function firstTouchHold(graph: DbLike, outreach: DbLike, tenantId: string, leadId: string, o: { now?: number; env?: Record<string, string | undefined> } = {}): Promise<IdentityHold | 'account_contacted_recently' | null> {
  let link
  try { link = await resolveLead(graph, tenantId, leadId, { now: o.now }) } catch { return 'identity_unresolved' }
  if (!link) return null
  if (link.status !== 'linked') return 'identity_review_required'
  try {
    // The leads already emailed inside the window are resolved too, so a backlog cannot hide the account they belong to.
    // A send-capped set; past the bound the check cannot be complete and holds.
    const days = cooldownDays(o.env).account
    if (days > 0) {
      const since = (o.now ?? Math.floor(Date.now() / 1000)) - days * 86400
      const emailed = await asDb(outreach).all<{ lead_id: string }>(`SELECT DISTINCT lead_id FROM outreach_messages WHERE tenant_id = ? AND ${CONTACTED} AND ${AT} >= ? ORDER BY lead_id LIMIT ?`, [tenantId, since, EMAILED_MAX + 1])
      if (emailed.length > EMAILED_MAX) return 'identity_unresolved'
      for (const e of emailed) if (!(await asDb(graph).get('SELECT 1 AS k FROM tenant_lead_links WHERE tenant_id = ? AND lead_id = ?', [tenantId, e.lead_id]))) await resolveLead(graph, tenantId, e.lead_id, { now: o.now })
    }
    return await accountHold(graph, outreach, tenantId, leadId, o)
  } catch { return 'identity_unresolved' }
}
// More leads emailed inside the account window than this: the check is not attempted and the first touch is held.
export const EMAILED_MAX = 2000
