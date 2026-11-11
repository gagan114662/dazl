import { after, NextRequest, NextResponse } from 'next/server'
import { getScanDb, requireUser } from '@/lib/scan/service'
import { getDb } from '@/lib/db/client'
import { sameOriginJson } from '@/lib/same-origin'
import { rateLimit } from '@/lib/rate-limit'
import { denied } from '@/lib/workspace-access'
import { audit } from '@/lib/audit-route'
import { kickRunner } from '@/lib/scan/runner'
import { runPlayNow, type RunNowRefusal } from '@/lib/play-now'

// #1042 "Find leads now": runs one of the tenant's saved plays now, by pulling its next scheduled run forward
// (lib/play-now.ts). Same request, profile and offer the scheduled run would use, funded the way that run is (own key,
// or the free trial's existing admission for a new account's automatic first-play repeat), monthly quota, one scan at
// a time; the play's next run moves to now + its interval. Another account's play is 404.
// The job is queued exactly as a scheduled run queues it, and this route dispatches the scan runner itself the way the
// scheduler tick does (app/api/internal/tick: kickRunner on the app's scan store, after the response), so the run starts
// whether or not the page stays open. The scan runner reads only that SQLite store: with DATABASE_URL set (Postgres,
// not authorized for production, docs/PLATFORM.md) a job written there would never be claimed, so the route refuses
// (503 runner_unavailable) before writing anything rather than queue a run that cannot start.
const STATUS: Record<RunNowRefusal, number> = { not_found: 404, paused: 409, no_api_key: 400, quota_exceeded: 402, scan_active: 409, too_soon: 429, trial_used: 402, trial_busy: 503 }

export async function POST(req: NextRequest, ctx: { params: Promise<{ kind: string; id: string }> }) {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  const no = denied(user, 'operate'); if (no) return no
  if (!sameOriginJson(req)) return NextResponse.json({ error: 'Bad request' }, { status: 400 })
  const { kind, id } = await ctx.params
  if ((kind !== 'watch' && kind !== 'monitor') || !/^[0-9a-f]{24}$/.test(id)) return NextResponse.json({ error: 'not_found' }, { status: 404 })
  const db = await getDb()
  if (db.kind !== 'sqlite') return NextResponse.json({ error: 'runner_unavailable' }, { status: 503 })
  const rl = await rateLimit(`play-run-now:${user.tenantId}`, 10, 60 * 60 * 1000)
  if (rl.unavailable) return NextResponse.json({ error: 'limits_unavailable' }, { status: 503, headers: { 'Retry-After': String(rl.retryAfterS) } })
  if (!rl.ok) return NextResponse.json({ error: 'too_many' }, { status: 429, headers: { 'Retry-After': String(rl.retryAfterS) } })
  const r = await runPlayNow(db, user.tenantId, kind, id)
  if ('error' in r) return NextResponse.json(r, { status: STATUS[r.error], ...(r.error === 'trial_busy' ? { headers: { 'Retry-After': '3600' } } : {}) })
  // a run the user started is spend they asked for: recorded like a monitor's creation
  await audit(user, req, { action: 'play.run_now', resource: kind, id, summary: { job_id: r.job_id, funded_by: r.funded_by } })
  const raw = getScanDb()
  after(() => kickRunner(raw))
  return NextResponse.json(r, { status: 202 })
}
