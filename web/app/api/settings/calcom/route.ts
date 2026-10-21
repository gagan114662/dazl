import { NextRequest, NextResponse } from 'next/server'
import { getScanDb, requireUser } from '@/lib/scan/service'
import { migrateCalcom, getSecret, rotateSecret, listBookings } from '@/lib/calcom'
import { sameOriginJson } from '@/lib/same-origin'
import { rateLimit } from '@/lib/rate-limit'

// Manage the tenant's Cal.com webhook: generate/rotate the signing secret and list recent bookings
// (matched ones show their lead, unmatched stay visible so the user can reconcile by hand).
export async function GET(req: NextRequest) {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  const db = getScanDb()
  migrateCalcom(db)
  const secret = getSecret(db, user.id)
  return NextResponse.json({
    configured: !!secret,
    secret, // the user's own secret - they must paste it into Cal.com
    webhook_url: `${req.nextUrl.origin}/api/hooks/calcom?u=${encodeURIComponent(user.id)}`,
    bookings: listBookings(db, user.id),
  })
}

export async function POST(req: NextRequest) {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  if (!sameOriginJson(req)) return NextResponse.json({ error: 'Bad request' }, { status: 400 })
  if (!rateLimit(`calcom-cfg:${user.id}`, 10, 60_000).ok) return NextResponse.json({ error: 'Too many requests' }, { status: 429 })
  const body = await req.json().catch(() => null)
  if (body?.action !== 'rotate') return NextResponse.json({ error: 'Bad request' }, { status: 400 })
  const db = getScanDb()
  migrateCalcom(db)
  return NextResponse.json({ ok: true, secret: rotateSecret(db, user.id) })
}
