import { NextRequest, NextResponse } from 'next/server'
import { getScanDb, requireUser } from '@/lib/scan/service'
import { createPortalUrl } from '@/lib/billing/stripe'
import { sameOriginJson } from '@/lib/same-origin'

export async function POST(req: NextRequest) {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  if (!sameOriginJson(req)) return NextResponse.json({ error: 'Bad request' }, { status: 400 })
  if (!process.env.STRIPE_SECRET_KEY) return NextResponse.json({ error: 'Billing is not available yet' }, { status: 503 })
  try {
    const url = await createPortalUrl(getScanDb(), user.id)
    return url ? NextResponse.json({ url }) : NextResponse.json({ error: 'No subscription found' }, { status: 404 })
  } catch (e) {
    console.error('portal failed', e)
    return NextResponse.json({ error: 'Could not open the billing portal' }, { status: 502 })
  }
}
