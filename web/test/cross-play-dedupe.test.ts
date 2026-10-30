// #364 (first slice): the same person is never emailed from two plays at once, or again within the cooldown. Two
// leads in two scans share one address; every first-touch gate (draft, approve, send claim) refuses the second while the
// first is on its way or was sent recently. Tenant-scoped; synthetic leads; Gmail stubbed, nothing leaves the process.
import { seedOffers } from './helpers/seed-offer.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import Database from 'better-sqlite3'
import { migrateScan, createJob } from '../lib/scan/store.ts'
import { migrateOutreach } from '../lib/outreach/store.ts'
import { completeOAuth, startOAuth } from '../lib/gmail/oauth.ts'
import { migrateConnectors } from '../lib/connectors/store.ts'
import { approve, approveBlockReason, contactedElsewhere, CONTACT_COOLDOWN_DAYS, createDraft, draftBlockReason, OutreachError, resolveUncertain, saveSettings, sendBlockReason, sendMessage, skip, type Deps } from '../lib/outreach/service.ts'

const master = randomBytes(32)
const env = { GOOGLE_CLIENT_ID: 'cid.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'csecret', PUBLIC_BASE_URL: 'https://app.test' }
const NOW = 1_800_000_000

function setup() {
  const db = new Database(':memory:')
  migrateScan(db); migrateOutreach(db); seedOffers(db); migrateConnectors(db)
  return db
}
function addLead(db: Database.Database, tenant: string, o: Partial<{ contact: string | null; evidence: string | null; confidence: number | null; fit: number | null; intent: number | null }> = {}) {
  const job = createJob(db, tenant, { business_name: 'Acme', industry: 'roofing', location: 'Toronto' })
  const id = randomBytes(12).toString('hex')
  db.prepare("UPDATE scan_jobs SET status = 'running' WHERE id = ?").run(job)
  db.prepare('INSERT INTO leads (id, scan_job_id, company, contact, signal, source_url, evidence_excerpt, confidence, fit, intent) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
    id, job, 'Northside Builders', 'contact' in o ? o.contact : 'info@northside.example', 'Hiring five roofers', 'https://news.example/a',
    'evidence' in o ? o.evidence : 'Northside Builders is hiring five roofers', 'confidence' in o ? o.confidence : 85,
    'fit' in o ? o.fit : null, 'intent' in o ? o.intent : null)
  // Explicit human review is the eligible baseline for unrelated send tests.
  db.prepare("UPDATE leads SET human_confirmed_at=1800000000, human_confirmed_from='test_review' WHERE id=? AND confidence IS NOT NULL AND evidence_excerpt IS NOT NULL").run(id)
  return id
}
const idToken = (email: string, verified = true) => 'x.' + Buffer.from(JSON.stringify({ email, email_verified: verified })).toString('base64url') + '.y'
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status })
function connect(db: Database.Database, tenant: string, email = 'me@acme.example') {
  const state = new URL(startOAuth(db, tenant, { env, now: NOW })).searchParams.get('state')!
  return completeOAuth(db, tenant, 'code', state, { env, master, now: NOW, fetchImpl: (async () => json({ refresh_token: 'rt-secret-123', scope: 'openid email https://www.googleapis.com/auth/gmail.send', id_token: idToken(email) })) as unknown as typeof fetch })
}
const tokenOk = (async (url: string) => (String(url).includes('token') ? json({ access_token: 'at-1' }) : json({}, 404))) as unknown as typeof fetch
function ready(db: Database.Database, tenant = 'A') {
  saveSettings(db, tenant, { sender_name: 'Pat Smith', postal_address: '1 King St W, Toronto ON M5H 1A1, Canada' })
}
const deps = (over: Partial<Deps> = {}): Deps => ({ env, master, now: NOW, baseUrl: 'https://app.test', fetchImpl: tokenOk, ...over })
const okSend = () => { const sent: string[] = []; return { sent, sendFn: (async (_t: string, raw: string) => { sent.push(raw); return { id: 'gm1' } }) as never } }


const code = (f: () => unknown) => { try { f(); return null } catch (e) { return e instanceof OutreachError ? e.code : String(e) } }
const acode = async (f: () => Promise<unknown>) => { try { await f(); return null } catch (e) { return e instanceof OutreachError ? e.code : String(e) } }

test('a second play cannot draft, approve or send to an address the first play emailed or is emailing', async () => {
  const db = setup(); await connect(db, 'A'); ready(db)
  const play1 = addLead(db, 'A'), play2 = addLead(db, 'A') // two scans, the same published address
  const m1 = createDraft(db, 'A', play1, 'Acme')
  // a draft alone does not block: nothing is on its way yet
  const m2 = createDraft(db, 'A', play2, 'Acme')
  approve(db, 'A', m1)
  // play 1 is approved: play 2 can neither be approved nor sent, and a third play cannot even draft
  assert.equal(code(() => approve(db, 'A', m2)), 'already_contacted')
  assert.equal(approveBlockReason(db, 'A', m2), 'already_contacted')
  const play3 = addLead(db, 'A')
  assert.equal(code(() => createDraft(db, 'A', play3, 'Acme')), 'already_contacted')
  assert.equal(draftBlockReason(db, 'A', play3), 'already_contacted')
  const { sent, sendFn } = okSend()
  assert.equal(await sendMessage(db, 'A', m1, deps({ sendFn })), 'sent')
  assert.equal(sent.length, 1)
  // after the send, within the cooldown: still refused everywhere
  assert.equal(code(() => approve(db, 'A', m2)), 'already_contacted')
  assert.equal(code(() => createDraft(db, 'A', play3, 'Acme')), 'already_contacted')
  // play 1's own message is not "another" one: its lead is unaffected
  assert.equal(contactedElsewhere(db, 'A', 'info@northside.example', play1, NOW), false)
})

test('two plays approved before either sent (a race the approve gate cannot see): the first claim wins, the other is refused', async () => {
  const db = setup(); await connect(db, 'A'); ready(db)
  const play1 = addLead(db, 'A'), play2 = addLead(db, 'A')
  const m1 = createDraft(db, 'A', play1, 'Acme'), m2 = createDraft(db, 'A', play2, 'Acme')
  // both approved: approve m2 while m1 is still a draft, then m1 with m2 briefly set back (two requests racing)
  approve(db, 'A', m2)
  db.prepare("UPDATE outreach_messages SET status = 'draft' WHERE id = ?").run(m2)
  approve(db, 'A', m1)
  db.prepare("UPDATE outreach_messages SET status = 'approved' WHERE id = ?").run(m2)
  // neither blocks the other while both are only approved
  assert.deepEqual([sendBlockReason(db, 'A', m1, { now: NOW }), sendBlockReason(db, 'A', m2, { now: NOW })], [null, null])
  const { sent, sendFn } = okSend()
  const results = await Promise.allSettled([sendMessage(db, 'A', m1, deps({ sendFn })), sendMessage(db, 'A', m2, deps({ sendFn }))])
  assert.equal(sent.length, 1, 'one email to the person')
  assert.deepEqual(results.map(r => r.status === 'fulfilled' ? r.value : (r.reason as OutreachError).code).sort(), ['already_contacted', 'sent'])
  // the refused one stays approved, never lost or half-sent
  assert.deepEqual((db.prepare("SELECT status FROM outreach_messages WHERE id IN (?, ?) ORDER BY status").all(m1, m2) as { status: string }[]).map(r => r.status), ['approved', 'sent'])
})

test('the claim itself re-checks: an approved message whose address another play has just sent to is not sent', async () => {
  const db = setup(); await connect(db, 'A'); ready(db)
  const play1 = addLead(db, 'A'), play2 = addLead(db, 'A')
  const m2 = createDraft(db, 'A', play2, 'Acme'); approve(db, 'A', m2)
  // play 1's email went out from another path after m2 was approved (e.g. a resolved uncertain send)
  db.prepare("INSERT INTO outreach_messages (id, tenant_id, lead_id, to_email, subject, body, status, sent_at) VALUES ('m1x', 'A', ?, 'info@northside.example', 's', 'An email that already went out to them.', 'sent', ?)").run(play1, NOW - 3600)
  assert.equal(sendBlockReason(db, 'A', m2, { now: NOW }), 'already_contacted')
  const { sent, sendFn } = okSend()
  assert.equal(await acode(() => sendMessage(db, 'A', m2, deps({ sendFn }))), 'already_contacted')
  assert.equal(sent.length, 0)
  assert.equal((db.prepare('SELECT status FROM outreach_messages WHERE id = ?').get(m2) as { status: string }).status, 'approved', 'left approved, not lost')
})

test('what counts: uncertain and sending block; skipped, unapproved drafts and sends older than the cooldown do not; case-insensitive', async () => {
  const db = setup()
  const play1 = addLead(db, 'A'), play2 = addLead(db, 'A')
  const put = (status: string, sentAt: number | null, to = 'info@northside.example') => {
    db.prepare('DELETE FROM outreach_messages').run()
    db.prepare("INSERT INTO outreach_messages (id, tenant_id, lead_id, to_email, subject, body, status, sent_at) VALUES ('mx', 'A', ?, ?, 's', 'An email body long enough.', ?, ?)").run(play1, to, status, sentAt)
  }
  const blocked = () => contactedElsewhere(db, 'A', 'INFO@Northside.example', play2, NOW)
  for (const [status, sentAt, want] of [['uncertain', null, true], ['sending', null, true], ['approved', null, true], ['sent', NOW - 10 * 86400, true],
    ['sent', NOW - (CONTACT_COOLDOWN_DAYS - 1) * 86400, true], ['sent', NOW - (CONTACT_COOLDOWN_DAYS + 1) * 86400, false], ['skipped', null, false], ['draft', null, false]] as const) {
    put(status, sentAt)
    assert.equal(blocked(), want, `${status} ${sentAt}`)
  }
  put('sent', NOW - 86400, 'someone-else@northside.example')
  assert.equal(blocked(), false, 'another address at the same company is not this person')
})

test('tenant-scoped: another tenant emailing the same address never blocks this tenant', async () => {
  const db = setup(); await connect(db, 'A'); ready(db); await connect(db, 'B'); ready(db, 'B')
  const a = addLead(db, 'A'), b = addLead(db, 'B')
  const ma = createDraft(db, 'A', a, 'Acme'); approve(db, 'A', ma)
  const { sendFn } = okSend()
  await sendMessage(db, 'A', ma, deps({ sendFn }))
  const mb = createDraft(db, 'B', b, 'Acme')
  assert.equal(code(() => approve(db, 'B', mb)), null)
})

test('autopilot-style flow and a resolved uncertain send follow the same rule', async () => {
  const db = setup(); await connect(db, 'A'); ready(db)
  const play1 = addLead(db, 'A'), play2 = addLead(db, 'A')
  const m1 = createDraft(db, 'A', play1, 'Acme'); approve(db, 'A', m1)
  db.prepare("UPDATE outreach_messages SET status = 'uncertain' WHERE id = ?").run(m1)
  assert.equal(code(() => createDraft(db, 'A', play2, 'Acme')), 'already_contacted', 'an unknown outcome is treated as contacted')
  resolveUncertain(db, 'A', m1, 'retry', deps())
  // back to approved (not sent): still on its way, still blocks
  assert.equal(code(() => createDraft(db, 'A', play2, 'Acme')), 'already_contacted')
  skip(db, 'A', m1)
  // play 1 gave up: play 2 may go ahead
  assert.equal(code(() => createDraft(db, 'A', play2, 'Acme')), null)
})
