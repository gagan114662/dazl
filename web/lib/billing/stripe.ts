import { createHmac, timingSafeEqual } from 'node:crypto'
import type Database from 'better-sqlite3'
import { setPlan } from '../plans.ts'

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
  data: { object: StripeObject }
}

function tenantFor(db: Database.Database, o: StripeObject): string | null {
  const direct = o.client_reference_id ?? o.metadata?.tenant_id
  if (direct) return direct
  if (o.customer) {
    const r = db.prepare('SELECT tenant_id FROM tenant_plans WHERE stripe_customer_id = ?').get(o.customer) as { tenant_id: string } | undefined
    return r?.tenant_id ?? null
  }
  return null
}

function link(db: Database.Database, tenantId: string, customer?: string, subscription?: string) {
  db.prepare('INSERT OR IGNORE INTO tenant_plans (tenant_id) VALUES (?)').run(tenantId)
  db.prepare('UPDATE tenant_plans SET stripe_customer_id = COALESCE(?, stripe_customer_id), stripe_subscription_id = COALESCE(?, stripe_subscription_id) WHERE tenant_id = ?').run(customer ?? null, subscription ?? null, tenantId)
}

// Apply a verified event. Each Stripe event id is processed once. Returns 'applied' | 'ignored' | 'duplicate'.
export function applyStripeEvent(db: Database.Database, event: StripeEvent): 'applied' | 'ignored' | 'duplicate' {
  return db.transaction(() => {
    if (db.prepare('INSERT OR IGNORE INTO stripe_events (id, type) VALUES (?, ?)').run(event.id, event.type).changes === 0) return 'duplicate'
    const o = event.data?.object ?? {}
    const tenantId = tenantFor(db, o)
    if (!tenantId) return 'ignored'

    if (event.type === 'checkout.session.completed' && o.mode === 'subscription') {
      link(db, tenantId, o.customer, o.subscription)
      setPlan(db, tenantId, 'pro')
      return 'applied'
    }
    if (event.type === 'customer.subscription.updated' || event.type === 'customer.subscription.created') {
      link(db, tenantId, o.customer, o.id)
      if (o.status === 'active' || o.status === 'trialing' || o.status === 'past_due') setPlan(db, tenantId, 'pro') // past_due: Stripe is still retrying
      else if (o.status === 'canceled' || o.status === 'unpaid' || o.status === 'incomplete_expired') setPlan(db, tenantId, 'free')
      return 'applied'
    }
    if (event.type === 'customer.subscription.deleted') {
      setPlan(db, tenantId, 'free')
      return 'applied'
    }
    return 'ignored'
  })()
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

export async function createCheckoutUrl(db: Database.Database, tenantId: string, email: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  const row = db.prepare('SELECT stripe_customer_id FROM tenant_plans WHERE tenant_id = ?').get(tenantId) as { stripe_customer_id: string | null } | undefined
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

export async function createPortalUrl(db: Database.Database, tenantId: string, fetchImpl: typeof fetch = fetch): Promise<string | null> {
  const row = db.prepare('SELECT stripe_customer_id FROM tenant_plans WHERE tenant_id = ?').get(tenantId) as { stripe_customer_id: string | null } | undefined
  if (!row?.stripe_customer_id) return null
  const out = await stripePost('billing_portal/sessions', new URLSearchParams({ customer: row.stripe_customer_id, return_url: `${baseUrl()}/app/settings` }), fetchImpl)
  return out.url ?? null
}
