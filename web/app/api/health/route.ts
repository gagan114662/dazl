import { connection } from 'next/server'
import { healthResponse } from '@/lib/ops/health-route'

// Health (lib/ops/health-route.ts): the commit this process serves and whether each configured database answers
// (SQLite; Postgres when DATABASE_URL is set). 503 when one does not. The deploy smoke check (scripts/health-smoke.mjs)
// requires it ok with the new commit. Liveness alone, touching no store, is /api/health/live; full readiness (schema,
// queue, env) is /api/ready, which ops/safe_launch.py waits on before a production cutover.
export async function GET() {
  await connection() // opt out of prerendering so the answer is per request
  return healthResponse()
}
