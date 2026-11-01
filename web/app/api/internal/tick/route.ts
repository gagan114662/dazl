import { runSequences } from '@/lib/outreach/sequences'
import { after, NextRequest, NextResponse } from 'next/server'
import { timingSafeEqual } from 'node:crypto'
import { getScanDb } from '@/lib/scan/service'
import { syncReplies, READ_CONSENT_VERSION } from '@/lib/outreach/replies'
import { runFollowups } from '@/lib/outreach/followups'
import { drainFirstTouch, runAutopilot } from '@/lib/outreach/autopilot'
import { runDueWatches } from '@/lib/watch'
import { collectMonitorResults, runDueMonitors } from '@/lib/monitors'
import { kickRunner } from '@/lib/scan/runner'
import { getDb, type Tx } from '@/lib/db/client'
import { LeaseLost, StaleLeaseWrite, tryLease } from '@/lib/shared/lease'
import type { Lease } from '@/lib/shared/lease'
import { dueTenants, runIndexChecks } from '@/lib/seo/indexing'
import { reapAccountHistory } from '@/lib/account-retention'
import { captureError } from '@/lib/ops/errors'
import { requestIdOf } from '@/lib/ops/request-log'
import { classifySync, classifyWork, finishRun, migrateSchedulerRuns, recordProgress, startRun, type Kind, type Outcome } from '@/lib/ops/scheduler-runs'

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
  // Heartbeat (lib/ops/scheduler-runs.ts): the run is recorded before any work, outside the lease's fence, so a tick
  // that dies leaves a 'running' row that reads as crashed once it outlives the lease, and one that loses the lease
  // still records why it stopped.
  const raw = getScanDb()
  migrateSchedulerRuns(raw)
  const runId = await startRun(raw, lease)
  try {
    return await tick(lease, runId, requestIdOf(req))
  } catch (e) {
    if (e instanceof LeaseLost || e instanceof StaleLeaseWrite) { await finishRun(raw, runId, 'lease_lost', e); captureError(e, { source: 'worker', where: 'tick', requestId: requestIdOf(req) }); return NextResponse.json({ ok: false, stopped: 'lease_lost' }) }
    await finishRun(raw, runId, 'failed', e)
    throw e
  } finally {
    await lease.release().catch(() => {})
  }
}

// Heartbeat every ~6.7 min (default (ttl - budget) / 3); keep() refuses a new step with under 10 min of confirmed lease.
const TICK_LEASE = { ttlMs: 30 * 60 * 1000, stepBudgetMs: 10 * 60 * 1000 }

async function tick(lease: Lease, runId: string, requestId?: string) {
  const raw = getScanDb()
  const db = lease.fenceSqlite(raw)
  // A refused write means this tick lost the lease: stop, never carry on with the next tenant.
  const fenced = (e: unknown) => { if (e instanceof StaleLeaseWrite) throw e }
  // Progress per tenant and kind of work, recorded only after the work returned (its writes passed the fence). The
  // workers report refusals as a result, not an exception, so what came back is classified (lib/ops/scheduler-runs.ts):
  // success, a hold (the tenant's own configuration or idle state) or a failure. Only failures make the run partial.
  let failures = 0, holds = 0
  const progress = async (tenant: string, kind: Kind, o: Outcome) => { if (o.outcome === 'failure') failures++; else if (o.outcome === 'hold') holds++; await recordProgress(raw, runId, tenant, kind, o) }
  const failed = (e: unknown): Outcome => ({ outcome: 'failure', error: e })
  // Sending follow-ups stays gated on the send-side switches (autopilot on, not paused, follow-ups on).
  const sendTenants = db.prepare('SELECT s.tenant_id, u.business_name FROM autopilot_settings s JOIN users u ON u.id = s.tenant_id WHERE s.enabled = 1 AND s.paused = 0 AND s.followups_enabled = 1').all() as { tenant_id: string; business_name: string | null }[]
  const sendSet = new Map(sendTenants.map(t => [t.tenant_id, t.business_name] as const))
  // First-touch work (backlog drain + new leads) needs only autopilot on and unpaused; the follow-ups switch is
  // irrelevant to it. Consent, warmup and offer authority are re-checked inside the workers themselves.
  const firstTouchTenants = db.prepare('SELECT s.tenant_id, u.business_name FROM autopilot_settings s JOIN users u ON u.id = s.tenant_id WHERE s.enabled = 1 AND s.paused = 0').all() as { tenant_id: string; business_name: string | null }[]
  const firstTouchSet = new Map(firstTouchTenants.map(t => [t.tenant_id, t.business_name] as const))
  // Reading replies, opt-outs and bounces is authorized by READ consent plus an active read-granted mailbox - never by
  // permission to send. A first-touch-only, paused or follow-ups-off account still gets its safety ingest; a revoked
  // consent or a missing/inactive/read-less mailbox is never selected (syncReplies re-checks the same gates, so a
  // race between this read and a revocation still ends before any provider call).
  const readTenants = db.prepare("SELECT c.tenant_id FROM mail_read_consent c JOIN gmail_accounts g ON g.tenant_id = c.tenant_id WHERE c.version = ? AND g.read_granted = 1 AND g.status = 'active'").all(READ_CONSENT_VERSION) as { tenant_id: string }[]
  const all = [...new Set([...sendSet.keys(), ...firstTouchSet.keys(), ...readTenants.map(t => t.tenant_id)])]
  let done = 0
  for (const tenantId of all) {
    await lease.keep()
    let stage: 'reply_sync' | 'followups' | 'first_touch' = 'reply_sync'
    try {
      const sync = classifySync(await syncReplies(db, tenantId))
      await progress(tenantId, 'reply_sync', sync)
      if (sync.outcome === 'failure') continue
      if (!sendSet.has(tenantId) && !firstTouchSet.has(tenantId)) { done++; continue } // read-only tenant: replies ingested; nothing to send
      if (sendSet.has(tenantId)) {
        stage = 'followups'
        const f = classifyWork(await runFollowups(db, tenantId, sendSet.get(tenantId) ?? ''))
        await progress(tenantId, 'followups', f)
        if (f.outcome === 'failure') continue
      }
      if (firstTouchSet.has(tenantId)) {
        // Drain due held drafts, then pick up new leads: first touches restart without waiting for a new scan.
        // Drain and discovery are one kind of scheduled work; a drain failure skips discovery (its sends are the riskier half).
        stage = 'first_touch'
        const dr = classifyWork(await drainFirstTouch(db, tenantId))
        await progress(tenantId, 'first_touch', dr)
        if (dr.outcome === 'failure') continue
        const ap = classifyWork(await runAutopilot(db, tenantId, firstTouchSet.get(tenantId) ?? ''))
        await progress(tenantId, 'first_touch', ap)
        if (ap.outcome === 'failure') continue
      }
      done++
    } catch (e) { fenced(e); await progress(tenantId, stage, failed(e)); captureError(e, { source: 'worker', where: 'tick:replies', tenantId, requestId }) }
  }
  let sequences = 0
  for (const t of db.prepare("SELECT DISTINCT tenant_id FROM sequences WHERE status IN ('approved','active')").all() as { tenant_id: string }[]) {
    await lease.keep()
    try { const r = await runSequences(db,t.tenant_id,''); sequences += r.sent; await progress(t.tenant_id, 'sequences', classifyWork(r)) } catch (e) { fenced(e); await progress(t.tenant_id, 'sequences', failed(e)); captureError(e, { source: 'worker', where: 'tick:sequences', tenantId: t.tenant_id, requestId }) }
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
  // Expired and long-revoked sessions, at most 500 per tick (lib/sessions.ts); working sessions never match.
  await lease.keep()
  let sessionsReaped = 0
  try { sessionsReaped = (await reapAccountHistory(shared, { fence })).sessions } catch (e) { fenced(e); captureError(e, { source: 'worker', where: 'tick:sessions', requestId }) }
  await finishRun(raw, runId, failures ? 'partial' : 'ok')
  return NextResponse.json({ ok: true, run: runId, tenants: done, tenant_failures: failures, tenant_holds: holds, sequences, watches, monitor_jobs: monitorJobs.length, monitor_alerts: monitorAlerts, sessions_reaped: sessionsReaped, index_checks: indexChecked })

}
