import { runSequences } from '@/lib/outreach/sequences'
import { after, NextRequest, NextResponse } from 'next/server'
import { timingSafeEqual } from 'node:crypto'
import { getScanDb } from '@/lib/scan/service'
import { scheduledReplySync } from '@/lib/outreach/reply-schedule'
import { runFollowups } from '@/lib/outreach/followups'
import { runDueWatches } from '@/lib/watch'
import { collectMonitorResults, runDueMonitors } from '@/lib/monitors'
import { kickRunner } from '@/lib/scan/runner'
import { getDb, type Tx } from '@/lib/db/client'
import { LeaseLost, StaleLeaseWrite, tryLease } from '@/lib/shared/lease'
import type { Lease } from '@/lib/shared/lease'
import { dueTenants, runIndexChecks } from '@/lib/seo/indexing'
import { captureError } from '@/lib/ops/errors'
import { requestIdOf } from '@/lib/ops/request-log'

// Called by a scheduler (cron or a systemd timer) with AUTOPILOT_TICK_SECRET. Reads replies, opt-outs and bounces for
// every tenant with read consent and the read grant (whatever its sending settings, #413), then sends due follow-ups and
// sequence steps for tenants who turned those on and whose read succeeded in this tick. Without the secret configured the
// route does not exist.
export async function POST(req: NextRequest) {
  const secret = process.env.AUTOPILOT_TICK_SECRET
  const got = req.headers.get('authorization') ?? ''
  const want = `Bearer ${secret}`
  if (!secret || got.length !== want.length || !timingSafeEqual(Buffer.from(got), Buffer.from(want))) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  // One tick at a time across app instances: a scheduler that fires twice, or on two instances, gets `skipped`. The tick's
  // work writes only through the lease's fenced view of the store (lib/shared/lease.ts): if this tick loses the lease
  // (paused, cut off, expired) and another takes over, every write this one still attempts is refused. A crashed holder
  // blocks ticks for at most TICK_LEASE.ttlMs.
  const lease = await tryLease(await getDb(), 'internal-tick', TICK_LEASE)
  if (!lease) return NextResponse.json({ ok: true, skipped: 'another tick is running' })
  try {
    return await tick(lease, requestIdOf(req))
  } catch (e) {
    if (e instanceof LeaseLost || e instanceof StaleLeaseWrite) { captureError(e, { source: 'worker', where: 'tick', requestId: requestIdOf(req) }); return NextResponse.json({ ok: false, stopped: 'lease_lost' }) }
    throw e
  } finally {
    await lease.release().catch(() => {})
  }
}

// Heartbeat every ~6.7 min (default (ttl - budget) / 3); keep() refuses a new step with under 10 min of confirmed lease.
const TICK_LEASE = { ttlMs: 30 * 60 * 1000, stepBudgetMs: 10 * 60 * 1000 }

async function tick(lease: Lease, requestId?: string) {
  const raw = getScanDb()
  const db = lease.fenceSqlite(raw)
  // A refused write means this tick lost the lease: stop, never carry on with the next tenant.
  const fenced = (e: unknown) => { if (e instanceof StaleLeaseWrite) throw e }
  // #413: replies, opt-outs and bounces are read for every read-authorized tenant, whatever its sending settings (first-touch
  // only, paused, follow-ups off). Sending below uses only a sync that succeeded in this tick.
  const synced = await scheduledReplySync(db, { keep: () => lease.keep(), onError: (tenantId, e) => { fenced(e); captureError(e, { source: 'worker', where: 'tick:replies', tenantId, requestId }) } })
  const tenants = db.prepare('SELECT s.tenant_id, u.business_name FROM autopilot_settings s JOIN users u ON u.id = s.tenant_id WHERE s.enabled = 1 AND s.paused = 0 AND s.followups_enabled = 1').all() as { tenant_id: string; business_name: string | null }[]
  let done = 0
  for (const t of tenants) {
    await lease.keep()
    const sync = synced.get(t.tenant_id)
    if (!sync || sync.error) continue   // no fresh read this tick: no follow-up relies on stale safety state
    try { await runFollowups(db, t.tenant_id, t.business_name ?? ''); done++ } catch (e) { fenced(e); captureError(e, { source: 'worker', where: 'tick:replies', tenantId: t.tenant_id, requestId }) }
  }
  let sequences = 0
  for (const t of db.prepare("SELECT DISTINCT tenant_id FROM sequences WHERE status IN ('approved','active')").all() as { tenant_id: string }[]) {
    await lease.keep()
    const sync = synced.get(t.tenant_id)
    try { const r = await runSequences(db, t.tenant_id, '', { presynced: sync ?? { error: 'reading_not_enabled' } }); sequences += r.sent } catch (e) { fenced(e); captureError(e, { source: 'worker', where: 'tick:sequences', tenantId: t.tenant_id, requestId }) }
  }
  await lease.keep()
  // Watches and monitors are on the Db layer: each of their transactions takes the lease's fence first.
  const shared = await getDb()
  const fence = (t: Tx) => lease.fence(t)
  const watches = await runDueWatches(shared, { fence })
  // The scan runner works outside the tick's lease (its own claims), so it gets the raw handle.
  if (watches.ran > 0) after(() => kickRunner(raw))
  // Continuous monitoring: queue due monitors as ordinary scans, then fold finished runs into
  // per-monitor new-lead counts. Monitor jobs respect the same quota and pipeline as manual scans.
  const monitorJobs = await runDueMonitors(shared, { fence })
  if (monitorJobs.length > 0) after(() => kickRunner(raw))
  const monitorAlerts = await collectMonitorResults(shared, { fence })
  // Weekly indexing checks: one TinyFish site: search per saved keyword, inside the tenant's
  // own 10-searches-per-week allowance (separate from the scan caps). Best-effort per tenant.
  let indexChecked = 0
  for (const t of await dueTenants(shared, Math.floor(Date.now() / 1000))) {
    await lease.keep()
    try { const r = await runIndexChecks(shared, t); if (r && r.length > 0) indexChecked++ } catch (e) { fenced(e); captureError(e, { source: 'worker', where: 'tick:index-checks', tenantId: t, requestId }) }
  }
  return NextResponse.json({ ok: true, tenants: done, replies_synced: [...synced.values()].filter(r => !r.error).length, sequences, watches, monitor_jobs: monitorJobs.length, monitor_alerts: monitorAlerts, index_checks: indexChecked })
}
