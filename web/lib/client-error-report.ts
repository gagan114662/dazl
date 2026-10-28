// Browser side of error monitoring: uncaught errors, unhandled promise rejections and errors caught by the error
// boundaries (app/error.tsx, app/app/error.tsx, app/global-error.tsx) are posted to /api/client-errors, which records
// them through the same error records and alert hooks as server errors (lib/ops/client-errors.ts).
// The report is an ALLOWLIST, never the error's text: no message, no stack text, nothing a scrubber would have to catch.
//   kind   - boundary | error | unhandledrejection
//   type   - the error's class if it is a built-in one (TypeError, ...), else 'Error'
//   path   - location.pathname (the server keeps only its route template)
//   frames - up to 8 stack frames as { file, line, col }, and only for this app's own bundles (/_next/static/...,
//            without query); any other frame is left out
// The body is at most MAX_BODY bytes (frames are dropped until it fits). At most MAX_PER_PAGE reports per page load
// and each distinct error once, so a render loop cannot flood the endpoint; a failed send is dropped silently. A missing
// JavaScript chunk is not reported: after a deploy it is expected and lib/chunk-recovery.ts handles it.
import { isChunkLoadError } from './chunk-recovery.ts'
export type ClientErrorKind = 'boundary' | 'error' | 'unhandledrejection'
export interface ClientFrame { file: string; line: number; col: number }
const MAX_PER_PAGE = 5
export const MAX_BODY = 2048
export const CLIENT_ERROR_TYPES = new Set(['Error', 'TypeError', 'RangeError', 'ReferenceError', 'SyntaxError', 'URIError', 'EvalError', 'AggregateError', 'AbortError', 'TimeoutError', 'DOMException', 'NotFoundError', 'SecurityError', 'InvalidStateError', 'NetworkError', 'QuotaExceededError'])

interface Win { location: { pathname: string }; fetch: typeof fetch; addEventListener: (t: string, f: (e: never) => void) => void }
const state = { sent: 0, seen: new Set<string>() }

// file:line:col of each stack line (Chrome "at f (url:1:2)", Firefox/Safari "f@url:1:2"); the function name and any
// other text on the line are never kept
export function clientFrames(stack: unknown): ClientFrame[] {
  if (typeof stack !== 'string') return []
  const out: ClientFrame[] = []
  for (const line of stack.slice(0, 8000).split('\n')) {
    const m = /(https?:\/\/[^\s()@]+?):(\d{1,7}):(\d{1,7})\)?\s*$/.exec(line)
    if (!m) continue
    let p: string
    try { p = new URL(m[1]).pathname } catch { continue }
    if (/^\/_next\/static\/[A-Za-z0-9_./~-]{1,200}$/.test(p)) out.push({ file: p, line: Number(m[2]), col: Number(m[3]) })
    if (out.length === 8) break
  }
  return out
}

export function clientReport(kind: ClientErrorKind, err: unknown, path: string): string {
  const name = err instanceof Error ? err.name : ''
  const report = { kind, type: CLIENT_ERROR_TYPES.has(name) ? name : 'Error', path: String(path).slice(0, 200), frames: clientFrames(err instanceof Error ? err.stack : undefined) }
  let body = JSON.stringify(report)
  while (body.length > MAX_BODY && report.frames.length) { report.frames.pop(); body = JSON.stringify(report) }
  return body.length > MAX_BODY ? JSON.stringify({ kind, type: report.type, path: '/', frames: [] }) : body
}

export function reportClientError(kind: ClientErrorKind, err: unknown, w: Win = globalThis as unknown as Win): boolean {
  try {
    if (isChunkLoadError(err)) return false
    const body = clientReport(kind, err, w.location.pathname)
    if (state.sent >= MAX_PER_PAGE || state.seen.has(body)) return false // the same report again is not resent
    state.seen.add(body); state.sent++
    void w.fetch('/api/client-errors', { method: 'POST', body, keepalive: true, headers: { 'content-type': 'application/json' } }).catch(() => {})
    return true
  } catch { return false }
}

let installed = false
export function installClientErrorReporting(w: Win = globalThis as unknown as Win): void {
  if (installed) return
  installed = true
  w.addEventListener('error', (ev: ErrorEvent) => { reportClientError('error', ev.error ?? ev.message, w) })
  w.addEventListener('unhandledrejection', (ev: PromiseRejectionEvent) => { reportClientError('unhandledrejection', ev.reason, w) })
}

// tests only
export function resetClientErrorReporting(): void { state.sent = 0; state.seen.clear(); installed = false }
