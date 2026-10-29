import { NextRequest, NextResponse } from 'next/server'
import { requireUser } from '@/lib/scan/service'
import { sameOriginJson } from '@/lib/same-origin'
import { rateLimit } from '@/lib/rate-limit'
import { readHasKey } from '@/lib/llm/key-store'
import { getDb } from '@/lib/db/client'
import { connectorStatus } from '@/lib/connectors/store'
import { estimateForBody } from '@/lib/scan/estimate-request'

// Price estimate for a scan request, before anything paid runs. Read-only: it queues nothing, counts nothing against the
// quota or the trial, reserves nothing and calls no provider. POST body = the body POST /api/scan would take.
export async function POST(req: NextRequest) {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  const rl = await rateLimit(`scan-estimate:${user.id}`, 60, 60 * 60 * 1000)
  if (!rl.ok) return NextResponse.json({ error: 'Too many requests. Try again later.' }, { status: 429, headers: { 'Retry-After': String(rl.retryAfterS) } })
  if (!sameOriginJson(req)) return NextResponse.json({ error: 'Bad request' }, { status: 400 })
  const body = await req.json().catch(() => null)
  const db = await getDb()   // the Db layer, not the raw SQLite handle
  const vendors = (await connectorStatus(db, user.id).catch(() => [])).filter(c => c.enabled).map(c => c.connector)
  const r = estimateForBody(body, { userId: user.id, hasOwnKey: await readHasKey(db, user.id), enrichmentVendors: vendors })
  if (!r.ok) return NextResponse.json({ error: r.error, ...(r.detail ? { detail: r.detail } : {}) }, { status: r.status })
  return NextResponse.json({ estimate: r.estimate })
}
