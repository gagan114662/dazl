import { connection } from 'next/server'
import { liveResponse } from '@/lib/ops/health-route'

// Liveness (lib/ops/health-route.ts): the process answers, with the commit it serves. No store is touched. Readiness
// (the store, its schema, the scan queue) is /api/ready; ops/safe_launch.py waits on that before a cutover.
export async function GET() {
  await connection() // opt out of prerendering so the answer is per request
  return liveResponse()
}
