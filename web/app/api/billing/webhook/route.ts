import { NextRequest, NextResponse } from 'next/server'
import { getDb } from '@/lib/db/client'
import { getScanDb } from '@/lib/scan/service'
import { recordLifecycleEvent } from '@/lib/outreach/lifecycle'
import { applyStripeEvent, verifyStripeSignature, type StripeEvent } from '@/lib/billing/stripe'
import { captureError } from '@/lib/ops/errors'
import { requestIdOf } from '@/lib/ops/request-log'

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
    // #417: a paid subscription is a conversion - stop acquisition work queued for the buyer's exact email.
    // After applyStripeEvent so a held tie (503 retry) records nothing twice; the event itself is idempotent.
    if (result !== 'held' && event.type === 'checkout.session.completed') {
      const o = (event.data?.object ?? {}) as { customer_details?: { email?: unknown }; customer_email?: unknown }
      const email = typeof o.customer_details?.email === 'string' ? o.customer_details.email : typeof o.customer_email === 'string' ? o.customer_email : ''
      if (email) { try { recordLifecycleEvent(getScanDb(), 'payment', email, null) } catch (e) { captureError(e, { source: 'route', where: '/api/billing/webhook:lifecycle', method: 'POST', ref: event.id, requestId: requestIdOf(req) }) } }
    }
    // 'held': a same-second tie Stripe could not settle yet; the restrictive plan is in place and the event is not
    // marked processed, so answering 503 makes Stripe deliver it again
    if (result === 'held') return NextResponse.json({ result }, { status: 503 })
    return NextResponse.json({ result })
  } catch (e) {
    captureError(e, { source: 'route', where: '/api/billing/webhook', method: 'POST', ref: event.id, requestId: requestIdOf(req) })
    return NextResponse.json({ error: 'Could not process' }, { status: 500 }) // Stripe will retry
  }
}
