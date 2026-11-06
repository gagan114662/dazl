import { NextRequest, NextResponse } from 'next/server'
import { getDb } from '@/lib/db/client'
import { clientIp, rateLimit } from '@/lib/rate-limit'
import { apiEnabled, authenticate, bearerSecret } from '@/lib/api-tokens'
import { handleRpc } from '@/lib/mcp/discovery'
import type { RpcRequest } from '@/lib/mcp/discovery'
import { captureError } from '@/lib/ops/errors'
import { requestIdOf } from '@/lib/ops/request-log'

// The scoped discovery API (#392): MCP over Streamable HTTP, JSON responses only, stateless (no session id, no GET
// stream). Authenticated by a workspace API token (Authorization: Bearer <secret>, lib/api-tokens.ts), never a cookie.
// OFF unless DAZL_API_TOKENS=1: until the owner turns it on this answers 404 like any unknown path.
// Nothing here logs the Authorization header, the token or a request body (the request log has method and path only;
// an unexpected error is recorded through captureError, which never reads headers or bodies and scrubs token shapes).
const MAX_BODY = 64 * 1024
const unauthorized = () => NextResponse.json({ error: 'invalid_token' }, { status: 401, headers: { 'WWW-Authenticate': 'Bearer realm="dazl", error="invalid_token"', 'Cache-Control': 'no-store' } })
const limited = (r: { unavailable?: true; retryAfterS: number }) => r.unavailable
  ? NextResponse.json({ error: 'limits_unavailable' }, { status: 503, headers: { 'Retry-After': String(r.retryAfterS) } })
  : NextResponse.json({ error: 'rate_limited' }, { status: 429, headers: { 'Retry-After': String(r.retryAfterS) } })
const rpcError = (status: number, code: number, message: string) => NextResponse.json({ jsonrpc: '2.0', id: null, error: { code, message } }, { status, headers: { 'Cache-Control': 'no-store' } })

// The body as UTF-8 text, read at most MAX_BODY bytes: a larger one is refused without buffering it whole (a stated
// Content-Length over the cap is refused before reading). 'too_large' | 'not_utf8' | the text.
async function readBody(req: Request): Promise<string | 'too_large' | 'not_utf8'> {
  const stated = Number(req.headers.get('content-length') ?? '0')
  if (Number.isFinite(stated) && stated > MAX_BODY) return 'too_large'
  if (!req.body) return ''
  const reader = req.body.getReader()
  const parts: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > MAX_BODY) { await reader.cancel().catch(() => { /* the refusal stands */ }); return 'too_large' }
    parts.push(value)
  }
  const buf = new Uint8Array(size)
  let at = 0
  for (const p of parts) { buf.set(p, at); at += p.byteLength }
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf) } catch { return 'not_utf8' }
}

export async function POST(req: NextRequest) {
  if (!apiEnabled()) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  // DNS-rebinding guard the MCP transport asks for: a browser-sent Origin must be this host; server-side clients send none
  const origin = req.headers.get('origin')
  if (origin) { let host = ''; try { host = new URL(origin).host } catch { /* refused below */ } if (host !== req.headers.get('host')) return NextResponse.json({ error: 'forbidden_origin' }, { status: 403 }) }
  try {
    // before the token lookup: bounds what an unauthenticated caller can make the store do
    const ip = await rateLimit(`mcp-ip:${clientIp(req)}`, 120, 60 * 1000)
    if (!ip.ok) return limited(ip)
    const secret = bearerSecret(req.headers.get('authorization'))
    if (!secret) return unauthorized()
    const p = await authenticate(await getDb(), secret)
    if (!p) return unauthorized()
    const rl = await rateLimit(`mcp:${p.tenantId}:${p.tokenId}`, 60, 60 * 1000)
    if (!rl.ok) return limited(rl)
    if (!(req.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')) return NextResponse.json({ error: 'unsupported_media_type' }, { status: 415 })
    const text = await readBody(req)
    if (text === 'too_large') return rpcError(413, -32600, 'Request too large')
    if (text === 'not_utf8') return rpcError(400, -32700, 'Parse error')
    let msg: unknown
    try { msg = JSON.parse(text) } catch { return rpcError(400, -32700, 'Parse error') }
    if (Array.isArray(msg)) return rpcError(400, -32600, 'Batches are not supported')
    const out = await handleRpc(p, msg as RpcRequest, req)
    if (!out) return new NextResponse(null, { status: 202 })
    return NextResponse.json(out, { headers: { 'Cache-Control': 'no-store' } })
  } catch (e) {
    // fails closed: nothing is retried here; a start_scan that threw keeps its idempotency claim (lib/mcp/discovery.ts)
    captureError(e, { source: 'route', where: '/api/mcp', method: 'POST', requestId: requestIdOf(req) })
    return rpcError(500, -32603, 'Internal error')
  }
}
