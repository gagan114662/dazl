import { NextRequest, NextResponse } from 'next/server'
import { getScanDb, requireUser } from '@/lib/scan/service'
import { answerQueue, releaseAnswer, resolveException } from '@/lib/replies/answer-ledger'
import { sameOriginJson } from '@/lib/same-origin'
import { denied } from '@/lib/workspace-access'
import { audit } from '@/lib/audit-route'

// The owner's side of routine buyer answers (#406, lib/replies/answer-ledger.ts). GET: three separate lists of the
// session tenant's own rows: exceptions the owner answers, written answers waiting for release, answers held for the
// sender, consent or a limit. POST: release a written answer (it then goes out only through runAnswers' send-time
// checks) or close an exception. The message id is looked up inside the session tenant only: another tenant's id, an
// unknown id, or a row in any other state answers 404 and changes nothing.
export async function GET() {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  return NextResponse.json(answerQueue(getScanDb(), user.tenantId))
}

const ACTIONS = { release: releaseAnswer, resolve: resolveException } as const

export async function POST(req: NextRequest) {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  const no = denied(user, 'send'); if (no) return no
  if (!sameOriginJson(req)) return NextResponse.json({ error: 'Bad request' }, { status: 400 })
  const body: unknown = await req.json().catch(() => null)
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : null
  const action = b?.action, id = b?.message_id
  if ((action !== 'release' && action !== 'resolve') || typeof id !== 'string' || id.length < 1 || id.length > 200)
    return NextResponse.json({ error: 'Bad request' }, { status: 400 })
  const r = ACTIONS[action](getScanDb(), user.tenantId, id, Math.floor(Date.now() / 1000))
  if (r !== 'ok') return NextResponse.json({ error: 'Not found' }, { status: 404 })
  await audit(user, req, { action: action === 'release' ? 'answer.released' : 'answer.exception_resolved', resource: 'buyer_answer', id })
  return NextResponse.json({ ok: true })
}
