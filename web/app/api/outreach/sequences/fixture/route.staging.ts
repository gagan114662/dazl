import { NextRequest, NextResponse } from 'next/server'
import { getScanDb, requireUser } from '@/lib/scan/service'
import { sameOriginJson } from '@/lib/same-origin'
import { rateLimit } from '@/lib/rate-limit'
import { denied } from '@/lib/workspace-access'
import { createReplyStopTestFixture, createSequenceTestFixture, fixtureAvailable, FixtureError } from '@/lib/outreach/test-fixture'

const notFound = () => NextResponse.json({ error: 'Not found' }, { status: 404 })

export async function GET() {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Sign in first.' }, { status: 401 })
  const no = denied(user, 'send'); if (no) return no
  if (process.env.DAZL_ENV !== 'staging') return notFound()
  return NextResponse.json({ available: fixtureAvailable(getScanDb(), user.tenantId) })
}

export async function POST(req: NextRequest) {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Sign in first.' }, { status: 401 })
  const no = denied(user, 'send'); if (no) return no
  if (process.env.DAZL_ENV !== 'staging') return notFound()
  if (!sameOriginJson(req)) return NextResponse.json({ error: 'Bad request' }, { status: 400 })
  if (!(await rateLimit(`sequences:${user.tenantId}`,30,3600000)).ok) return NextResponse.json({ error: 'Too many requests. Try again later.' }, { status: 429 })
  const body = await req.json().catch(() => null)
  try {
    if (body?.action === 'create_test_fixture') return NextResponse.json(createSequenceTestFixture(getScanDb(), user.tenantId))
    if (body?.action === 'create_reply_stop_fixture') return NextResponse.json(createReplyStopTestFixture(getScanDb(), user.tenantId))
    return NextResponse.json({ error: 'Bad request' }, { status: 400 })
  } catch (e) {
    if (e instanceof FixtureError) return NextResponse.json({ error: e.code }, { status: 400 })
    throw e
  }
}
