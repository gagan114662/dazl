import { NextRequest, NextResponse } from 'next/server'
import { clientIp } from '@/lib/rate-limit'
import { readHasKey } from '@/lib/llm/key-store'
import { requireUser } from '@/lib/scan/service'
import { getDb } from '@/lib/db/client'
import { readBillingStatus, readScanQuota } from '@/lib/plans'
import { TRIAL_SCANS_PER_ACCOUNT, readTrialStatus } from '@/lib/scan/trial'
import { trialRefusal } from '@/lib/billing/trial-budget'

export async function GET(req: NextRequest) {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  const db = await getDb()
  const q = await readScanQuota(db, user.id)
  // Trial state only matters to accounts without their own key; everyone else gets null.
  const keyed = await readHasKey(db, user.id)
  const t = keyed ? null : await readTrialStatus(db, user.id, clientIp(req))
  // The free-scans counter: what is left of the account's trial scans, and, when one would not run now, why (the
  // account or network caps of lib/scan/trial.ts, or dazl's trial budget and abuse limits, lib/billing/trial-budget.ts).
  const blocked = !t ? null : !t.funded ? t.reason ?? null : await trialRefusal(db, { id: user.id, email: user.email })
  return NextResponse.json({
    plan: q.plan, scans_used: q.used, scan_limit: q.limit, has_key: keyed,
    billing_status: await readBillingStatus(db, user.id), // e.g. past_due after a failed payment while Stripe retries (still Pro)
    trial: t ? { funded: t.funded && blocked === null, remaining: t.remaining, cap: TRIAL_SCANS_PER_ACCOUNT, blocked } : null,
  })
}
