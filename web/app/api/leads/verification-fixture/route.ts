import { NextRequest, NextResponse } from 'next/server'
import { getScanDb, requireUser } from '@/lib/scan/service'
import { sameOriginJson } from '@/lib/same-origin'
import { rateLimit } from '@/lib/rate-limit'
import { createVerificationFixture, deleteVerificationFixture, VERIFICATION_FIXTURE_JOB } from '@/lib/scan/verification-fixture'
import { createReviewDraftFixture, deleteReviewDraftFixtures } from '@/lib/scan/review-draft-fixture'
import { createFirstTouchFixture, deleteFirstTouchFixture, firstTouchFixtureExists } from '@/lib/scan/first-touch-fixture'
import { fixtureAvailable, FixtureError } from '@/lib/outreach/test-fixture'
import { denied } from '@/lib/workspace-access'

// Test-only verification fixture for the designated test tenant: one labelled fixture
// lead with contact enrichments, source-ledger rows and a replied sequence, so the
// populated rendering of right-people / source quality / warm paths can be checked
// without a paid scan, real contacts, network calls or email. DELETE removes every
// row the fixture created.
//
// action 'first_touch' (#411): ONE labelled test-only lead addressed to the allowlisted test inbox that the real
// autopilot may draft to once the user confirms it. Lead only: the draft, hold, scheduler drain and send run through the
// real code. DELETE with action 'first_touch' removes only that fixture; a plain DELETE removes it with the others.

// The body's action, only when the body is a plain object carrying a string action; anything else is no action.
const actionOf = (body: unknown): string | undefined => {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return undefined
  const a = (body as { action?: unknown }).action
  return typeof a === 'string' ? a : undefined
}

export async function GET() {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  const db = getScanDb()
  const exists = !!db.prepare('SELECT id FROM scan_jobs WHERE user_id = ? AND business_name = ? LIMIT 1').get(user.tenantId, VERIFICATION_FIXTURE_JOB)
  const available = fixtureAvailable(db, user.tenantId)
  return NextResponse.json({ available, exists, firstTouchExists: available && firstTouchFixtureExists(db, user.tenantId) })
}

export async function POST(req: NextRequest) {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  const no = denied(user, 'operate'); if (no) return no
  if (!sameOriginJson(req)) return NextResponse.json({ error: 'Bad origin' }, { status: 403 })
  if (!(await rateLimit(`verification-fixture:${user.tenantId}`, 5, 60_000)).ok) return NextResponse.json({ error: 'Too many requests' }, { status: 429 })
  try {
    const action = actionOf(await req.json().catch(()=>null))
    if (action === 'first_touch') return NextResponse.json(createFirstTouchFixture(getScanDb(), user.tenantId))
    return NextResponse.json(action==='review_draft' ? createReviewDraftFixture(getScanDb(),user.tenantId) : createVerificationFixture(getScanDb(), user.tenantId))
  } catch (e) {
    if (e instanceof FixtureError) return NextResponse.json({ error: e.code }, { status: 403 })
    throw e
  }
}

export async function DELETE(req: NextRequest) {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  const no = denied(user, 'operate'); if (no) return no
  if (!sameOriginJson(req)) return NextResponse.json({ error: 'Bad origin' }, { status: 403 })
  try {
    if (!fixtureAvailable(getScanDb(),user.tenantId)) throw new FixtureError('test_tenant_only')
    const action = actionOf(await req.json().catch(()=>null))
    // First: a send to the first-touch fixture in flight refuses the whole cleanup before anything is removed.
    const firstTouch = deleteFirstTouchFixture(getScanDb(), user.tenantId)
    if (action === 'first_touch') return NextResponse.json(firstTouch)
    deleteReviewDraftFixtures(getScanDb(),user.tenantId)
    return NextResponse.json(deleteVerificationFixture(getScanDb(), user.tenantId))
  } catch (e) {
    if (e instanceof FixtureError) return NextResponse.json({ error: e.code }, { status: 403 })
    throw e
  }
}
