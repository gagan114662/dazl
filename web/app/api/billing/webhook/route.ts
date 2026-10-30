import { NextRequest, NextResponse } from 'next/server'
import { getDb } from '@/lib/db/client'
import { applyStripeEvent, verifyStripeSignature, type StripeEvent } from '@/lib/billing/stripe'
import { captureError } from '@/lib/ops/errors'
import { requestIdOf } from '@/lib/ops/request-log'
import { applyPendingLifecycle, recordLifecycleEvent } from '@/lib/outreach/lifecycle'

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
    // #417: a checkout by a prospect of dazl's own acquisition outreach (the account's own email). Only a session Stripe
    // reports as paid is a payment; a trial or unpaid session is a checkout, not a paying customer. Never fails the
    // webhook; anything missed is recorded from the plan by the scheduler's reconciliation.
    if ((result === 'applied' || result === 'reconciled') && event.type === 'checkout.session.completed') {
      const o = (event.data?.object ?? {}) as { client_reference_id?: string; metadata?: { tenant_id?: string }; payment_status?: string }
      const tenant = o.client_reference_id ?? o.metadata?.tenant_id
      try {
        const db = await getDb(), u = tenant ? await db.get<{ email: string }>('SELECT email FROM users WHERE id = ?', [tenant]) : undefined
        if (u) { await recordLifecycleEvent(db, { key: `stripe:${event.id}`, kind: o.payment_status === 'paid' ? 'paid' : 'checkout_unpaid', userId: tenant!, email: u.email }); await applyPendingLifecycle(db) }
      } catch (e) { captureError(e, { source: 'route', where: '/api/billing/webhook:lifecycle', ref: event.id, requestId: requestIdOf(req) }) }
    }
    return NextResponse.json({ result })
  } catch (e) {
    captureError(e, { source: 'route', where: '/api/billing/webhook', method: 'POST', ref: event.id, requestId: requestIdOf(req) })
    return NextResponse.json({ error: 'Could not process' }, { status: 500 }) // Stripe will retry
  }
}
