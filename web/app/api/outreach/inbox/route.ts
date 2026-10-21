import { NextResponse } from 'next/server'
import { getScanDb, requireUser } from '@/lib/scan/service'
import { hasReadConsent, inboxRows } from '@/lib/outreach/replies'
import { autopilotAvailable } from '@/lib/outreach/autopilot'

export async function GET() {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  const db = getScanDb()
  const acc = db.prepare('SELECT read_granted FROM gmail_accounts WHERE tenant_id = ?').get(user.id) as { read_granted: number } | undefined
  return NextResponse.json({ available: autopilotAvailable(), consent_accepted: hasReadConsent(db, user.id), read_granted: acc?.read_granted === 1, rows: inboxRows(db, user.id) })
}
