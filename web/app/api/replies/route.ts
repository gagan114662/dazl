import { NextRequest, NextResponse } from 'next/server'
import { getScanDb, requireUser } from '@/lib/scan/service'
import { sameOriginJson } from '@/lib/same-origin'
import { rateLimit } from '@/lib/rate-limit'
import { advFlags, platformAllowed } from '@/lib/advanced/config'
import { hasConsent } from '@/lib/advanced/index'
import { keyStatus } from '@/lib/llm/key-store'
import { dismissThread, listQueries, listThreads, migrateThreadReplies, refreshReplies, setQueries } from '@/lib/replies/threads'

export async function GET() {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  const db = getScanDb()
  migrateThreadReplies(db)
  const flags = advFlags()
  return NextResponse.json({
    queries: listQueries(db, user.id),
    threads: listThreads(db, user.id),
    platforms: { reddit: platformAllowed('reddit', flags), x: platformAllowed('x', flags) },
    consent: hasConsent(db, user.id, 'advanced'),
    has_key: keyStatus(db, user.id).length > 0,
  })
}

export async function POST(req: NextRequest) {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  if (!sameOriginJson(req)) return NextResponse.json({ error: 'Bad request' }, { status: 400 })
  if (!(await rateLimit(`replies:${user.id}`, 30, 60_000)).ok) return NextResponse.json({ error: 'Too many requests' }, { status: 429 })
  const body = await req.json().catch(() => null)
  const db = getScanDb()
  migrateThreadReplies(db)

  if (body?.action === 'set_queries') {
    if (!Array.isArray(body.queries)) return NextResponse.json({ error: 'Bad request' }, { status: 400 })
    const r = setQueries(db, user.id, body.queries)
    if (!r.ok) return NextResponse.json({ error: r.error }, { status: 400 })
    return NextResponse.json({ ok: true, queries: r.queries })
  }

  if (body?.action === 'refresh') {
    if (!(await rateLimit(`replies-refresh:${user.id}`, 10, 3_600_000)).ok) return NextResponse.json({ error: 'Refresh is limited to 10 times an hour' }, { status: 429 })
    return NextResponse.json(await refreshReplies(db, user.id))
  }

  if (body?.action === 'dismiss') {
    if (!dismissThread(db, user.id, String(body.id ?? ''))) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    return NextResponse.json({ ok: true })
  }

  return NextResponse.json({ error: 'Bad request' }, { status: 400 })
}
