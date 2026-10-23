import { NextRequest, NextResponse } from 'next/server'
import { getScanDb, requireUser } from '@/lib/scan/service'
import { sameOriginJson } from '@/lib/same-origin'
import { rateLimit } from '@/lib/rate-limit'
import { createVerificationFixture, deleteVerificationFixture, VERIFICATION_FIXTURE_JOB } from '@/lib/scan/verification-fixture'
import { createReviewDraftFixture, deleteReviewDraftFixtures } from '@/lib/scan/review-draft-fixture'
import { fixtureAvailable, FixtureError } from '@/lib/outreach/test-fixture'

// Test-only verification fixture for the designated test tenant: one labelled fixture
// lead with contact enrichments, source-ledger rows and a replied sequence, so the
// populated rendering of right-people / source quality / warm paths can be checked
// without a paid scan, real contacts, network calls or email. DELETE removes every
// row the fixture created.

export async function GET() {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  const db = getScanDb()
  const exists = !!db.prepare('SELECT id FROM scan_jobs WHERE user_id = ? AND business_name = ? LIMIT 1').get(user.id, VERIFICATION_FIXTURE_JOB)
  return NextResponse.json({ available: fixtureAvailable(db, user.id), exists })
}

export async function POST(req: NextRequest) {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  if (!sameOriginJson(req)) return NextResponse.json({ error: 'Bad origin' }, { status: 403 })
  if (!rateLimit(`verification-fixture:${user.id}`, 5, 60_000).ok) return NextResponse.json({ error: 'Too many requests' }, { status: 429 })
  try {
    const body=await req.json().catch(()=>null)
    return NextResponse.json(body?.action==='review_draft' ? createReviewDraftFixture(getScanDb(),user.id) : createVerificationFixture(getScanDb(), user.id))
  } catch (e) {
    if (e instanceof FixtureError) return NextResponse.json({ error: e.code }, { status: 403 })
    throw e
  }
}

export async function DELETE(req: NextRequest) {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  if (!sameOriginJson(req)) return NextResponse.json({ error: 'Bad origin' }, { status: 403 })
  try {
    if (!fixtureAvailable(getScanDb(),user.id)) throw new FixtureError('test_tenant_only')
    deleteReviewDraftFixtures(getScanDb(),user.id)
    return NextResponse.json(deleteVerificationFixture(getScanDb(), user.id))
  } catch (e) {
    if (e instanceof FixtureError) return NextResponse.json({ error: e.code }, { status: 403 })
    throw e
  }
}
