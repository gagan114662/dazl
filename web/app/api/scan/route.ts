import { after, NextRequest, NextResponse } from 'next/server'
import { clientIp } from '@/lib/rate-limit'
import { getScanDb, requireUser } from '@/lib/scan/service'
import { sameOriginJson } from '@/lib/same-origin'
import { getDb } from '@/lib/db/client'
import { kickRunner } from '@/lib/scan/runner'
import { denied } from '@/lib/workspace-access'
import { admitScan, rateLimited, scanRateLimit } from '@/lib/discovery/admit'
import { getAuthDb, sellerProfile } from '@/lib/auth-db'

export async function POST(req: NextRequest) {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  const no = denied(user, 'operate'); if (no) return no

  const limited = rateLimited(await scanRateLimit(user.tenantId))
  if (limited) return NextResponse.json(limited.body, { status: limited.status, headers: limited.headers })

  if (!sameOriginJson(req)) return NextResponse.json({ error: 'Bad request' }, { status: 400 })
  const body = await req.json().catch(() => null)
  // every admission check lives in lib/discovery/admit.ts, shared with the external API (app/api/v1/discovery)
  const db = getScanDb()
  const r = await admitScan(db, await getDb(), { tenantId: user.tenantId, actorId: user.actorId, email: user.email, ip: clientIp(req), seller: sellerProfile(getAuthDb(), user.tenantId), trialAllowed: true }, body)
  if (r.jobId) after(() => kickRunner(db))
  return NextResponse.json(r.body, { status: r.status, headers: r.headers })
}
