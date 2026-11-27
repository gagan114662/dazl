import { NextRequest, NextResponse } from 'next/server'
import { clientIp } from '@/lib/rate-limit'
import { readHasKey } from '@/lib/llm/key-store'
import { requireUser } from '@/lib/scan/service'
import { historyTotals } from '@/lib/scan/history-jobs'
import { getDb } from '@/lib/db/client'
import { readBillingStatus, readScanQuota } from '@/lib/plans'
import { TRIAL_SCANS_PER_ACCOUNT, readTrialStatus } from '@/lib/scan/trial'
import { trialPrincipal, trialQaExemptAccount, trialRefusal } from '@/lib/billing/trial-budget'

export async function GET(req: NextRequest) {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  const db = await getDb()
  const q = await readScanQuota(db, user.tenantId)
  // Trial state only matters to accounts without their own key; everyone else gets null.
  const keyed = await readHasKey(db, user.tenantId)
  // The trial is the founder's own (lib/billing/trial-budget.ts trialPrincipal): another member of the workspace, or a
  // workspace without a trial principal, has none.
  const principal = keyed ? null : await trialPrincipal(db, user)
  const t = !principal ? null : await readTrialStatus(db, principal.id, clientIp(req))
  // The free-scans counter: what is left of the account's trial scans, and, when one would not run now, why (the
  // account or network caps of lib/scan/trial.ts, or dazl's trial budget and abuse limits, lib/billing/trial-budget.ts).
  const blocked = !t ? null : !t.funded ? t.reason ?? null : await trialRefusal(db, principal!)
  // used: the account's real count from the trial store, so the counter never shows a full allowance after a search (#1704).
  // exempt: the QA acceptance account (#1579), whose remaining never moves; the counter says so instead.
  const exempt = !t || t.reason === 'not_configured' ? false : await trialQaExemptAccount(db, principal!.id)
  const { finished } = await historyTotals(db, user.tenantId)
  return NextResponse.json({
    finished_searches: finished,
    plan: q.plan, scans_used: q.used, scan_limit: q.limit, has_key: keyed,
    billing_status: await readBillingStatus(db, user.tenantId), // e.g. past_due after a failed payment while Stripe retries (still Pro)
    trial: t ? { funded: t.funded && blocked === null, remaining: t.remaining, used: t.used, exempt, cap: TRIAL_SCANS_PER_ACCOUNT, blocked } : null,
  })
}
