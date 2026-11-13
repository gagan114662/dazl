import { NextRequest, NextResponse } from 'next/server'
import { getScanDb, requireUser } from '@/lib/scan/service'
import { sameOriginJson } from '@/lib/same-origin'
import { rateLimit } from '@/lib/rate-limit'
import { createVerificationFixture, deleteVerificationFixture, VERIFICATION_FIXTURE_JOB } from '@/lib/scan/verification-fixture'
import { createReviewDraftFixture, deleteReviewDraftFixtures } from '@/lib/scan/review-draft-fixture'
import { createFirstTouchFixture, deleteFirstTouchFixture, firstTouchFixtureExists } from '@/lib/scan/first-touch-fixture'
import { createWorkEmailFixture, deleteWorkEmailFixture, workEmailFixtureAvailable, workEmailFixtureExists } from '@/lib/scan/work-email-fixture'
import { fixtureAvailable, FixtureError } from '@/lib/outreach/test-fixture'
import { denied } from '@/lib/workspace-access'

// Test-only verification fixture for the designated test tenant: one labelled fixture
// lead with contact enrichments, source-ledger rows and a replied sequence, so the
// populated rendering of right-people / source quality / warm paths can be checked
// without a paid scan, real contacts, network calls or email. DELETE removes every
// row the fixture created.
//
// action 'work_email' (#1036): ONE labelled test-only lead on a settled site naming four buyer-role people, so Find work email can
// be clicked through on staging against the staging fake People Data Labs and fake ZeroBounce. Created only on the test tenant
// with DAZL_ENV=staging, DAZL_STAGING_FAKE_PDL=1 and DAZL_STAGING_FAKE_ZEROBOUNCE=1 (403 staging_fakes_only otherwise). DELETE with action 'work_email' removes it.
//
// action 'first_touch' (#411): ONE labelled test-only lead addressed to the allowlisted test inbox that the real
// autopilot may draft to once the user confirms it. Lead only: the draft, hold, scheduler drain and send run through the
// real code. DELETE with action 'first_touch' removes only that fixture; a DELETE with no action removes it with the
// others; any other body (a misspelled or wrong-typed action or key, null, a non-object or invalid JSON) is a 400 on
// POST and DELETE.

// The body's action. Only an empty body or exactly {} is "no action" (the legacy whole-fixture request, which on DELETE
// removes every fixture). An object carrying one of the method's known string actions is that action (other keys are
// ignored, e.g. a forged tenant_id). Everything else is malformed and refused: a misspelled or wrong-typed action, a
// misspelled key ({"acton": ...}), a JSON null, a non-object body, invalid JSON or a body that could not be read.
const NO_ACTION = Symbol('no action')
async function actionOf(req: NextRequest, known: readonly string[]): Promise<string | typeof NO_ACTION | null> {
  let text: string
  try { text = await req.text() } catch { return null }
  if (text.trim() === '') return NO_ACTION
  let body: unknown
  try { body = JSON.parse(text) } catch { return null }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null
  if (!Object.prototype.hasOwnProperty.call(body, 'action')) return Object.keys(body).length === 0 ? NO_ACTION : null
  const a = (body as { action?: unknown }).action
  return typeof a === 'string' && known.includes(a) ? a : null
}
const badAction = () => NextResponse.json({ error: 'unknown_action' }, { status: 400 })

export async function GET() {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  const db = getScanDb()
  const exists = !!db.prepare('SELECT id FROM scan_jobs WHERE user_id = ? AND business_name = ? LIMIT 1').get(user.tenantId, VERIFICATION_FIXTURE_JOB)
  const available = fixtureAvailable(db, user.tenantId)
  return NextResponse.json({ available, exists, firstTouchExists: available && firstTouchFixtureExists(db, user.tenantId), workEmailAvailable: workEmailFixtureAvailable(db, user.tenantId), workEmailExists: available && workEmailFixtureExists(db, user.tenantId) })
}

export async function POST(req: NextRequest) {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  const no = denied(user, 'operate'); if (no) return no
  if (!sameOriginJson(req)) return NextResponse.json({ error: 'Bad origin' }, { status: 403 })
  if (!(await rateLimit(`verification-fixture:${user.tenantId}`, 5, 60_000)).ok) return NextResponse.json({ error: 'Too many requests' }, { status: 429 })
  try {
    const action = await actionOf(req, ['first_touch', 'review_draft', 'work_email'])
    if (action === null) return badAction()
    if (action === 'first_touch') return NextResponse.json(createFirstTouchFixture(getScanDb(), user.tenantId))
    if (action === 'work_email') return NextResponse.json(createWorkEmailFixture(getScanDb(), user.tenantId))
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
    const action = await actionOf(req, ['first_touch', 'work_email'])
    if (action === null) return badAction()
    if (action === 'work_email') return NextResponse.json(deleteWorkEmailFixture(getScanDb(), user.tenantId))
    // First: a send to the first-touch fixture in flight, uncertain or sent in the last 24 h refuses the whole cleanup
    // before anything is removed.
    const firstTouch = deleteFirstTouchFixture(getScanDb(), user.tenantId)
    if (action === 'first_touch') return NextResponse.json(firstTouch)
    deleteReviewDraftFixtures(getScanDb(),user.tenantId)
    deleteWorkEmailFixture(getScanDb(), user.tenantId)
    return NextResponse.json(deleteVerificationFixture(getScanDb(), user.tenantId))
  } catch (e) {
    if (e instanceof FixtureError) return NextResponse.json({ error: e.code }, { status: 403 })
    throw e
  }
}
