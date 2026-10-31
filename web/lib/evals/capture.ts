// Production trace capture for scan/discovery (docs/design/agent-evals.md, "Production capture"). OFF unless
// DAZL_TRACE_CAPTURE=1. When on, runJob records every external call of the run through the same TraceRecorder the replay
// harness uses, and on finish the trace is REDACTED (./redact.ts: secrets, emails, phones, profile slugs, extracted names)
// and size-capped, then written to the app's own store (scan_traces, tenant-scoped) - never to a third-party trace store.
// Rows older than DAZL_TRACE_RETENTION_DAYS (default 14) are deleted on every capture for that tenant and by the
// scheduled tick for everyone - but the tick purges ONLY under a retention somebody chose: capture on (its retention),
// or an explicit valid DAZL_TRACE_RETENTION_DAYS with capture off (so turning capture off can still clear old rows).
// With capture unset, off, or on with an invalid retention, the tick deletes nothing: no retention policy is applied
// by default (PR #463 review).
//
// Storage and retention are the owner's decision; the defaults above stand until Gagan says otherwise. Capture never
// changes what a run does: the recorder returns and throws exactly what the inner call did, and a failure to record or
// persist is logged and swallowed. Storing happens after the run's own work, and is bounded: background body reads get
// SETTLE_MS (then whatever was read is kept) and the whole finish FINISH_MS, so a stalled stream or store can never keep
// runJob, and the runner slot it holds, from returning. A recorded trace is PRIVATE: it is not a World until
// worldFromTrace (which accepts it only because it is redacted), and it is never published or shared across tenants.
import { randomBytes } from 'node:crypto'
import { getDb, type Db, type Tx, type TxBody } from '../db/client.ts'
import { resolveServedCommit } from '../commit-marker.ts'
import { TraceRecorder, TRACE_VERSION, type Trace, type TraceLead } from './trace.ts'
import { redactTrace } from './redact.ts'

export type Env = Record<string, string | undefined>
export const DEFAULT_RETENTION_DAYS = 14
export const MAX_RETENTION_DAYS = 365
export const MAX_STRING_CHARS = 50_000      // one prompt, page or body; longer values are cut and marked
export const MAX_TRACE_BYTES = 2_000_000     // the whole stored trace as UTF-8 JSON: a hard bound (capTrace), never exceeded on insert
export const SETTLE_MS = 5_000
export const FINISH_MS = 15_000
export const PURGE_LIMIT = 500               // expired rows deleted per scheduled purge (one tick): bounded like the session reap

// `purge`: whether the scheduled purge may delete anything - true only when capture is on, or a valid retention was set explicitly.
export interface TraceCaptureConfig { enabled: boolean; retentionDays: number; reason: 'on' | 'off' | 'invalid_retention'; purge: boolean }

// Both settings are configuration (environment), not code. An invalid retention never captures and never purges: nothing
// is stored, and nothing deleted, under a retention nobody chose. A retention is a plain decimal whole number of days
// ("7", "14"); "0x10", "1e1", "+7", "7.0" are not accepted even though Number() would read them.
export function traceCaptureConfig(env: Env = process.env): TraceCaptureConfig {
  const raw = env.DAZL_TRACE_RETENTION_DAYS?.trim()
  const explicit = raw !== undefined && raw !== ''
  const n = explicit ? (/^\d+$/.test(raw) ? Number(raw) : NaN) : DEFAULT_RETENTION_DAYS
  const valid = Number.isInteger(n) && n >= 1 && n <= MAX_RETENTION_DAYS
  if (env.DAZL_TRACE_CAPTURE !== '1') return { enabled: false, retentionDays: valid ? n : DEFAULT_RETENTION_DAYS, reason: 'off', purge: explicit && valid }
  if (!valid) return { enabled: false, retentionDays: DEFAULT_RETENTION_DAYS, reason: 'invalid_retention', purge: false }
  return { enabled: true, retentionDays: n, reason: 'on', purge: true }
}

export interface TraceJob { id: string; user_id: string; attempts: number; query?: string | null; icp?: string | null; business_name?: string; industry?: string; location?: string }
export interface Capture<D> { deps: D; recorder: TraceRecorder; finish(outcome: string): Promise<string | null> }
export interface CaptureOptions { env?: Env; now?: () => number; db?: () => Promise<Db>; settleMs?: number; finishMs?: number }

const within = <T>(p: Promise<T>, ms: number, onTimeout: () => T): Promise<T> => {
  let t: ReturnType<typeof setTimeout> | undefined
  return Promise.race([p, new Promise<T>(r => { t = setTimeout(() => r(onTimeout()), ms) })]).finally(() => clearTimeout(t))
}

// Starts recording one run attempt, or returns null (capture off, or the caller already records, as a replay does).
// Only seams the run already resolves are wrapped: fetchImpl here (always `?? fetch` inside the run, never a mode switch),
// providers and the verifier's page fetch through deps.trace inside runJob. Seams whose presence changes behaviour
// (newsHttp turns news search on, fetchPage changes the resolution call) are never added.
export function beginScanTrace<D extends { trace?: TraceRecorder; fetchImpl?: typeof fetch }>(job: TraceJob, deps: D, o: CaptureOptions = {}): Capture<D> | null {
  const env = o.env ?? process.env
  const cfg = traceCaptureConfig(env)
  if (!cfg.enabled || deps.trace) return null
  const now = o.now ?? Date.now
  const recorder = new TraceRecorder()
  const startedAt = new Date(now()).toISOString()
  return {
    recorder,
    deps: { ...deps, trace: recorder, fetchImpl: recorder.fetch(deps.fetchImpl ?? globalThis.fetch) },
    finish(outcome) {
      return within(store(outcome), o.finishMs ?? FINISH_MS, () => { console.error(JSON.stringify({ trace_capture: 'failed', job: job.id, error: 'timeout' })); return null })
    },
  }
  async function store(outcome: string): Promise<string | null> {
    try {
      await recorder.settled(o.settleMs ?? SETTLE_MS) // a stalled body keeps what was read and is cancelled
      const db = await (o.db ?? getDb)()
      const commit = resolveServedCommit(env)
      const raw: Trace = {
        v: TRACE_VERSION, kind: 'dazl.trace', id: randomBytes(12).toString('hex'), path: 'scan.discovery', synthetic: false, redacted: false,
        started_at: startedAt, agent: { commit: commit === 'unknown' ? null : commit, label: 'production' },
        input: { request: job.query ?? [job.business_name, job.industry, job.location].filter(Boolean).join(' / '), icp: parseIcp(job.icp), as_of: startedAt },
        spans: recorder.spans,
        output: { status: outcome, leads: await jobLeads(db, job) },
      }
      const stored = capTrace(redactTrace(raw))
      const json = JSON.stringify(stored)
      if (Buffer.byteLength(json) > MAX_TRACE_BYTES) throw new Error('trace over MAX_TRACE_BYTES') // capTrace guarantees this; never insert past it
      const at = Math.floor(now() / 1000)
      await db.run('INSERT INTO scan_traces (id, tenant_id, job_id, attempt, created_at, bytes, trace) VALUES (?, ?, ?, ?, ?, ?, ?)', [stored.id, job.user_id, job.id, job.attempts, at, Buffer.byteLength(json), json])
      await db.run('DELETE FROM scan_traces WHERE tenant_id = ? AND created_at < ?', [job.user_id, at - cfg.retentionDays * 86_400])
      return stored.id
    } catch (e) {
      // Never into the run: the scan's outcome stands whether or not its trace was kept. Never the error's message in the
      // log: a store error can quote the row it refused (trace content). Its class and code only.
      console.error(JSON.stringify({ trace_capture: 'failed', job: job.id, error: errorKind(e) }))
      return null
    }
  }
}

const errorKind = (e: unknown): string => {
  const code = (e as { code?: unknown } | null)?.code
  const name = e instanceof Error ? e.name : typeof e
  return typeof code === 'string' && /^[A-Z0-9_]{1,40}$/.test(code) ? `${name}:${code}` : name
}

const parseIcp = (s: string | null | undefined): unknown => { try { return s ? JSON.parse(s) : undefined } catch { return undefined } }

// This run's leads, read through the job's own tenant. Empty when the leads live in another store (the scan still runs on
// SQLite while DATABASE_URL points the Db layer at Postgres before cutover).
async function jobLeads(db: Db, job: TraceJob): Promise<TraceLead[]> {
  try {
    return await db.all<TraceLead>(`SELECT l.name, l.company, l.contact, l.source_url, l.evidence_excerpt AS excerpt, l.event_date, l.review_reason, l.confidence
      FROM leads l JOIN scan_jobs j ON j.id = l.scan_job_id WHERE j.id = ? AND j.user_id = ? ORDER BY l.company`, [job.id, job.user_id])
  } catch { return [] }
}

// Fits a trace into `maxBytes` of UTF-8 JSON - the exact bytes stored - dropping content in stages, each recorded in
// `capture` (with complete: false), so a stored trace never looks more complete than it is:
//   1. every string and key cut to MAX_STRING_CHARS (never splitting a surrogate pair);
//   2. span inputs/outputs dropped, span metadata kept;
//   3. output leads dropped (count kept);
//   4. input dropped and spans dropped (count kept): a header only.
// Throws when even the header does not fit (an absurdly small bound): the caller then stores nothing.
export function capTrace(t: Trace, maxBytes = MAX_TRACE_BYTES): Trace {
  let cut = 0
  const cutStr = (v: string): string => {
    if (v.length <= MAX_STRING_CHARS) return v
    cut++
    let n = MAX_STRING_CHARS
    const c = v.charCodeAt(n - 1)
    if (c >= 0xd800 && c <= 0xdbff) n-- // a high surrogate whose pair would be cut off
    return `${v.slice(0, n)}…[truncated]`
  }
  const deep = (v: unknown): unknown => {
    if (typeof v === 'string') return cutStr(v)
    if (Array.isArray(v)) return v.map(deep)
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [cutStr(k), deep(x)]))
    return v
  }
  const fits = (x: Trace) => Buffer.byteLength(JSON.stringify(x)) <= maxBytes
  const base = deep(t) as Trace
  const prior = t.capture ?? {}
  const mark = (x: Trace, more: NonNullable<Trace['capture']>): Trace => {
    const truncated = (prior.truncated_strings ?? 0) + cut
    const c = { ...prior, ...more, ...(truncated ? { truncated_strings: truncated } : {}), ...(bodies ? { bodies_truncated: bodies } : {}) }
    const dropped = !!(c.truncated_strings || c.bodies_truncated || c.spans_metadata_only || c.spans_omitted || c.leads_omitted || c.input_omitted || prior.complete === false)
    return { ...x, capture: { ...c, complete: !dropped, max_bytes: maxBytes } }
  }
  // Bodies the recorder cut before this point (its cap, a failed read, the settle bound) are drops too.
  const bodies = t.spans.filter(s => (s.output as { truncated?: unknown } | null)?.truncated === true).length
  const s1 = mark(base, {})
  if (fits(s1)) return s1
  const meta = base.spans.map(s => ({ ...s, input: { url: typeof (s.input as { url?: unknown }).url === 'string' ? cutStr(String((s.input as { url: string }).url)).slice(0, 2_000) : null, stage: (s.input as { stage?: unknown }).stage ?? null }, output: null, ...(s.error ? { error: s.error.slice(0, 300) } : {}) }))
  const s2 = mark({ ...base, spans: meta }, { spans_metadata_only: true })
  if (fits(s2)) return s2
  const leads = base.output?.leads.length ?? 0
  const s3 = mark({ ...base, spans: meta, ...(base.output ? { output: { status: base.output.status.slice(0, 200), leads: [] } } : {}) }, { spans_metadata_only: true, ...(leads ? { leads_omitted: leads } : {}) })
  if (fits(s3)) return s3
  const header: Trace = {
    v: base.v, kind: base.kind, id: base.id, path: base.path, synthetic: base.synthetic, redacted: base.redacted, started_at: base.started_at.slice(0, 40),
    agent: { commit: base.agent.commit ? base.agent.commit.slice(0, 64) : null, ...(base.agent.label ? { label: base.agent.label.slice(0, 64) } : {}) },
    input: { request: '', as_of: base.input.as_of.slice(0, 40) }, spans: [],
    ...(base.output ? { output: { status: base.output.status.slice(0, 200), leads: [] } } : {}),
  }
  const s4 = mark(header, { spans_metadata_only: true, input_omitted: true, ...(base.spans.length ? { spans_omitted: base.spans.length } : {}), ...(leads ? { leads_omitted: leads } : {}) })
  if (fits(s4)) return s4
  throw new Error('trace header alone is over the byte bound')
}

export interface StoredTraceRow { id: string; job_id: string; attempt: number; created_at: number; bytes: number }
// Reads are always for one tenant: another tenant's trace id answers like an unknown one.
export function listTraces(db: Db, tenantId: string, limit = 20): Promise<StoredTraceRow[]> {
  return db.all<StoredTraceRow>('SELECT id, job_id, attempt, created_at, bytes FROM scan_traces WHERE tenant_id = ? ORDER BY created_at DESC, id LIMIT ?', [tenantId, Math.max(1, Math.min(200, Math.floor(limit)))])
}
export async function getTrace(db: Db, tenantId: string, id: string): Promise<Trace | null> {
  const r = await db.get<{ trace: string }>('SELECT trace FROM scan_traces WHERE tenant_id = ? AND id = ?', [tenantId, id])
  return r ? JSON.parse(r.trace) as Trace : null
}

// The scheduled retention purge (app/api/internal/tick): every tenant's rows older than the configured retention, ONLY
// under a retention somebody chose (traceCaptureConfig().purge: capture on, or an explicit valid DAZL_TRACE_RETENTION_DAYS
// with capture off, which is how old rows are cleared after capture is turned off). Otherwise nothing is deleted and 0 is
// returned: a deployment with capture unset, off or misconfigured applies no retention policy of its own.
// Bounded and fenced like the session reap (lib/sessions.ts reapSessions): at most `limit` rows (PURGE_LIMIT) per call,
// oldest first, in one transaction that takes the tick lease's fence first - a tick that lost its lease deletes nothing
// (StaleLeaseWrite), and a first purge after weeks of capture drains over several ticks instead of one statement.
export interface PurgeOptions { env?: Env; now?: number; fence?: (t: Tx) => TxBody<void>; limit?: number }
export async function purgeExpiredTraces(db: Db, o: PurgeOptions = {}): Promise<number> {
  const { purge, retentionDays } = traceCaptureConfig(o.env ?? process.env)
  if (!purge) return 0
  const cutoff = Math.floor((o.now ?? Date.now()) / 1000) - retentionDays * 86_400
  const limit = Math.max(1, Math.min(o.limit ?? PURGE_LIMIT, 5000))
  return db.tx(function* (t) {
    if (o.fence) yield* o.fence(t)
    return (yield* t.run('DELETE FROM scan_traces WHERE id IN (SELECT id FROM scan_traces WHERE created_at < ? ORDER BY created_at, id LIMIT ?)', [cutoff, limit])).changes
  })
}
