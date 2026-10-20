import { NextRequest, NextResponse } from 'next/server'
import { checkWorker } from '@/lib/worker-auth'
import { getScanDb } from '@/lib/scan/service'
import { completeJob } from '@/lib/scan/store'

// POST {status:'done'|'failed', error?}: finish a running job.
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const denied = checkWorker(req)
  if (denied) return denied
  const { id } = await ctx.params
  if (!/^[a-f0-9]{24}$/.test(id)) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const body = await req.json().catch(() => null)
  if (body?.status !== 'done' && body?.status !== 'failed') return NextResponse.json({ error: 'status must be done or failed' }, { status: 400 })
  const ok = completeJob(getScanDb(), id, body.status, typeof body.error === 'string' ? body.error : undefined)
  return ok ? NextResponse.json({ ok: true }) : NextResponse.json({ error: 'Job is not running' }, { status: 409 })
}
