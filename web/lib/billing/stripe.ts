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
    -- is a new subscription id, so an ended id never upgrades a tenant again. PG: 0006_stripe_event_order.sql.
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

// What an event would do to the plan: upgrade, downgrade, or nothing. `ends` marks the subscription as over for good.
function effect(event: StripeEvent): { plan: 'pro' | 'free'; subscription?: string; ends: boolean } | null {
  const o = event.data?.object ?? {}
  if (event.type === 'checkout.session.completed') return o.mode === 'subscription' ? { plan: 'pro', subscription: o.subscription, ends: false } : null
  if (event.type === 'customer.subscription.updated' || event.type === 'customer.subscription.created') {
    if (o.status === 'active' || o.status === 'trialing' || o.status === 'past_due') return { plan: 'pro', subscription: o.id, ends: false } // past_due: Stripe is still retrying
    if (o.status === 'canceled' || o.status === 'incomplete_expired') return { plan: 'free', subscription: o.id, ends: true }
    if (o.status === 'unpaid') return { plan: 'free', subscription: o.id, ends: false } // can become active again
    return null
  }
  if (event.type === 'customer.subscription.deleted') return { plan: 'free', subscription: o.id, ends: true }
  return null
}

// Apply a verified event. Each Stripe event id is processed once, in one transaction with its plan change: a concurrent
// second delivery waits on the first's event row and then reports 'duplicate'.
// Stripe delivers events out of order, and `created` is in whole seconds, so time alone cannot order two events of the
// same second. The rules, in this order:
//   1. An ended subscription (deleted, canceled, incomplete_expired) stays ended: its id is recorded, and no later or
//      same-second event for it upgrades the tenant again ('stale'). A resubscribe is a new subscription id.
//   2. The end of the tenant's current subscription always downgrades, whatever its timestamp. The end of an older
//      subscription changes nothing ('ignored').
//   3. Otherwise an event created before the one that last set the plan is 'stale'. Two non-ending events of the same
//      second (say active and unpaid) apply in arrival order; Stripe sends the next invoice event to settle them.
// The tenant's plan row is locked (FOR UPDATE on Postgres; SQLite has one writer) before these checks, so two events
// for one tenant processed at the same time are ordered by the rules, not by which commits last.
export async function applyStripeEvent(db: Db, event: StripeEvent): Promise<'applied' | 'ignored' | 'stale' | 'duplicate'> {
  return db.tx(function* (t): TxBody<'applied' | 'ignored' | 'stale' | 'duplicate'> {
    if ((yield* t.run('INSERT INTO stripe_events (id, type) VALUES (?, ?) ON CONFLICT (id) DO NOTHING', [event.id, event.type])).changes === 0) return 'duplicate'
    const o = event.data?.object ?? {}
    const tenantId = yield* tenantFor(t, o)
    if (!tenantId) return 'ignored'
    const fx = effect(event)
    if (!fx) return 'ignored'
    yield* t.run('INSERT INTO tenant_plans (tenant_id) VALUES (?) ON CONFLICT (tenant_id) DO NOTHING', [tenantId])
    const row = (yield* t.get<{ stripe_subscription_id: string | null; stripe_event_at: number | null }>(
      `SELECT stripe_subscription_id, stripe_event_at FROM tenant_plans WHERE tenant_id = ?${t.kind === 'pg' ? ' FOR UPDATE' : ''}`, [tenantId]))!
    const created = typeof event.created === 'number' && Number.isFinite(event.created) ? event.created : null
    const current = row.stripe_subscription_id
    if (fx.ends && fx.subscription) yield* t.run('INSERT INTO stripe_ended_subscriptions (subscription_id, tenant_id, ended_at) VALUES (?, ?, ?) ON CONFLICT (subscription_id) DO NOTHING', [fx.subscription, tenantId, created])
    if (fx.plan === 'pro' && fx.subscription && (yield* t.get('SELECT 1 AS x FROM stripe_ended_subscriptions WHERE subscription_id = ?', [fx.subscription]))) return 'stale'
    if (fx.plan === 'free' && current && fx.subscription && fx.subscription !== current) return 'ignored'
    if (!fx.ends && created !== null && row.stripe_event_at != null && created < Number(row.stripe_event_at)) return 'stale'
    yield* link(t, tenantId, o.customer, fx.subscription)
    yield* writePlan(t, tenantId, fx.plan)
    if (created !== null) yield* t.run('UPDATE tenant_plans SET stripe_event_at = ? WHERE tenant_id = ? AND (stripe_event_at IS NULL OR stripe_event_at < ?)', [created, tenantId, created])
    return 'applied'
  })
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
