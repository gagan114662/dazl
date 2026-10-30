import { NextRequest, NextResponse } from 'next/server'
import { requireUser } from '@/lib/scan/service'
import { getDb } from '@/lib/db/client'
import { bookingCounts, getSecret, rotateSecret, listBookings, setMeetingOutcome } from '@/lib/calcom'
import { sameOriginJson } from '@/lib/same-origin'
import { rateLimit } from '@/lib/rate-limit'

// Manage the tenant's Cal.com webhook: generate/rotate the signing secret and list recent bookings
// (matched ones show their lead, unmatched stay visible so the user can reconcile by hand).
export async function GET(req: NextRequest) {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  const db = await getDb()
  const secret = await getSecret(db, user.id)
  return NextResponse.json({
    configured: !!secret,
    secret, // the user's own secret - they must paste it into Cal.com
    webhook_url: `${(process.env.PUBLIC_BASE_URL || req.nextUrl.origin).replace(/\/$/, '')}/api/hooks/calcom?u=${encodeURIComponent(user.id)}`,
    bookings: await listBookings(db, user.id),
    counts: await bookingCounts(db, user.id),
  })
}

export async function POST(req: NextRequest) {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  if (!sameOriginJson(req)) return NextResponse.json({ error: 'Bad request' }, { status: 400 })
  if (!(await rateLimit(`calcom-cfg:${user.id}`, 10, 60_000)).ok) return NextResponse.json({ error: 'Too many requests' }, { status: 429 })
  const body = await req.json().catch(() => null)
  // a person records what happened at a meeting (or clears it): audited with who did it; only an active booking
  if (body?.action === 'outcome') {
    const uid = typeof body.booking_uid === 'string' ? body.booking_uid.slice(0, 120) : ''
    const outcome = body.outcome === 'held' || body.outcome === 'no_show' ? body.outcome : body.outcome === null ? null : undefined
    if (!uid || outcome === undefined) return NextResponse.json({ error: 'Bad request' }, { status: 400 })
    if (!(await setMeetingOutcome(await getDb(), user.id, uid, outcome, user.id))) return NextResponse.json({ error: 'No active booking to mark' }, { status: 409 })
    return NextResponse.json({ ok: true })
  }
  if (body?.action !== 'rotate') return NextResponse.json({ error: 'Bad request' }, { status: 400 })
  return NextResponse.json({ ok: true, secret: await rotateSecret(await getDb(), user.id) })
}
