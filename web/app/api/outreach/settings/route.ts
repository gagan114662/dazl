import { NextRequest, NextResponse } from 'next/server'
import { getScanDb, requireUser } from '@/lib/scan/service'
import { gmailStatus } from '@/lib/gmail/oauth'
import { READ_CONSENT_TEXT } from '@/lib/outreach/replies'
import { DAILY_CAP, getSettings, OutreachError, saveSettings, sentLast24h } from '@/lib/outreach/service'
import { sameOriginJson } from '@/lib/same-origin'
import { accountSendCount } from '@/lib/outreach/send-budget'

// account_sent_24h is the whole rolling budget the daily cap is checked against (first touches, follow-ups, sequence steps,
// re-opens); sent_24h is first touches only. Read-only.
export async function GET() {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  const db = getScanDb()
  return NextResponse.json({ gmail: gmailStatus(db, user.id), sender: getSettings(db, user.id) ?? null, daily_cap: DAILY_CAP, sent_24h: sentLast24h(db, user.id), account_sent_24h: accountSendCount(db, user.id, Math.floor(Date.now() / 1000)), read_notice: READ_CONSENT_TEXT })
}

export async function PUT(req: NextRequest) {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  if (!sameOriginJson(req)) return NextResponse.json({ error: 'Bad request' }, { status: 400 })
  const body = await req.json().catch(() => null)
  if (typeof body?.sender_name !== 'string' || typeof body?.postal_address !== 'string') return NextResponse.json({ error: 'Bad request' }, { status: 400 })
  try {
    saveSettings(getScanDb(), user.id, { sender_name: body.sender_name, postal_address: body.postal_address, booking_url: body.booking_url })
    return NextResponse.json({ ok: true })
  } catch (e) {
    if (e instanceof OutreachError) return NextResponse.json({ error: e.code === 'bad_postal_address' ? 'Enter your full mailing address (required by anti-spam law).' : e.code === 'bad_booking_url' ? 'The booking link must be a full https URL (or leave it empty).' : 'Enter the name recipients will see.' }, { status: 400 })
    throw e
  }
}
