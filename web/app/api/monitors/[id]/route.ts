import { NextRequest, NextResponse } from 'next/server'
import { getScanDb, requireUser } from '@/lib/scan/service'
import { sameOriginJson } from '@/lib/same-origin'
import { deleteMonitor, setMonitorEnabled } from '@/lib/monitors'

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  if (!sameOriginJson(req)) return NextResponse.json({ error: 'Bad request' }, { status: 400 })
  const { id } = await params
  if (!/^[a-f0-9]{24}$/.test(id)) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const body = await req.json().catch(() => null)
  if (typeof body?.enabled !== 'boolean') return NextResponse.json({ error: 'Bad request' }, { status: 400 })
  if (!setMonitorEnabled(getScanDb(), user.id, id, body.enabled)) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  return NextResponse.json({ ok: true })
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  if (!sameOriginJson(req)) return NextResponse.json({ error: 'Bad request' }, { status: 400 })
  const { id } = await params
  if (!/^[a-f0-9]{24}$/.test(id)) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  if (!deleteMonitor(getScanDb(), user.id, id)) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  return NextResponse.json({ ok: true })
}
