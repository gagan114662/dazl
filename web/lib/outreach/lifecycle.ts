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
//   acquisition_lifecycle_events   private event history (namespaced: #404 has its own lifecycle_events): one row per
//                      event key, the account it is about and a hash of the address the evidence was captured with, never
//                      the address. Evidence stays bound to that address: an account that later changes its email does not
//                      carry old sign-up, verification or payment proof to the new one (recordEmailChange). Recorded first; applied_at is set only once every acquisition workspace has
//                      been updated, so an event whose application failed is applied again on the next pass.
//   acquisition_holds  durable stop state for one acquisition workspace and one person it emailed: the strongest
//                      evidence so far. Only a workspace that already emailed the address gets a row (and an audit line
//                      without the address); any other workspace is protected from a future cold play by the private
//                      hash lookup in lifecycleHold, which it cannot read.
// Evidence, weakest first: an email/password sign-up (the address is not verified yet: "unverified signup hold"), a
// checkout or subscription without payment evidence (a trial, an unpaid session, or only an entitlement status), a sign-up
// verified by Google for that exact address, and a payment: only a Stripe event that shows money taken (a checkout Stripe
// reports paid with an amount above zero, or a paid invoice above zero). A subscription's status is entitlement, never
// payment evidence. A hold is
// only ever promoted by stronger evidence, never relabelled from weaker. Nothing here verifies an account, blocks
// verification or sends an onboarding email.
// Durability: the sign-up and Google hooks record and apply in their own try, after their own commit, so a failure
// never undoes a sign-up; reconcileLifecycle (every scheduler tick) records an unverified sign-up for any account whose
// current address has none (a crash between the commit and the hook, or sign-ups while this was off), records a checkout
// for any subscription without one, and applies every pending event. Payment is never reconstructed from plan status: the
// Stripe webhook records it, and answers 500 when it cannot, so Stripe delivers the event again (a duplicate is recorded
// again, idempotently). Retention: forgetLifecycleUser removes a deleted
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
    CREATE TABLE IF NOT EXISTS acquisition_lifecycle_events (
      event_key   TEXT PRIMARY KEY CHECK (length(event_key) <= 200),
      kind        TEXT NOT NULL CHECK (kind IN ('signup_unverified','signup_verified','checkout_unpaid','paid')),
      user_id     TEXT NOT NULL,
      email_hash  TEXT NOT NULL CHECK (length(email_hash) = 64),
      received_at INTEGER NOT NULL,
      applied_at  INTEGER
    );
    CREATE INDEX IF NOT EXISTS acquisition_lifecycle_events_hash ON acquisition_lifecycle_events (email_hash);
    CREATE INDEX IF NOT EXISTS acquisition_lifecycle_events_pending ON acquisition_lifecycle_events (applied_at);
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
  if (!acquisitionTenants(env).includes(tenantId) || !tableExists(db, 'acquisition_lifecycle_events')) return null
  const h = lifecycleEmailHash(email)
  const held = (db.prepare('SELECT status FROM acquisition_holds WHERE tenant_id = ? AND email_hash = ?').get(tenantId, h) as { status: HoldStatus } | undefined)?.status ?? null
  const kinds = (db.prepare('SELECT kind FROM acquisition_lifecycle_events WHERE email_hash = ?').all(h) as { kind: LifecycleKind }[]).map(r => STATUS[r.kind])
  return [held, ...kinds].filter((s): s is HoldStatus => !!s).sort((a, b) => RANK[b] - RANK[a])[0] ?? null
}

// Records one event (idempotent by its key). Off: nothing is recorded. Returns whether a new row was written.
export async function recordLifecycleEvent(db: Db, e: { key: string; kind: LifecycleKind; userId: string; email: string; at?: number }, env: Record<string, string | undefined> = process.env): Promise<boolean> {
  if (!acquisitionTenants(env).length || !e.email.includes('@')) return false
  const r = await db.run('INSERT INTO acquisition_lifecycle_events (event_key, kind, user_id, email_hash, received_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (event_key) DO NOTHING',
    [e.key.slice(0, 200), e.kind, e.userId, lifecycleEmailHash(e.email), e.at ?? Math.floor(Date.now() / 1000)])
  return r.changes === 1
}

export interface ApplyResult { applied: number; stopped: { held: number; drafts: number; sequences: number; followups: number } }

// Applies every pending event to every acquisition workspace, one event per transaction; an event that fails stays
// pending for the next pass. Matching is by the event's own address hash against the addresses each workspace emailed,
// never by the account's current email.
export async function applyPendingLifecycle(db: Db, env: Record<string, string | undefined> = process.env, now = Math.floor(Date.now() / 1000)): Promise<ApplyResult> {
  const out: ApplyResult = { applied: 0, stopped: { held: 0, drafts: 0, sequences: 0, followups: 0 } }
  const tenants = acquisitionTenants(env)
  if (!tenants.length) return out
  const pending = await db.all<{ event_key: string; kind: LifecycleKind; email_hash: string }>('SELECT event_key, kind, email_hash FROM acquisition_lifecycle_events WHERE applied_at IS NULL ORDER BY received_at LIMIT 200')
  for (const ev of pending) {
    await db.tx(function* (t): TxBody<void> {
      for (const tenantId of tenants) yield* applyOne(t, tenantId, ev.email_hash, STATUS[ev.kind], ev.event_key, now, out)
      yield* t.run('UPDATE acquisition_lifecycle_events SET applied_at = ? WHERE event_key = ? AND applied_at IS NULL', [now, ev.event_key])
    })
    out.applied++
  }
  return out
}

function* applyOne(t: Parameters<Parameters<Db['tx']>[0]>[0], tenantId: string, h: string, status: HoldStatus, eventKey: string, now: number, out: ApplyResult): TxBody<void> {
  // The addresses this workspace emailed whose hash is the event's: the exact captured address, nothing else.
  const rows = yield* t.all<{ email: string; lead_id: string }>('SELECT DISTINCT lower(to_email) AS email, lead_id FROM outreach_messages WHERE tenant_id = ?', [tenantId])
  const hit = rows.filter(r => lifecycleEmailHash(r.email) === h)
  if (!hit.length) return // never emailed by this workspace: nothing visible here; a later cold play is stopped by the private lookup
  const email = hit[0].email, leads = [...new Set(hit.map(r => r.lead_id))]
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

// Every scheduler tick: records the evidence the hooks could have missed, then applies everything pending. Bounded.
//   - an unverified sign-up for every account's current address that has none (key signup:<user>:<address hash>);
//   - a checkout without payment evidence for every subscription the plans table shows (key checkout:<tenant>). Plan or
//     subscription status is entitlement only: it never becomes "paid" here.
// Verification is recorded only by the Google sign-in itself, for the address Google verified; payment only by the
// Stripe webhook.
export async function reconcileLifecycle(db: Db, env: Record<string, string | undefined> = process.env, now = Math.floor(Date.now() / 1000)): Promise<ApplyResult & { recorded: number }> {
  if (!acquisitionTenants(env).length) return { recorded: 0, applied: 0, stopped: { held: 0, drafts: 0, sequences: 0, followups: 0 } }
  let recorded = 0
  const add = async (key: string, kind: LifecycleKind, userId: string, email: string) => { if (await recordLifecycleEvent(db, { key, kind, userId, email, at: now }, env)) recorded++ }
  const have = new Set((await db.all<{ event_key: string }>("SELECT event_key FROM acquisition_lifecycle_events WHERE event_key LIKE 'signup:%' OR event_key LIKE 'checkout:%'")).map(r => r.event_key))
  for (const u of await db.all<{ id: string; email: string }>('SELECT id, email FROM users')) {
    const key = signupKey(u.id, u.email)
    if (!have.has(key)) await add(key, 'signup_unverified', u.id, u.email)
  }
  for (const p of await db.all<{ tenant_id: string; email: string }>("SELECT p.tenant_id, u.email FROM tenant_plans p JOIN users u ON u.id = p.tenant_id WHERE p.subscription_status IN ('active','trialing','incomplete','past_due')"))
    if (!have.has(`checkout:${p.tenant_id}`)) await add(`checkout:${p.tenant_id}`, 'checkout_unpaid', p.tenant_id, p.email)
  return { recorded, ...await applyPendingLifecycle(db, env, now) }
}

// Event keys bound to the captured address, so the same account at another address is another event.
export const signupKey = (userId: string, email: string) => `signup:${userId}:${lifecycleEmailHash(email).slice(0, 16)}`
export const verifiedKey = (userId: string, email: string) => `verified:${userId}:${lifecycleEmailHash(email).slice(0, 16)}`

// An account's email changed (the change-email flow calls this after it commits). Proof never moves: the old address
// keeps its own evidence; the new one starts from what is shown for it now: verified (the flow proved the new address)
// counts as a verified sign-up there, otherwise it is an unverified sign-up hold. Payment proof is never carried over.
export async function recordEmailChange(db: Db, e: { userId: string; newEmail: string; verified: boolean; at?: number }, env: Record<string, string | undefined> = process.env): Promise<boolean> {
  const at = e.at ?? Math.floor(Date.now() / 1000)
  const a = await recordLifecycleEvent(db, { key: signupKey(e.userId, e.newEmail), kind: 'signup_unverified', userId: e.userId, email: e.newEmail, at }, env)
  const b = e.verified ? await recordLifecycleEvent(db, { key: verifiedKey(e.userId, e.newEmail), kind: 'signup_verified', userId: e.userId, email: e.newEmail, at }, env) : false
  return a || b
}

// Stripe evidence of money taken: a checkout Stripe reports paid with an amount above zero, or a paid invoice above zero.
// Anything else from a checkout (a trial, no payment required, unpaid) is a checkout without payment.
export function stripeEvidence(event: { type?: string; data?: { object?: object } }): LifecycleKind | null {
  const o = (event.data?.object ?? {}) as Record<string, unknown>
  if (event.type === 'checkout.session.completed') return o.payment_status === 'paid' && Number(o.amount_total) > 0 ? 'paid' : 'checkout_unpaid'
  if (event.type === 'invoice.paid' || event.type === 'invoice.payment_succeeded') return o.paid !== false && Number(o.amount_paid) > 0 ? 'paid' : null
  return null
}

// #455: an account deleted from dazl takes its event history with it. Its holds stay (a stop, like an opt-out).
export async function forgetLifecycleUser(db: Db, userId: string): Promise<number> {
  return (await db.run('DELETE FROM acquisition_lifecycle_events WHERE user_id = ?', [userId])).changes
}
