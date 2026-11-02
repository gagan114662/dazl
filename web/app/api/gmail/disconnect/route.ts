import { NextRequest, NextResponse } from 'next/server'
import { getScanDb, requireUser } from '@/lib/scan/service'
import { disconnectGmail } from '@/lib/gmail/oauth'
import { sameOriginJson } from '@/lib/same-origin'
import { audit } from '@/lib/audit-route'
import { denied, stale } from '@/lib/workspace-access'

export async function POST(req: NextRequest) {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  const no = denied(user, 'configure'); if (no) return no
  const old = stale(user); if (old) return old

  if (!sameOriginJson(req)) return NextResponse.json({ error: 'Bad request' }, { status: 400 })
  const db = getScanDb()
  // disconnecting when nothing is connected changes nothing, so it records nothing
  const connected = !!db.prepare('SELECT 1 FROM gmail_accounts WHERE tenant_id = ?').get(user.tenantId)
  await disconnectGmail(db, user.tenantId)
  if (connected) await audit(user, req, { action: 'credential.removed', resource: 'gmail' })
  return NextResponse.json({ ok: true })
}
