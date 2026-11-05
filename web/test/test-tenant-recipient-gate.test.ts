// The env-designated test tenant (OUTREACH_TEST_TENANT_ID) may address only the approved test
// inbox. Every send path (draft, manual send, autopilot, follow-up, sequence step, re-open) runs
// the shared recipientAllowed gate synchronously before a send, so narrowing it here narrows
// every path at once - this is a fail-closed recipient restriction at the authoritative send
// boundary, not a UI rule. The testing grant is "no sends except the approved self-inbox"; a
// missing or malformed allowlist fails closed. Code gate only, not evidence of user permission.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import Database from 'better-sqlite3'
import { seedOffers } from './helpers/seed-offer.ts'
import { migrateScan, createJob } from '../lib/scan/store.ts'
import { migrateOutreach } from '../lib/outreach/store.ts'
import { migrateSequences, setTestAddresses } from '../lib/outreach/sequences.ts'
import { migrateConnectors } from '../lib/connectors/store.ts'
import { approve, createDraft, recipientAllowed, saveSettings, sendBlockReason, sendMessage, TEST_INBOX, type Deps } from '../lib/outreach/service.ts'
import { completeOAuth, startOAuth, GMAIL_READ_SCOPE } from '../lib/gmail/oauth.ts'
import { migrateAutopilot } from '../lib/outreach/autopilot.ts'
import { migrateLedger } from '../lib/outreach/ledger.ts'
import { acceptReadConsent, migrateReplies } from '../lib/outreach/replies.ts'
import { approveSequence, createSequence, runSequences } from '../lib/outreach/sequences.ts'
import { runCalibration } from '../lib/outreach/calibration.ts'
import { acceptLaunchPolicy, LAUNCH_POLICY_VERSION } from '../lib/outreach/launch-policy.ts'

const master = randomBytes(32)
const oauthEnv = { GOOGLE_CLIENT_ID: 'cid.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'csecret', PUBLIC_BASE_URL: 'https://app.test' }
const NOW = 1_800_000_000
const T = 'tenant-designated-test'
const OTHER = 'tenant-other'
const BUSINESS = 'ceo@acme.example'
const CONSUMER = 'someone@yahoo.com'

function setup() {
  const db = new Database(':memory:')
  migrateScan(db); migrateOutreach(db); seedOffers(db, [T, OTHER]); migrateSequences(db); migrateConnectors(db)
  return db
}
const designated = <R>(fn: () => R): R => {
  process.env.OUTREACH_TEST_TENANT_ID = T
  try { return fn() } finally { delete process.env.OUTREACH_TEST_TENANT_ID }
}
const designatedAsync = async (fn: () => Promise<void>): Promise<void> => {
  process.env.OUTREACH_TEST_TENANT_ID = T
  try { await fn() } finally { delete process.env.OUTREACH_TEST_TENANT_ID }
}
async function connect(db: Database.Database, tenant: string) {
  const state = new URL(startOAuth(db, tenant, { env: oauthEnv, now: NOW })).searchParams.get('state')!
  const token = 'x.' + Buffer.from(JSON.stringify({ email: 'me@acme.example', email_verified: true })).toString('base64url') + '.y'
  await completeOAuth(db, tenant, 'code', state, { env: oauthEnv, master, now: NOW, fetchImpl: (async () => new Response(JSON.stringify({ refresh_token: 'rt', scope: 'openid email https://www.googleapis.com/auth/gmail.send', id_token: token }))) as unknown as typeof fetch })
}
function addLead(db: Database.Database, tenant: string, contact: string) {
  const job = createJob(db, tenant, { business_name: 'Acme', industry: 'roofing', location: 'Toronto' })
  const id = randomBytes(12).toString('hex')
  db.prepare("UPDATE scan_jobs SET status = 'running' WHERE id = ?").run(job)
  db.prepare('INSERT INTO leads (id, scan_job_id, company, contact, signal, source_url, evidence_excerpt, confidence) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
    id, job, 'Acme Corp', contact, 'Hiring five roofers', 'https://news.example/a', 'Acme Corp is hiring five roofers', 85)
  db.prepare("UPDATE leads SET human_confirmed_at = 1800000000, human_confirmed_from = 'test_review' WHERE id = ?").run(id)
  return id
}

test('designated test tenant: only the exact approved, allowlisted test inbox is addressable', () => {
  const db = setup()
  designated(() => {
    // a business recipient is refused for the designated tenant (the pre-fix gap)
    assert.equal(recipientAllowed(db, T, BUSINESS), false)
    // any other consumer address stays refused
    assert.equal(recipientAllowed(db, T, CONSUMER), false)
    // the approved inbox is refused while the allowlist row is missing: fail closed
    assert.equal(recipientAllowed(db, T, TEST_INBOX), false)
    // ...and while the allowlist is malformed: fail closed
    db.prepare("INSERT INTO sequence_settings (tenant_id, test_addresses) VALUES (?, ?)").run(T, 'not json{')
    assert.equal(recipientAllowed(db, T, TEST_INBOX), false)
    // only the exact allowlisted inbox passes
    setTestAddresses(db, T, [TEST_INBOX])
    assert.equal(recipientAllowed(db, T, TEST_INBOX), true)
    // an address merely sharing the inbox local part or a lookalike domain does not
    assert.equal(recipientAllowed(db, T, 'instinct114114@gmail.com.evil.example'), false)
    assert.equal(recipientAllowed(db, T, 'other@gmail.com'), false)
  })
})

test('other tenants are unaffected by the designation', () => {
  const db = setup()
  designated(() => {
    assert.equal(recipientAllowed(db, OTHER, BUSINESS), true)
    assert.equal(recipientAllowed(db, OTHER, CONSUMER), false)
    setTestAddresses(db, OTHER, [TEST_INBOX])
    assert.equal(recipientAllowed(db, OTHER, TEST_INBOX), false)
  })
})

test('with no tenant designated, the test inbox is never addressable', () => {
  const db = setup()
  setTestAddresses(db, T, [TEST_INBOX])
  assert.equal(recipientAllowed(db, T, TEST_INBOX), false)
  assert.equal(recipientAllowed(db, T, BUSINESS), true)
})

test('send boundary: an approved draft to a business address is refused for the designated tenant', async () => {
  const db = setup()
  await connect(db, T)
  saveSettings(db, T, { sender_name: 'Pat Smith', postal_address: '1 King St W, Toronto ON M5H 1A1, Canada' })
  const id = createDraft(db, T, addLead(db, T, BUSINESS), 'Acme')
  approve(db, T, id)
  designated(() => {
    setTestAddresses(db, T, [TEST_INBOX])
    // the shared pre-claim checks sendMessage runs refuse it as an address this tenant may not use
    assert.equal(sendBlockReason(db, T, id, { skipAccount: true }), 'personal_email')
  })
})

test('send boundary: the approved test inbox stays sendable within the other existing gates', async () => {
  const db = setup()
  await connect(db, T)
  saveSettings(db, T, { sender_name: 'Pat Smith', postal_address: '1 King St W, Toronto ON M5H 1A1, Canada' })
  designated(() => {
    setTestAddresses(db, T, [TEST_INBOX])
    const id = createDraft(db, T, addLead(db, T, TEST_INBOX), 'Acme')
    approve(db, T, id)
    // the recipient gate passes; nothing else in the read-only pre-send chain refuses it
    assert.equal(sendBlockReason(db, T, id, { skipAccount: true }), null)
  })
})

const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status })

// An approved draft to the approved inbox whose allowlist row is revoked DURING the token
// await must not send: the recipient gate is re-proved after the last await, fail closed.
test('send boundary: allowlist revocation during the token await stops the send (TOCTOU)', async () => {
  const db = setup()
  await connect(db, T)
  saveSettings(db, T, { sender_name: 'Pat Smith', postal_address: '1 King St W, Toronto ON M5H 1A1, Canada' })
  await designatedAsync(async () => {
    setTestAddresses(db, T, [TEST_INBOX])
    const id = createDraft(db, T, addLead(db, T, TEST_INBOX), 'Acme')
    approve(db, T, id)
    const sent: string[] = []
    const fetchImpl = (async (u: unknown) => {
      if (String(u).includes('oauth2') || String(u).includes('token')) {
        // the operator narrows the allowlist while the send path waits on the token
        db.prepare('DELETE FROM sequence_settings WHERE tenant_id = ?').run(T)
        return json({ access_token: 'at-1' })
      }
      return json({}, 404)
    }) as unknown as typeof fetch
    await assert.rejects(
      sendMessage(db, T, id, { env: oauthEnv, master, now: NOW, baseUrl: 'https://app.test', fetchImpl, sendFn: (async (_t: string, raw: string) => { sent.push(raw); return { id: 'gm1' } }) as never }),
      /personal_email/,
    )
    assert.equal(sent.length, 0)
  })
})

// The same revocation during a sequence step's token await: the step is unclaimed and the
// sequence stops with the recipient reason; Gmail is never called for it.
test('sequence step: allowlist revocation during the token await stops the step and the sequence', async () => {
  const db = new Database(':memory:')
  migrateScan(db); migrateOutreach(db); migrateConnectors(db); migrateAutopilot(db); migrateLedger(db); migrateReplies(db); migrateSequences(db); seedOffers(db, [T])
  const state = new URL(startOAuth(db, T, { env: oauthEnv, now: NOW, withRead: true })).searchParams.get('state')!
  const idToken = 'x.' + Buffer.from(JSON.stringify({ email: 'me@acme.example', email_verified: true })).toString('base64url') + '.y'
  await completeOAuth(db, T, 'c', state, { env: oauthEnv, master, now: NOW, fetchImpl: (async () => json({ refresh_token: 'rt', scope: `https://www.googleapis.com/auth/gmail.send ${GMAIL_READ_SCOPE}`, id_token: idToken })) as unknown as typeof fetch })
  saveSettings(db, T, { sender_name: 'Pat', postal_address: '1 King St W, Toronto ON M5H 1A1' })
  acceptReadConsent(db, T)
  const sent: string[] = []
  let tokenCalls = 0
  const fetchImpl = (async (u: unknown) => {
    const url = String(u)
    if (url.includes('oauth2')) {
      tokenCalls++
      if (tokenCalls === 2) db.prepare('DELETE FROM sequence_settings WHERE tenant_id = ?').run(T)
      return json({ access_token: 'at' })
    }
    if (url.includes('/threads/')) return json({ messages: [] })
    if (url.includes('messages?q=')) return json({ messages: [] })
    return json({}, 404)
  }) as unknown as typeof fetch
  const d: Deps & { flags: Record<string, string> } = { env: oauthEnv, master, now: NOW, fetchImpl, flags: { SEQUENCES_ENABLED: '1' }, sendFn: (async (_t: string, raw: string) => { sent.push(raw); return { id: `gm${sent.length}`, threadId: 'thread-1' } }) as never }
  await designatedAsync(async () => {
    setTestAddresses(db, T, [TEST_INBOX])
    const job = createJob(db, T, { business_name: 'Acme', industry: 'x', location: 'y' })
    db.prepare("UPDATE scan_jobs SET status = 'running' WHERE id = ?").run(job)
    const lead = randomBytes(12).toString('hex'), mid = randomBytes(12).toString('hex')
    db.prepare('INSERT INTO leads (id,scan_job_id,company,contact,signal,source_url,evidence_excerpt,confidence) VALUES (?,?,?,?,?,?,?,?)').run(lead, job, 'Acme', TEST_INBOX, 'Hiring roofers', 'https://acme.example/jobs', 'Hiring roofers', 90)
    db.prepare("UPDATE leads SET human_confirmed_at=1800000000, human_confirmed_from='test_review' WHERE id = ?").run(lead)
    db.prepare("INSERT INTO outreach_messages (id,tenant_id,lead_id,to_email,subject,body,test) VALUES (?,?,?,?,'A quick question','This is a draft message for review.',1)").run(mid, T, lead, TEST_INBOX)
    const seq = createSequence(db, T, mid)
    approveSequence(db, T, seq, (mId: string) => approve(db, T, mId, true), NOW)
    await sendMessage(db, T, mid, d) // first touch: allowlist intact (token call 1)
    assert.equal(sent.length, 1)
    const r = await runSequences(db, T, '', { ...d, now: NOW + 3 * 86400 }) // step 2: revoked mid-await (token call 2)
    assert.equal(r.sent, 0)
    assert.equal(sent.length, 1, 'the step after the revocation must never reach Gmail')
    assert.equal((db.prepare('SELECT stop_reason FROM sequences WHERE id = ?').get(seq) as { stop_reason: string }).stop_reason, 'personal_email')
    assert.deepEqual(db.prepare('SELECT status, claimed_at FROM sequence_steps WHERE sequence_id = ? AND step = 2').get(seq), { status: 'approved', claimed_at: null })
  })
})

// The launch calibration integration check is a send too: for the designated tenant it may
// address only the approved test inbox, whatever mailbox is connected.
test('calibration: the designated tenant integration check is gated to the approved test inbox', async () => {
  const db = new Database(':memory:')
  migrateScan(db); migrateOutreach(db); migrateConnectors(db); migrateAutopilot(db); migrateReplies(db); migrateSequences(db); seedOffers(db, [T])
  db.exec('DROP TRIGGER IF EXISTS leads_only_while_running')
  const state = new URL(startOAuth(db, T, { env: oauthEnv, now: NOW })).searchParams.get('state')!
  const idToken = 'x.' + Buffer.from(JSON.stringify({ email: 'me@acme.example', email_verified: true })).toString('base64url') + '.y'
  await completeOAuth(db, T, 'c', state, { env: oauthEnv, master, now: NOW, fetchImpl: (async () => json({ refresh_token: 'rt', scope: 'https://www.googleapis.com/auth/gmail.send', id_token: idToken })) as unknown as typeof fetch })
  saveSettings(db, T, { sender_name: 'Pat', postal_address: '1 King St W, Toronto ON M5H 1A1' })
  const job = createJob(db, T, { business_name: 'Acme', industry: 'x', location: 'y' })
  db.prepare("UPDATE scan_jobs SET status = 'running' WHERE id = ?").run(job)
  db.prepare("UPDATE scan_jobs SET status = 'done' WHERE id = ?").run(job)
  for (const c of ['a@one.example', 'b@two.example', 'c@three.example']) {
    const lead = randomBytes(12).toString('hex')
    db.prepare('INSERT INTO leads (id,scan_job_id,company,contact,signal,source_url,evidence_excerpt,confidence,score) VALUES (?,?,?,?,?,?,?,?,?)').run(lead, job, 'Co', c, 'Hiring roofers', 'https://n.example/a', 'Co is hiring', 90, 80)
    db.prepare("UPDATE leads SET human_confirmed_at=1800000000, human_confirmed_from='test_review' WHERE id = ?").run(lead)
  }
  // policy sender and test inbox are the tenant's own mailbox - not the approved test inbox
  const pol = { version: LAUNCH_POLICY_VERSION, sender: 'me@acme.example', audience: { playIds: [job] }, exclusions: { domains: ['customer.example'], emails: [] }, dailyCap: 20, spendCapUsd: 25, claims: { mayStatePrice: true, benchmarkUrls: [] }, stops: { pauseOnAnyReply: true, maxBounceRate: 0.05 }, testInbox: 'me@acme.example' }
  acceptLaunchPolicy(db, T, pol as never, NOW)
  const sent: string[] = []
  const fetchImpl = (async (u: unknown) => (String(u).includes('oauth2') || String(u).includes('token') ? json({ access_token: 'at' }) : json({}, 404))) as unknown as typeof fetch
  const d = { flags: { AUTOPILOT_ENABLED: '1' }, env: oauthEnv, master, now: NOW, baseUrl: 'https://app.test', fetchImpl, sendFn: (async (_t: string, raw: string) => { sent.push(raw); return { id: 'g1' } }) as never }
  await designatedAsync(async () => {
    setTestAddresses(db, T, [TEST_INBOX])
    await runCalibration(db, T, 'Acme', d as never)
    assert.equal(sent.length, 0, 'the integration check may not send to a non-approved inbox for the designated tenant')
  })
})

// The recipient gate must not mask the evidence guard for the designated tenant: an approved
// self-inbox draft whose lead evidence is withdrawn is still refused for the evidence reason.
test('designated tenant: evidence withdrawal still refuses an approved self-inbox draft', async () => {
  const db = setup()
  await connect(db, T)
  saveSettings(db, T, { sender_name: 'Pat Smith', postal_address: '1 King St W, Toronto ON M5H 1A1, Canada' })
  designated(() => {
    setTestAddresses(db, T, [TEST_INBOX])
    const lead = addLead(db, T, TEST_INBOX)
    const id = createDraft(db, T, lead, 'Acme')
    approve(db, T, id)
    // an ordinary message (fixture drafts to the approved inbox are test=1, which the evidence gate exempts by design)
    db.prepare('UPDATE outreach_messages SET test = 0 WHERE id = ?').run(id)
    db.prepare('UPDATE leads SET human_confirmed_at = NULL, confidence = NULL WHERE id = ?').run(lead)
    const reason = sendBlockReason(db, T, id, { skipAccount: true })
    assert.ok(reason === 'lead_evidence_withdrawn' || reason === 'lead_currentness_unconfirmed', `expected the evidence/currentness guard, got ${reason}`)
  })
})
