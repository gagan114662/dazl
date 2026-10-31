// Scheduler overdue alert (issue #361; docs/SCHEDULER.md). Run every 5 minutes by ops/scheduler/dazl-scheduler-check.timer.
// Reads the app's own /api/health/scheduler (counts only) and, when it is not ok (scheduler stale, crashed or never ran
// with work waiting; the latest run failed or lost its lease with no success since; tenants blocked, reply sync stale, due work overdue) or the app does not answer, alerts:
// OPS_ALERT_WEBHOOK_URL (https; e.g. a Slack incoming webhook) or SCHEDULER_ALERT_CMD (tests; the JSON as its argument).
// The same problems alert at most once per SCHEDULER_ALERT_EVERY_S (3600); a recovery after an alert is announced once.
// Stamps live in --state-dir. The alert carries the endpoint's counts and states only: no tenant id or error text.
//   node --experimental-strip-types scripts/ops/scheduler-check.mts --url http://127.0.0.1:3100/api/health/scheduler --state-dir /var/lib/dazl-scheduler-check
// Exit 0 = ok; 1 = problem (alerted or throttled).
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const arg = (f: string) => { const i = process.argv.indexOf(f); return i >= 0 ? process.argv[i + 1] : undefined }
const url = arg('--url'), state = arg('--state-dir')
if (!url || !state) { console.error('usage: scheduler-check.mts --url <app>/api/health/scheduler --state-dir DIR'); process.exit(2) }
const u = new URL(url)
if (u.protocol !== 'https:' && !['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)) { console.error('scheduler-check: --url must be https or loopback'); process.exit(2) }

let problems: string[] = [], facts: Record<string, unknown> = {}
try {
  const r = await fetch(u, { cache: 'no-store', signal: AbortSignal.timeout(10_000) })
  const h = await r.json() as { ok: boolean; problems?: string[]; operational?: Record<string, unknown>; tenants?: Record<string, unknown> }
  problems = h.ok ? [] : (h.problems?.length ? h.problems : [`HTTP ${r.status}, not ok`])
  facts = { scheduler: h.operational?.state, last_completed_age_s: h.operational?.last_completed_age_s, lease_generation: h.operational?.lease_generation, last_failure_status: (h.operational?.unresolved_failure as { status?: string } | null | undefined)?.status ?? null, tenants: h.tenants }
} catch (e) { problems = [`scheduler health not answering (${e instanceof Error ? e.name : 'error'})`] }

const body = { level: problems.length ? 'error' : 'info', type: 'scheduler_check', ok: problems.length === 0, host: os.hostname(), at: new Date().toISOString(), problems, ...facts }
console.log(JSON.stringify(body))
// A throttle stamp is a delivery receipt, never an attempted-send receipt.
const send = async (b: object): Promise<boolean> => {
  const cmd = process.env.SCHEDULER_ALERT_CMD, hook = process.env.OPS_ALERT_WEBHOOK_URL
  if (cmd) {
    const result = spawnSync(cmd, [JSON.stringify(b)], { stdio: 'inherit', timeout: 10_000 })
    if (result.error || result.status !== 0) { console.error('scheduler-check: alert command failed'); return false }
    return true
  }
  if (!hook?.startsWith('https://')) { console.error('scheduler-check: no alert destination: set OPS_ALERT_WEBHOOK_URL (https); problems are in the journal only'); return false }
  try {
    const r = await fetch(hook, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b), signal: AbortSignal.timeout(10_000) })
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
