// Request ids and JSON request logs (docs/PLATFORM.md step 6). proxy.ts gives every /app and /api request a fresh
// random UUID (an incoming x-request-id is replaced, never trusted: a caller could put anything in it), forwards it to
// the route as the x-request-id request header, returns it as a response header, and writes one JSON line per request
// to stdout.
// The id also lands on error records (lib/ops/request-error.ts), so a log line and an error can be joined.
// A log line carries: time, request id, method and the ROUTE TEMPLATE the path matches (lib/ops/routes.ts), e.g.
// /api/leads/[lead]/confirm. No caller-supplied path text is ever logged, decoded or not: a path that matches no
// known route logs as /api/[unknown] or /app/[unknown]. Never headers, cookies, bodies, IPs or the query.
import { randomUUID } from 'node:crypto'
import { ROUTE_TEMPLATES } from './routes.ts'

// A random UUIDv4 and nothing else: the shape is what makes it safe to log next to a tenant id.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
export const isRequestId = (v: unknown): v is string => typeof v === 'string' && UUID.test(v)
export const newRequestId = (): string => randomUUID()

export interface RequestLogLine { level: 'info'; type: 'request'; ts: string; request_id: string; method: string; path: string }

const METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'])
const TEMPLATES = ROUTE_TEMPLATES.map(t => ({ t, segs: t.split('/').filter(Boolean) }))
  .map(x => ({ ...x, statics: x.segs.filter(g => !g.startsWith('[')).length }))
  .sort((a, b) => b.statics - a.statics) // a static segment wins over a dynamic one (/api/outreach/autopilot over /api/outreach/[id])

// The template a path matches, compared segment by segment on the raw (still encoded) path: static segments must be
// equal, a [dynamic] segment takes any one segment. Its value is never returned.
export function routeTemplate(pathname: string): string {
  const segs = pathname.split(/[?#]/)[0].split('/').filter(Boolean)
  for (const { t, segs: ts } of TEMPLATES) {
    if (ts.length === segs.length && ts.every((g, i) => g.startsWith('[') || g === segs[i])) return t
  }
  return segs[0] === 'api' ? '/api/[unknown]' : segs[0] === 'app' ? '/app/[unknown]' : '/[unknown]'
}

export function requestLogLine(requestId: string, method: string, pathname: string, now = new Date()): RequestLogLine {
  return { level: 'info', type: 'request', ts: now.toISOString(), request_id: requestId, method: METHODS.has(method) ? method : 'OTHER', path: routeTemplate(pathname) }
}

let write = (line: string) => { process.stdout.write(line + '\n') }
// Tests capture the lines; returns a restore function.
export function setRequestLogWriter(w: (line: string) => void): () => void {
  const prev = write
  write = w
  return () => { write = prev }
}
export function logRequest(l: RequestLogLine): void {
  try { write(JSON.stringify(l)) } catch { /* logging never breaks a request */ }
}
