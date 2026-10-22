import { NextRequest, NextResponse } from 'next/server'
import { getScanDb, requireUser } from '@/lib/scan/service'
import { sameOriginJson } from '@/lib/same-origin'
import { commenterBatchStatus, deleteCommenterBatch } from '@/lib/scan/commenter-import'

export async function GET(_req: NextRequest, ctx: { params: Promise<{ batch: string }> }) {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  const { batch } = await ctx.params
  const status = commenterBatchStatus(getScanDb(), user.id, batch)
  if (!status) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  return NextResponse.json(status)
}

// Removes the batch and everything it made: lead_enrichments first (explicit), then
// leads, rows, the owning job and the batch itself.
export async function DELETE(req: NextRequest, ctx: { params: Promise<{ batch: string }> }) {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  if (!sameOriginJson(req)) return NextResponse.json({ error: 'Bad request' }, { status: 400 })
  const { batch } = await ctx.params
  if (!deleteCommenterBatch(getScanDb(), user.id, batch)) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  return NextResponse.json({ ok: true })
}
