import { NextRequest, NextResponse } from 'next/server'
import { requireUser } from '@/lib/scan/service'
import { getDb } from '@/lib/db/client'
import { createPortalUrl } from '@/lib/billing/stripe'
import { sameOriginJson } from '@/lib/same-origin'
import { captureError } from '@/lib/ops/errors'
import { requestIdOf } from '@/lib/ops/request-log'
import { audit, denied, stale } from '@/lib/workspace-access'

export async function POST(req: NextRequest) {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  const no = await denied(user, 'billing'); if (no) return no
  const old = await stale(user); if (old) return old
  if (!sameOriginJson(req)) return NextResponse.json({ error: 'Bad request' }, { status: 400 })
  if (!process.env.STRIPE_SECRET_KEY) return NextResponse.json({ error: 'Billing is not available yet' }, { status: 503 })
  try {
    const url = await createPortalUrl(await getDb(), user.tenantId)
    if (!url) return NextResponse.json({ error: 'No subscription found' }, { status: 404 })
    await audit(user, 'billing.portal_opened', 'billing')
    return NextResponse.json({ url })
  } catch (e) {
    captureError(e, { source: 'route', where: '/api/billing/portal', method: 'POST', tenantId: user.tenantId, requestId: requestIdOf(req) })
    return NextResponse.json({ error: 'Could not open the billing portal' }, { status: 502 })
  }
}
