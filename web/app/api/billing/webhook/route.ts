import { NextRequest, NextResponse } from 'next/server'
import { getScanDb } from '@/lib/scan/service'
import { applyStripeEvent, verifyStripeSignature, type StripeEvent } from '@/lib/billing/stripe'

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
    return NextResponse.json({ result: applyStripeEvent(getScanDb(), event) })
  } catch (e) {
    console.error('webhook apply failed', event.id, e)
    return NextResponse.json({ error: 'Could not process' }, { status: 500 }) // Stripe will retry
  }
}
