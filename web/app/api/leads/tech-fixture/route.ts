import { NextRequest, NextResponse } from 'next/server'
import { getScanDb, requireUser } from '@/lib/scan/service'
import { sameOriginJson } from '@/lib/same-origin'
import { rateLimit } from '@/lib/rate-limit'
import { crawlTechFixture, deleteTechFixture, isTechFixturePage, techFixtureOn, TECH_FIXTURE_PAGES } from '@/lib/scan/tech-fixture'
import { FixtureError } from '@/lib/outreach/test-fixture'
import { denied } from '@/lib/workspace-access'

// TEST-ONLY, staging only (#769): serve the fixture company's homepage as the named variant and crawl it once through the real site
// crawl, so a technology adoption, a removal and an outage between readable pages can be watched live. See lib/scan/tech-fixture.ts.
// Outside staging a signed-in member with the operate role gets 404, before the request body is read or anything is written
// (signed out is 401 and a viewer 403 everywhere, like every session route).
const notFound = () => NextResponse.json({ error: 'Not found' }, { status: 404 })

export async function POST(req: NextRequest) {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  const no = denied(user, 'operate'); if (no) return no
  if (!techFixtureOn()) return notFound()
  if (!sameOriginJson(req)) return NextResponse.json({ error: 'Bad origin' }, { status: 403 })
  if (!(await rateLimit(`tech-fixture:${user.tenantId}`, 30, 60_000)).ok) return NextResponse.json({ error: 'Too many requests' }, { status: 429 })
  const body = await req.json().catch(() => null) as { page?: unknown } | null
  if (!isTechFixturePage(body?.page)) return NextResponse.json({ error: 'unknown_page', pages: TECH_FIXTURE_PAGES }, { status: 400 })
  try {
    return NextResponse.json(await crawlTechFixture(getScanDb(), user.tenantId, body.page, { signal: AbortSignal.timeout(30_000) }), { headers: { 'Cache-Control': 'no-store' } })
  } catch (e) {
    if (e instanceof FixtureError) return NextResponse.json({ error: e.code }, { status: e.code === 'crawl_disabled' || e.code === 'clock_not_advancing' || e.code === 'crawl_incomplete' ? 503 : e.code === 'crawl_in_flight' ? 409 : 403 })
    throw e
  }
}

export async function DELETE(req: NextRequest) {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  const no = denied(user, 'operate'); if (no) return no
  if (!techFixtureOn()) return notFound()
  if (!sameOriginJson(req)) return NextResponse.json({ error: 'Bad origin' }, { status: 403 })
  if (!(await rateLimit(`tech-fixture:${user.tenantId}`, 30, 60_000)).ok) return NextResponse.json({ error: 'Too many requests' }, { status: 429 })
  try {
    return NextResponse.json(deleteTechFixture(getScanDb(), user.tenantId))
  } catch (e) {
    if (e instanceof FixtureError) return NextResponse.json({ error: e.code }, { status: 403 })
    throw e
  }
}
