import { NextRequest, NextResponse } from 'next/server'
import { clientIp } from '@/lib/rate-limit'
import { hasKey } from '@/lib/llm/key-store'
import { getScanDb, requireUser } from '@/lib/scan/service'
import { getBillingStatus, scanQuota } from '@/lib/plans'
import { TRIAL_SCANS_PER_ACCOUNT, trialStatus } from '@/lib/scan/trial'

export async function GET(req: NextRequest) {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  const db = getScanDb()
  const q = scanQuota(db, user.id)
  // Trial state only matters to accounts without their own key; everyone else gets null.
  const keyed = hasKey(db, user.id)
  const t = keyed ? null : trialStatus(db, user.id, clientIp(req))
  return NextResponse.json({
    plan: q.plan, scans_used: q.used, scan_limit: q.limit, has_key: keyed,
    billing_status: getBillingStatus(db, user.id), // e.g. past_due after a failed payment while Stripe retries (still Pro)
    trial: t ? { funded: t.funded, remaining: t.remaining, cap: TRIAL_SCANS_PER_ACCOUNT } : null,
  })
}
