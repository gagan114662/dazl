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
import { createHash, randomUUID } from 'node:crypto'
import { appCodeFile, bundleFile } from './emitted.ts'

export interface ErrorContext {
  source: 'route' | 'render' | 'worker' | 'health' | 'process' | 'client'
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
const SOURCES = new Set(['route', 'render', 'worker', 'health', 'process', 'client'])
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
  for (const h of alertHooks()) { try { h(r) } catch { /* same */ } }
  return r
}

// What leaves the server (the alert webhook and Sentry) is an ALLOWLIST, not the scrubbed record: the scrub above is
// pattern-based and cannot recognise every name, secret or note, so no free text is sent at all. Allowed:
//   error type  - a built-in error class or one of this app's own error classes (APP_ERROR_CLASSES), else 'Error'
//   frames      - file, line and column of up to 8 stack frames; no function names. A file is kept only when this
//                 build has it (lib/ops/emitted.ts): a server file under the app root, sent relative to it, a Node
//                 built-in, or a /_next/static/ bundle this build emitted. Any other frame is dropped
//   where, source, method, request_id, fingerprint - already fixed-shape in the record (see the top of this file)
//   environment, release - from the deployment's own settings
// Never sent: the error and cause messages, the tenant (user), ref, request bodies, headers, cookies, query strings or
// any other context. There is no Sentry SDK, so there are no breadcrumbs, default PII or request data to turn off: the
// event is built field by field below. The full scrubbed record stays in the server's own log (stderr).
const BUILTIN_ERRORS = new Set(['Error', 'TypeError', 'RangeError', 'ReferenceError', 'SyntaxError', 'URIError', 'EvalError', 'AggregateError', 'AbortError', 'TimeoutError', 'DOMException', 'ChunkLoadError'])
// This app's error classes (test/ops-sentry.test.ts fails when a class extending an Error in lib/ or app/ is missing).
export const APP_ERROR_CLASSES: ReadonlySet<string> = new Set(['CopyRefused', 'CopyVerifyError', 'EnrichError', 'FixtureError', 'GmailError', 'GmailSendError', 'InboxQueryError', 'JobFeedError',
  'LeaseLost', 'MemoryError', 'OutreachError', 'ProviderError', 'RaceLost', 'ScanStopped', 'ScanTimedOut', 'SequenceError', 'SourceReviewError', 'SpendRefused',
  'StaleLeaseWrite', 'StatementFailedInTx', 'Timeout',
  // lib/pipeline/deals.ts (#366): a refused deal change
  'DealError',
  // lib/evals (docs/design/agent-evals.md): a malformed World or case file. Offline eval tooling only.
  'WorldError', 'CaseError',
  // lib/ops/client-errors.ts (#312): the wrapper for a browser report. Its runtime name is always replaced by an
  // allowlisted built-in type before capture, so this class name itself is never what is sent.
  'ClientReport',
  // lib/crm/index.ts (#365): a CRM push that failed (nothing created) or has an unknown outcome
  'CrmPushError'])
export const outboundType = (name: string): string => BUILTIN_ERRORS.has(name) || APP_ERROR_CLASSES.has(name) ? name : 'Error'
export interface OutboundFrame { filename: string; lineno: number; colno: number }
// A frame's file only when it is this build's own code (lib/ops/emitted.ts): a server file that exists under the app
// root (sent relative to it), a Node built-in, or a /_next/static/ bundle this build emitted. Other frames are dropped.
function outboundFile(f: string, root?: string): string | null {
  if (/^https?:\/\//.test(f)) { try { return bundleFile(new URL(f).pathname, root) } catch { return null } }
  if (f.startsWith('/_next/static/')) return bundleFile(f, root)
  return appCodeFile(f, root)
}
export function outboundFrames(stack: string[], root?: string): OutboundFrame[] {
  const out: OutboundFrame[] = []
  for (const line of stack.slice(0, 8)) {
    // the location is the last "(file:line:col)" or the bare "file:line:col" after "at "
    const m = /(?:\(|^at (?:async )?)([^()\s]+):(\d{1,7}):(\d{1,7})\)?$/.exec(line.trim())
    const file = m ? outboundFile(m[1].split(/[?#]/)[0], root) : null
    if (m && file) out.push({ filename: file, lineno: Number(m[2]), colno: Number(m[3]) })
  }
  return out
}
// root: the app root that frame files are checked against (default: the working directory; tests pass their own)
export interface Deployment { environment: string; release?: string; root?: string }
// environment: SENTRY_ENVIRONMENT when it is a plain word, else 'staging' when DAZL_ENV=staging, else 'production'
export function deployment(env: Record<string, string | undefined> = process.env): Deployment {
  const named = env.SENTRY_ENVIRONMENT && /^[a-z0-9_-]{1,32}$/.test(env.SENTRY_ENVIRONMENT) ? env.SENTRY_ENVIRONMENT : null
  const release = env.DAZL_COMMIT_SHA && /^[0-9a-f]{7,40}$/.test(env.DAZL_COMMIT_SHA) ? env.DAZL_COMMIT_SHA : undefined
  return { environment: named ?? (env.DAZL_ENV === 'staging' ? 'staging' : 'production'), ...(release ? { release } : {}) }
}
// The alert webhook's body: the same allowlist.
export function outboundRecord(r: ErrorRecord, d: Deployment) {
  return {
    level: r.level, ts: r.ts, source: r.source, where: r.where, ...(r.method ? { method: r.method } : {}), ...(r.request_id ? { request_id: r.request_id } : {}),
    error: { type: outboundType(r.error.name), frames: outboundFrames(r.error.stack, d.root) }, fingerprint: r.fingerprint,
    environment: d.environment, ...(d.release ? { release: d.release } : {}),
  }
}

// Alert hooks. Both are throttled the same way: one alert per fingerprint per window and a global cap per window, so an
// error loop cannot flood them. Fire and forget, with a timeout; a failing hook is dropped silently (it must not log
// through captureError and loop). Each sends the scrubbed record only, never anything the record does not hold.
export interface AlertOptions { url?: string; fetchImpl?: typeof fetch; windowMs?: number; maxPerWindow?: number; timeoutMs?: number; clock?: () => number; deployment?: Deployment }

function throttled(o: AlertOptions, send: (r: ErrorRecord, f: typeof fetch, signal: AbortSignal) => Promise<unknown>): ErrorSink {
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
    void Promise.resolve().then(() => send(r, f, AbortSignal.timeout(o.timeoutMs ?? 3000))).catch(() => {})
  }
}

// OPS_ALERT_WEBHOOK_URL (https only): POST the allowlisted record (outboundRecord) as JSON.
export function makeAlertHook(o: AlertOptions): ErrorSink {
  const url = o.url
  if (!url || !/^https:\/\//.test(url)) return () => {}
  const d = o.deployment ?? deployment()
  return throttled(o, (r, f, signal) => f(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(outboundRecord(r, d)), signal }))
}

// SENTRY_DSN (https only): the record as a Sentry event, in an envelope POSTed to the DSN's project. Any service that
// takes Sentry's ingestion protocol works (Sentry, GlitchTip, a self-hosted relay); no SDK is loaded. Without a DSN, or
// with one that does not parse, nothing is sent.
export interface SentryDsn { endpoint: string; publicKey: string; dsn: string }
export function parseSentryDsn(dsn: string | undefined): SentryDsn | null {
  if (!dsn) return null
  let u: URL
  try { u = new URL(dsn) } catch { return null }
  const parts = u.pathname.split('/').filter(Boolean)
  const project = parts.pop()
  if (u.protocol !== 'https:' || !u.username || !project || !/^\d+$/.test(project)) return null
  const prefix = parts.length ? `/${parts.join('/')}` : ''
  return { endpoint: `https://${u.host}${prefix}/api/${project}/envelope/`, publicKey: decodeURIComponent(u.username), dsn: `https://${u.username}@${u.host}${prefix}/${project}` }
}

// One Sentry event per record, built only from the allowlist above. Grouping uses the record's own fingerprint.
export function toSentryEnvelope(r: ErrorRecord, d: SentryDsn, dep: Deployment = deployment(), sentAt = new Date()): string {
  const eventId = randomUUID().replace(/-/g, '')
  const tags: Record<string, string> = { source: r.source, where: r.where }
  if (r.method) tags.method = r.method
  if (r.request_id) tags.request_id = r.request_id
  const frames = outboundFrames(r.error.stack, dep.root)
  const event = {
    event_id: eventId, timestamp: Date.parse(r.ts) / 1000, platform: 'node', level: 'error', logger: r.source, transaction: r.where,
    fingerprint: [r.fingerprint], tags, environment: dep.environment, ...(dep.release ? { release: dep.release } : {}),
    // Sentry lists frames oldest first; a stack trace lists the newest first
    exception: { values: [{ type: outboundType(r.error.name), ...(frames.length ? { stacktrace: { frames: [...frames].reverse() } } : {}) }] },
  }
  return [JSON.stringify({ event_id: eventId, sent_at: sentAt.toISOString(), dsn: d.dsn }), JSON.stringify({ type: 'event' }), JSON.stringify(event)].join('\n')
}

export function makeSentryHook(o: Omit<AlertOptions, 'url'> & { dsn?: string }): ErrorSink {
  const d = parseSentryDsn(o.dsn)
  if (!d) return () => {}
  const dep = o.deployment ?? deployment()
  const auth = `Sentry sentry_version=7, sentry_key=${d.publicKey}, sentry_client=dazl-ops/1.0`
  return throttled(o, (r, f, signal) => f(d.endpoint, {
    method: 'POST', headers: { 'content-type': 'application/x-sentry-envelope', 'x-sentry-auth': auth },
    body: toSentryEnvelope(r, d, dep), signal,
  }))
}

let hook: { key: string; sinks: ErrorSink[] } | null = null
function alertHooks(): ErrorSink[] {
  const e = process.env
  const key = [e.OPS_ALERT_WEBHOOK_URL, e.SENTRY_DSN, e.SENTRY_ENVIRONMENT, e.DAZL_ENV, e.DAZL_COMMIT_SHA].join('\n')
  if (!hook || hook.key !== key) {
    const dep = deployment(e)
    hook = { key, sinks: [makeAlertHook({ url: e.OPS_ALERT_WEBHOOK_URL, deployment: dep }), makeSentryHook({ dsn: e.SENTRY_DSN, deployment: dep })] }
  }
  return hook.sinks
}
