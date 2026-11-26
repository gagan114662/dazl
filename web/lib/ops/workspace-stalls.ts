import { createHash } from 'node:crypto'
import type Database from 'better-sqlite3'
import type { Db, Tx, TxBody } from '../db/client.ts'
import { sendSystemMail } from '../system-mail.ts'
import { alertRequest } from './alert-destination.ts'
import { alertNote, captureError } from './errors.ts'
import { HELD_AFTER_S } from './stalls.ts'

const HOUR = 3600
type Env = Record<string, string | undefined>
type Reason = keyof typeof WORKSPACE_STALL_COPY

export const WORKSPACE_STALL_COPY = {
  gmail_reconnect: { text: 'Gmail needs reconnecting before dazl can send or check replies.', href: '/app/connect-gmail', action: 'Reconnect Gmail' },
  send_held: { text: 'Your scheduled emails have been on hold for at least a day.', href: '/app/outreach', action: 'Review Outreach' },
  key_unreadable: { text: 'A search stopped because dazl could not read your saved AI key.', href: '/app/settings', action: 'Check your AI key' },
  reply_stale: { text: 'dazl has been unable to check replies for at least six hours while scheduled sending is on.', href: '/app/settings', action: 'Review reply settings' },
} as const

export function migrateWorkspaceStalls(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS workspace_stall_state (
    tenant_id TEXT PRIMARY KEY,
    gmail_since INTEGER,
    sequences_since INTEGER,
    reply_since INTEGER,
    mail_at INTEGER,
    operator_at INTEGER
  )`)
}

type State = { gmail_since: number | null; sequences_since: number | null; reply_since: number | null; mail_at: number | null; operator_at: number | null }
type Facts = State & { gmail: number; autopilot_held: number; autopilot_enabled: number; sequences_enabled: number; sequences_held: number; key_unreadable: number; last_reply: number | null }

const candidateTenants = `
  SELECT tenant_id FROM workspace_stall_state
  UNION SELECT tenant_id FROM gmail_accounts WHERE status = 'needs_reconnect'
  UNION SELECT tenant_id FROM autopilot_settings WHERE enabled = 1 AND paused = 0
  UNION SELECT tenant_id FROM sequences WHERE status IN ('approved','active')
  UNION SELECT user_id AS tenant_id FROM scan_jobs WHERE status = 'failed' AND error = 'key_unreadable' AND funded_by != 'trial'`

const factsSql = `WITH workspace AS (SELECT CAST(? AS TEXT) AS tenant_id),
  sequences_waiting AS (SELECT 1 FROM sequences WHERE tenant_id = (SELECT tenant_id FROM workspace)
    AND status IN ('active','approved') LIMIT 1)
SELECT st.gmail_since, st.sequences_since, st.reply_since, st.mail_at, st.operator_at,
  CASE WHEN g.status = 'needs_reconnect' THEN 1 ELSE 0 END AS gmail,
  CASE WHEN a.enabled = 1 AND a.paused = 0 THEN 1 ELSE 0 END AS autopilot_enabled,
  CASE WHEN EXISTS (SELECT 1 FROM autopilot_work w WHERE w.tenant_id = ws.tenant_id)
    AND NOT EXISTS (SELECT 1 FROM autopilot_work w WHERE w.tenant_id = ws.tenant_id AND w.created_at > ?) THEN 1 ELSE 0 END AS autopilot_held,
  CASE WHEN COALESCE(a.paused, 0) = 0 AND EXISTS (SELECT 1 FROM sequences_waiting) THEN 1 ELSE 0 END AS sequences_enabled,
  CASE WHEN q.last_outcome = 'hold' AND q.last_hold NOT IN ('paused','daily_cap','warmup')
    OR q.last_outcome = 'failure' AND q.last_error IN ('Error: reading_not_enabled', 'Error: gmail_or_identity',
      'Error: gmail_unavailable', 'Error: reply_sync_failed', 'Error: reply_sync_incomplete')
    THEN 1 ELSE 0 END AS sequences_held,
  CASE WHEN EXISTS (SELECT 1 FROM scan_jobs j WHERE j.user_id = ws.tenant_id AND j.status = 'failed'
    AND j.error = 'key_unreadable' AND j.funded_by != 'trial'
    AND EXISTS (SELECT 1 FROM tenant_llm_keys k WHERE k.tenant_id = ws.tenant_id
      AND k.validated_at <= COALESCE(j.finished_at, ?))) THEN 1 ELSE 0 END AS key_unreadable,
  p.last_success_at AS last_reply
FROM workspace ws
LEFT JOIN workspace_stall_state st ON st.tenant_id = ws.tenant_id
LEFT JOIN gmail_accounts g ON g.tenant_id = ws.tenant_id
LEFT JOIN autopilot_settings a ON a.tenant_id = ws.tenant_id
LEFT JOIN scheduler_progress q ON q.tenant_id = ws.tenant_id AND q.kind = 'sequences'
LEFT JOIN scheduler_progress p ON p.tenant_id = ws.tenant_id AND p.kind = 'reply_sync'`

function inspect(f: Facts, now: number, env: Env) {
  const sendsOn = env.AUTOPILOT_KILL !== '1'
  const autopilot = sendsOn && Number(f.autopilot_enabled) === 1
  const sequences = sendsOn && env.SEQUENCES_ENABLED === '1' && Number(f.sequences_enabled) === 1
  const gmail = Number(f.gmail) === 1 ? Number(f.gmail_since ?? now) : null
  const held = sequences && Number(f.sequences_held) === 1 ? Number(f.sequences_since ?? now) : null
  const reply = autopilot || sequences ? Number(f.reply_since ?? now) : null
  const reasons: Reason[] = []
  if (gmail !== null && gmail <= now - HOUR) reasons.push('gmail_reconnect')
  if ((autopilot && Number(f.autopilot_held) === 1) || (held !== null && held <= now - HELD_AFTER_S)) reasons.push('send_held')
  if (Number(f.key_unreadable) === 1) reasons.push('key_unreadable')
  if (reply !== null && Math.max(reply, Number(f.last_reply ?? 0)) <= now - 6 * HOUR) reasons.push('reply_stale')
  return { gmail, held, reply, reasons }
}

export async function workspaceStallReasons(db: Db, tenantId: string, now = Math.floor(Date.now() / 1000), env: Env = process.env): Promise<Reason[]> {
  const facts = await db.get<Facts>(factsSql, [tenantId, now - HELD_AFTER_S, now])
  return facts ? inspect(facts, now, env).reasons : []
}

const due = (at: number | null, now: number) => at === null || Number(at) <= now - HELD_AFTER_S
type Recipient = { id: string; email: string }
type Alert = { tenant_hash: string; reasons: Reason[] }
type Options = { now?: number; env?: Env; fetchImpl?: typeof fetch; fence?: (t: Tx) => TxBody<void> }

function* claim(t: Tx, tenantId: string, now: number, env: Env, operatorEnabled: boolean, fence?: Options['fence']) {
  if (fence) yield* fence(t)
  // Serialize notice claims even when two scheduler instances observe the same workspace.
  yield* t.run(`INSERT INTO workspace_stall_state (tenant_id)
    SELECT ? WHERE NOT EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant = ?)
    ON CONFLICT (tenant_id) DO NOTHING`, [tenantId, tenantId])
  if (!(yield* t.get('SELECT 1 FROM workspace_stall_state WHERE tenant_id = ?', [tenantId]))) return null
  yield* t.run('UPDATE workspace_stall_state SET gmail_since = gmail_since WHERE tenant_id = ?', [tenantId])
  const f = yield* t.get<Facts>(factsSql, [tenantId, now - HELD_AFTER_S, now])
  if (!f) return null
  const { gmail, held, reply, reasons } = inspect(f, now, env)
  let recipient: Recipient | undefined
  if (reasons.length && due(f.mail_at, now)) {
    recipient = yield* t.get<Recipient>(`SELECT id,email FROM users WHERE email_verified_at IS NOT NULL
      AND id = COALESCE((SELECT created_by FROM organizations WHERE id = ?), ?)`, [tenantId, tenantId])
  }
  const operator = reasons.length > 0 && operatorEnabled && due(f.operator_at, now)
  if (!reasons.length && gmail === null && held === null && reply === null && due(f.mail_at, now) && due(f.operator_at, now)) {
    yield* t.run('DELETE FROM workspace_stall_state WHERE tenant_id = ?', [tenantId])
  } else {
    yield* t.run(`UPDATE workspace_stall_state SET gmail_since=?, sequences_since=?, reply_since=?, mail_at=?, operator_at=?
      WHERE tenant_id=?`, [gmail, held, reply, recipient ? now : f.mail_at, operator ? now : f.operator_at, tenantId])
  }
  return { recipient, reasons, operator }
}

export async function sendWorkspaceStallAlerts(db: Db, { now = Math.floor(Date.now() / 1000), env = process.env, fetchImpl = fetch, fence }: Options = {}) {
  const sink = env.OPS_ALERT_WEBHOOK_URL
  const operatorEnabled = alertRequest(sink, {}, 'dazl workspace stall') !== null
  const found = await db.all<{ tenant_id: string }>(candidateTenants)
  const alerts: Alert[] = []
  let mail = 0
  for (const { tenant_id: tenantId } of found) {
    const notice = await db.tx(t => claim(t, tenantId, now, env, operatorEnabled, fence))
    if (!notice) continue
    const { recipient, reasons, operator } = notice
    if (operator) alerts.push({ tenant_hash: createHash('sha256').update(tenantId).digest('hex').slice(0, 12), reasons })
    if (!recipient) continue
    const base = (env.PUBLIC_BASE_URL || 'https://dazl.ai').replace(/\/+$/, '')
    const text = reasons.map(reason => {
      const copy = WORKSPACE_STALL_COPY[reason]
      return `${copy.text}\n${copy.action}: ${base}${copy.href}`
    }).join('\n\n')
    try {
      await sendSystemMail(db, { userId: recipient.id, to: recipient.email, subject: 'Your dazl workspace needs attention', text }, env)
      mail++
    } catch (e) {
      captureError(e, { source: 'worker', where: 'tick:workspace-stall-mail' })
    }
  }
  let operator = 0
  // Keep each message under the existing destination's text limit even when several workspaces stall together.
  for (let i = 0; i < alerts.length; i += 25) {
    const workspaces = alerts.slice(i, i + 25)
    const counts: Partial<Record<Reason, number>> = {}
    for (const row of workspaces) for (const reason of row.reasons) counts[reason] = (counts[reason] ?? 0) + 1
    const text = `dazl: ${workspaces.length} workspace(s) need attention\n` +
      workspaces.map(row => `${row.tenant_hash} ${row.reasons.join(', ')}`).join('\n')
    const request = alertRequest(sink, { type: 'workspace_stall', counts, workspaces }, text)
    if (!request) continue
    try {
      const response = await fetchImpl(request.url, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: request.body, signal: AbortSignal.timeout(5000), redirect: 'error' })
      if (response.ok) operator += workspaces.length
      else alertNote({ type: 'alert_delivery', sink: 'alert', status: response.status })
    } catch {
      alertNote({ type: 'alert_delivery', sink: 'alert', reason: 'network' })
    }
  }
  return { mail, operator }
}
