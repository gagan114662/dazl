// Browser side of error monitoring: uncaught errors, unhandled promise rejections and errors caught by the error
// boundaries (app/error.tsx, app/app/error.tsx, app/global-error.tsx) are posted to /api/client-errors, which records
// them through the same scrubbed error records and alert hooks as server errors (lib/ops/client-errors.ts).
// Sends only the error's name, message and stack, the kind, and the page path (recorded as its route template). At most
// MAX_PER_PAGE reports per page load and each distinct error once, so a render loop cannot flood the endpoint; a failed
// send is dropped silently and never reported again. A missing JavaScript chunk is not reported: after a deploy it is
// expected, lib/chunk-recovery.ts handles it, and every open tab would raise an alert.
import { isChunkLoadError } from './chunk-recovery.ts'
export type ClientErrorKind = 'boundary' | 'error' | 'unhandledrejection'
const MAX_PER_PAGE = 5

interface Win { location: { pathname: string }; fetch: typeof fetch; addEventListener: (t: string, f: (e: never) => void) => void }
const state = { sent: 0, seen: new Set<string>() }

export function reportClientError(kind: ClientErrorKind, err: unknown, w: Win = globalThis as unknown as Win): boolean {
  try {
    if (isChunkLoadError(err)) return false
    const e = err instanceof Error ? err : { name: typeof err, message: typeof err === 'string' ? err : '[non-error thrown]', stack: '' }
    const key = `${kind}|${e.name}|${e.message}`
    if (state.sent >= MAX_PER_PAGE || state.seen.has(key)) return false
    state.seen.add(key); state.sent++
    const body = JSON.stringify({ kind, name: String(e.name).slice(0, 100), message: String(e.message).slice(0, 1000), stack: String(e.stack ?? '').slice(0, 4000), path: w.location.pathname })
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
