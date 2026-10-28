import { NextRequest, NextResponse } from 'next/server'
import { getSessionUser } from '@/lib/auth-db'
import { clientIp, rateLimit } from '@/lib/rate-limit'
import { MAX_CLIENT_ERROR_BYTES, recordClientError } from '@/lib/ops/client-errors'

// Browser error reports (lib/client-error-report.ts) into the same scrubbed error records and alert hooks as server
// errors (lib/ops/client-errors.ts). Open to signed-out pages too, so it is bounded instead of authenticated: same-origin
// only, 30 reports per IP per 10 minutes (the alert hooks are throttled on top), and at most MAX_CLIENT_ERROR_BYTES:
// a larger Content-Length is refused before the body is read, and reading stops as soon as the limit is passed. The
// tenant comes from the session cookie, never from the body. Always answers without a body; a refused report is just
// not recorded.
export async function POST(req: NextRequest) {
  if (!sameOrigin(req.headers.get('origin'), req.headers.get('host'))) return new NextResponse(null, { status: 403 })
  if (!(await rateLimit(`client-errors:${clientIp(req)}`, 30, 10 * 60 * 1000)).ok) return new NextResponse(null, { status: 429 })
  if (Number(req.headers.get('content-length') ?? 0) > MAX_CLIENT_ERROR_BYTES) return new NextResponse(null, { status: 413 })
  const text = await readCapped(req, MAX_CLIENT_ERROR_BYTES)
  if (text === null) return new NextResponse(null, { status: 413 })
  let body: unknown
  try { body = JSON.parse(text) } catch { return new NextResponse(null, { status: 400 }) }
  let tenantId: string | null = null
  try { tenantId = (await getSessionUser(req.cookies.get('dazl_session')?.value))?.id ?? null } catch { /* recorded without a tenant */ }
  const r = recordClientError(body, { tenantId, requestId: req.headers.get('x-request-id') })
  return new NextResponse(null, { status: r === 'invalid' ? 400 : 204 })
}

function sameOrigin(origin: string | null, host: string | null): boolean {
  try { return !!origin && !!host && new URL(origin).host === host } catch { return false }
}

// The body as text, or null once it passes `max` bytes (the rest is never read).
async function readCapped(req: NextRequest, max: number): Promise<string | null> {
  if (!req.body) return ''
  const reader = req.body.getReader()
  const chunks: Uint8Array[] = []
  let n = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    n += value.byteLength
    if (n > max) { await reader.cancel().catch(() => {}); return null }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString('utf8')
}
