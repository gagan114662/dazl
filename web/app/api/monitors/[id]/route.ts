import { NextRequest, NextResponse } from 'next/server'
import { requireUser } from '@/lib/scan/service'
import { getDb } from '@/lib/db/client'
import { sameOriginJson } from '@/lib/same-origin'
import { deleteMonitor, setMonitorEnabled } from '@/lib/monitors'
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
  if (!(await setMonitorEnabled(await getDb(), user.tenantId, id, body.enabled))) return NextResponse.json({ error: 'Not found' }, { status: 404 })
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
  return NextResponse.json({ ok: true })
}
