// #411 live-journey enabler: the test-only first-touch fixture creates ONE lead the REAL autopilot may draft to once the
// user confirms it, and nothing else. Every later step here runs through the real code: confirmLeadReview (the confirm
// route's rule), runAutopilot / drainFirstTouch (the scheduler tick's passes), createDraft, the holds and the send gates.
// Stub Gmail only: sendFn records the raw message, nothing leaves the process.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import Database from 'better-sqlite3'
import { seedOffers } from './helpers/seed-offer.ts'
import { migrateAllSqlite } from '../lib/db/sqlite-migrations.ts'
import { sqliteDb } from '../lib/db/client.ts'
import { completeOAuth, startOAuth } from '../lib/gmail/oauth.ts'
import { saveSettings, TEST_INBOX, draftBlockReason, type Deps } from '../lib/outreach/service.ts'
import { setTestAddresses } from '../lib/outreach/sequences.ts'
import { ATTESTATIONS, CONSENT_VERSION, drainFirstTouch, enable, migrateAutopilot, pause, resume, runAutopilot } from '../lib/outreach/autopilot.ts'
import { confirmLeadReview } from '../lib/scan/review-confirm.ts'
import { createFirstTouchFixture, deleteFirstTouchFixture, firstTouchFixtureExists, FIRST_TOUCH_FIXTURE_COMPANY } from '../lib/scan/first-touch-fixture.ts'
import { createVerificationFixture } from '../lib/scan/verification-fixture.ts'
import { accountSendCount, anyUncertainSend } from '../lib/outreach/send-budget.ts'

const T = 'first-touch-fixture-tenant'
const master = randomBytes(32)
const genv = { GOOGLE_CLIENT_ID: 'cid.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'cs', PUBLIC_BASE_URL: 'https://app.test' }
const NOW = 1_800_000_000
const ON = { AUTOPILOT_ENABLED: '1', AUTOPILOT_WARMUP: '2' }
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status })
const idToken = (email: string) => 'x.' + Buffer.from(JSON.stringify({ email, email_verified: true })).toString('base64url') + '.y'
const tokenOk = (async (url: string) => (String(url).includes('token') ? json({ access_token: 'at' }) : json({}, 404))) as unknown as typeof fetch

async function setup(opts: { allowlist?: boolean } = {}) {
  const db = new Database(':memory:'); migrateAllSqlite(db); migrateAutopilot(db); seedOffers(db, [T])
  process.env.OUTREACH_TEST_TENANT_ID = T
  if (opts.allowlist !== false) setTestAddresses(db, T, [TEST_INBOX])
  const state = new URL(startOAuth(db, T, { env: genv, now: NOW })).searchParams.get('state')!
  await completeOAuth(db, T, 'c', state, { env: genv, master, now: NOW, fetchImpl: (async () => json({ refresh_token: 'rt', scope: 'https://www.googleapis.com/auth/gmail.send', id_token: idToken('me@acme.example') })) as unknown as typeof fetch })
  saveSettings(db, T, { sender_name: 'Pat', postal_address: '1 King St W, Toronto ON M5H 1A1' })
  return db
}
const stub = (now: number) => {
  const calls: string[] = []
  const d: Deps & { flags: Record<string, string> } = { flags: ON, env: genv, master, now, baseUrl: 'https://app.test', fetchImpl: tokenOk, sendFn: (async (_t: string, raw: string) => { calls.push(raw); return { id: 'g' + calls.length } }) as never }
  return { calls, d }
}
const on = (db: Database.Database, cap = 1) => enable(db, T, { version: CONSENT_VERSION, attestations: [...ATTESTATIONS], daily_cap: cap })
// Two old manual sends (outside every cap window) clear the warmup gate (AUTOPILOT_WARMUP=2).
const warmed = (db: Database.Database) => db.prepare("INSERT INTO outreach_messages (id, tenant_id, lead_id, to_email, subject, body, status, sent_at, claimed_at) VALUES ('w1a2b3c4d5e6f7a8b9c0d1e2',?,'x1','o1@z.example','s','bodybodybodybodybodybody','sent',?,?),('w2a2b3c4d5e6f7a8b9c0d1e2',?,'x2','o2@z.example','s','bodybodybodybodybodybody','sent',?,?)").run(T, NOW - 9e5, NOW - 9e5, T, NOW - 9e5, NOW - 9e5)
// The daily cap already used today by one earlier autopilot send, one hour ago.
const capUsed = (db: Database.Database) => db.prepare("INSERT INTO autopilot_audit (id, tenant_id, action, detail, created_at) VALUES (?, ?, 'sent', 'z.example', ?)").run(randomBytes(12).toString('hex'), T, NOW - 3600)
const msgs = (db: Database.Database, leadId: string) => db.prepare('SELECT id, to_email, status, test, hold_reason FROM outreach_messages WHERE tenant_id = ? AND lead_id = ?').all(T, leadId) as { id: string; to_email: string; status: string; test: number; hold_reason: string | null }[]

test('gate: only the designated test tenant with the allowlisted test inbox; idempotent; one labelled lead and nothing else', async () => {
  const db = await setup()
  assert.throws(() => createFirstTouchFixture(db, 'someone-else'), /test_tenant_only/)
  for (const bad of ['', null, undefined, 42, ['x'], { id: T }] as unknown[]) assert.throws(() => createFirstTouchFixture(db, bad as string), /test_tenant_only/)
  assert.throws(() => deleteFirstTouchFixture(db, 'someone-else'), /test_tenant_only/)
  const saved = process.env.OUTREACH_TEST_TENANT_ID
  delete process.env.OUTREACH_TEST_TENANT_ID
  assert.throws(() => createFirstTouchFixture(db, T), /test_tenant_only/)
  process.env.OUTREACH_TEST_TENANT_ID = saved
  const noAllow = await setup({ allowlist: false })
  assert.throws(() => createFirstTouchFixture(noAllow, T), /test_tenant_only/)

  const f = createFirstTouchFixture(db, T, NOW)
  assert.equal(f.created, true)
  assert.deepEqual(createFirstTouchFixture(db, T, NOW), { jobId: f.jobId, leadId: f.leadId, created: false })
  assert.equal(firstTouchFixtureExists(db, T), true); assert.equal(firstTouchFixtureExists(db, 'someone-else'), false)
  assert.equal((db.prepare('SELECT count(*) n FROM leads WHERE company = ?').get(FIRST_TOUCH_FIXTURE_COMPANY) as { n: number }).n, 1)
  const lead = db.prepare('SELECT l.contact, l.company, l.signal, l.source_url, l.review_reason, l.human_confirmed_at, l.source_kind, j.status, j.business_name, j.run_budget, j.funded_by FROM leads l JOIN scan_jobs j ON j.id = l.scan_job_id WHERE l.id = ?').get(f.leadId) as Record<string, unknown>
  assert.equal(lead.contact, TEST_INBOX)
  assert.match(String(lead.company), /\(test only\)/); assert.match(String(lead.business_name), /\(test only\)/)
  assert.match(String(lead.signal), /Test-only/); assert.match(String(lead.source_url), /test-only/)
  assert.equal(lead.review_reason, 'quote_unconfirmed', 'held in review until a person confirms it')
  assert.equal(lead.human_confirmed_at, null, 'the fixture never claims a human confirmation')
  assert.equal(lead.source_kind, 'test'); assert.equal(lead.status, 'done'); assert.equal(lead.run_budget, null); assert.equal(lead.funded_by, 'user')
  // lead only: no draft, no hold, no autopilot setting, no audit
  assert.equal((db.prepare('SELECT count(*) n FROM outreach_messages WHERE tenant_id = ?').get(T) as { n: number }).n, 0)
  assert.equal((db.prepare('SELECT count(*) n FROM autopilot_work').get() as { n: number }).n, 0)
  assert.equal((db.prepare('SELECT count(*) n FROM autopilot_settings').get() as { n: number }).n, 0)
  assert.equal((db.prepare('SELECT count(*) n FROM autopilot_audit').get() as { n: number }).n, 0)
})

test('real journey: unconfirmed lead is never drafted; after the real confirm, autopilot drafts it to the test inbox, holds it at the daily cap, and the scheduler drain sends it exactly once at the due time with no new scan', async () => {
  const db = await setup(); on(db, 1); warmed(db); capUsed(db)
  const f = createFirstTouchFixture(db, T, NOW)
  // before the user confirms it: the real draft gate refuses it and autopilot creates nothing
  assert.equal(draftBlockReason(db, T, f.leadId), 'lead_currentness_unconfirmed')
  const s0 = stub(NOW)
  await runAutopilot(db, T, 'Acme', s0.d)
  assert.equal(msgs(db, f.leadId).length, 0); assert.equal(s0.calls.length, 0)
  // the real confirm rule (POST /api/leads/[lead]/confirm)
  assert.equal(await confirmLeadReview(sqliteDb(db), T, f.leadId, NOW + 60), true)
  assert.equal(draftBlockReason(db, T, f.leadId), null, 'confirmed: the real draft gate accepts it')
  // a tick after the confirmation: the earlier refusal does not keep it out; drafted and held at the daily cap
  const s1 = stub(NOW + 120)
  const r1 = await runAutopilot(db, T, 'Acme', s1.d)
  assert.equal(s1.calls.length, 0); assert.equal(r1.sent, 0); assert.equal(r1.held, 1)
  const [m] = msgs(db, f.leadId)
  assert.equal(m.to_email, TEST_INBOX); assert.equal(m.status, 'draft'); assert.equal(m.test, 1)
  const work = db.prepare('SELECT reason, next_at FROM autopilot_work WHERE tenant_id = ? AND message_id = ?').get(T, m.id) as { reason: string; next_at: number }
  assert.equal(work.reason, 'daily_cap'); assert.ok(work.next_at > NOW + 120 && work.next_at <= NOW - 3600 + 86401, `due when the earlier send leaves the 24h window: ${work.next_at}`)
  // before the due time: nothing goes out
  const early = stub(NOW + 3600)
  assert.equal((await drainFirstTouch(db, T, early.d)).sent + (await runAutopilot(db, T, 'Acme', early.d)).sent, 0)
  assert.equal(early.calls.length, 0)
  // paused: the due work does not go
  pause(db, T)
  const paused = stub(NOW + 86400)
  assert.equal((await runAutopilot(db, T, 'Acme', paused.d)).stopped, 'paused')
  assert.equal(paused.calls.length, 0)
  resume(db, T)
  // due: exactly one stub send, to the own test inbox, and none on the next tick
  const due = stub(NOW + 86400)
  const r2 = await runAutopilot(db, T, 'Acme', due.d)
  assert.equal(r2.sent, 1); assert.equal(due.calls.length, 1)
  assert.match(Buffer.from(due.calls[0], 'base64url').toString('utf8') + due.calls[0], new RegExp(TEST_INBOX.replace('.', '\\.')))
  assert.equal(msgs(db, f.leadId)[0].status, 'sent')
  const again = stub(NOW + 86400 + 60)
  await runAutopilot(db, T, 'Acme', again.d); await drainFirstTouch(db, T, again.d)
  assert.equal(again.calls.length, 0)
  assert.equal(msgs(db, f.leadId).length, 1)
})

test('warmup: the confirmed fixture is drafted but held for the user (old manual policy), never auto-sent', async () => {
  const db = await setup(); on(db, 5) // no prior sends: the warmup gate still applies
  const f = createFirstTouchFixture(db, T, NOW)
  await confirmLeadReview(sqliteDb(db), T, f.leadId, NOW + 60)
  for (const t of [NOW + 120, NOW + 86400, NOW + 3 * 86400]) {
    const s = stub(t)
    await runAutopilot(db, T, 'Acme', s.d); await drainFirstTouch(db, T, s.d)
    assert.equal(s.calls.length, 0)
  }
  const ms = msgs(db, f.leadId)
  assert.equal(ms.length, 1); assert.equal(ms[0].status, 'draft')
  const w = db.prepare('SELECT reason, next_at FROM autopilot_work WHERE tenant_id = ? AND message_id = ?').get(T, ms[0].id) as { reason: string; next_at: number | null }
  assert.equal(w.reason, 'warmup'); assert.equal(w.next_at, null, 'never due: the user approves it')
})

test('cleanup: removes the fixture and what the real paths attached to its lead, keeps the audit, refuses while a send is in flight or uncertain, never touches other rows', async () => {
  const db = await setup(); on(db, 1); warmed(db); capUsed(db)
  createVerificationFixture(db, T, NOW) // a sibling fixture: untouched by this cleanup
  const f = createFirstTouchFixture(db, T, NOW)
  await confirmLeadReview(sqliteDb(db), T, f.leadId, NOW + 60)
  await runAutopilot(db, T, 'Acme', stub(NOW + 120).d)
  const [m] = msgs(db, f.leadId)
  assert.ok(db.prepare('SELECT 1 FROM autopilot_work WHERE message_id = ?').get(m.id))
  const auditBefore = (db.prepare('SELECT count(*) n FROM autopilot_audit WHERE tenant_id = ?').get(T) as { n: number }).n
  for (const st of ['sending', 'uncertain']) {
    db.prepare('UPDATE outreach_messages SET status = ? WHERE id = ?').run(st, m.id)
    assert.throws(() => deleteFirstTouchFixture(db, T), /send_in_flight/)
    assert.ok(db.prepare('SELECT 1 FROM leads WHERE id = ?').get(f.leadId), 'nothing removed on refusal')
    assert.ok(db.prepare('SELECT 1 FROM outreach_messages WHERE id = ?').get(m.id))
  }
  db.prepare("UPDATE outreach_messages SET status = 'draft' WHERE id = ?").run(m.id)
  assert.deepEqual(deleteFirstTouchFixture(db, T), { deleted: true })
  assert.equal(db.prepare('SELECT 1 FROM leads WHERE id = ?').get(f.leadId), undefined)
  assert.equal(db.prepare('SELECT 1 FROM scan_jobs WHERE id = ?').get(f.jobId), undefined)
  assert.equal(db.prepare('SELECT 1 FROM outreach_messages WHERE id = ?').get(m.id), undefined)
  assert.equal(db.prepare('SELECT 1 FROM autopilot_work WHERE message_id = ?').get(m.id), undefined)
  assert.equal((db.prepare('SELECT count(*) n FROM autopilot_audit WHERE tenant_id = ?').get(T) as { n: number }).n, auditBefore, 'the audit record stays')
  assert.equal((db.prepare("SELECT count(*) n FROM outreach_messages WHERE tenant_id = ? AND id LIKE 'w%'").get(T) as { n: number }).n, 2, 'other messages untouched')
  assert.ok(db.prepare("SELECT 1 FROM scan_jobs WHERE user_id = ? AND business_name = 'dazl verification fixture (test only)'").get(T), 'sibling fixture untouched')
  assert.deepEqual(deleteFirstTouchFixture(db, T), { deleted: false })
  // re-creatable after cleanup
  assert.equal(createFirstTouchFixture(db, T, NOW).created, true)
})

// Synthetic delivery rows attached to the fixture lead by the real later paths (a cold sequence and a warm follow-up thread).
const hex = () => randomBytes(12).toString('hex')
function attachSequence(db: Database.Database, leadId: string, step2: { status: string; at: number }) {
  const msgId = hex(), seqId = hex()
  db.prepare("INSERT INTO outreach_messages (id, tenant_id, lead_id, to_email, subject, body, status, sent_at, claimed_at) VALUES (?, ?, ?, ?, 's', 'bodybodybodybodybodybody', 'sent', ?, ?)").run(msgId, T, leadId, TEST_INBOX, NOW - 9e5, NOW - 9e5)
  db.prepare("INSERT INTO sequences (id, tenant_id, lead_id, message_id, to_email, status) VALUES (?, ?, ?, ?, ?, 'active')").run(seqId, T, leadId, msgId, TEST_INBOX)
  db.prepare("INSERT INTO sequence_steps (tenant_id, sequence_id, step, subject, body, status, claimed_at, sent_at, created_at) VALUES (?, ?, 1, 's', 'b', 'sent', ?, ?, ?)").run(T, seqId, NOW - 9e5, NOW - 9e5, NOW - 9e5)
  db.prepare('INSERT INTO sequence_steps (tenant_id, sequence_id, step, subject, body, status, claimed_at, sent_at, created_at) VALUES (?, ?, 2, \'s2\', \'b2\', ?, ?, ?, ?)').run(T, seqId, step2.status, step2.at, step2.status === 'sent' ? step2.at : null, step2.at)
  return seqId
}
function attachFollowup(db: Database.Database, leadId: string, step1: { status: string; at: number }) {
  const threadId = 't-' + hex()
  db.prepare("INSERT INTO followup_threads (tenant_id, thread_id, lead_id, to_email, root_message_id, last_activity_at) VALUES (?, ?, ?, ?, 'root', ?)").run(T, threadId, leadId, TEST_INBOX, NOW - 9e5)
  db.prepare('INSERT INTO followup_messages (tenant_id, thread_id, step, status, created_at) VALUES (?, ?, 1, ?, ?)').run(T, threadId, step1.status, step1.at)
  return threadId
}

for (const table of ['sequence_steps', 'followup_messages'] as const) for (const status of ['sending', 'uncertain']) {
  test(`cleanup refuses while a ${table} row to the fixture lead is ${status}, so the tenant-wide uncertain stop is never erased`, async () => {
    const db = await setup()
    const f = createFirstTouchFixture(db, T, NOW)
    const id = table === 'sequence_steps' ? attachSequence(db, f.leadId, { status, at: NOW - 60 }) : attachFollowup(db, f.leadId, { status, at: NOW - 60 })
    const rows = () => table === 'sequence_steps'
      ? (db.prepare('SELECT count(*) n FROM sequence_steps WHERE sequence_id = ?').get(id) as { n: number }).n
      : (db.prepare('SELECT count(*) n FROM followup_messages WHERE thread_id = ?').get(id) as { n: number }).n
    const before = rows(), uncertainBefore = anyUncertainSend(db, T)
    assert.equal(uncertainBefore, status === 'uncertain')
    assert.throws(() => deleteFirstTouchFixture(db, T, NOW), /send_in_flight/, `${table} ${status}`)
    assert.equal(rows(), before, `${table} ${status}: nothing removed on refusal`)
    assert.ok(db.prepare('SELECT 1 FROM leads WHERE id = ?').get(f.leadId), `${table} ${status}: lead kept`)
    assert.equal(anyUncertainSend(db, T), uncertainBefore, `${table} ${status}: the uncertain stop stays`)
  })
}

test('cleanup removes the fixture follow-up thread together with its messages: no orphaned followup_messages', async () => {
  const db = await setup()
  const f = createFirstTouchFixture(db, T, NOW)
  const threadId = attachFollowup(db, f.leadId, { status: 'sent', at: NOW - 3 * 86400 })
  const seqId = attachSequence(db, f.leadId, { status: 'sent', at: NOW - 3 * 86400 })
  assert.deepEqual(deleteFirstTouchFixture(db, T, NOW), { deleted: true })
  assert.equal(db.prepare('SELECT 1 FROM followup_threads WHERE thread_id = ?').get(threadId), undefined)
  assert.equal((db.prepare('SELECT count(*) n FROM followup_messages WHERE thread_id = ?').get(threadId) as { n: number }).n, 0, 'no orphaned follow-up message')
  assert.equal((db.prepare('SELECT count(*) n FROM sequence_steps WHERE sequence_id = ?').get(seqId) as { n: number }).n, 0)
})

const sentCases: [string, (db: Database.Database, leadId: string, at: number) => void][] = [
  ['first touch', (db, leadId, at) => db.prepare("INSERT INTO outreach_messages (id, tenant_id, lead_id, to_email, subject, body, status, sent_at, claimed_at) VALUES (?, ?, ?, ?, 's', 'bodybodybodybodybodybody', 'sent', ?, ?)").run(hex(), T, leadId, TEST_INBOX, at, at)],
  ['sequence step', (db, leadId, at) => { attachSequence(db, leadId, { status: 'sent', at }) }],
  ['follow-up', (db, leadId, at) => { attachFollowup(db, leadId, { status: 'sent', at }) }],
]
for (const [name, attach] of sentCases) {
  test(`cleanup never lowers the account-wide rolling send count (${name}): refused while it was sent inside the 24 h window, allowed once it ages out`, async () => {
    const db = await setup()
    const f = createFirstTouchFixture(db, T, NOW)
    attach(db, f.leadId, NOW - 60)
    const before = accountSendCount(db, T, NOW)
    assert.ok(before >= 1, name)
    assert.throws(() => deleteFirstTouchFixture(db, T, NOW), /recent_send/, name)
    assert.equal(accountSendCount(db, T, NOW), before, `${name}: accountSendCount unchanged across the refused cleanup`)
    assert.ok(db.prepare('SELECT 1 FROM leads WHERE id = ?').get(f.leadId), `${name}: lead kept`)
    // once the send has left the window, cleanup goes ahead and the count it reads is still unchanged
    const later = NOW - 60 + 86401
    const beforeLater = accountSendCount(db, T, later)
    assert.deepEqual(deleteFirstTouchFixture(db, T, later), { deleted: true }, name)
    assert.equal(accountSendCount(db, T, later), beforeLater, `${name}: accountSendCount unchanged across cleanup`)
  })
}
