import { NextRequest, NextResponse } from 'next/server'
import { requireUser } from '@/lib/scan/service'
import { getDb } from '@/lib/db/client'
import { getSecret, rotateSecret, listBookings } from '@/lib/calcom'
import { sameOriginJson } from '@/lib/same-origin'
import { rateLimit } from '@/lib/rate-limit'
import { audit } from '@/lib/audit-route'

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
  })
}

export async function POST(req: NextRequest) {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  if (!sameOriginJson(req)) return NextResponse.json({ error: 'Bad request' }, { status: 400 })
  if (!(await rateLimit(`calcom-cfg:${user.id}`, 10, 60_000)).ok) return NextResponse.json({ error: 'Too many requests' }, { status: 429 })
  const body = await req.json().catch(() => null)
  if (body?.action !== 'rotate') return NextResponse.json({ error: 'Bad request' }, { status: 400 })
  const secret = await rotateSecret(await getDb(), user.id)
  // the new secret goes back to the caller once; the trail records only that it changed
  await audit(user, req, { action: 'credential.rotated', resource: 'calcom' })
  return NextResponse.json({ ok: true, secret })
}
