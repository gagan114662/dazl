import { NextRequest, NextResponse } from 'next/server'
import { requireUser } from '@/lib/scan/service'
import { getDb } from '@/lib/db/client'
import { pipelineReport } from '@/lib/pipeline/deals'

// Pipeline and revenue report of this workspace (#366), rebuilt from the deal history as of ?as_of=<unix seconds>
// (default now), with its definitions and attribution assumptions in the body.
export async function GET(req: NextRequest) {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  const raw = new URL(req.url).searchParams.get('as_of')
  const asOf = raw === null ? undefined : /^\d{1,12}$/.test(raw) ? Number(raw) : NaN
  if (Number.isNaN(asOf)) return NextResponse.json({ error: 'Bad request' }, { status: 400 })
  return NextResponse.json(await pipelineReport(await getDb(), user.tenantId, { asOf }), { headers: { 'cache-control': 'no-store' } })
}
