import { NextRequest, NextResponse } from 'next/server'
import { getScanDb, requireUser } from '@/lib/scan/service'
import { gmailStatus } from '@/lib/gmail/oauth'
import { DAILY_CAP, getSettings, OutreachError, saveSettings, sentLast24h } from '@/lib/outreach/service'
import { sameOriginJson } from '@/lib/same-origin'

export async function GET() {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  const db = getScanDb()
  return NextResponse.json({ gmail: gmailStatus(db, user.id), sender: getSettings(db, user.id) ?? null, daily_cap: DAILY_CAP, sent_24h: sentLast24h(db, user.id) })
}

export async function PUT(req: NextRequest) {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  if (!sameOriginJson(req)) return NextResponse.json({ error: 'Bad request' }, { status: 400 })
  const body = await req.json().catch(() => null)
  if (typeof body?.sender_name !== 'string' || typeof body?.postal_address !== 'string') return NextResponse.json({ error: 'Bad request' }, { status: 400 })
  try {
    saveSettings(getScanDb(), user.id, { sender_name: body.sender_name, postal_address: body.postal_address })
    return NextResponse.json({ ok: true })
  } catch (e) {
    if (e instanceof OutreachError) return NextResponse.json({ error: e.code === 'bad_postal_address' ? 'Enter your full mailing address (required by anti-spam law).' : 'Enter the name recipients will see.' }, { status: 400 })
    throw e
  }
}
