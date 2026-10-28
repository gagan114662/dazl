import { createHmac, timingSafeEqual } from 'node:crypto'
import type Database from 'better-sqlite3'
import { writePlan } from '../plans.ts'
import type { Db, Tx, TxBody } from '../db/client.ts'

// Stripe-Signature check: HMAC-SHA256 over `${t}.${rawBody}`, 5-minute replay window.
// Ported from the repo worker's billing.ts, using node:crypto.
export function verifyStripeSignature(payload: string, header: string | null, secret: string, nowMs = Date.now(), toleranceSec = 300): boolean {
  if (!header || !secret) return false
  const parts = header.split(',').map(p => p.split('='))
  const t = parts.find(([k]) => k === 't')?.[1]
  const sigs = parts.filter(([k]) => k === 'v1').map(([, v]) => v)
  if (!t || sigs.length === 0 || !Number.isFinite(Number(t))) return false
  if (Math.abs(nowMs / 1000 - Number(t)) > toleranceSec) return false
  const expected = createHmac('sha256', secret).update(`${t}.${payload}`).digest()
  return sigs.some(s => {
    const b = Buffer.from(s, 'hex')
    return b.length === expected.length && timingSafeEqual(b, expected)
  })
}

export function migrateBilling(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS stripe_events (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      processed_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER))
    );
    CREATE INDEX IF NOT EXISTS tenant_plans_customer ON tenant_plans (stripe_customer_id);
    -- Subscriptions Stripe has ended (deleted, canceled, incomplete_expired). Ending is final in Stripe: a resubscribe
    -- is a new subscription id, so an ended id never upgrades a tenant again. PG: 0007_stripe_event_order.sql.
    CREATE TABLE IF NOT EXISTS stripe_ended_subscriptions (
      subscription_id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      ended_at INTEGER
    );
  `)
}

interface StripeObject {
  client_reference_id?: string
  customer?: string
  subscription?: string
  id?: string
  status?: string
  mode?: string
  metadata?: { tenant_id?: string }
  // invoices: the subscription id moved under parent.subscription_details in API version 2025-03-31
  parent?: { subscription_details?: { subscription?: string } }
}
export interface StripeEvent {
  id: string
  type: string
  // Unix seconds when Stripe created the event. Stripe does not deliver events in order or only once.
  created?: number
  data: { object: StripeObject }
}

function* tenantFor(t: Tx, o: StripeObject): TxBody<string | null> {
  const direct = o.client_reference_id ?? o.metadata?.tenant_id
  if (direct) return direct
  if (o.customer) return (yield* t.get<{ tenant_id: string }>('SELECT tenant_id FROM tenant_plans WHERE stripe_customer_id = ?', [o.customer]))?.tenant_id ?? null
  return null
}

function* link(t: Tx, tenantId: string, customer?: string, subscription?: string): TxBody<void> {
  yield* t.run('INSERT INTO tenant_plans (tenant_id) VALUES (?) ON CONFLICT (tenant_id) DO NOTHING', [tenantId])
  yield* t.run('UPDATE tenant_plans SET stripe_customer_id = COALESCE(?, stripe_customer_id), stripe_subscription_id = COALESCE(?, stripe_subscription_id) WHERE tenant_id = ?', [customer ?? null, subscription ?? null, tenantId])
}

// What a subscription status means for the plan: an explicit policy for every status Stripe documents. `ends` marks the
// subscription as over for good. Unknown statuses return null: never proof of Pro (see applyStripeEvent).
//   active, trialing, past_due          -> Pro (past_due: Stripe is still retrying the payment)
//   canceled, incomplete_expired        -> Free, ended for good
//   unpaid, incomplete, paused          -> Free, can become active again
export const ENTITLING = new Set(['active', 'trialing', 'past_due'])
const ENDED = new Set(['canceled', 'incomplete_expired'])
const NOT_ENTITLING = new Set(['unpaid', 'incomplete', 'paused'])
function statusEffect(status: string | undefined, subscription: string | undefined): { plan: 'pro' | 'free'; subscription?: string; ends: boolean } | null {
  if (status && ENTITLING.has(status)) return { plan: 'pro', subscription, ends: false }
  if (status && ENDED.has(status)) return { plan: 'free', subscription, ends: true }
  if (status && NOT_ENTITLING.has(status)) return { plan: 'free', subscription, ends: false }
  return null
}

// What an event would do to the plan: upgrade, downgrade, or nothing.
function effect(event: StripeEvent): { plan: 'pro' | 'free'; subscription?: string; ends: boolean; status?: string } | null {
  const o = event.data?.object ?? {}
  if (event.type === 'checkout.session.completed') return o.mode === 'subscription' ? { plan: 'pro', subscription: o.subscription, ends: false, status: 'active' } : null
  if (event.type === 'customer.subscription.updated' || event.type === 'customer.subscription.created') { const fx = statusEffect(o.status, o.id); return fx && { ...fx, status: o.status } }
  if (event.type === 'customer.subscription.deleted') return { plan: 'free', subscription: o.id, ends: true, status: 'canceled' }
  return null
}

// A tie: a non-ending event for the tenant's current subscription, created in the same second as the event that last
// set the plan, which would change the plan. Its order against that event is unknown (created is in whole seconds), so
// the plan comes from the subscription's current status at Stripe instead of from delivery order. (An event for a
// different subscription is not a tie: a new subscription links and upgrades, an old one's downgrade is ignored.)
// A held tie (stripe_reconcile_at = that second) stays a tie for every event of that second until Stripe's answer
// settles it, whatever the plan is meanwhile.
type PlanRow = { plan: string; stripe_subscription_id: string | null; stripe_event_at: number | null; stripe_reconcile_at: number | null }
function isTie(fx: { plan: string; ends: boolean; subscription?: string }, created: number | null, row: PlanRow | undefined): boolean {
  return !fx.ends && !!fx.subscription && fx.subscription === row?.stripe_subscription_id && created !== null
    && row.stripe_event_at != null && created === Number(row.stripe_event_at)
    && (fx.plan !== row.plan || (row.stripe_reconcile_at != null && created === Number(row.stripe_reconcile_at)))
}

// The subscription's current status, read from Stripe (GET, test or live key; no charge). Tests always stub this.
export async function fetchSubscriptionStatus(id: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  const res = await fetchImpl(`https://api.stripe.com/v1/subscriptions/${encodeURIComponent(id)}`, {
    headers: { authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}` }, signal: AbortSignal.timeout(10_000),
  })
  if (!res.ok) throw new Error(`stripe_${res.status}`)
  const status = ((await res.json()) as { status?: unknown }).status
  if (typeof status !== 'string') throw new Error('stripe_no_status')
  return status
}

export interface StripeDeps { subscriptionStatus?: (id: string) => Promise<string>; log?: (line: StripeLogLine) => void }

// Apply a verified event. Each Stripe event id is processed once, in one transaction with its plan change: a concurrent
// second delivery waits on the first's event row and then reports 'duplicate'.
// Stripe delivers events out of order, and `created` is in whole seconds, so time alone cannot order two events of the
// same second. The rules, in this order:
//   1. An ended subscription (deleted, canceled, incomplete_expired) stays ended: its id is recorded, and no later or
//      same-second event for it upgrades the tenant again ('stale'). A resubscribe is a new subscription id.
//   2. The end of the tenant's current subscription always downgrades, whatever its timestamp. The end of an older
//      subscription changes nothing ('ignored').
//   3. An event created before the one that last set the plan is 'stale'.
//   4. A tie (see isTie: same second, non-ending, would change the plan) is settled by the subscription's current
//      status at Stripe, read before the transaction ('reconciled'), never by delivery order, using the status policy
//      above. Without a usable answer (the read failed, Stripe returned a status the policy does not know, or the tie
//      only appeared under the lock) the tie goes to the restrictive state, Free, at once, and the event is NOT marked
//      processed ('held'): the webhook answers 503, Stripe delivers it again, and the read settles it then. Only an
//      entitling status from Stripe grants Pro on a tie.
// The tenant's plan row is locked (FOR UPDATE on Postgres; SQLite has one writer) before these checks, so two events
// for one tenant processed at the same time are ordered by the rules, not by which commits last.
export type ApplyResult = 'applied' | 'reconciled' | 'held' | 'ignored' | 'stale' | 'duplicate'
export async function applyStripeEvent(db: Db, event: StripeEvent, deps: StripeDeps = {}): Promise<ApplyResult> {
  const eventFx = effect(event)
  const o = event.data?.object ?? {}
  const created = typeof event.created === 'number' && Number.isFinite(event.created) ? event.created : null
  // Pre-check (read only): when this event would tie, read the subscription's status from Stripe now, outside the
  // transaction, so no network call happens while the plan row is locked.
  let authoritative: string | undefined
  if (eventFx && !eventFx.ends && eventFx.subscription && created !== null) {
    const pre = await db.tx(function* (t) {
      const tenantId = yield* tenantFor(t, o)
      const row = tenantId ? yield* t.get<PlanRow>('SELECT plan, stripe_subscription_id, stripe_event_at, stripe_reconcile_at FROM tenant_plans WHERE tenant_id = ?', [tenantId]) : undefined
      const ended = !!(yield* t.get('SELECT 1 AS x FROM stripe_ended_subscriptions WHERE subscription_id = ?', [eventFx.subscription!]))
      return { row, ended }
    })
    if (!pre.ended && isTie(eventFx, created, pre.row)) {
      try { authoritative = await (deps.subscriptionStatus ?? (id => fetchSubscriptionStatus(id)))(eventFx.subscription) } catch { authoritative = undefined } // held below
    }
  }
  let ignoredWhy: IgnoredReason | null = null
  const result = await db.tx(function* (t): TxBody<ApplyResult> {
    if ((yield* t.run('INSERT INTO stripe_events (id, type) VALUES (?, ?) ON CONFLICT (id) DO NOTHING', [event.id, event.type])).changes === 0) return 'duplicate'
    const tenantId = yield* tenantFor(t, o)
    if (!tenantId) { ignoredWhy = 'unknown_tenant'; return 'ignored' }
    // One Stripe customer is one tenant's: an event that names this tenant with another tenant's customer changes nothing.
    if (o.customer && (yield* t.get('SELECT 1 AS x FROM tenant_plans WHERE stripe_customer_id = ? AND tenant_id <> ?', [o.customer, tenantId]))) { ignoredWhy = 'customer_conflict'; return 'ignored' }
    if (event.type === 'invoice.payment_failed') return yield* paymentFailed(t, tenantId, o.subscription ?? o.parent?.subscription_details?.subscription, created)
    if (!eventFx) return 'ignored'
    yield* t.run('INSERT INTO tenant_plans (tenant_id) VALUES (?) ON CONFLICT (tenant_id) DO NOTHING', [tenantId])
    const row = (yield* t.get<PlanRow>(
      `SELECT plan, stripe_subscription_id, stripe_event_at, stripe_reconcile_at FROM tenant_plans WHERE tenant_id = ?${t.kind === 'pg' ? ' FOR UPDATE' : ''}`, [tenantId]))!
    const current = row.stripe_subscription_id
    // rules 1 and 2 first: they decide without asking Stripe
    if (eventFx.ends && eventFx.subscription) yield* t.run('INSERT INTO stripe_ended_subscriptions (subscription_id, tenant_id, ended_at) VALUES (?, ?, ?) ON CONFLICT (subscription_id) DO NOTHING', [eventFx.subscription, tenantId, created])
    if (eventFx.plan === 'pro' && eventFx.subscription && (yield* t.get('SELECT 1 AS x FROM stripe_ended_subscriptions WHERE subscription_id = ?', [eventFx.subscription]))) return 'stale'
    if (eventFx.plan === 'free' && current && eventFx.subscription && eventFx.subscription !== current) return 'ignored'
    let fx: { plan: 'pro' | 'free'; subscription?: string; ends: boolean; status?: string } = eventFx
    const tie = isTie(eventFx, created, row)
    const settled = tie && authoritative !== undefined ? statusEffect(authoritative, eventFx.subscription) : null
    if (tie && !settled) {
      // no usable answer from Stripe (no read, or a status the policy does not know): the restrictive state now, and
      // leave the event unprocessed so Stripe delivers it again
      yield* writePlan(t, tenantId, 'free')
      yield* t.run('UPDATE tenant_plans SET stripe_reconcile_at = ? WHERE tenant_id = ?', [created, tenantId])
      yield* t.run('DELETE FROM stripe_events WHERE id = ?', [event.id])
      return 'held'
    }
    if (tie && settled) {
      yield* t.run('UPDATE tenant_plans SET stripe_reconcile_at = NULL WHERE tenant_id = ?', [tenantId])
      fx = { ...settled, status: authoritative }
      if (fx.ends) yield* t.run('INSERT INTO stripe_ended_subscriptions (subscription_id, tenant_id, ended_at) VALUES (?, ?, ?) ON CONFLICT (subscription_id) DO NOTHING', [fx.subscription!, tenantId, created])
    } else if (!fx.ends && created !== null && row.stripe_event_at != null && created < Number(row.stripe_event_at)) return 'stale'
    yield* link(t, tenantId, o.customer, fx.subscription)
    yield* writePlan(t, tenantId, fx.plan)
    if (fx.status) yield* t.run('UPDATE tenant_plans SET subscription_status = ? WHERE tenant_id = ?', [fx.status, tenantId])
    if (created !== null) yield* t.run('UPDATE tenant_plans SET stripe_event_at = ? WHERE tenant_id = ? AND (stripe_event_at IS NULL OR stripe_event_at < ?)', [created, tenantId, created])
    return tie ? 'reconciled' : 'applied'
  })
  // A verified event naming no tenant this store knows (no client_reference_id or metadata.tenant_id, and a customer id
  // no tenant has), or a tenant whose customer is another tenant's: nothing changes but the event's own processed record,
  // so a replay stays a no-op. Logged, so a misconfigured price, a checkout made outside the app or a subscription moved
  // between customers in Stripe shows up instead of vanishing.
  if (ignoredWhy) (deps.log ?? logLine)(ignoredLine(event, new Date(), ignoredWhy))
  return result
}

// unknown_tenant: the event names no tenant this store knows. customer_conflict: it names a tenant, but its Stripe customer
// already belongs to another tenant; applying it would link one customer to two tenants (and later customer-only events,
// and the billing portal, to the wrong one), so it changes nothing.
export type IgnoredReason = 'unknown_tenant' | 'customer_conflict'
export interface StripeLogLine { level: 'warn'; type: 'stripe_event'; ts: string; event_id: string; event_type: string; result: 'ignored'; reason: IgnoredReason }
// Only the event's own id and type, each checked against its shape; never a customer, email or amount.
export function ignoredLine(event: StripeEvent, now = new Date(), reason: IgnoredReason = 'unknown_tenant'): StripeLogLine {
  return {
    level: 'warn', type: 'stripe_event', ts: now.toISOString(),
    event_id: /^evt_[A-Za-z0-9]{1,64}$/.test(event.id) ? event.id : '[unrecognized]',
    event_type: /^[a-z_]{1,40}(\.[a-z_]{1,40}){1,3}$/.test(event.type) ? event.type : '[unrecognized]',
    result: 'ignored', reason,
  }
}
const logLine = (l: StripeLogLine) => { process.stdout.write(JSON.stringify(l) + '\n') }

// invoice.payment_failed: Stripe is retrying the payment. The plan never changes here (a failed payment never grants
// Pro, and the policy keeps past_due on Pro until Stripe gives up, which arrives as subscription.updated/deleted); the
// tenant's billing status becomes past_due so Settings can say why, even when Stripe's subscription.updated is late.
// Only for the tenant's current subscription while it is Pro; an invoice of an older or ended subscription, or one
// created before the event that last set the plan, changes nothing.
function* paymentFailed(t: Tx, tenantId: string, subscription: string | undefined, created: number | null): TxBody<ApplyResult> {
  const row = yield* t.get<PlanRow>(
    `SELECT plan, stripe_subscription_id, stripe_event_at, stripe_reconcile_at FROM tenant_plans WHERE tenant_id = ?${t.kind === 'pg' ? ' FOR UPDATE' : ''}`, [tenantId])
  if (!row || !subscription || subscription !== row.stripe_subscription_id) return 'ignored'
  if (yield* t.get('SELECT 1 AS x FROM stripe_ended_subscriptions WHERE subscription_id = ?', [subscription])) return 'stale'
  if (created !== null && row.stripe_event_at != null && created < Number(row.stripe_event_at)) return 'stale'
  if (row.plan !== 'pro') return 'ignored'
  yield* t.run("UPDATE tenant_plans SET subscription_status = 'past_due' WHERE tenant_id = ?", [tenantId])
  if (created !== null) yield* t.run('UPDATE tenant_plans SET stripe_event_at = ? WHERE tenant_id = ? AND (stripe_event_at IS NULL OR stripe_event_at < ?)', [created, tenantId, created])
  return 'applied'
}

function baseUrl() {
  return (process.env.PUBLIC_BASE_URL || 'https://dazl.ai').replace(/\/$/, '')
}

async function stripePost(path: string, form: URLSearchParams, fetchImpl: typeof fetch): Promise<{ url?: string }> {
  const res = await fetchImpl(`https://api.stripe.com/v1/${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}`, 'content-type': 'application/x-www-form-urlencoded' },
    body: form,
    signal: AbortSignal.timeout(15_000),
  })
  if (!res.ok) throw new Error(`stripe_${res.status}`)
  return (await res.json()) as { url?: string }
}

export async function createCheckoutUrl(db: Db, tenantId: string, email: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  const row = await db.get<{ stripe_customer_id: string | null }>('SELECT stripe_customer_id FROM tenant_plans WHERE tenant_id = ?', [tenantId])
  const form = new URLSearchParams({
    mode: 'subscription',
    'line_items[0][price]': process.env.STRIPE_PRICE_PRO ?? '',
    'line_items[0][quantity]': '1',
    client_reference_id: tenantId,
    'subscription_data[metadata][tenant_id]': tenantId,
    success_url: `${baseUrl()}/app/settings?billing=success`,
    cancel_url: `${baseUrl()}/app/settings?billing=cancelled`,
  })
  if (row?.stripe_customer_id) form.set('customer', row.stripe_customer_id)
  else form.set('customer_email', email)
  const out = await stripePost('checkout/sessions', form, fetchImpl)
  if (!out.url) throw new Error('stripe_no_url')
  return out.url
}

export async function createPortalUrl(db: Db, tenantId: string, fetchImpl: typeof fetch = fetch): Promise<string | null> {
  const row = await db.get<{ stripe_customer_id: string | null }>('SELECT stripe_customer_id FROM tenant_plans WHERE tenant_id = ?', [tenantId])
  if (!row?.stripe_customer_id) return null
  const out = await stripePost('billing_portal/sessions', new URLSearchParams({ customer: row.stripe_customer_id, return_url: `${baseUrl()}/app/settings` }), fetchImpl)
  return out.url ?? null
}
