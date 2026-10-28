import { NextRequest, NextResponse } from 'next/server'
import { requireUser } from '@/lib/scan/service'
import { getDb } from '@/lib/db/client'
import { saveDomain, getConfig, listKeywords, addKeyword, removeKeyword, latestResults, runIndexChecks, weeklySpend, WEEKLY_ALLOWANCE } from '@/lib/seo/indexing'
import { sameOriginJson } from '@/lib/same-origin'
import { rateLimit } from '@/lib/rate-limit'

export async function GET() {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  const db = await getDb()
  const now = Math.floor(Date.now() / 1000)
  return NextResponse.json({
    config: await getConfig(db, user.id),
    keywords: await listKeywords(db, user.id),
    results: await latestResults(db, user.id),
    allowance: { used: await weeklySpend(db, user.id, now), limit: WEEKLY_ALLOWANCE },
  })
}

export async function POST(req: NextRequest) {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  if (!sameOriginJson(req)) return NextResponse.json({ error: 'Bad request' }, { status: 400 })
  if (!(await rateLimit(`seo-idx:${user.id}`, 20, 60_000)).ok) return NextResponse.json({ error: 'Too many requests' }, { status: 429 })
  const body = await req.json().catch(() => null)
  const db = await getDb()
  switch (body?.action) {
    case 'domain': {
      const domain = typeof body?.domain === 'string' ? await saveDomain(db, user.id, body.domain) : null
      if (!domain) return NextResponse.json({ error: 'That does not look like a domain' }, { status: 400 })
      return NextResponse.json({ ok: true, domain })
    }
    case 'add': {
      const r = typeof body?.keyword === 'string' ? await addKeyword(db, user.id, body.keyword) : { error: 'invalid' as const }
      if ('error' in r) return NextResponse.json({ error: r.error === 'limit' ? 'Up to 10 keywords' : 'That keyword looks too short' }, { status: 400 })
      return NextResponse.json({ ok: true })
    }
    case 'remove':
      if (typeof body?.keyword === 'string') await removeKeyword(db, user.id, body.keyword)
      return NextResponse.json({ ok: true })
    case 'run': {
      // Manual run, still inside the 10/week allowance.
      const r = await runIndexChecks(db, user.id)
      if (r === null) return NextResponse.json({ error: 'Nothing to run, or this week\'s checks are spent. They re-run weekly.' }, { status: 400 })
      if (r.length === 0) return NextResponse.json({ error: 'The search backend is at its daily cap right now - nothing was checked or spent. The weekly check will retry automatically.' }, { status: 503 })
      return NextResponse.json({ ok: true, results: r })
    }
    default:
      return NextResponse.json({ error: 'Bad request' }, { status: 400 })
  }
}
