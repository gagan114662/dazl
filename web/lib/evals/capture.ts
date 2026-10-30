// Production trace capture for scan/discovery (docs/design/agent-evals.md, "Production capture"). OFF unless
// DAZL_TRACE_CAPTURE=1. When on, runJob records every external call of the run through the same TraceRecorder the replay
// harness uses, and on finish the trace is REDACTED (./redact.ts: secrets, emails, phones, profile slugs, extracted names)
// and size-capped, then written to the app's own store (scan_traces, tenant-scoped) - never to a third-party trace store.
// Rows older than DAZL_TRACE_RETENTION_DAYS (default 14) are deleted on every capture for that tenant and by the
// scheduled tick for everyone, whether capture is on or not.
//
// Storage and retention are the owner's decision; the defaults above stand until Gagan says otherwise. Capture never
// changes what a run does: the recorder returns and throws exactly what the inner call did, and a failure to record or
// persist is logged and swallowed. Storing happens after the run's own work, and is bounded: background body reads get
// SETTLE_MS (then whatever was read is kept) and the whole finish FINISH_MS, so a stalled stream or store can never keep
// runJob, and the runner slot it holds, from returning. A recorded trace is PRIVATE: it is not a World until
// worldFromTrace (which accepts it only because it is redacted), and it is never published or shared across tenants.
import { randomBytes } from 'node:crypto'
import { getDb, type Db } from '../db/client.ts'
import { resolveServedCommit } from '../commit-marker.ts'
import { TraceRecorder, TRACE_VERSION, type Trace, type TraceLead } from './trace.ts'
import { redactTrace } from './redact.ts'

export type Env = Record<string, string | undefined>
export const DEFAULT_RETENTION_DAYS = 14
export const MAX_RETENTION_DAYS = 365
export const MAX_STRING_CHARS = 50_000      // one prompt, page or body; longer values are cut and marked
export const MAX_TRACE_BYTES = 2_000_000     // the whole stored trace; above this only span metadata is kept
export const SETTLE_MS = 5_000
export const FINISH_MS = 15_000

export interface TraceCaptureConfig { enabled: boolean; retentionDays: number; reason: 'on' | 'off' | 'invalid_retention' }

// Both settings are configuration (environment), not code. An invalid retention never captures: nothing is stored with a
// retention nobody chose. Purging still runs, at the default.
export function traceCaptureConfig(env: Env = process.env): TraceCaptureConfig {
  const raw = env.DAZL_TRACE_RETENTION_DAYS?.trim()
  const n = raw === undefined || raw === '' ? DEFAULT_RETENTION_DAYS : Number(raw)
  const valid = Number.isInteger(n) && n >= 1 && n <= MAX_RETENTION_DAYS
  if (env.DAZL_TRACE_CAPTURE !== '1') return { enabled: false, retentionDays: valid ? n : DEFAULT_RETENTION_DAYS, reason: 'off' }
  if (!valid) return { enabled: false, retentionDays: DEFAULT_RETENTION_DAYS, reason: 'invalid_retention' }
  return { enabled: true, retentionDays: n, reason: 'on' }
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
      const at = Math.floor(now() / 1000)
      await db.run('INSERT INTO scan_traces (id, tenant_id, job_id, attempt, created_at, bytes, trace) VALUES (?, ?, ?, ?, ?, ?, ?)', [stored.id, job.user_id, job.id, job.attempts, at, Buffer.byteLength(json), json])
      await db.run('DELETE FROM scan_traces WHERE tenant_id = ? AND created_at < ?', [job.user_id, at - cfg.retentionDays * 86_400])
      return stored.id
    } catch (e) {
      // Never into the run: the scan's outcome stands whether or not its trace was kept. No trace content in the log.
      console.error(JSON.stringify({ trace_capture: 'failed', job: job.id, error: e instanceof Error ? e.message.slice(0, 200) : 'error' }))
      return null
    }
  }
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

// Cuts every string to MAX_STRING_CHARS; if the whole trace is still over MAX_TRACE_BYTES, keeps only span metadata.
// What was cut is recorded in `capture`, so a stored trace never looks more complete than it is.
export function capTrace(t: Trace): Trace {
  let cut = 0
  const deep = (v: unknown): unknown => {
    if (typeof v === 'string') { if (v.length <= MAX_STRING_CHARS) return v; cut++; return `${v.slice(0, MAX_STRING_CHARS)}…[truncated]` }
    if (Array.isArray(v)) return v.map(deep)
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, deep(x)]))
    return v
  }
  const capped = { ...(deep(t) as Trace) }
  capped.capture = { truncated_strings: cut, ...(t.capture ?? {}) }
  if (Buffer.byteLength(JSON.stringify(capped)) <= MAX_TRACE_BYTES) return capped
  return { ...capped, spans: capped.spans.map(s => ({ ...s, input: { url: (s.input as { url?: unknown }).url ?? null, stage: (s.input as { stage?: unknown }).stage ?? null }, output: null })), capture: { ...capped.capture, spans_metadata_only: true } }
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

// The scheduled retention purge (app/api/internal/tick): every tenant's rows older than the configured retention. Runs
// whether capture is on or off, so turning capture off never leaves old traces behind.
export async function purgeExpiredTraces(db: Db, env: Env = process.env, now = Date.now()): Promise<number> {
  const { retentionDays } = traceCaptureConfig(env)
  return (await db.run('DELETE FROM scan_traces WHERE created_at < ?', [Math.floor(now / 1000) - retentionDays * 86_400])).changes
}
