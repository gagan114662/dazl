import { runSequences } from '@/lib/outreach/sequences'
import { after, NextRequest, NextResponse } from 'next/server'
import { timingSafeEqual } from 'node:crypto'
import { getScanDb } from '@/lib/scan/service'
import { syncReplies } from '@/lib/outreach/replies'
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
import { DbQueue } from '@/lib/queue/db'
import { drainTickWork, enqueueTickWork, tickQueueEnabled } from '@/lib/queue/tick-work'

// Called by a scheduler (cron or a systemd timer) with AUTOPILOT_TICK_SECRET. Reads replies and sends due
// follow-ups for tenants who turned both on. Without the secret configured the route does not exist.
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
// DAZL_TICK_QUEUE: no new follow-up/sequence claim after this long; what is left waits for the next tick.
const TICK_QUEUE_BUDGET_MS = 15 * 60 * 1000

async function tick(lease: Lease, requestId?: string) {
  const raw = getScanDb()
  const db = lease.fenceSqlite(raw)
  // A refused write means this tick lost the lease: stop, never carry on with the next tenant.
  const fenced = (e: unknown) => { if (e instanceof StaleLeaseWrite) throw e }
  const tenants = db.prepare('SELECT s.tenant_id, u.business_name FROM autopilot_settings s JOIN users u ON u.id = s.tenant_id WHERE s.enabled = 1 AND s.paused = 0 AND s.followups_enabled = 1').all() as { tenant_id: string; business_name: string | null }[]
  const seqTenants = (db.prepare("SELECT DISTINCT tenant_id FROM sequences WHERE status IN ('approved','active')").all() as { tenant_id: string }[]).map(t => t.tenant_id)
  const shared = await getDb()
  let done = 0, sequences = 0
  let queued: Awaited<ReturnType<typeof drainTickWork>> | undefined
  if (tickQueueEnabled()) {
    // DAZL_TICK_QUEUE=1 (default OFF): the same per-tenant work as the loops below, as durable queue items claimed
    // round-robin in the replies lane within a budget (lib/queue/tick-work.ts). An item left from an earlier tick for a
    // tenant no longer due is completed without running.
    const q = new DbQueue(shared)
    const names = new Map(tenants.map(t => [t.tenant_id, t.business_name ?? '']))
    const seqDue = new Set(seqTenants)
    await enqueueTickWork(q, [{ kind: 'followup', tenantIds: [...names.keys()] }, { kind: 'sequence', tenantIds: seqTenants }])
    queued = await drainTickWork(q, {
      followup: async id => { if (!names.has(id)) return; const sync = await syncReplies(db, id); if (sync.error) return; await runFollowups(db, id, names.get(id)!); done++ },
      sequence: async id => { if (!seqDue.has(id)) return; sequences += (await runSequences(db, id, '')).sent },
    }, {
      budgetMs: TICK_QUEUE_BUDGET_MS, keep: () => lease.keep(),
      isFenceError: e => e instanceof StaleLeaseWrite || e instanceof LeaseLost,
      onError: (e, item) => captureError(e, { source: 'worker', where: `tick:${item.kind === 'sequence' ? 'sequences' : 'replies'}`, tenantId: item.tenantId, requestId }),
    })
  } else {
    for (const t of tenants) {
      await lease.keep()
      try { const sync = await syncReplies(db, t.tenant_id); if (sync.error) continue; await runFollowups(db, t.tenant_id, t.business_name ?? ''); done++ } catch (e) { fenced(e); captureError(e, { source: 'worker', where: 'tick:replies', tenantId: t.tenant_id, requestId }) }
    }
    for (const t of seqTenants) {
      await lease.keep()
      try { const r = await runSequences(db, t, ''); sequences += r.sent } catch (e) { fenced(e); captureError(e, { source: 'worker', where: 'tick:sequences', tenantId: t, requestId }) }
    }
  }
  await lease.keep()
  // Watches and monitors are on the Db layer: each of their transactions takes the lease's fence first.
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
  return NextResponse.json({ ok: true, tenants: done, sequences, watches, monitor_jobs: monitorJobs.length, monitor_alerts: monitorAlerts, index_checks: indexChecked, ...(queued ? { queue: queued } : {}) })
}
