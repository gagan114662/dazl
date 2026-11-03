import { NextRequest, NextResponse } from 'next/server'
import { getDb } from '@/lib/db/client'
import { rateLimit } from '@/lib/rate-limit'
import { ingest, MAX_BODY, readConfig, verifyRequest } from '@/lib/signals/first-party'

// #390 first-party signal receiver: the tenant's own server posts its consented form submissions, demo requests and
// company-level visit/product events here. No session: the tenant id in the URL (?u=) picks the config, and
// X-Dazl-Signature = HMAC-SHA256(secret, `${X-Dazl-Timestamp}.${body}`) with a timestamp inside the replay window
// authenticates it. The secret belongs on the tenant's server, never in a browser page. Collection off (the tenant's
// opt-out) stores nothing.
export async function POST(req: NextRequest) {
  const tenantId = req.nextUrl.searchParams.get('u') ?? ''
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(tenantId)) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  if (!(await rateLimit(`first-party:${tenantId}`, 120, 60_000)).ok) return NextResponse.json({ error: 'Too many requests' }, { status: 429 })
  const db = await getDb()
  const c = await readConfig(db, tenantId)
  if (!c) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const raw = await req.text()
  if (raw.length > MAX_BODY) return NextResponse.json({ error: 'Too large' }, { status: 413 })
  const sig = req.headers.get('x-dazl-signature')
  const check = verifyRequest(c.config.secret, req.headers.get('x-dazl-timestamp'), sig, raw)
  if (check !== 'ok') return NextResponse.json({ error: check === 'stale' ? 'Stale timestamp' : 'Bad signature' }, { status: 401 })
  if (!c.enabled) return NextResponse.json({ error: 'Collection is off for this workspace' }, { status: 403 })
  const r = await ingest(db, tenantId, raw, sig ?? '')
  if (r.status === 'off') return NextResponse.json({ error: 'Collection is off for this workspace' }, { status: 403 })
  if (r.status === 'not_configured') return NextResponse.json({ error: 'Not found' }, { status: 404 })
  if (r.status === 'bad_body') return NextResponse.json({ error: 'Send {"events":[...]} with 1-50 events' }, { status: 400 })
  return NextResponse.json({ ok: true, results: r.results, counts: r.counts })
}
