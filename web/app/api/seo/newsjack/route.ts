import { NextRequest, NextResponse } from 'next/server'
import { getScanDb, requireUser } from '@/lib/scan/service'
import { createNewsjack, approveNewsjack, migrateNewsjacks, recentNewsjacks } from '@/lib/seo/newsjack'
import { sameOriginJson } from '@/lib/same-origin'
import { rateLimit } from '@/lib/rate-limit'

export async function GET() {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  const db = getScanDb()
  migrateNewsjacks(db)
  return NextResponse.json({ newsjacks: recentNewsjacks(db, user.id) })
}

export async function POST(req: NextRequest) {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  if (!sameOriginJson(req)) return NextResponse.json({ error: 'Bad request' }, { status: 400 })
  if (!(await rateLimit(`newsjack:${user.id}`, 10, 60 * 60 * 1000)).ok) return NextResponse.json({ error: 'Too many drafts this hour. Try later.' }, { status: 429 })
  const body = await req.json().catch(() => null)
  const db = getScanDb()
  migrateNewsjacks(db)
  if (body?.action === 'approve') {
    const ok = typeof body?.id === 'string' && approveNewsjack(db, user.id, body.id)
    return ok ? NextResponse.json({ ok: true }) : NextResponse.json({ error: 'Not found' }, { status: 404 })
  }
  const r = await createNewsjack(db, user.id, typeof body?.url === 'string' ? body.url : '')
  if ('error' in r) {
    if (r.error === 'no_key') return NextResponse.json({ error: 'Drafts use your own AI key. Add one in Settings first.' }, { status: 400 })
    if (r.error === 'invalid') return NextResponse.json({ error: 'Paste the full https URL of the news article.' }, { status: 400 })
    if (r.error === 'fetch') return NextResponse.json({ error: 'Could not read that page. Check the link is public.' }, { status: 400 })
    return NextResponse.json({ error: 'The model did not answer. Try again.' }, { status: 502 })
  }
  return NextResponse.json(r)
}
