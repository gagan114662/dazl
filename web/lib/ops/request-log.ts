// Request ids and JSON request logs (docs/PLATFORM.md step 6). proxy.ts gives every /app and /api request a fresh
// random UUID (an incoming x-request-id is replaced, never trusted: a caller could put anything in it), forwards it to
// the route as the x-request-id request header, returns it as a response header, and writes one JSON line per request
// to stdout.
// The id also lands on error records (lib/ops/request-error.ts), so a log line and an error can be joined.
// A log line carries: time, request id, method and the path without its query, with ids in the path replaced by [id]
// and emails, tokens and numbers scrubbed (lib/ops/errors.ts scrub). Never headers, cookies, bodies, IPs or the query.
import { randomUUID } from 'node:crypto'
import { scrub } from './errors.ts'

// A random UUIDv4 and nothing else: the shape is what makes it safe to log next to a tenant id.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
export const isRequestId = (v: unknown): v is string => typeof v === 'string' && UUID.test(v)
export const newRequestId = (): string => randomUUID()

export interface RequestLogLine { level: 'info'; type: 'request'; ts: string; request_id: string; method: string; path: string }

const METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'])
export function requestLogLine(requestId: string, method: string, pathname: string, now = new Date()): RequestLogLine {
  // ids in the path (lead, job, batch ids: 16+ opaque characters, or any run of 6+ digits) become [id] first, so the
  // route shape stays readable; then the scrub catches emails and the rest
  const segs = pathname.split(/[?#]/)[0].split('/').map(seg => /^[A-Za-z0-9_-]{16,}$/.test(seg) || /\d{6}/.test(seg) ? '[id]' : seg)
  const path = scrub(segs.join('/')).slice(0, 200)
  return { level: 'info', type: 'request', ts: now.toISOString(), request_id: requestId, method: METHODS.has(method) ? method : 'OTHER', path }
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

// The id proxy.ts gave this request, for a route's own error records; undefined when absent or not that shape.
export function requestIdOf(req: { headers: { get(name: string): string | null } }): string | undefined {
  const v = req.headers.get('x-request-id')
  return isRequestId(v) ? v : undefined
}
