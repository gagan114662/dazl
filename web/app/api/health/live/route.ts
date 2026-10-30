import { connection } from 'next/server'
import { liveResponse } from '@/lib/ops/health-route'

// Liveness probe (same as /api/health): the process answers. Touches no database, so a slow store never gets a healthy
// process restarted.
export async function GET() {
  await connection()
  return liveResponse()
}
