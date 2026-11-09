// Scheduler overdue alert (issue #361; docs/SCHEDULER.md). Run every 5 minutes by ops/scheduler/dazl-scheduler-check.timer.
// Reads the app's own /api/health/scheduler (counts only) and, when it is not ok (scheduler stale, crashed or never ran
// with work waiting; the latest run failed or lost its lease with no success since; tenants blocked, reply sync stale, due work overdue) or the app does not answer, alerts:
// OPS_ALERT_WEBHOOK_URL (https; e.g. a Slack incoming webhook) or SCHEDULER_ALERT_CMD (tests; the JSON as its argument).
// The webhook body is the structured JSON plus a Slack-compatible `text` summary. Both carry allowlisted counts and states only (built at the send boundary, see below).
// The same problems alert at most once per SCHEDULER_ALERT_EVERY_S (3600); a recovery after an alert is announced once.
// Stamps live in --state-dir. The alert carries the endpoint's counts and states only: no tenant id or error text.
//   node --experimental-strip-types scripts/ops/scheduler-check.mts --url http://127.0.0.1:3100/api/health/scheduler --state-dir /var/lib/dazl-scheduler-check
// Exit 0 = ok; 1 = problem (alerted or throttled).
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// Must equal OVERDUE_ALERT_S in lib/ops/scheduler-runs.ts (the endpoint's own threshold wording).
const OVERDUE_ALERT_S = 60 * 60
const arg = (f: string) => { const i = process.argv.indexOf(f); return i >= 0 ? process.argv[i + 1] : undefined }
const url = arg('--url'), state = arg('--state-dir')
if (!url || !state) { console.error('usage: scheduler-check.mts --url <app>/api/health/scheduler --state-dir DIR'); process.exit(2) }
const u = new URL(url)
if (u.protocol !== 'https:' && !['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)) { console.error('scheduler-check: --url must be https or loopback'); process.exit(2) }

// Counts-and-states only, enforced HERE (the send boundary) and not by trusting the endpoint's output: only allowlisted fields with valid values are read, and every problem line is built
// from those known states and counts, never copied from the response. Anything else (extra fields, a token in a problem string, a non-string entry, a non-object body) is dropped
// without being echoed, and malformed input is a problem to report, never a crash.
const STATES = new Set(['never_ran', 'running', 'fresh', 'stale', 'crashed']), FAILS = new Set(['failed', 'lease_lost'])
const ERRS = new Set(['TimeoutError', 'AbortError', 'TypeError', 'SyntaxError'])
const num = (v: unknown): number | null => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null
const obj = (v: unknown): Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {}
const TENANT_KEYS = ['tracked', 'blocked', 'held', 'reply_sync_stale', 'overdue', 'oldest_overdue_s'] as const
let problems: string[] = [], facts: Record<string, unknown> = {}
try {
  const r = await fetch(u, { cache: 'no-store', signal: AbortSignal.timeout(10_000) })
  const raw: unknown = await r.json().catch(() => undefined)
  const h = obj(raw), op = obj(h.operational), t = obj(h.tenants)
  const state = typeof op.state === 'string' && STATES.has(op.state) ? op.state : null
  const age = num(op.last_completed_age_s)
  const fail = (() => { const f = obj(op.unresolved_failure).status; return typeof f === 'string' && FAILS.has(f) ? f : null })()
  const tenants: Record<string, number> = {}
  for (const k of TENANT_KEYS) { const n = num(t[k]); if (n !== null) tenants[k] = n }
  facts = { scheduler: state ?? undefined, last_completed_age_s: age ?? undefined, lease_generation: num(op.lease_generation) ?? undefined, last_failure_status: fail, tenants }
  // What the allowlisted fields themselves show, whatever `ok` claims (an endpoint saying ok:true while a state is stale or a tenant is blocked is not healthy).
  const derived: string[] = []
  if (state === 'stale' || state === 'crashed') derived.push(`scheduler ${state}${age !== null ? `: last completed run ${age}s ago` : ': no completed run'}`)
  if (fail) derived.push(`latest scheduler run ${fail}: no successful run since`)
  if (state === 'never_ran' && (tenants.tracked ?? 0) > 0) derived.push('scheduler never ran, but tenants have scheduled work')
  if (tenants.blocked) derived.push(`${tenants.blocked} tenant(s) blocked by repeated failures`)
  if (tenants.reply_sync_stale) derived.push(`${tenants.reply_sync_stale} tenant(s) with stale reply sync`)
  if (tenants.overdue) derived.push(`${tenants.overdue} tenant(s) with due work overdue by more than ${OVERDUE_ALERT_S}s${tenants.oldest_overdue_s != null ? ` (oldest ${tenants.oldest_overdue_s}s)` : ''}`)
  // Healthy (and so a recovery) needs ALL of: a successful HTTP status, ok literally true, a valid state and a tracked count, and no problem reconstructed from the fields.
  // Anything less keeps the problem (and any prior alert receipt) and says so plainly, copying nothing from the response.
  if (!r.ok || h.ok !== true) problems = derived.length ? derived : [`HTTP ${r.status}, not ok`]
  else if (derived.length) problems = derived
  else if (state === null || tenants.tracked === undefined) problems = [`scheduler health unreadable (HTTP ${r.status})`]
} catch (e) { problems = [`scheduler health not answering (${ERRS.has(e instanceof Error ? e.name : '') ? (e as Error).name : 'error'})`] }

const body = { level: problems.length ? 'error' : 'info', type: 'scheduler_check', ok: problems.length === 0, host: os.hostname(), at: new Date().toISOString(), problems, ...facts }
console.log(JSON.stringify(body))
// One human-readable block for Slack-style receivers, built from the same allowlisted fields as the JSON.
const summary = (b: { type: string; host?: string; problems: string[]; scheduler?: unknown }): string => b.type === 'scheduler_recovered'
  ? `dazl scheduler recovered${b.host ? ` on ${b.host}` : ''}: health is ok again.`
  : ([`dazl scheduler problem${b.host ? ` on ${b.host}` : ''}${b.scheduler ? ` (${String(b.scheduler)})` : ''}:`, ...b.problems.map(x => `- ${x}`)].join('\n'))
// A throttle stamp is a delivery receipt, never an attempted-send receipt.
const send = async (b: { type: string; host?: string; problems: string[]; scheduler?: unknown }): Promise<boolean> => {
  const cmd = process.env.SCHEDULER_ALERT_CMD, hook = process.env.OPS_ALERT_WEBHOOK_URL
  if (cmd) {
    const result = spawnSync(cmd, [JSON.stringify(b)], { stdio: 'inherit', timeout: 10_000 })
    if (result.error || result.status !== 0) { console.error('scheduler-check: alert command failed'); return false }
    return true
  }
  if (!hook?.startsWith('https://')) { console.error('scheduler-check: no alert destination: set OPS_ALERT_WEBHOOK_URL (https); problems are in the journal only'); return false }
  try {
    const r = await fetch(hook, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: summary(b), ...b }), signal: AbortSignal.timeout(10_000) })
    if (!r.ok) { console.error(`scheduler-check: alert webhook HTTP ${r.status}`); return false }
    return true
  } catch (e) { console.error(`scheduler-check: alert webhook failed (${e instanceof Error ? e.name : 'error'})`); return false }
}
mkdirSync(state, { recursive: true, mode: 0o700 })
const stamps = () => readdirSync(state).filter(f => f.startsWith('alert-'))
if (!problems.length) {
  if (stamps().length) {
    if (!await send({ ...body, type: 'scheduler_recovered' })) process.exit(1)
    for (const f of stamps()) rmSync(path.join(state, f))
  }
  process.exit(0)
}
const every = Number(process.env.SCHEDULER_ALERT_EVERY_S ?? 3600)
// numbers in the messages change every run; the kind of problem is what is throttled
const stamp = path.join(state, 'alert-' + createHash('sha256').update(problems.map(p => p.replace(/\d+/g, 'N')).join('\n')).digest('hex').slice(0, 16))
if (existsSync(stamp) && Date.now() - statSync(stamp).mtimeMs < every * 1000) { console.error('scheduler-check: alert already sent for these problems within the interval'); process.exit(1) }
if (await send(body)) writeFileSync(stamp, '')
process.exit(1)
