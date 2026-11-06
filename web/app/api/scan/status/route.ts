import { NextRequest, NextResponse } from 'next/server'
import { requireUser } from '@/lib/scan/service'
import { scanStatusPayload } from '@/lib/scan/status-payload'

// The payload is built in lib/scan/status-payload.ts, shared with the scoped API (#392).
export async function GET(req: NextRequest) {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  // ?passive=1 is the explicit no-kick QA mode (lib/scan/status-payload.ts)
  const payload = await scanStatusPayload(user.tenantId, req.nextUrl.searchParams.get('job_id') ?? '', { kick: req.nextUrl.searchParams.get('passive') !== '1' })
  if (!payload) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  return NextResponse.json(payload)
}
