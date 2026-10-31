import { connection } from 'next/server'
import { getDb } from '@/lib/db/client'
import { schedulerHealthResponse } from '@/lib/ops/scheduler-runs'

// Scheduler freshness for the operator and the alert timer (issue #361; docs/SCHEDULER.md): whether ticks are completing
// and how many tenants are blocked, stale or overdue. 200 when there is no problem, 503 otherwise. Counts and the
// scheduler's own state only: no tenant id, name or error text. Separate from readiness, so a stalled scheduler never
// blocks a deploy or restarts a healthy web process.
export async function GET() {
  await connection()
  return await schedulerHealthResponse(await getDb())
}
