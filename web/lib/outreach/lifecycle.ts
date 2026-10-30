import { createHash, randomBytes } from 'node:crypto'
import type Database from 'better-sqlite3'
import type { Db, TxBody } from '../db/client.ts'
import { tableExists } from './send-budget.ts'
import { norm } from './store.ts'

// #417: a prospect of dazl's own acquisition outreach who signs up for dazl or pays leaves that outreach. Only the
// workspaces the operator names as dazl's acquisition senders (DAZL_ACQUISITION_TENANTS, comma-separated tenant ids)
// are affected; unset (production today) = off: nothing is recorded, nothing is held. A customer's workspace never sees
// or acts on what its own prospects do on dazl.
//
// Two tables, separate from the opt-out suppression list and from transactional service email (never touched here):
//   lifecycle_events   private event history: one row per event key (signup:<user>, verified:<user>, stripe:<event>,
//                      paid:<tenant>, checkout:<tenant>), the account it is about and a hash of that account's email,
//                      never the address. Recorded first; applied_at is set only once every acquisition workspace has
//                      been updated, so an event whose application failed is applied again on the next pass.
//   acquisition_holds  durable stop state for one acquisition workspace and one person it emailed: the strongest
//                      evidence so far. Only a workspace that already emailed the address gets a row (and an audit line
//                      without the address); any other workspace is protected from a future cold play by the private
//                      hash lookup in lifecycleHold, which it cannot read.
// Evidence, weakest first: an email/password sign-up (the address is not verified yet: "unverified signup hold"), a
// checkout that did not take payment (a trial or an unpaid session), a sign-up verified by Google, a payment. A hold is
// only ever promoted by stronger evidence, never relabelled from weaker. Nothing here verifies an account, blocks
// verification or sends an onboarding email.
// Durability: the sign-up, Google and Stripe hooks record and apply in their own try, after their own commit, so a
// failure never undoes a sign-up or a payment; reconcileLifecycle (every scheduler tick) re-derives any event that was
// never recorded (a crash between the commit and the hook, or sign-ups and payments while this was off) from the users,
// identities and plans tables and applies every pending event. Retention: forgetLifecycleUser removes a deleted
// account's events (#455 runs it with the rest of the account); holds stay, as an opt-out does, so a deleted account is
// not re-contacted.

export type LifecycleKind = 'signup_unverified' | 'signup_verified' | 'checkout_unpaid' | 'paid'
export type HoldStatus = 'unverified_signup_hold' | 'checkout_unpaid' | 'signed_up' | 'paid'
const STATUS: Record<LifecycleKind, HoldStatus> = { signup_unverified: 'unverified_signup_hold', checkout_unpaid: 'checkout_unpaid', signup_verified: 'signed_up', paid: 'paid' }
const RANK: Record<HoldStatus, number> = { unverified_signup_hold: 1, checkout_unpaid: 2, signed_up: 3, paid: 4 }
// What a stopped sequence or follow-up thread says (lib/outreach/lifecycle-words.ts).
export const STOP_REASON: Record<HoldStatus, string> = { unverified_signup_hold: 'unverified_signup_hold', checkout_unpaid: 'checkout_unpaid', signed_up: 'converted_signup', paid: 'converted_paid' }

export function migrateLifecycle(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS lifecycle_events (
      event_key   TEXT PRIMARY KEY CHECK (length(event_key) <= 200),
      kind        TEXT NOT NULL CHECK (kind IN ('signup_unverified','signup_verified','checkout_unpaid','paid')),
      user_id     TEXT NOT NULL,
      email_hash  TEXT NOT NULL CHECK (length(email_hash) = 64),
      received_at INTEGER NOT NULL,
      applied_at  INTEGER
    );
    CREATE INDEX IF NOT EXISTS lifecycle_events_hash ON lifecycle_events (email_hash);
    CREATE INDEX IF NOT EXISTS lifecycle_events_pending ON lifecycle_events (applied_at);
    CREATE TABLE IF NOT EXISTS acquisition_holds (
      tenant_id  TEXT NOT NULL,
      email_hash TEXT NOT NULL CHECK (length(email_hash) = 64),
      status     TEXT NOT NULL CHECK (status IN ('unverified_signup_hold','checkout_unpaid','signed_up','paid')),
      event_key  TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (tenant_id, email_hash)
    );
  `)
}

export const acquisitionTenants = (env: Record<string, string | undefined> = process.env): string[] =>
  (env.DAZL_ACQUISITION_TENANTS ?? '').split(',').map(s => s.trim()).filter(Boolean)
export const lifecycleEmailHash = (email: string) => createHash('sha256').update(`dazl-lifecycle-v1\n${norm(email)}`).digest('hex')

// For the send paths (raw handle): the strongest evidence that this address is a dazl sign-up or customer, for an
// acquisition workspace; null = none, send as usual. A recorded event counts before it is applied (fail closed).
export function lifecycleHold(db: Database.Database, tenantId: string, email: string, env: Record<string, string | undefined> = process.env): HoldStatus | null {
  if (!acquisitionTenants(env).includes(tenantId) || !tableExists(db, 'lifecycle_events')) return null
  const h = lifecycleEmailHash(email)
  const held = (db.prepare('SELECT status FROM acquisition_holds WHERE tenant_id = ? AND email_hash = ?').get(tenantId, h) as { status: HoldStatus } | undefined)?.status ?? null
  const kinds = (db.prepare('SELECT kind FROM lifecycle_events WHERE email_hash = ?').all(h) as { kind: LifecycleKind }[]).map(r => STATUS[r.kind])
  return [held, ...kinds].filter((s): s is HoldStatus => !!s).sort((a, b) => RANK[b] - RANK[a])[0] ?? null
}

// Records one event (idempotent by its key). Off: nothing is recorded. Returns whether a new row was written.
export async function recordLifecycleEvent(db: Db, e: { key: string; kind: LifecycleKind; userId: string; email: string; at?: number }, env: Record<string, string | undefined> = process.env): Promise<boolean> {
  if (!acquisitionTenants(env).length || !e.email.includes('@')) return false
  const r = await db.run('INSERT INTO lifecycle_events (event_key, kind, user_id, email_hash, received_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (event_key) DO NOTHING',
    [e.key.slice(0, 200), e.kind, e.userId, lifecycleEmailHash(e.email), e.at ?? Math.floor(Date.now() / 1000)])
  return r.changes === 1
}

export interface ApplyResult { applied: number; stopped: { held: number; drafts: number; sequences: number; followups: number } }

// Applies every pending event to every acquisition workspace, one event per transaction; an event that fails stays
// pending for the next pass.
export async function applyPendingLifecycle(db: Db, env: Record<string, string | undefined> = process.env, now = Math.floor(Date.now() / 1000)): Promise<ApplyResult> {
  const out: ApplyResult = { applied: 0, stopped: { held: 0, drafts: 0, sequences: 0, followups: 0 } }
  const tenants = acquisitionTenants(env)
  if (!tenants.length) return out
  const pending = await db.all<{ event_key: string; kind: LifecycleKind; user_id: string }>('SELECT event_key, kind, user_id FROM lifecycle_events WHERE applied_at IS NULL ORDER BY received_at LIMIT 200')
  for (const ev of pending) {
    await db.tx(function* (t): TxBody<void> {
      const u = yield* t.get<{ email: string }>('SELECT email FROM users WHERE id = ?', [ev.user_id])
      const status = STATUS[ev.kind]
      if (u) for (const tenantId of tenants) yield* applyOne(t, tenantId, norm(u.email), status, ev.event_key, now, out)
      yield* t.run('UPDATE lifecycle_events SET applied_at = ? WHERE event_key = ? AND applied_at IS NULL', [now, ev.event_key])
    })
    out.applied++
  }
  return out
}

function* applyOne(t: Parameters<Parameters<Db['tx']>[0]>[0], tenantId: string, email: string, status: HoldStatus, eventKey: string, now: number, out: ApplyResult): TxBody<void> {
  const leads = (yield* t.all<{ lead_id: string }>('SELECT DISTINCT lead_id FROM outreach_messages WHERE tenant_id = ? AND lower(to_email) = ?', [tenantId, email])).map(x => x.lead_id)
  if (!leads.length) return // never emailed by this workspace: nothing visible here; a later cold play is stopped by the private lookup
  const h = lifecycleEmailHash(email)
  const cur = yield* t.get<{ status: HoldStatus }>('SELECT status FROM acquisition_holds WHERE tenant_id = ? AND email_hash = ?', [tenantId, h])
  if (cur && RANK[cur.status] >= RANK[status]) return // never relabelled from weaker evidence
  if (cur) yield* t.run('UPDATE acquisition_holds SET status = ?, event_key = ?, updated_at = ? WHERE tenant_id = ? AND email_hash = ?', [status, eventKey, now, tenantId, h])
  else yield* t.run('INSERT INTO acquisition_holds (tenant_id, email_hash, status, event_key, updated_at) VALUES (?, ?, ?, ?, ?)', [tenantId, h, status, eventKey, now])
  const inLeads = `(${leads.map(() => '?').join(',')})`, reason = STOP_REASON[status]
  const weaker = (Object.keys(STOP_REASON) as HoldStatus[]).filter(s => RANK[s] < RANK[status]).map(s => STOP_REASON[s])
  const exists = (name: string) => t.get(t.kind === 'pg' ? 'SELECT 1 AS x FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = ?' : "SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = ?", [name])
  // autopilot_work: held first touches (#411), where that queue exists.
  if (yield* exists('autopilot_work')) out.stopped.held += (yield* t.run(`DELETE FROM autopilot_work WHERE tenant_id = ? AND lead_id IN ${inLeads}`, [tenantId, ...leads])).changes
  out.stopped.drafts += (yield* t.run("UPDATE outreach_messages SET status = 'draft', approved_hash = NULL WHERE tenant_id = ? AND lower(to_email) = ? AND status = 'approved'", [tenantId, email])).changes
  out.stopped.sequences += (yield* t.run(`UPDATE sequences SET status = 'stopped', stop_reason = ? WHERE tenant_id = ? AND lead_id IN ${inLeads} AND status IN ('draft','approved','active')`, [reason, tenantId, ...leads])).changes
  out.stopped.followups += (yield* t.run(`UPDATE followup_threads SET stopped = ? WHERE tenant_id = ? AND lead_id IN ${inLeads} AND stopped IS NULL`, [reason, tenantId, ...leads])).changes
  // Already stopped for weaker evidence: the reason is promoted with the hold.
  if (weaker.length) {
    const w = `(${weaker.map(() => '?').join(',')})`
    yield* t.run(`UPDATE sequences SET stop_reason = ? WHERE tenant_id = ? AND lead_id IN ${inLeads} AND status = 'stopped' AND stop_reason IN ${w}`, [reason, tenantId, ...leads, ...weaker])
    yield* t.run(`UPDATE followup_threads SET stopped = ? WHERE tenant_id = ? AND lead_id IN ${inLeads} AND stopped IN ${w}`, [reason, tenantId, ...leads, ...weaker])
  }
  yield* t.run('INSERT INTO autopilot_audit (id, tenant_id, lead_id, message_id, action, detail, created_at) VALUES (?, ?, ?, NULL, ?, ?, ?)', [randomBytes(12).toString('hex'), tenantId, leads[0], 'acquisition_hold', status, now])
}

// Every scheduler tick: records any event that should exist but does not (a hook that never ran or failed, or sign-ups
// and payments made while this was off), then applies everything pending. Bounded per pass.
export async function reconcileLifecycle(db: Db, env: Record<string, string | undefined> = process.env, now = Math.floor(Date.now() / 1000)): Promise<ApplyResult & { recorded: number }> {
  if (!acquisitionTenants(env).length) return { recorded: 0, applied: 0, stopped: { held: 0, drafts: 0, sequences: 0, followups: 0 } }
  let recorded = 0
  const add = async (key: string, kind: LifecycleKind, userId: string, email: string) => { if (await recordLifecycleEvent(db, { key, kind, userId, email, at: now }, env)) recorded++ }
  for (const u of await db.all<{ id: string; email: string }>("SELECT u.id, u.email FROM users u WHERE NOT EXISTS (SELECT 1 FROM lifecycle_events e WHERE e.event_key = 'signup:' || u.id) LIMIT 500"))
    await add(`signup:${u.id}`, 'signup_unverified', u.id, u.email)
  for (const u of await db.all<{ id: string; email: string }>("SELECT DISTINCT u.id, u.email FROM users u JOIN oauth_identities o ON o.user_id = u.id AND o.provider = 'google' WHERE NOT EXISTS (SELECT 1 FROM lifecycle_events e WHERE e.event_key = 'verified:' || u.id) LIMIT 500"))
    await add(`verified:${u.id}`, 'signup_verified', u.id, u.email)
  for (const p of await db.all<{ tenant_id: string; email: string; subscription_status: string | null }>("SELECT p.tenant_id, u.email, p.subscription_status FROM tenant_plans p JOIN users u ON u.id = p.tenant_id WHERE p.subscription_status IN ('active','trialing','incomplete') LIMIT 500"))
    await add(p.subscription_status === 'active' ? `paid:${p.tenant_id}` : `checkout:${p.tenant_id}`, p.subscription_status === 'active' ? 'paid' : 'checkout_unpaid', p.tenant_id, p.email)
  return { recorded, ...await applyPendingLifecycle(db, env, now) }
}

// #455: an account deleted from dazl takes its event history with it. Its holds stay (a stop, like an opt-out).
export async function forgetLifecycleUser(db: Db, userId: string): Promise<number> {
  return (await db.run('DELETE FROM lifecycle_events WHERE user_id = ?', [userId])).changes
}
