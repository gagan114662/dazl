// Settings > LinkedIn reading (#1122): the dazl Connect extension's pace for this workspace. Status; pause / resume; the reading
// window (default 09:00-17:00 in the workspace's time zone); a later close for today only, which ends by itself at local midnight.
import { NextRequest, NextResponse } from 'next/server'
import { requireUser } from '@/lib/scan/service'
import { getDb } from '@/lib/db/client'
import { sameOriginJson } from '@/lib/same-origin'
import { denied, stale } from '@/lib/workspace-access'
import { extendToday, extensionStatus, setPaused, setTimezone, setWindow } from '@/lib/linkedin-tasks/store'
import { parseHm, validZone } from '@/lib/linkedin-tasks/limits'
import { connectionStatus } from '@/lib/advanced/linkedin-connect'

export async function GET() {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  const db = await getDb()
  const s = await extensionStatus(db, user.tenantId)
  return NextResponse.json({ connected: (await connectionStatus(db, user.tenantId)).connected, tz: s.tz, paused: s.paused, queued: s.queued, read_today: s.read_today,
    open_min: s.open_min, close_min: s.close_min, today_close_min: s.today_close_min, stopped_until: s.stopped_until })
}

export async function POST(req: NextRequest) {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  const no = denied(user, 'configure'); if (no) return no
  const old = stale(user); if (old) return old
  if (!sameOriginJson(req)) return NextResponse.json({ error: 'Bad request' }, { status: 400 })
  const body = await req.json().catch(() => null) as { action?: unknown; timezone?: unknown; open?: unknown; close?: unknown } | null
  const db = await getDb()
  if (body?.action === 'pause' || body?.action === 'resume') { await setPaused(db, user.tenantId, body.action === 'pause'); return NextResponse.json({ ok: true }) }
  if (body?.action === 'timezone') {
    const tz = validZone(body.timezone)
    if (!tz) return NextResponse.json({ error: 'Unknown time zone' }, { status: 400 })
    await setTimezone(db, user.tenantId, tz); return NextResponse.json({ ok: true })
  }
  if (body?.action === 'window') {
    const o = parseHm(body.open), c = parseHm(body.close)
    if (o === null || c === null || !(await setWindow(db, user.tenantId, o, c))) return NextResponse.json({ error: 'The end must be after the start' }, { status: 400 })
    return NextResponse.json({ ok: true })
  }
  if (body?.action === 'tonight') {
    const c = parseHm(body.close)
    const until = c === null ? null : await extendToday(db, user.tenantId, c)
    if (until === null) return NextResponse.json({ error: 'Connect LinkedIn first' }, { status: 400 })
    return NextResponse.json({ ok: true, until })
  }
  return NextResponse.json({ error: 'Bad request' }, { status: 400 })
}
