import { NextRequest, NextResponse } from 'next/server'
import { getDb } from '@/lib/db/client'
import { getScanDb } from '@/lib/scan/service'
import { paymentAccountFor, queuePendingLifecycle, recordLifecycleEvent } from '@/lib/outreach/lifecycle'
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
    // #417: a paid subscription is a conversion - stop acquisition work queued for the paying ACCOUNT's email.
    // The identity is the account bound to the checkout (client_reference_id/metadata), never the buyer-typed
    // Stripe email, which proves no ownership. Verified email converts now; unverified queues a durable pending
    // conversion that verification completes. After applyStripeEvent so a held tie records nothing twice; the
    // event itself is idempotent. A store failure answers 503: Stripe retries, the replayed event comes back as
    // 'duplicate' (not 'held'), and this block completes the conversion then.
    if (result !== 'held' && event.type === 'checkout.session.completed') {
      try {
        const o = (event.data?.object ?? {}) as { client_reference_id?: unknown; metadata?: { tenant_id?: unknown } }
        const tenantId = typeof o.client_reference_id === 'string' && o.client_reference_id ? o.client_reference_id : typeof o.metadata?.tenant_id === 'string' && o.metadata.tenant_id ? o.metadata.tenant_id : null
        const account = tenantId ? paymentAccountFor(getScanDb(), tenantId) : null
        if (tenantId && account) {
          if (account.verified) recordLifecycleEvent(getScanDb(), 'payment', account.email, tenantId)
          else queuePendingLifecycle(getScanDb(), 'payment', account.email, tenantId)
        }
      } catch (e) {
        captureError(e, { source: 'route', where: '/api/billing/webhook:lifecycle', method: 'POST', ref: event.id, requestId: requestIdOf(req) })
        return NextResponse.json({ error: 'Could not record conversion' }, { status: 503 }) // Stripe retries; the replay completes the conversion
      }
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
