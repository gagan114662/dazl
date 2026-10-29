import { NextRequest, NextResponse } from 'next/server'
import { getScanDb, requireUser } from '@/lib/scan/service'
import { disconnectGmail } from '@/lib/gmail/oauth'
import { sameOriginJson } from '@/lib/same-origin'
import { audited, denied, stale } from '@/lib/workspace-access'

export async function POST(req: NextRequest) {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  const no = await denied(user, 'configure'); if (no) return no
  const done = audited(user, 'credential.removed', 'gmail')
  const old = await stale(user); if (old) return old
  if (!sameOriginJson(req)) return NextResponse.json({ error: 'Bad request' }, { status: 400 })
  await disconnectGmail(getScanDb(), user.tenantId)
  return done({ ok: true })
}
