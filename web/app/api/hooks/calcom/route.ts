import { NextRequest, NextResponse } from 'next/server'
import { getScanDb } from '@/lib/scan/service'
import { migrateCalcom, getSecret, verifySignature, parseBooking, recordBooking } from '@/lib/calcom'
import { rateLimit } from '@/lib/rate-limit'

// Cal.com webhook receiver. No session: the per-user secret in the URL (?u=<tenant id>) plus the
// X-Cal-Signature-256 HMAC over the raw body authenticate the call. Only BOOKING_CREATED is
// recorded; retries are idempotent on the booking uid.
export async function POST(req: NextRequest) {
  const tenantId = req.nextUrl.searchParams.get('u') ?? ''
  if (!/^[A-Za-z0-9_-]{6,80}$/.test(tenantId)) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  if (!rateLimit(`calcom:${tenantId}`, 60, 60_000).ok) return NextResponse.json({ error: 'Too many requests' }, { status: 429 })
  const db = getScanDb()
  migrateCalcom(db)
  const secret = getSecret(db, tenantId)
  if (!secret) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const raw = await req.text()
  if (raw.length > 64_000) return NextResponse.json({ error: 'Too large' }, { status: 413 })
  if (!verifySignature(secret, raw, req.headers.get('x-cal-signature-256'))) {
    return NextResponse.json({ error: 'Bad signature' }, { status: 401 })
  }
  const booking = parseBooking(raw)
  if (!booking) return NextResponse.json({ ok: true, ignored: true }) // other trigger events are fine, just not ours
  const outcome = recordBooking(db, tenantId, booking)
  return NextResponse.json({ ok: true, outcome })
}
