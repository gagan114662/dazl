import { NextRequest, NextResponse } from 'next/server'
import { getScanDb, requireUser } from '@/lib/scan/service'
import { getAuthDb, getSellerProfile } from '@/lib/auth-db'
import { sameOriginJson } from '@/lib/same-origin'
import { rateLimit } from '@/lib/rate-limit'
import { draftReply, markDraft, migrateThreadReplies, saveDraft } from '@/lib/replies/threads'
import { KEY_UNREADABLE_COPY, knownErrorCopy } from '@/lib/error-copy'

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  if (!sameOriginJson(req)) return NextResponse.json({ error: 'Bad request' }, { status: 400 })
  if (!(await rateLimit(`replies:${user.id}`, 30, 60_000)).ok) return NextResponse.json({ error: 'Too many requests' }, { status: 429 })
  const { id } = await params
  if (!/^[a-f0-9]{24}$/.test(id)) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const body = await req.json().catch(() => null)
  const db = getScanDb()
  migrateThreadReplies(db)

  if (body?.action === 'draft') {
    const r = await draftReply(db, user.id, id, getSellerProfile(getAuthDb(), user.id))
    if ('error' in r) {
      const msg = r.error === 'key_unreadable' ? KEY_UNREADABLE_COPY : r.error === 'key_rejected' ? knownErrorCopy('key_rejected')! : r.error === 'no_key' ? 'Add your own AI key in Settings first' : r.error === 'not_found' ? 'Not found' : 'The AI provider failed - try again'
      return NextResponse.json({ error: msg }, { status: r.error === 'not_found' ? 404 : r.error === 'no_key' || r.error === 'key_unreadable' || r.error === 'key_rejected' ? 400 : 502 })
    }
    return NextResponse.json(r)
  }

  if (body?.action === 'save') {
    const r = saveDraft(db, user.id, id, String(body.draft ?? ''))
    if (!r.ok) return NextResponse.json({ error: r.error }, { status: 400 })
    return NextResponse.json({ ok: true })
  }

  if (body?.action === 'mark' && (body.status === 'copied' || body.status === 'posted')) {
    if (!markDraft(db, user.id, id, body.status)) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    return NextResponse.json({ ok: true })
  }

  return NextResponse.json({ error: 'Bad request' }, { status: 400 })
}
