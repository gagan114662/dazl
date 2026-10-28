// Structured error capture (docs/PLATFORM.md step 6). One JSON line per error on stderr, plus an optional alert hook.
// Every emitted field is either built here (ts, fingerprint), scrubbed free text (message, stack frames, both bounded),
// or checked against the shape it must have, and replaced when it does not match:
//   source, method   - fixed sets
//   where            - a route template or worker name: [A-Za-z0-9_-./[]:] only, at most 128 chars
//   tenant           - a users.id: 32 lowercase hex characters (randomBytes(16), app/api/auth/signup, lib/auth-google.ts)
//   request_id       - the random UUIDv4 proxy.ts gave the request
//   ref              - a Stripe event id from a signature-verified webhook (evt_ + 24-64 base62, with a digit), or a
//                      scan_jobs.id (24 lowercase hex, randomBytes(12) in lib/scan/store.ts)
//   error.name, cause.name - a class name ending in Error/Exception, or one of this app's own error classes, that the
//                            scrub leaves unchanged and that has no run of 4+ digits
// Never read: request bodies, headers, cookies, query strings. The scrub (emails, keys, tokens, IPs, phone numbers,
// DB URLs, URL queries) is a backstop for free text, not a licence: callers pass the error and the tenant id only.
import { createHash } from 'node:crypto'

export interface ErrorContext {
  source: 'route' | 'render' | 'worker' | 'health' | 'process'
  // route template ('/api/leads/[lead]/confirm') or worker name ('tick:replies'); never a concrete URL
  where: string
  method?: string
  tenantId?: string | null
  // a Stripe event id (signature-verified webhook) or a scan job id; dropped unless it has one of those shapes
  ref?: string
  // the request id proxy.ts gave the request (lib/ops/request-log.ts): a random UUIDv4, dropped unless it has that shape
  requestId?: string | null
}

export interface ErrorRecord {
  level: 'error'
  ts: string
  source: ErrorContext['source']
  where: string
  method?: string
  tenant: string | null
  ref?: string
  request_id?: string
  error: { name: string; message: string; stack: string[]; cause?: { name: string; message: string } }
  fingerprint: string
}

const REDACTIONS: [RegExp, string][] = [
  [/\b(?:postgres(?:ql)?|mysql|redis):\/\/[^\s'"]+/gi, '[db-url]'],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[email]'],
  [/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, '[auth]'],
  // provider key shapes (Stripe sk_/rk_/whsec_, Anthropic/OpenAI sk-, Google AIza, GitHub ghp_...)
  [/\b(?:sk|rk|pk|whsec)_(?:live|test)?_?[A-Za-z0-9]{8,}\b/g, '[key]'],
  [/\b(?:sk-[A-Za-z0-9_-]{8,}|AIza[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|xox[abpr]-[A-Za-z0-9-]{10,})/g, '[key]'],
  // query strings and fragments carry tokens and emails (unsubscribe links, OAuth callbacks)
  [/(https?:\/\/[^\s?#'"]+)[?#][^\s'"]*/gi, '$1?[query]'],
  [/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '[ip]'],
  [/(?:\+?\d[\d ().-]{8,}\d)/g, '[number]'],
  // session tokens, hashes, JWT segments: any long opaque run
  [/\b[A-Za-z0-9_-]{32,}\b/g, '[token]'],
]

export function scrub(s: string): string {
  let out = s
  for (const [re, to] of REDACTIONS) out = out.replace(re, to)
  return out.length > 500 ? out.slice(0, 500) + '…' : out
}

// This app's error classes whose names do not end in Error (grep 'extends Error').
const OWN_ERROR_NAMES = new Set(['LeaseLost', 'RaceLost', 'ScanStopped', 'ScanTimedOut', 'SpendRefused', 'StaleLeaseWrite', 'StatementFailedInTx', 'Timeout'])
// A class-shaped name is not safe by its shape alone (Account1234567890Error): it must also come through the scrub
// unchanged and carry no run of 4+ digits.
export function errorName(n: unknown): string {
  return typeof n === 'string' && /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(n) && (/(?:Error|Exception)$/.test(n) || OWN_ERROR_NAMES.has(n))
    && !/[0-9]{4}/.test(n) && scrub(n) === n ? n : '[unrecognized-name]'
}
const SOURCES = new Set(['route', 'render', 'worker', 'health', 'process'])
const METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'])
export const isTenantId = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{32}$/.test(v)
// Stripe ids are evt_ + 24+ random base62 characters (digits included); the only caller passes the id of an event whose
// signature was verified, so the value came from Stripe, and the shape check is a second guard.
const isStripeEventId = (v: unknown): v is string => typeof v === 'string' && /^evt_(?=[A-Za-z]*[0-9])[A-Za-z0-9]{24,64}$/.test(v)
const isScanJobId = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{24}$/.test(v)
export function whereName(w: unknown): string {
  const s = typeof w === 'string' ? w.split(/[?#]/)[0] : ''
  return /^[A-Za-z0-9_\-./[\]:]{1,128}$/.test(s) && scrub(s) === s ? s : '[unrecognized]'
}

function describe(e: unknown): { name: string; message: string; stack: string[] } {
  if (e instanceof Error) {
    // stack frames only (the first stack line repeats the message); at most 8, scrubbed
    const frames = (e.stack ?? '').split('\n').map(l => l.trim()).filter(l => l.startsWith('at ')).slice(0, 8).map(scrub)
    return { name: errorName(e.name), message: scrub(String(e.message ?? '')), stack: frames }
  }
  // a thrown non-Error (string, object): keep only its type, its contents may be anything
  return { name: typeof e, message: typeof e === 'string' ? scrub(e) : '[non-error thrown]', stack: [] }
}

export function toRecord(e: unknown, ctx: ErrorContext, now = new Date()): ErrorRecord {
  const d = describe(e)
  const cause = e instanceof Error && e.cause !== undefined ? describe(e.cause) : undefined
  const where = whereName(ctx.where)
  const source = SOURCES.has(ctx.source) ? ctx.source : 'process'
  const fingerprint = createHash('sha256').update([source, where, d.name, d.stack[0] ?? d.message].join('|')).digest('hex').slice(0, 16)
  return {
    level: 'error', ts: now.toISOString(), source, where, ...(ctx.method && METHODS.has(ctx.method) ? { method: ctx.method } : {}),
    tenant: isTenantId(ctx.tenantId) ? ctx.tenantId : null,
    ...(isStripeEventId(ctx.ref) || isScanJobId(ctx.ref) ? { ref: ctx.ref } : {}),
    ...(typeof ctx.requestId === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(ctx.requestId) ? { request_id: ctx.requestId } : {}),
    error: { ...d, ...(cause ? { cause: { name: cause.name, message: cause.message } } : {}) },
    fingerprint,
  }
}

export type ErrorSink = (r: ErrorRecord) => void
const stderrSink: ErrorSink = r => { process.stderr.write(JSON.stringify(r) + '\n') }
let sinks: ErrorSink[] = [stderrSink]

// Tests replace the sinks; returns a restore function.
export function setErrorSinks(s: ErrorSink[]): () => void {
  const prev = sinks
  sinks = s
  return () => { sinks = prev }
}

// Never throws: error capture must not turn a handled error into a crash.
export function captureError(e: unknown, ctx: ErrorContext): ErrorRecord | null {
  let r: ErrorRecord
  try { r = toRecord(e, ctx) } catch { return null }
  for (const s of sinks) { try { s(r) } catch { /* a broken sink never breaks the caller */ } }
  try { alertHook()(r) } catch { /* same */ }
  return r
}

// Alert hook: when OPS_ALERT_WEBHOOK_URL is set (https only), POST the scrubbed record there. Throttled to one alert
// per fingerprint per window and a global cap per window, so an error loop cannot flood the hook. Fire and forget,
// with a timeout; a failing hook is dropped silently (it must not log through captureError and loop).
export interface AlertOptions { url?: string; fetchImpl?: typeof fetch; windowMs?: number; maxPerWindow?: number; timeoutMs?: number; clock?: () => number }

export function makeAlertHook(o: AlertOptions): ErrorSink {
  const url = o.url
  if (!url || !/^https:\/\//.test(url)) return () => {}
  const windowMs = o.windowMs ?? 10 * 60_000, max = o.maxPerWindow ?? 20, clock = o.clock ?? Date.now
  const lastSent = new Map<string, number>()
  let windowStart = 0, sentInWindow = 0
  return r => {
    const now = clock()
    if (now - windowStart >= windowMs) { windowStart = now; sentInWindow = 0 }
    const last = lastSent.get(r.fingerprint)
    if (last !== undefined && now - last < windowMs) return
    if (sentInWindow >= max) return
    lastSent.set(r.fingerprint, now)
    sentInWindow++
    if (lastSent.size > 1000) lastSent.delete(lastSent.keys().next().value!)
    const f = o.fetchImpl ?? fetch
    void Promise.resolve().then(() => f(url, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(r), signal: AbortSignal.timeout(o.timeoutMs ?? 3000),
    })).catch(() => {})
  }
}

let hook: { url: string | undefined; sink: ErrorSink } | null = null
function alertHook(): ErrorSink {
  const url = process.env.OPS_ALERT_WEBHOOK_URL
  if (!hook || hook.url !== url) hook = { url, sink: makeAlertHook({ url }) }
  return hook.sink
}
