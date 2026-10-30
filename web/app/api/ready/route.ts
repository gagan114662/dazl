import { connection } from 'next/server'
import { readyResponse } from '@/lib/ops/health-route'

// Readiness probe (same checks as /api/health/ready): the store answers and, on Postgres, its schema has every
// migration this build ships; the scan queue answers. Unauthenticated; check names and timings only, no tenant data.
export async function GET() {
  await connection()
  return readyResponse()
}
