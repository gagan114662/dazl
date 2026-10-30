import { NextRequest, NextResponse } from 'next/server'
import { getDb } from '@/lib/db/client'
import { applyStripeEvent, verifyStripeSignature, type StripeEvent } from '@/lib/billing/stripe'
import { captureError } from '@/lib/ops/errors'
import { requestIdOf } from '@/lib/ops/request-log'
import { applyPendingLifecycle, recordLifecycleEvent, stripeEvidence } from '@/lib/outreach/lifecycle'

// Stripe calls this directly: no session. Authenticity comes only from the
// signature over the raw body. With no STRIPE_WEBHOOK_SECRET the endpoint is off.
export async function POST(req: NextRequest) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET
  if (!secret) return NextResponse.json({ error: 'Webhook disabled' }, { status: 503 })
  const raw = await req.text()
  if (!verifyStripeSignature(raw, req.headers.get('stripe-signature'), secret)) return NextResponse.json({ error: 'Bad signature' }, { status: 400 })
  let event: StripeEvent
  try {
    event = JSON.parse(raw)
  } catch {
    return NextResponse.json({ error: 'Bad payload' }, { status: 400 })
  }
  if (!event?.id || !event?.type) return NextResponse.json({ error: 'Bad payload' }, { status: 400 })
  try {
    const result = await applyStripeEvent(await getDb(), event)
    // 'held': a same-second tie Stripe could not settle yet; the restrictive plan is in place and the event is not
    // marked processed, so answering 503 makes Stripe deliver it again
    if (result === 'held') return NextResponse.json({ result }, { status: 503 })
    // #417: payment evidence for dazl's own acquisition outreach (off unless DAZL_ACQUISITION_TENANTS is set): only money
    // taken counts as paid (lib/outreach/lifecycle.ts stripeEvidence); a trial or unpaid checkout is a checkout. Bound to
    // the paying account's address now. Recorded for a redelivered (duplicate) event too, idempotently; if it cannot be
    // recorded the webhook answers 500 so Stripe delivers it again (the plan change above is already committed).
    const kind = stripeEvidence(event)
    if (kind && (result === 'applied' || result === 'reconciled' || result === 'duplicate' || result === 'ignored')) {
      const o = (event.data?.object ?? {}) as { client_reference_id?: string; metadata?: { tenant_id?: string }; customer?: string }
      try {
        const db = await getDb()
        const tenant = o.client_reference_id ?? o.metadata?.tenant_id ?? (o.customer ? (await db.get<{ tenant_id: string }>('SELECT tenant_id FROM tenant_plans WHERE stripe_customer_id = ?', [o.customer]))?.tenant_id : undefined)
        const u = tenant ? await db.get<{ email: string }>('SELECT email FROM users WHERE id = ?', [tenant]) : undefined
        if (tenant && u) { await recordLifecycleEvent(db, { key: `stripe:${event.id}`, kind, userId: tenant, email: u.email }); await applyPendingLifecycle(db) }
      } catch (e) {
        captureError(e, { source: 'route', where: '/api/billing/webhook:lifecycle', ref: event.id, requestId: requestIdOf(req) })
        return NextResponse.json({ error: 'Could not process' }, { status: 500 })
      }
    }
    return NextResponse.json({ result })
  } catch (e) {
    captureError(e, { source: 'route', where: '/api/billing/webhook', method: 'POST', ref: event.id, requestId: requestIdOf(req) })
    return NextResponse.json({ error: 'Could not process' }, { status: 500 }) // Stripe will retry
  }
}
