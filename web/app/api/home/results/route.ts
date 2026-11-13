import { NextResponse } from 'next/server'
import { requireUser } from '@/lib/scan/service'
import { getDb } from '@/lib/db/client'
import { homeResults } from '@/lib/outreach/home-results'

// #1040: Home's last-30-days results for the signed-in workspace (counts and the 5 latest leads and replies). Read-only,
// tenant-scoped; a store that cannot be read answers 503 so Home says so instead of showing zeros.
export async function GET() {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  try {
    return NextResponse.json(await homeResults(await getDb(), user.tenantId), { headers: { 'Cache-Control': 'no-store' } })
  } catch {
    return NextResponse.json({ error: 'Could not read your results right now' }, { status: 503 })
  }
}
