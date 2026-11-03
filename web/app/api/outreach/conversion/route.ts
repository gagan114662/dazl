import { NextResponse } from 'next/server'
import { getScanDb, requireUser } from '@/lib/scan/service'
import { conversionReport } from '@/lib/outreach/conversion'
import { hasReadConsent } from '@/lib/outreach/replies'
import { gmailStatus } from '@/lib/gmail/oauth'

export async function GET() {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  const db = getScanDb()
  const acc = db.prepare('SELECT read_granted FROM gmail_accounts WHERE tenant_id = ?').get(user.tenantId) as { read_granted: number } | undefined
  const reading = hasReadConsent(db, user.tenantId) && acc?.read_granted === 1 && gmailStatus(db, user.tenantId)?.status === 'active'
  return NextResponse.json(conversionReport(db, user.tenantId, reading))
}
