import { connection } from 'next/server'
import { readyResponse } from '@/lib/ops/health-route'

// Readiness probe: same checks as /api/health.
export async function GET() {
  await connection()
  return readyResponse()
}
