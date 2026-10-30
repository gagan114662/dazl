import { NextRequest, NextResponse } from 'next/server'
import { getScanDb, requireUser } from '@/lib/scan/service'
import { disconnectGmail } from '@/lib/gmail/oauth'
import { sameOriginJson } from '@/lib/same-origin'
import { audit } from '@/lib/audit-route'

export async function POST(req: NextRequest) {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  if (!sameOriginJson(req)) return NextResponse.json({ error: 'Bad request' }, { status: 400 })
  await disconnectGmail(getScanDb(), user.id)
  await audit(user, req, { action: 'credential.removed', resource: 'gmail' })
  return NextResponse.json({ ok: true })
}
