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
import { approve, createDraft, recipientAllowed, saveSettings, sendBlockReason, TEST_INBOX } from '../lib/outreach/service.ts'
import { completeOAuth, startOAuth } from '../lib/gmail/oauth.ts'

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
