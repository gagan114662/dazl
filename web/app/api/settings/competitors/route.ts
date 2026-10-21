import { NextRequest, NextResponse } from 'next/server'
import { getScanDb, requireUser } from '@/lib/scan/service'
import { listCompetitors, setCompetitors } from '@/lib/signals/competitor-reddit'

// The competitor list drives the Reddit complaint search. Names only - no credentials.
export async function GET() {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  return NextResponse.json({ competitors: listCompetitors(getScanDb(), user.id) })
}

export async function PUT(req: NextRequest) {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  const body = await req.json().catch(() => null) as { competitors?: unknown } | null
  if (!Array.isArray(body?.competitors)) return NextResponse.json({ error: 'competitors must be an array of names' }, { status: 400 })
  const r = setCompetitors(getScanDb(), user.id, body!.competitors as string[])
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: 400 })
  return NextResponse.json({ competitors: r.names })
}
