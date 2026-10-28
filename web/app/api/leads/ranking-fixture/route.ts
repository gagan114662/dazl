import { NextRequest, NextResponse } from 'next/server'
import { getScanDb, requireUser } from '@/lib/scan/service'
import { sameOriginJson } from '@/lib/same-origin'
import { rateLimit } from '@/lib/rate-limit'
import { createRankingFixture } from '@/lib/scan/ranking-fixture'
import { FixtureError } from '@/lib/outreach/test-fixture'

// Test-only ranking fixture for the designated test tenant. Creates no outreach, no
// messages, no real identities - only labelled fixture leads/events for ordering checks.
export async function POST(req: NextRequest) {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  if (!sameOriginJson(req)) return NextResponse.json({ error: 'Bad origin' }, { status: 403 })
  if (!(await rateLimit(`ranking-fixture:${user.id}`, 5, 60_000)).ok) return NextResponse.json({ error: 'Too many requests' }, { status: 429 })
  try {
    return NextResponse.json(createRankingFixture(getScanDb(), user.id))
  } catch (e) {
    if (e instanceof FixtureError) return NextResponse.json({ error: e.code }, { status: 403 })
    throw e
  }
}
