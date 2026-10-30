import { after, NextRequest, NextResponse } from 'next/server'
import { clientIp } from '@/lib/rate-limit'
import { getScanDb } from '@/lib/scan/service'
import { getDb } from '@/lib/db/client'
import { kickRunner } from '@/lib/scan/runner'
import { authenticateKey } from '@/lib/api/keys'
import { startDiscovery } from '@/lib/discovery/api'
import { getAuthDb, sellerProfile } from '@/lib/auth-db'

// External API (#392): start a discovery with a scoped API key (discovery:start). No session cookie is read; the
// workspace comes from the key. Same admission as the app's scan route, plus a required Idempotency-Key.
export async function POST(req: NextRequest) {
  const shared = await getDb()
  const auth = await authenticateKey(shared, req.headers.get('authorization'), 'discovery:start')
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status })
  const body = await req.json().catch(() => null)
  const db = getScanDb()
  const r = await startDiscovery(db, shared, auth, clientIp(req), req.headers.get('idempotency-key'), body, sellerProfile(getAuthDb(), auth.tenantId))
  if (r.jobId) after(() => kickRunner(db))
  return NextResponse.json(r.body, { status: r.status, headers: r.headers })
}
