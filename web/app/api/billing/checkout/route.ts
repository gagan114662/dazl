import { NextRequest, NextResponse } from 'next/server'
import { requireUser } from '@/lib/scan/service'
import { getDb } from '@/lib/db/client'
import { createCheckoutUrl } from '@/lib/billing/stripe'
import { readPlan } from '@/lib/plans'
import { rateLimit } from '@/lib/rate-limit'
import { sameOriginJson } from '@/lib/same-origin'
import { captureError } from '@/lib/ops/errors'
import { requestIdOf } from '@/lib/ops/request-log'
import { denied, stale } from '@/lib/workspace-access'

export async function POST(req: NextRequest) {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  const no = denied(user, 'billing'); if (no) return no
  const old = stale(user); if (old) return old
  if (!sameOriginJson(req)) return NextResponse.json({ error: 'Bad request' }, { status: 400 })
  if (!process.env.STRIPE_SECRET_KEY || !process.env.STRIPE_PRICE_PRO) return NextResponse.json({ error: 'Billing is not available yet' }, { status: 503 })
  if (!(await rateLimit(`checkout:${user.tenantId}`, 10, 60 * 60 * 1000)).ok) return NextResponse.json({ error: 'Too many attempts' }, { status: 429 })
  const db = await getDb()
  if (await readPlan(db, user.tenantId) === 'pro') return NextResponse.json({ error: 'Already on Pro' }, { status: 409 })
  try {
    return NextResponse.json({ url: await createCheckoutUrl(db, user.tenantId, user.email) })
  } catch (e) {
    captureError(e, { source: 'route', where: '/api/billing/checkout', method: 'POST', tenantId: user.tenantId, requestId: requestIdOf(req) })
    return NextResponse.json({ error: 'Could not start checkout' }, { status: 502 })
  }
}
