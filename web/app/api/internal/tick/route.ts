import { runSequences } from '@/lib/outreach/sequences'
import { after, NextRequest, NextResponse } from 'next/server'
import { timingSafeEqual } from 'node:crypto'
import { getScanDb } from '@/lib/scan/service'
import { syncReplies } from '@/lib/outreach/replies'
import { runFollowups } from '@/lib/outreach/followups'
import { runDueWatches } from '@/lib/watch'
import { collectMonitorResults, runDueMonitors } from '@/lib/monitors'
import { kickRunner } from '@/lib/scan/runner'
import { getDb } from '@/lib/db/client'
import { LeaseLost, tryLease } from '@/lib/shared/lease'
import type { Lease } from '@/lib/shared/lease'
import { migrateIndexing, dueTenants, runIndexChecks } from '@/lib/seo/indexing'

// Called by a scheduler (cron or a systemd timer) with AUTOPILOT_TICK_SECRET. Reads replies and sends due
// follow-ups for tenants who turned both on. Without the secret configured the route does not exist.
export async function POST(req: NextRequest) {
  const secret = process.env.AUTOPILOT_TICK_SECRET
  const got = req.headers.get('authorization') ?? ''
  const want = `Bearer ${secret}`
  if (!secret || got.length !== want.length || !timingSafeEqual(Buffer.from(got), Buffer.from(want))) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  // One tick at a time across every app instance: a scheduler that fires twice, or fires on two instances, runs the
  // work once. The lease is renewed by a heartbeat for as long as this process runs the tick, however long one tenant's
  // step takes, and keep() stops the tick between steps if the lease could not be renewed (lib/shared/lease.ts). A
  // crashed holder blocks ticks for at most TICK_LEASE.ttlMs.
  const lease = await tryLease(await getDb(), 'internal-tick', TICK_LEASE)
  if (!lease) return NextResponse.json({ ok: true, skipped: 'another tick is running' })
  try {
    return await tick(lease)
  } catch (e) {
    if (e instanceof LeaseLost) { console.error('tick stopped early', e.message); return NextResponse.json({ ok: false, stopped: 'lease_lost' }) }
    throw e
  } finally {
    await lease.release().catch(() => {})
  }
}

// Heartbeat every ~6.7 min (default (ttl - budget) / 3); keep() refuses a new step with under 10 min of confirmed lease.
const TICK_LEASE = { ttlMs: 30 * 60 * 1000, stepBudgetMs: 10 * 60 * 1000 }

async function tick(lease: Lease) {
  const db = getScanDb()
  const tenants = db.prepare('SELECT s.tenant_id, u.business_name FROM autopilot_settings s JOIN users u ON u.id = s.tenant_id WHERE s.enabled = 1 AND s.paused = 0 AND s.followups_enabled = 1').all() as { tenant_id: string; business_name: string | null }[]
  let done = 0
  for (const t of tenants) {
    await lease.keep()
    try { const sync = await syncReplies(db, t.tenant_id); if (sync.error) continue; await runFollowups(db, t.tenant_id, t.business_name ?? ''); done++ } catch (e) { console.error('tick failed', t.tenant_id, e instanceof Error ? e.message : 'error') }
  }
  let sequences = 0
  for (const t of db.prepare("SELECT DISTINCT tenant_id FROM sequences WHERE status IN ('approved','active')").all() as { tenant_id: string }[]) {
    await lease.keep()
    try { const r = await runSequences(db,t.tenant_id,''); sequences += r.sent } catch (e) { console.error('sequence tick failed',t.tenant_id,e instanceof Error ? e.message : 'error') }
  }
  await lease.keep()
  const watches = runDueWatches(db)
  if (watches.ran > 0) after(() => kickRunner(db))
  // Continuous monitoring: queue due monitors as ordinary scans, then fold finished runs into
  // per-monitor new-lead counts. Monitor jobs respect the same quota and pipeline as manual scans.
  const monitorJobs = runDueMonitors(db)
  if (monitorJobs.length > 0) after(() => kickRunner(db))
  const monitorAlerts = collectMonitorResults(db)
  // Weekly indexing checks: one TinyFish site: search per saved keyword, inside the tenant's
  // own 10-searches-per-week allowance (separate from the scan caps). Best-effort per tenant.
  migrateIndexing(db)
  let indexChecked = 0
  for (const t of dueTenants(db, Math.floor(Date.now() / 1000))) {
    await lease.keep()
    try { const r = await runIndexChecks(db, t); if (r && r.length > 0) indexChecked++ } catch (e) { console.error('index check failed', t, e instanceof Error ? e.message : 'error') }
  }
  return NextResponse.json({ ok: true, tenants: done, sequences, watches, monitor_jobs: monitorJobs.length, monitor_alerts: monitorAlerts, index_checks: indexChecked })
}
