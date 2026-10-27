// Structured error capture (docs/PLATFORM.md step 6). One JSON line per error on stderr, plus an optional alert hook.
// What a record carries: where it happened (route template or worker name), the tenant id (an opaque random id,
// never an email or name), the error's class, a scrubbed message and stack, and a fingerprint for grouping.
// What it never carries: request bodies, headers, cookies, query strings, emails, phone numbers, IPs, tokens or keys.
// The scrubbing is a backstop, not a licence: callers pass the error and the tenant id, nothing else about the user.
import { createHash } from 'node:crypto'

export interface ErrorContext {
  source: 'route' | 'render' | 'worker' | 'health' | 'process'
  // route template ('/api/leads/[lead]/confirm') or worker name ('tick:replies'); never a concrete URL
  where: string
  method?: string
  tenantId?: string | null
  // an opaque id that helps find the failing unit (scan job id, Stripe event id); dropped unless it looks opaque
  ref?: string
}

export interface ErrorRecord {
  level: 'error'
  ts: string
  source: ErrorContext['source']
  where: string
  method?: string
  tenant: string | null
  ref?: string
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

function describe(e: unknown): { name: string; message: string; stack: string[] } {
  if (e instanceof Error) {
    // stack frames only (the first stack line repeats the message); at most 8, scrubbed
    const frames = (e.stack ?? '').split('\n').map(l => l.trim()).filter(l => l.startsWith('at ')).slice(0, 8).map(scrub)
    return { name: e.name || 'Error', message: scrub(e.message ?? ''), stack: frames }
  }
  // a thrown non-Error (string, object): keep only its type, its contents may be anything
  return { name: typeof e, message: typeof e === 'string' ? scrub(e) : '[non-error thrown]', stack: [] }
}

// Ids are random tokens; anything else (an email passed by mistake) is dropped rather than logged.
const opaque = (v: string | null | undefined): string | null => typeof v === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(v) ? v : null

export function toRecord(e: unknown, ctx: ErrorContext, now = new Date()): ErrorRecord {
  const d = describe(e)
  const cause = e instanceof Error && e.cause !== undefined ? describe(e.cause) : undefined
  const where = scrub(ctx.where.split(/[?#]/)[0])
  const fingerprint = createHash('sha256').update([ctx.source, where, d.name, d.stack[0] ?? d.message].join('|')).digest('hex').slice(0, 16)
  return {
    level: 'error', ts: now.toISOString(), source: ctx.source, where, ...(ctx.method ? { method: ctx.method } : {}),
    tenant: opaque(ctx.tenantId),
    ...(opaque(ctx.ref) ? { ref: opaque(ctx.ref)! } : {}),
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
