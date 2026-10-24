import { migrateConnectors } from '../lib/connectors/store.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import Database from 'better-sqlite3'
import { migrateScan } from '../lib/scan/store.ts'
import { migrateOutreach } from '../lib/outreach/store.ts'
import { migrateAutopilot } from '../lib/outreach/autopilot.ts'
import { migrateLedger } from '../lib/outreach/ledger.ts'
import { migrateReplies, acceptReadConsent } from '../lib/outreach/replies.ts'
import { completeOAuth, startOAuth, GMAIL_READ_SCOPE } from '../lib/gmail/oauth.ts'
import { saveSettings, approve, sendMessage, leadHeld, recipientAllowed, isSuppressed, OutreachError, TEST_INBOX } from '../lib/outreach/service.ts'
import { migrateSequences, setTestAddresses, approveSequence, runSequences, SequenceError } from '../lib/outreach/sequences.ts'
import { createSequenceTestFixture, createReplyStopTestFixture, fixtureAvailable, FixtureError, FIXTURE_STEPS, REPLY_FIXTURE_STEPS } from '../lib/outreach/test-fixture.ts'

const NOW = 1800000000
const master = randomBytes(32)
const env = { GOOGLE_CLIENT_ID: 'client', GOOGLE_CLIENT_SECRET: 'secret', PUBLIC_BASE_URL: 'https://app.test' }
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status })

async function setup() {
  const db = new Database(':memory:')
  migrateScan(db); migrateOutreach(db); migrateConnectors(db); migrateAutopilot(db); migrateLedger(db); migrateReplies(db); migrateSequences(db)
  const state = new URL(startOAuth(db, 'A', { env, now: NOW, withRead: true })).searchParams.get('state')!
  await completeOAuth(db, 'A', 'c', state, { env, master, now: NOW, fetchImpl: (async () => json({ refresh_token: 'test-token', scope: `https://www.googleapis.com/auth/gmail.send ${GMAIL_READ_SCOPE}`, id_token: 'x.' + Buffer.from(JSON.stringify({ email: TEST_INBOX, email_verified: true })).toString('base64url') + '.y' })) as typeof fetch })
  saveSettings(db, 'A', { sender_name: 'Dazl', postal_address: '1122 International Blvd, Ste 700, Burlington, ON L7L 6Z8' })
  acceptReadConsent(db, 'A')
  return db
}
// The MIME body is base64; decode it for content assertions.
const mimeText = (raw: string) => Buffer.from(raw.split('\r\n\r\n')[1].replace(/\r\n/g, ''), 'base64').toString('utf8')
function mock() {
  const calls: string[] = []
  const fetchImpl = (async (u: unknown) => {
    const url = String(u)
    if (url.includes('oauth2')) return json({ access_token: 'at' })
    if (url.includes('/threads/')) return json({ messages: [] })
    return json({}, 404)
  }) as typeof fetch
  const sendFn = (async (_t: string, raw: string) => { calls.push(Buffer.from(raw, 'base64url').toString('utf8')); return { id: `gm${calls.length}`, threadId: 'thread-1' } })
  return { calls, fetchImpl, sendFn, env, master, now: NOW, flags: { SEQUENCES_ENABLED: '1' } }
}
function withTenant<T>(fn: () => T): T {
  process.env.OUTREACH_TEST_TENANT_ID = 'A'
  try { return fn() } finally { delete process.env.OUTREACH_TEST_TENANT_ID }
}
// Async variant: the grant must survive across awaits (sendMessage re-checks after token refresh).
async function withTenantAsync<T>(fn: () => Promise<T>): Promise<T> {
  process.env.OUTREACH_TEST_TENANT_ID = 'A'
  try { return await fn() } finally { delete process.env.OUTREACH_TEST_TENANT_ID }
}

test('fixture is gated to the designated test tenant and the allowlisted inbox', async () => {
  const db = await setup()
  assert.throws(() => createSequenceTestFixture(db, 'A'), (e: unknown) => e instanceof FixtureError && (e as FixtureError).code === 'test_tenant_only')
  process.env.OUTREACH_TEST_TENANT_ID = 'A'
  try {
    assert.equal(fixtureAvailable(db, 'A'), false)
    assert.throws(() => createSequenceTestFixture(db, 'A'), (e: unknown) => e instanceof FixtureError && (e as FixtureError).code === 'test_inbox_not_allowlisted')
    assert.throws(() => createSequenceTestFixture(db, 'B'), (e: unknown) => e instanceof FixtureError && (e as FixtureError).code === 'test_tenant_only')
  } finally { delete process.env.OUTREACH_TEST_TENANT_ID }
})

test('fixture creates the exact approved 3-step set, labelled test-only, with no fabricated evidence', async () => {
  const db = await setup()
  setTestAddresses(db, 'A', [TEST_INBOX])
  const r = withTenant(() => createSequenceTestFixture(db, 'A'))
  assert.equal(r.created, true)
  assert.equal(withTenant(() => fixtureAvailable(db, 'A')), true)

  const msg = db.prepare('SELECT * FROM outreach_messages WHERE id = ?').get(r.messageId) as { to_email: string; subject: string; body: string; status: string; test: number }
  assert.equal(msg.to_email, TEST_INBOX)
  assert.equal(msg.test, 1)
  assert.equal(msg.status, 'draft')
  assert.equal(msg.subject, FIXTURE_STEPS[0].subject)
  assert.equal(msg.body, FIXTURE_STEPS[0].body)

  const steps = db.prepare('SELECT step, subject, body, status FROM sequence_steps WHERE tenant_id = ? AND sequence_id = ? ORDER BY step').all('A', r.sequenceId) as { step: number; subject: string; body: string; status: string }[]
  assert.equal(steps.length, 3)
  for (const st of steps) {
    const want = FIXTURE_STEPS[st.step - 1]
    assert.equal(st.subject, want.subject)
    assert.equal(st.body, want.body)
    assert.equal(st.status, 'draft')
  }
  // Byte-exact approved texts, defensive against accidental edits of the constants.
  assert.equal(steps[0].subject, 'dazl sequence test - step 1 of 3')
  assert.equal(steps[0].body, 'Hi Gagan,\n\nThis is the initial message in the dazl own-inbox sequence test. Its purpose is only to verify step 1 of 3.\n\nThanks,')
  assert.equal(steps[1].body, 'Hi Gagan,\n\nThis is the no-reply follow-up check in the dazl own-inbox sequence test. Its purpose is only to verify step 2 of 3.\n\nThanks,')
  assert.equal(steps[2].body, 'Hi Gagan,\n\nThis is the final check in the dazl own-inbox sequence test. Its purpose is only to verify step 3 of 3.\n\nThanks,')

  // The fixture lead claims no verification evidence and is not held.
  const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(r.leadId) as { evidence_excerpt: string | null; confidence: number | null; fit: number | null; intent: number | null; contact: string; signal: string }
  assert.equal(lead.evidence_excerpt, null)
  assert.equal(lead.confidence, null)
  assert.equal(lead.fit, null)
  assert.equal(lead.intent, null)
  assert.equal(lead.contact, TEST_INBOX)
  assert.match(lead.signal, /[Tt]est-only/)
  assert.equal(leadHeld(db, 'A', r.leadId), false)

  // Consumer-inbox send guard: allowed only for the designated tenant, never for others.
  assert.equal(withTenant(() => recipientAllowed(db, 'A', TEST_INBOX)), true)
  assert.equal(recipientAllowed(db, 'A', TEST_INBOX), false)

  const job = db.prepare('SELECT status, business_name FROM scan_jobs WHERE id = ?').get(r.jobId) as { status: string; business_name: string }
  assert.equal(job.status, 'done')
  assert.match(job.business_name, /test only/i)

  // Idempotent: a second call returns the same set instead of duplicating it.
  const again = withTenant(() => createSequenceTestFixture(db, 'A'))
  assert.deepEqual(again, { ...r, created: false })
  assert.equal((db.prepare('SELECT count(*) AS n FROM sequences WHERE tenant_id = ?').get('A') as { n: number }).n, 1)
})

test('fixture set approves and sends steps on test timing exactly as written', async () => {
  const db = await setup()
  setTestAddresses(db, 'A', [TEST_INBOX])
  const r = withTenant(() => createSequenceTestFixture(db, 'A'))
  const m = mock()
  withTenant(() => approveSequence(db, 'A', r.sequenceId, id => approve(db, 'A', id, true), NOW))
  assert.equal((db.prepare('SELECT status FROM sequences WHERE id = ?').get(r.sequenceId) as { status: string }).status, 'approved')

  // Step 1 keeps the normal manual send path.
  assert.equal(await withTenantAsync(() => sendMessage(db, 'A', r.messageId, m)), 'sent')
  assert.equal(m.calls.length, 1)
  assert.match(m.calls[0], /Subject: dazl sequence test - step 1 of 3/)
  assert.match(mimeText(m.calls[0]), /verify step 1 of 3/)

  // Steps 2 and 3 wait for test-mode gaps (3m/7m) and send only with the env grant in place.
  assert.equal((await withTenantAsync(() => runSequences(db, 'A', '', { ...m, now: NOW + 1 }))).sent, 0) // activation tick
  assert.equal((await withTenantAsync(() => runSequences(db, 'A', '', { ...m, now: NOW + 179 }))).sent, 0)
  assert.equal((await withTenantAsync(() => runSequences(db, 'A', '', { ...m, now: NOW + 181 }))).sent, 1)
  assert.equal((await withTenantAsync(() => runSequences(db, 'A', '', { ...m, now: NOW + 421 }))).sent, 1)
  assert.equal(m.calls.length, 3)
  assert.match(mimeText(m.calls[1]), /verify step 2 of 3/)
  assert.match(mimeText(m.calls[2]), /verify step 3 of 3/)
  // Footer carries the saved sender details and an unsubscribe link on every step.
  for (const raw of m.calls) {
    const text = raw + mimeText(raw) // From header + decoded footer
    assert.match(text, /Dazl/)
    assert.match(text, /1122 International Blvd, Ste 700, Burlington, ON L7L 6Z8/)
    assert.match(text, /unsubscribe/i)
  }
  assert.equal((db.prepare('SELECT status FROM sequences WHERE id = ?').get(r.sequenceId) as { status: string }).status, 'done')

  // Without the operator env grant the same approved set would stop as personal_email.
  const db2 = await setup()
  setTestAddresses(db2, 'A', [TEST_INBOX])
  const r2 = withTenant(() => createSequenceTestFixture(db2, 'A'))
  const m2 = mock()
  withTenant(() => approveSequence(db2, 'A', r2.sequenceId, id => approve(db2, 'A', id, true), NOW))
  assert.equal(await withTenantAsync(() => sendMessage(db2, 'A', r2.messageId, m2)), 'sent')
  await withTenantAsync(() => runSequences(db2, 'A', '', { ...m2, now: NOW + 1 }))
  assert.equal((await runSequences(db2, 'A', '', { ...m2, now: NOW + 421 })).sent, 0) // no env grant now
  assert.equal(m2.calls.length, 1)
  assert.equal((db2.prepare('SELECT stop_reason FROM sequences WHERE id = ?').get(r2.sequenceId) as { stop_reason: string }).stop_reason, 'personal_email')
})

test('reply-stop fixture: gated, exact 2-step texts, idempotent, distinct from the 3-step fixture', async () => {
  const db = await setup()
  setTestAddresses(db, 'A', [TEST_INBOX])
  const r = withTenant(() => createReplyStopTestFixture(db, 'A'))
  assert.equal(r.created, true)

  const steps = db.prepare('SELECT step, subject, body, status FROM sequence_steps WHERE tenant_id = ? AND sequence_id = ? ORDER BY step').all('A', r.sequenceId) as { step: number; subject: string; body: string; status: string }[]
  assert.equal(steps.length, 2)
  for (const st of steps) {
    const want = REPLY_FIXTURE_STEPS[st.step - 1]
    assert.equal(st.subject, want.subject)
    assert.equal(st.body, want.body)
    assert.equal(st.status, 'draft')
  }
  // Byte-exact approved texts, defensive against accidental edits of the constants.
  assert.equal(steps[0].subject, 'dazl sequence test - reply stop check - step 1 of 2')
  assert.equal(steps[0].body, 'Hi Gagan,\n\nThis is the reply-stop check in the dazl own-inbox sequence test. Its purpose is only to verify that a reply stops the sequence before step 2.\n\nThanks,')
  assert.equal(steps[1].body, 'Hi Gagan,\n\nThis follow-up should never be sent. If it arrives, the reply-stop check in the dazl own-inbox sequence test has failed.\n\nThanks,')

  // Same gating: other tenants cannot create it.
  assert.throws(() => withTenant(() => createReplyStopTestFixture(db, 'B')), (e: unknown) => e instanceof FixtureError && (e as FixtureError).code === 'test_tenant_only')

  // Idempotent per variant, and independent of the 3-step fixture.
  const again = withTenant(() => createReplyStopTestFixture(db, 'A'))
  assert.deepEqual(again, { ...r, created: false })
  const main = withTenant(() => createSequenceTestFixture(db, 'A'))
  assert.equal(main.created, true)
  assert.notEqual(main.sequenceId, r.sequenceId)
  assert.equal((db.prepare('SELECT count(*) AS n FROM sequences WHERE tenant_id = ?').get('A') as { n: number }).n, 2)
})

test('reply-stop fixture: a human reply before step 2 stops the sequence and step 2 never sends', async () => {
  const db = await setup()
  setTestAddresses(db, 'A', [TEST_INBOX])
  const r = withTenant(() => createReplyStopTestFixture(db, 'A'))
  const m = mock()
  withTenant(() => approveSequence(db, 'A', r.sequenceId, id => approve(db, 'A', id, true), NOW))
  assert.equal(await withTenantAsync(() => sendMessage(db, 'A', r.messageId, m)), 'sent')
  assert.equal(m.calls.length, 1)
  assert.match(m.calls[0], /Subject: dazl sequence test - reply stop check - step 1 of 2/)

  // A neutral human reply lands in the thread before step 2 is due.
  const reply = { id: 'g-reply', threadId: 'thread-1', internalDate: String((NOW + 60) * 1000), payload: { mimeType: 'text/plain', body: { data: Buffer.from('Hi, this is a test reply for the dazl sequence test. Nothing is needed.').toString('base64url') }, headers: [{ name: 'From', value: 'Owner <owner@example.com>' }] } }
  const withReply = { ...m, fetchImpl: (async (u: unknown) => { const url = String(u); if (url.includes('oauth2')) return json({ access_token: 'at' }); if (url.includes('/threads/')) return json({ messages: [reply] }); return json({}, 404) }) as typeof fetch }

  // Activation tick sees the reply and stops the sequence; the +3m tick sends nothing.
  assert.equal((await withTenantAsync(() => runSequences(db, 'A', '', { ...withReply, now: NOW + 1 }))).sent, 0)
  assert.equal((await withTenantAsync(() => runSequences(db, 'A', '', { ...withReply, now: NOW + 421 }))).sent, 0)
  assert.equal(m.calls.length, 1)
  const seq = db.prepare('SELECT status, stop_reason FROM sequences WHERE id = ?').get(r.sequenceId) as { status: string; stop_reason: string }
  assert.equal(seq.status, 'replied')
  assert.equal(seq.stop_reason, 'reply')
  // A neutral reply must not suppress the test address.
  assert.equal(isSuppressed(db, 'A', TEST_INBOX), false)
})

// Boundary: the shorter-set relaxation is fenced to the exact fixture boundary -
// designated test tenant (env grant) + hardcoded test inbox + allowlist + test=1 message.
// Any real tenant, missing env grant, or non-fixture message keeps the exact-3-steps rule.
test('shorter sets are rejected outside the exact test-fixture boundary', async () => {
  const db = await setup()
  setTestAddresses(db, 'A', [TEST_INBOX])
  const mkSet = (test: 0 | 1) => {
    const jobId = randomBytes(12).toString('hex')
    const leadId = randomBytes(12).toString('hex')
    const messageId = randomBytes(12).toString('hex')
    const sequenceId = randomBytes(12).toString('hex')
    db.prepare('INSERT INTO scan_jobs (id, user_id, business_name, industry, location) VALUES (?, ?, ?, ?, ?)').run(jobId, 'A', 'boundary check (test only)', 'test only', 'test only')
    db.prepare("UPDATE scan_jobs SET status = 'running' WHERE id = ?").run(jobId)
    db.prepare('INSERT INTO leads (id, scan_job_id, name, company, contact, signal, source_url) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(leadId, jobId, 'Gagan', 'boundary check (test only)', TEST_INBOX, 'Test-only boundary check.', 'https://dazl.ai/test-only-sequence-fixture')
    db.prepare("UPDATE scan_jobs SET status = 'done' WHERE id = ?").run(jobId)
    db.prepare('INSERT INTO outreach_messages (id, tenant_id, lead_id, to_email, subject, body, test) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(messageId, 'A', leadId, TEST_INBOX, 'boundary - step 1 of 2', 'boundary check step one body, test only', test)
    db.prepare('INSERT INTO sequences (id, tenant_id, lead_id, message_id, to_email) VALUES (?, ?, ?, ?, ?)').run(sequenceId, 'A', leadId, messageId, TEST_INBOX)
    const ins = db.prepare('INSERT INTO sequence_steps (tenant_id, sequence_id, step, subject, body) VALUES (?, ?, ?, ?, ?)')
    ins.run('A', sequenceId, 1, 'boundary - step 1 of 2', 'boundary check step one body, test only')
    ins.run('A', sequenceId, 2, 'Re: boundary - step 1 of 2', 'boundary check step two body, test only')
    return { messageId, sequenceId }
  }
  const stepsMissing = (e: unknown) => e instanceof SequenceError && (e as SequenceError).code === 'steps_missing'

  // 1. Fixture-shaped 2-step set WITHOUT the operator env grant: rejected.
  const noEnv = mkSet(1)
  assert.throws(() => approveSequence(db, 'A', noEnv.sequenceId, id => approve(db, 'A', id, true), NOW), stepsMissing)

  // 2. Same set but the env grant names a different tenant: rejected.
  const wrongTenant = mkSet(1)
  process.env.OUTREACH_TEST_TENANT_ID = 'SOMEONE_ELSE'
  try { assert.throws(() => approveSequence(db, 'A', wrongTenant.sequenceId, id => approve(db, 'A', id, true), NOW), stepsMissing) }
  finally { delete process.env.OUTREACH_TEST_TENANT_ID }

  // 3. With the correct grant, but the message is not fixture-created (test = 0): rejected.
  const notFixture = mkSet(0)
  assert.throws(() => withTenant(() => approveSequence(db, 'A', notFixture.sequenceId, id => approve(db, 'A', id, true), NOW)), stepsMissing)

  // 4. Send path defense-in-depth: a hand-raised approved 2-step set with test = 0 cannot send
  // even with the grant and allowlist in place. With no evidence basis it is stopped at the
  // evidence gate, before the changed-since-approval comparison is even reached.
  const direct = mkSet(0)
  db.prepare("UPDATE outreach_messages SET status = 'approved', approved_hash = 'x' WHERE id = ?").run(direct.messageId)
  db.prepare("UPDATE sequence_steps SET status = 'approved', approved_hash = 'x' WHERE sequence_id = ?").run(direct.sequenceId)
  db.prepare("UPDATE sequences SET status = 'approved' WHERE id = ?").run(direct.sequenceId)
  await assert.rejects(() => withTenantAsync(() => sendMessage(db, 'A', direct.messageId, mock())), (e: unknown) => e instanceof OutreachError && (e as OutreachError).code === 'lead_evidence_withdrawn')
})
