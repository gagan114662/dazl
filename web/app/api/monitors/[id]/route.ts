import { NextRequest, NextResponse } from 'next/server'
import { requireUser } from '@/lib/scan/service'
import { getDb } from '@/lib/db/client'
import { sameOriginJson } from '@/lib/same-origin'
import { deleteMonitor, setMonitorEnabled } from '@/lib/monitors'
import { audit } from '@/lib/audit-route'
import { denied } from '@/lib/workspace-access'

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  const no = denied(user, 'operate'); if (no) return no
  if (!sameOriginJson(req)) return NextResponse.json({ error: 'Bad request' }, { status: 400 })
  const { id } = await params
  if (!/^[a-f0-9]{24}$/.test(id)) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const body = await req.json().catch(() => null)
  if (typeof body?.enabled !== 'boolean') return NextResponse.json({ error: 'Bad request' }, { status: 400 })
  const db = await getDb()
  const was = (await db.get<{ enabled: number }>('SELECT enabled FROM monitors WHERE id = ? AND user_id = ?', [id, user.tenantId]))?.enabled === 1
  if (!(await setMonitorEnabled(db, user.tenantId, id, body.enabled))) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  // a toggle to the state the monitor is already in changes nothing, so it records nothing
  if (was !== body.enabled) await audit(user, req, { action: body.enabled ? 'monitor.enabled' : 'monitor.disabled', resource: 'monitor', id })
  return NextResponse.json({ ok: true })
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  const no = denied(user, 'operate'); if (no) return no
  if (!sameOriginJson(req)) return NextResponse.json({ error: 'Bad request' }, { status: 400 })
  const { id } = await params
  if (!/^[a-f0-9]{24}$/.test(id)) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  if (!(await deleteMonitor(await getDb(), user.tenantId, id))) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  await audit(user, req, { action: 'data.deleted', resource: 'monitor', id })
  return NextResponse.json({ ok: true })
}
