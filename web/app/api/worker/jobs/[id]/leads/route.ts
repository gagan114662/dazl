import { NextRequest, NextResponse } from 'next/server'
import { checkWorker } from '@/lib/worker-auth'
import { getScanDb } from '@/lib/scan/service'
import { addWorkerLeads, type WorkerLead } from '@/lib/scan/store'
import { parseLeads } from '@/lib/scan/validate-leads'

// POST {leads:[...]}: add up to 50 leads to a running job. All-or-nothing.
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const denied = checkWorker(req)
  if (denied) return denied
  const { id } = await ctx.params
  if (!/^[a-f0-9]{24}$/.test(id)) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const body = await req.json().catch(() => null)
  const parsed = parseLeads(body?.leads)
  if (typeof parsed === 'string') return NextResponse.json({ error: parsed }, { status: 400 })
  try {
    const added = addWorkerLeads(getScanDb(), id, parsed as WorkerLead[])
    return NextResponse.json({ added })
  } catch (e) {
    const msg = e instanceof Error ? e.message : ''
    if (/running/.test(msg) || /FOREIGN KEY/.test(msg)) return NextResponse.json({ error: 'Job is not running' }, { status: 409 })
    return NextResponse.json({ error: 'Could not add leads' }, { status: 400 })
  }
}
