import { NextRequest, NextResponse } from 'next/server'
import { requireUser } from '@/lib/scan/service'
import { getDb } from '@/lib/db/client'
import { generateBrief, recentBriefs } from '@/lib/seo/brief'
import { sameOriginJson } from '@/lib/same-origin'
import { rateLimit } from '@/lib/rate-limit'
import { denied } from '@/lib/workspace-access'

export async function GET() {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  return NextResponse.json({ briefs: await recentBriefs(await getDb(), user.tenantId) })
}

export async function POST(req: NextRequest) {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  const no = await denied(user, 'operate'); if (no) return no
  if (!sameOriginJson(req)) return NextResponse.json({ error: 'Bad request' }, { status: 400 })
  if (!(await rateLimit(`seo-brief:${user.tenantId}`, 10, 60 * 60 * 1000)).ok) return NextResponse.json({ error: 'Too many briefs this hour. Try later.' }, { status: 429 })
  const body = await req.json().catch(() => null)
  const r = await generateBrief(await getDb(), user.tenantId, typeof body?.topic === 'string' ? body.topic : '')
  if ('error' in r) {
    if (r.error === 'no_key') return NextResponse.json({ error: 'Briefs use your own AI key. Add one in Settings first.' }, { status: 400 })
    if (r.error === 'invalid') return NextResponse.json({ error: 'Give the topic a few words.' }, { status: 400 })
    return NextResponse.json({ error: 'The model did not answer. Try again.' }, { status: 502 })
  }
  return NextResponse.json(r)
}
