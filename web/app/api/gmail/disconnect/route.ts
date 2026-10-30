import { NextRequest, NextResponse } from 'next/server'
import { getScanDb, requireUser } from '@/lib/scan/service'
import { disconnectGmail } from '@/lib/gmail/oauth'
import { sameOriginJson } from '@/lib/same-origin'
import { audit } from '@/lib/audit-route'
import { denied } from '@/lib/workspace-access'

export async function POST(req: NextRequest) {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  const no = denied(user, 'configure'); if (no) return no
  if (!sameOriginJson(req)) return NextResponse.json({ error: 'Bad request' }, { status: 400 })
  await disconnectGmail(getScanDb(), user.tenantId)
  await audit(user, req, { action: 'credential.removed', resource: 'gmail' })
  return NextResponse.json({ ok: true })
}
