import { NextRequest, NextResponse } from 'next/server'
import { rateLimit } from '@/lib/rate-limit'
import { getScanDb } from '@/lib/scan/service'
import { getDb } from '@/lib/db/client'
import { authenticateKey } from '@/lib/api/keys'
import { readDiscovery } from '@/lib/discovery/api'

// External API (#392): poll a discovery and read its gated, evidence-backed leads with a discovery:read key.
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const shared = await getDb()
  const auth = await authenticateKey(shared, req.headers.get('authorization'), 'discovery:read')
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status })
  const rl = await rateLimit(`api-read:${auth.keyId}`, 120, 60 * 1000, shared)
  if (!rl.ok) return NextResponse.json({ error: rl.unavailable ? 'limits_unavailable' : 'rate_limited' }, { status: rl.unavailable ? 503 : 429, headers: { 'Retry-After': String(rl.retryAfterS) } })
  const r = readDiscovery(getScanDb(), auth.tenantId, (await params).id)
  return NextResponse.json(r.body, { status: r.status })
}
