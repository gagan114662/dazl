import { NextRequest, NextResponse } from 'next/server'
import { requireUser } from '@/lib/scan/service'
import { getDb } from '@/lib/db/client'
import { sameOriginJson } from '@/lib/same-origin'
import { readMemory, MemoryError, writeMemory } from '@/lib/memory'

export async function GET() {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  return NextResponse.json({ memory: await readMemory(await getDb(), user.id) })
}

export async function PUT(req: NextRequest) {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  if (!sameOriginJson(req)) return NextResponse.json({ error: 'Bad request' }, { status: 400 })
  const body = await req.json().catch(() => null)
  if (!body || typeof body !== 'object') return NextResponse.json({ error: 'Bad request' }, { status: 400 })
  try {
    return NextResponse.json({ memory: await writeMemory(await getDb(), user.id, body) })
  } catch (e) {
    if (e instanceof MemoryError) return NextResponse.json({ error: e.message, field: e.field }, { status: 400 })
    throw e
  }
}
