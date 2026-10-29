import { NextRequest, NextResponse } from 'next/server'
import { requireUser } from '@/lib/scan/service'
import { getDb } from '@/lib/db/client'
import { createNewsjack, approveNewsjack, recentNewsjacks } from '@/lib/seo/newsjack'
import { sameOriginJson } from '@/lib/same-origin'
import { rateLimit } from '@/lib/rate-limit'
import { denied } from '@/lib/workspace-access'

export async function GET() {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  return NextResponse.json({ newsjacks: await recentNewsjacks(await getDb(), user.tenantId) })
}

export async function POST(req: NextRequest) {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  const no = await denied(user, 'operate'); if (no) return no
  if (!sameOriginJson(req)) return NextResponse.json({ error: 'Bad request' }, { status: 400 })
  if (!(await rateLimit(`newsjack:${user.tenantId}`, 10, 60 * 60 * 1000)).ok) return NextResponse.json({ error: 'Too many drafts this hour. Try later.' }, { status: 429 })
  const body = await req.json().catch(() => null)
  const db = await getDb()
  if (body?.action === 'approve') {
    const ok = typeof body?.id === 'string' && await approveNewsjack(db, user.tenantId, body.id)
    return ok ? NextResponse.json({ ok: true }) : NextResponse.json({ error: 'Not found' }, { status: 404 })
  }
  const r = await createNewsjack(db, user.tenantId, typeof body?.url === 'string' ? body.url : '')
  if ('error' in r) {
    if (r.error === 'no_key') return NextResponse.json({ error: 'Drafts use your own AI key. Add one in Settings first.' }, { status: 400 })
    if (r.error === 'invalid') return NextResponse.json({ error: 'Paste the full https URL of the news article.' }, { status: 400 })
    if (r.error === 'fetch') return NextResponse.json({ error: 'Could not read that page. Check the link is public.' }, { status: 400 })
    return NextResponse.json({ error: 'The model did not answer. Try again.' }, { status: 502 })
  }
  return NextResponse.json(r)
}
