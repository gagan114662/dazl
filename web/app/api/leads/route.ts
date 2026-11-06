import { NextRequest, NextResponse } from 'next/server'
import { requireUser } from '@/lib/scan/service'
import { leadsPayload } from '@/lib/scan/leads-payload'

// The payload is built in lib/scan/leads-payload.ts, shared with the scoped API (#392).
export async function GET(req: NextRequest) {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  const payload = await leadsPayload(user.tenantId, req.nextUrl.searchParams.get('job_id') ?? '', req.nextUrl.searchParams.get('all') === '1')
  if (!payload) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  return NextResponse.json(payload)
}
