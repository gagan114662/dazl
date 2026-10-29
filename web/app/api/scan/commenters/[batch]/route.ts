import { NextRequest, NextResponse } from 'next/server'
import { getScanDb, requireUser } from '@/lib/scan/service'
import { sameOriginJson } from '@/lib/same-origin'
import { commenterBatchStatus, deleteCommenterBatch } from '@/lib/scan/commenter-import'
import { audited, denied } from '@/lib/workspace-access'

export async function GET(_req: NextRequest, ctx: { params: Promise<{ batch: string }> }) {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  const { batch } = await ctx.params
  const status = commenterBatchStatus(getScanDb(), user.tenantId, batch)
  if (!status) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  return NextResponse.json(status)
}

// Removes the batch and everything it made: lead_enrichments first (explicit), then
// leads, rows, the owning job and the batch itself.
export async function DELETE(req: NextRequest, ctx: { params: Promise<{ batch: string }> }) {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  const no = await denied(user, 'operate'); if (no) return no
  if (!sameOriginJson(req)) return NextResponse.json({ error: 'Bad request' }, { status: 400 })
  const { batch } = await ctx.params
  const done = audited(user, 'import.deleted', 'commenter_batch', batch)
  if (!deleteCommenterBatch(getScanDb(), user.tenantId, batch)) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  return done({ ok: true })
}
