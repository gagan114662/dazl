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

// What an event would do to the plan: upgrade, downgrade, or nothing.
function effect(event: StripeEvent): { plan: 'pro' | 'free'; subscription?: string } | null {
  const o = event.data?.object ?? {}
  if (event.type === 'checkout.session.completed') return o.mode === 'subscription' ? { plan: 'pro', subscription: o.subscription } : null
  if (event.type === 'customer.subscription.updated' || event.type === 'customer.subscription.created') {
    if (o.status === 'active' || o.status === 'trialing' || o.status === 'past_due') return { plan: 'pro', subscription: o.id } // past_due: Stripe is still retrying
    if (o.status === 'canceled' || o.status === 'unpaid' || o.status === 'incomplete_expired') return { plan: 'free', subscription: o.id }
    return null
  }
  if (event.type === 'customer.subscription.deleted') return { plan: 'free', subscription: o.id }
  return null
}

// Apply a verified event. Each Stripe event id is processed once, in one transaction with its plan change: a concurrent
// second delivery waits on the first's event row and then reports 'duplicate'.
// Out of order: an event created before the one that last set the plan is 'stale' and changes nothing (a delayed
// "active" must not undo a later cancellation). A downgrade only applies to the tenant's current subscription: an old
// subscription ending does not cancel a newer one.
export async function applyStripeEvent(db: Db, event: StripeEvent): Promise<'applied' | 'ignored' | 'stale' | 'duplicate'> {
  return db.tx(function* (t): TxBody<'applied' | 'ignored' | 'stale' | 'duplicate'> {
    if ((yield* t.run('INSERT INTO stripe_events (id, type) VALUES (?, ?) ON CONFLICT (id) DO NOTHING', [event.id, event.type])).changes === 0) return 'duplicate'
    const o = event.data?.object ?? {}
    const tenantId = yield* tenantFor(t, o)
    if (!tenantId) return 'ignored'
    const fx = effect(event)
    if (!fx) return 'ignored'
    const row = yield* t.get<{ stripe_subscription_id: string | null; stripe_event_at: number | null }>('SELECT stripe_subscription_id, stripe_event_at FROM tenant_plans WHERE tenant_id = ?', [tenantId])
    const created = typeof event.created === 'number' && Number.isFinite(event.created) ? event.created : null
    if (created !== null && row?.stripe_event_at != null && created < Number(row.stripe_event_at)) return 'stale'
    if (fx.plan === 'free' && row?.stripe_subscription_id && fx.subscription && fx.subscription !== row.stripe_subscription_id) return 'ignored'
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
