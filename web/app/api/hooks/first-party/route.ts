import { NextRequest, NextResponse } from 'next/server'
import { getDb } from '@/lib/db/client'
import { rateLimit } from '@/lib/rate-limit'
import { firstPartyAvailable, ingest, MAX_BODY, readConfig, verifyRequest } from '@/lib/signals/first-party'

// #390 first-party signal receiver: the tenant's own server posts its consented form submissions, demo requests and
// company-level visit/product events here. No session: the tenant id in the URL (?u=) picks the config, and
// X-Dazl-Signature = HMAC-SHA256(secret, `${X-Dazl-Timestamp}.${body}`) with a timestamp inside the replay window
// authenticates it. The secret belongs on the tenant's server, never in a browser page. Collection off (the tenant's
// opt-out) stores nothing.
// Read at most max+1 bytes of the request body; null when it is larger. The bound holds BEFORE the body is
// materialized in memory - a declared or streamed oversize body is rejected without an unbounded read.
async function readBodyBounded(req: NextRequest, max: number): Promise<string | null> {
  const declared = Number(req.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > max) return null
  if (!req.body) return ''
  const reader = req.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > max) return null
      chunks.push(value)
    }
  } finally {
    if (total > max) await reader.cancel().catch(() => undefined)
  }
  const buf = new Uint8Array(total)
  let off = 0
  for (const c of chunks) { buf.set(c, off); off += c.byteLength }
  return new TextDecoder().decode(buf)
}

export async function POST(req: NextRequest) {
  // Deployment gate (#390): first-party collection is unavailable unless this process is explicitly started with
  // DAZL_FIRST_PARTY_ENABLED=1. OFF answers exactly like the unknown-tenant/no-config case, checked FIRST - before
  // the tenant check, rate limit, body read, DB read or signature work - so nothing about the feature or its state
  // is observable and nothing is read or written. Read per request, never cached.
  if (!firstPartyAvailable()) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const tenantId = req.nextUrl.searchParams.get('u') ?? ''
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(tenantId)) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  if (!(await rateLimit(`first-party:${tenantId}`, 120, 60_000)).ok) return NextResponse.json({ error: 'Too many requests' }, { status: 429 })
  const raw = await readBodyBounded(req, MAX_BODY)
  if (raw === null) return NextResponse.json({ error: 'Too large' }, { status: 413 })
  const db = await getDb()
  const c = await readConfig(db, tenantId)
  // Unknown tenant, no recorded config, and every authentication failure all answer the same 404: the endpoint does
  // not reveal which tenant ids have a first-party config to anyone without a valid signature.
  if (!c) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const sig = req.headers.get('x-dazl-signature')
  const check = verifyRequest(c.config.secret, req.headers.get('x-dazl-timestamp'), sig, raw)
  if (check !== 'ok') return NextResponse.json({ error: 'Not found' }, { status: 404 })
  if (!c.enabled) return NextResponse.json({ error: 'Collection is off for this workspace' }, { status: 403 })
  // #921: ingest re-verifies these exact headers and bytes against the config it locks, so a re-record/erase that lands
  // between the check above and ingest's config lock cannot carry this request into the replacement config.
  const r = await ingest(db, tenantId, raw, { timestamp: req.headers.get('x-dazl-timestamp'), signature: sig })
  if (r.status === 'unauthenticated') return NextResponse.json({ error: 'Not found' }, { status: 404 })
  if (r.status === 'off') return NextResponse.json({ error: 'Collection is off for this workspace' }, { status: 403 })
  if (r.status === 'not_configured') return NextResponse.json({ error: 'Not found' }, { status: 404 })
  if (r.status === 'bad_body') return NextResponse.json({ error: 'Send {"events":[...]} with 1-50 events' }, { status: 400 })
  return NextResponse.json({ ok: true, results: r.results, counts: r.counts })
}
