// #1040: Home's last-30-days results from stored rows, tenant-scoped, on SQLite and Postgres.
import assert from 'node:assert/strict'
import { bothEngines } from './helpers/engines.ts'
import type { Db } from '../lib/db/client.ts'
import { homeResults, signalLabel } from '../lib/outreach/home-results.ts'
import { test } from 'node:test'

const NOW = 1_800_000_000, DAY = 86400
const OLD = NOW - 40 * DAY, IN = NOW - 5 * DAY

async function seed(db: Db) {
  for (const [id, user] of [['j'.repeat(24), 'A'], ['k'.repeat(24), 'B']]) await db.run("INSERT INTO scan_jobs (id, user_id, business_name, industry, location, status, created_at) VALUES (?, ?, 'x', 'test', 'test', 'running', ?)", [id, user, IN])
  const lead = (id: string, job: string, kind: string | null, created: number, quarantined = false) => db.run(
    "INSERT INTO leads (id, scan_job_id, company, signal, source_url, signal_kind, created_at, quarantined_at) VALUES (?, ?, ?, 'hiring an SDR', 'https://news.example/a', ?, ?, ?)",
    [id, job, `Co ${id}`, kind, created, quarantined ? IN : null])
  const J = 'j'.repeat(24), K = 'k'.repeat(24)
  await lead('a1', J, 'hiring', IN); await lead('a2', J, 'hiring', IN); await lead('a3', J, 'raised_funding', IN)
  await lead('a4', J, 'raised_funding', OLD)            // found before the window: not a new lead (its email still counts if sent in the window)
  await lead('a5', J, 'hiring', IN, true)               // rejected: never counted
  await lead('a6', J, null, IN)                         // no type
  await lead('b1', K, 'hiring', IN)                     // another tenant
  await lead('a7', J, 'hiring', OLD); await lead('a8', J, 'hiring', OLD); await lead('a9', J, 'hiring', OLD)   // older leads for the edge cases below
  const msg = (id: string, tenant: string, leadId: string, status: string, sentAt: number | null, isTest = 0) => db.run(
    "INSERT INTO outreach_messages (id, tenant_id, lead_id, to_email, subject, body, status, created_at, sent_at, test) VALUES (?, ?, ?, 'x@co.example', 'Hello there', 'A short first email body for the test.', ?, ?, ?, ?)",
    [id, tenant, leadId, status, sentAt ?? IN, sentAt, isTest])
  await msg('m1', 'A', 'a1', 'sent', IN); await msg('m2', 'A', 'a2', 'sent', IN); await msg('m3', 'A', 'a3', 'sent', IN)
  await msg('m4', 'A', 'a4', 'sent', IN)                // sent in the window to an older lead
  await msg('m5', 'A', 'a6', 'sent', OLD)               // sent before the window: not contacted
  await msg('m6', 'A', 'a5', 'draft', null)             // not sent
  await msg('m7', 'B', 'b1', 'sent', IN)                // another tenant
  await msg('m8', 'A', 'a9', 'sent', IN, 1)             // a test send: never contacted, its reply never counted
  await msg('m10', 'A', 'a7', 'sent', NOW - 30 * DAY)   // exactly 30 days ago: inside the window
  await msg('m11', 'A', 'a8', 'sent', NOW - 30 * DAY - 1) // one second earlier: outside
  const reply = (gid: string, tenant: string, msgId: string, cls: string, at = IN + DAY) => db.run(
    "INSERT INTO inbound_messages (gmail_id, tenant_id, thread_id, lead_id, from_email, excerpt, classification, received_at, outreach_message_id) VALUES (?, ?, ?, NULL, 'p@co.example', 'hi', ?, ?, ?)",
    [gid, tenant, `t-${msgId}`, cls, at, msgId])
  await reply('g1', 'A', 'm1', 'positive'); await reply('g2', 'A', 'm1', 'other', IN + 2 * DAY)   // two replies, one message: counted once
  await reply('g3', 'A', 'm3', 'negative')
  await reply('g4', 'A', 'm2', 'auto'); await reply('g5', 'A', 'm4', 'bounce_review'); await reply('g9', 'A', 'm4', 'soft_bounce')   // not person-written (the classifier's real bounce values)
  await reply('g7', 'A', 'm8', 'positive')                                                        // to a test send
  await reply('g8', 'A', 'm5', 'positive')                                                        // received in the window, to a message sent before it
  await reply('g6', 'B', 'm7', 'positive')                                                        // another tenant
}

bothEngines('#1040: the last 30 days - new leads, contacted, replied, interested - from stored rows, tenant-scoped; by signal adds up', async ({ db }) => {
  await seed(db)
  const r = await homeResults(db, 'A', NOW)
  assert.deepEqual(r.tiles, { leads: 4, contacted: 5, replied: 2, interested: 1 })
  assert.deepEqual(r.by_signal.map(s => [s.signal, s.leads, s.contacted, s.replied]),
    [['hiring', 2, 3, 1], ['raised_funding', 1, 2, 1], ['unknown', 1, 0, 0]])
  for (const k of ['leads', 'contacted', 'replied'] as const) assert.equal(r.by_signal.reduce((n, s) => n + s[k], 0), r.tiles[k], `by signal adds up to the ${k} tile`)
  assert.equal(r.latest_leads.length, 4); assert.ok(r.latest_leads.every(l => l.company.startsWith('Co a')), 'only this tenant\'s leads')
  assert.deepEqual(r.latest_replies.map(x => [x.company, x.classification]), [['Co a1', 'other'], ['Co a3', 'negative'], ['Co a1', 'positive']], 'person-written replies to messages sent in the window only, newest first (same time: the newest gmail id first)')
  // another tenant sees only its own
  assert.deepEqual((await homeResults(db, 'B', NOW)).tiles, { leads: 1, contacted: 1, replied: 1, interested: 1 })
  // a new workspace: zeros, empty lists
  const z = await homeResults(db, 'nobody', NOW)
  assert.deepEqual(z.tiles, { leads: 0, contacted: 0, replied: 0, interested: 0 }); assert.deepEqual([z.by_signal, z.latest_leads, z.latest_replies], [[], [], []])
})

test('#1040: signal types read as words', () => {
  assert.equal(signalLabel('raised_funding'), 'Raised funding'); assert.equal(signalLabel('unknown'), 'No signal type')
})

test('#1040: the 30-day reads use indexes (no full scan of messages, replies or leads)', async () => {
  const Database = (await import('better-sqlite3')).default
  const { migrateAllSqlite } = await import('../lib/db/sqlite-migrations.ts')
  const raw = new Database(':memory:'); migrateAllSqlite(raw)
  const plan = (sql: string, ...p: unknown[]) => (raw.prepare('EXPLAIN QUERY PLAN ' + sql).all(...p) as { detail: string }[]).map(r => r.detail).join(' | ')
  const sent = plan("SELECT COUNT(*) FROM outreach_messages m JOIN leads l ON l.id = m.lead_id WHERE m.tenant_id = ? AND m.status = 'sent' AND m.sent_at >= ? AND COALESCE(m.test, 0) = 0", 'A', 0)
  const replies = plan("SELECT r.thread_id FROM inbound_messages r WHERE r.tenant_id = ? AND r.received_at >= ? ORDER BY r.received_at DESC LIMIT 5", 'A', 0)
  const matched = plan("SELECT 1 FROM inbound_messages r WHERE r.tenant_id = ? AND r.outreach_message_id = ? AND r.classification = 'positive'", 'A', 'm')
  const leads = plan('SELECT COUNT(*) FROM leads l JOIN scan_jobs j ON j.id = l.scan_job_id WHERE j.user_id = ? AND l.created_at >= ?', 'A', 0)
  for (const [name, p] of [['sent', sent], ['replies', replies], ['matched', matched], ['leads', leads]] as const) {
    assert.doesNotMatch(p, /\bSCAN (m|r|outreach_messages|inbound_messages)\b(?! USING)/, `${name}: ${p}`)
    assert.match(p, /USING (COVERING )?INDEX/, `${name}: ${p}`)
  }
  assert.match(replies, /inbound_messages_tenant_received/, replies)
  assert.match(matched, /inbound_messages_outreach/, matched)
})

test('#1040 route: the real handler answers 401 / 503 / 200 no-store (child process, its own session and Db)', async () => {
  const { spawnSync } = await import('node:child_process')
  const { fileURLToPath } = await import('node:url')
  const env = { ...process.env }; delete env.NODE_TEST_CONTEXT
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', '--import', './test/helpers/net-fence.ts', '--loader', './test/helpers/tenant-route-loader.mjs', '--test-reporter=tap', '--test', './test/helpers/home-results-route-runtime.mts'],
    { cwd: fileURLToPath(new URL('../', import.meta.url)), env, encoding: 'utf8', timeout: 120000 })
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.match(r.stdout, /# pass 1/); assert.match(r.stdout, /# fail 0/)
})
