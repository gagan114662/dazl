import { NextRequest, NextResponse } from 'next/server'
import { getScanDb, requireUser } from '@/lib/scan/service'
import { commenterBatchStatus } from '@/lib/scan/commenter-import'

export async function GET(_req: NextRequest, ctx: { params: Promise<{ batch: string }> }) {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  const { batch } = await ctx.params
  const status = commenterBatchStatus(getScanDb(), user.id, batch)
  if (!status) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  return NextResponse.json(status)
}
