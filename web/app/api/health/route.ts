import { connection } from 'next/server'
import { readyResponse } from '@/lib/ops/health-route'

// Readiness (lib/ops/health.ts), kept at this path for ops/safe_launch.py and the deploy docs: 200 with ok:true and
// the served commit when the store, its schema and the SQLite file answer; 503 naming the failed check otherwise.
export async function GET() {
  await connection() // opt out of prerendering so the checks run per request
  return readyResponse()
}
