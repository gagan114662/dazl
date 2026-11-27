import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import Database from 'better-sqlite3'
import { sqliteDb } from '../lib/db/client.ts'
import { migrateAllSqlite } from '../lib/db/sqlite-migrations.ts'
import { sendWorkspaceStallAlerts, workspaceStallReasons } from '../lib/ops/workspace-stalls.ts'

const HOUR = 3600
const DAY = 24 * HOUR
const NOW = 1900000000
const ENV = { OPS_ALERT_WEBHOOK_URL: 'https://alerts.example.test/hook', SEQUENCES_ENABLED: '1' }

function fixture() {
  const raw = new Database(':memory:')
  migrateAllSqlite(raw)
  const db = sqliteDb(raw)
  const alerts: unknown[] = []
  const fetchImpl: typeof fetch = async (_url, init) => {
    alerts.push(JSON.parse(String(init?.body)))
    return new Response(null, { status: 204 })
  }
  const account = (id: string, verified = true) => raw.prepare(
    'INSERT INTO users (id,email,password_hash,salt,email_verified_at) VALUES (?,?,?,?,?)',
  ).run(id, `${id}@accounts.example.test`, 'hash', 'salt', verified ? NOW : null)
  const progress = (tenant: string, kind: string, outcome: string, success: number | null, hold: string | null = null) =>
    raw.prepare(`INSERT INTO scheduler_progress (tenant_id,kind,last_attempt_at,last_success_at,last_outcome,last_hold)
      VALUES (?,?,?,?,?,?) ON CONFLICT (tenant_id,kind) DO UPDATE SET last_success_at=excluded.last_success_at,
      last_outcome=excluded.last_outcome,last_hold=excluded.last_hold`).run(tenant, kind, NOW, success, outcome, hold)
  const run = (now: number) => sendWorkspaceStallAlerts(db, { now, env: ENV, fetchImpl })
  const reasons = (id: string, now: number) => workspaceStallReasons(db, id, now, ENV)
  const addresses = () => raw.prepare('SELECT to_email FROM system_mail_outbox ORDER BY to_email').all()
  return { raw, db, account, progress, alerts, run, reasons, addresses }
}

test('#1090 reconnect alerts start after an hour, coalesce per workspace for a day and clear without notifying another tenant', async () => {
  const { raw, account, alerts, run, reasons, addresses } = fixture()
  try {
    const tenant = 'mailbox-owner'
    account(tenant)
    account('another-workspace')
    raw.prepare("INSERT INTO gmail_accounts(tenant_id,email,refresh_ct,status) VALUES(?, 'sender@example.test', 'ct', 'needs_reconnect')").run(tenant)
    assert.deepEqual(await run(NOW), { mail: 0, operator: 0 })
    assert.deepEqual(await reasons(tenant, NOW + HOUR - 1), [])
    await Promise.all([run(NOW + HOUR), run(NOW + HOUR)])
    assert.deepEqual(await reasons(tenant, NOW + HOUR), ['gmail_reconnect'])
    assert.deepEqual(await reasons('another-workspace', NOW + HOUR), [])
    assert.deepEqual(addresses(), [{ to_email: 'mailbox-owner@accounts.example.test' }])
    const hash = createHash('sha256').update(tenant).digest('hex').slice(0, 12)
    assert.equal(alerts.length, 1)
    assert.deepEqual((alerts[0] as { workspaces: unknown[] }).workspaces, [{ tenant_hash: hash, reasons: ['gmail_reconnect'] }])
    assert.doesNotMatch(JSON.stringify(alerts), /mailbox-owner|sender@example/)
    assert.deepEqual(await run(NOW + HOUR + DAY - 1), { mail: 0, operator: 0 })
    assert.deepEqual(await run(NOW + HOUR + DAY), { mail: 1, operator: 1 })
    raw.prepare("UPDATE gmail_accounts SET status='active' WHERE tenant_id=?").run(tenant)
    assert.deepEqual(await reasons(tenant, NOW + HOUR + DAY + 1), [])
    assert.deepEqual(await run(NOW + HOUR + DAY + 1), { mail: 0, operator: 0 })
  } finally { raw.close() }
})

test('#1090 detects old held work, unreadable key and six-hour reply stalls without emailing unverified accounts', async () => {
  const { raw, account, progress, run, reasons, alerts, addresses } = fixture()
  try {
    for (const id of ['held', 'sequence', 'key', 'reply']) account(id, id !== 'key')
    raw.exec(`
      INSERT INTO autopilot_settings(tenant_id,enabled) VALUES ('held',1), ('reply',1);
      INSERT INTO autopilot_work(message_id,tenant_id,lead_id,reason,authority,created_at)
        VALUES ('m','held','l','consent_required','{}',${NOW - DAY});
      INSERT INTO sequences(id,tenant_id,lead_id,message_id,to_email,status) VALUES ('q','sequence','l','m','lead@example.test','active');
      INSERT INTO tenant_llm_keys(tenant_id,vendor,ciphertext,last4,validated_at) VALUES ('key','anthropic','ct','test',${NOW - 1});
      INSERT INTO scan_jobs(id,user_id,business_name,industry,location,status,error,finished_at)
        VALUES ('s','key','Fixture','fixture','fixture','failed','key_unreadable',${NOW});
    `)
    progress('sequence', 'sequences', 'hold', null, 'consent_required')
    progress('sequence', 'reply_sync', 'success', NOW)
    progress('held', 'reply_sync', 'success', NOW)
    assert.deepEqual(await run(NOW), { mail: 1, operator: 2 })
    assert.deepEqual(await reasons('held', NOW), ['send_held'])
    assert.deepEqual(await reasons('key', NOW), ['key_unreadable'])
    assert.deepEqual(await reasons('reply', NOW + 6 * HOUR - 1), [])
    assert.deepEqual(await reasons('reply', NOW + 6 * HOUR), ['reply_stale'])
    assert.deepEqual(await reasons('sequence', NOW + DAY), ['send_held', 'reply_stale'])
    assert.doesNotMatch(JSON.stringify(alerts), /lead@example|accounts\.example/)
    assert.deepEqual(addresses(), [{ to_email: 'held@accounts.example.test' }])

    raw.exec("DELETE FROM autopilot_work; UPDATE tenant_llm_keys SET validated_at=1900000001; UPDATE sequences SET status='done'")
    progress('reply', 'reply_sync', 'success', NOW + DAY)
    progress('held', 'reply_sync', 'success', NOW + DAY)
    assert.deepEqual(await run(NOW + DAY), { mail: 0, operator: 0 })
    for (const id of ['held', 'sequence', 'key', 'reply']) assert.deepEqual(await reasons(id, NOW + DAY), [])
  } finally { raw.close() }
})
