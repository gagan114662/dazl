// #417: a prospect's VERIFIED signup/payment stops queued acquisition work for their EXACT email - atomically,
// idempotently, with a terminal reason and attribution preserved - and future cold plays never pick them up.
// An UNVERIFIED identity queues a durable pending event: it cancels nothing and excludes nothing until
// ownership is proven (verification/reset link, Google sign-in). Ambiguous identity matches nothing.
// No sends: fixtures + stubbed transport.
import { seedOffers } from './helpers/seed-offer.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import Database from 'better-sqlite3'
import { migrateScan, createJob } from '../lib/scan/store.ts'
import { migrateConnectors } from '../lib/connectors/store.ts'
import { migrateOutreach } from '../lib/outreach/store.ts'
import { migrateAutopilot, runAutopilot, enable, getState, ATTESTATIONS, CONSENT_VERSION } from '../lib/outreach/autopilot.ts'
import { migrateSequences } from '../lib/outreach/sequences.ts'
import { migrateReplies, acceptReadConsent } from '../lib/outreach/replies.ts'
import { migrateLedger } from '../lib/outreach/ledger.ts'
import { acceptAutoSequencePolicy, AUTO_SEQUENCE_POLICY, enrollColdSequence, runSequences } from '../lib/outreach/sequences.ts'
import { GMAIL_READ_SCOPE } from '../lib/gmail/oauth.ts'
import { recordLifecycleEvent, queuePendingLifecycle, activateLifecycleFor, drainVerifiedPendingLifecycle, conversionBlockedNow, paymentAccountFor, conversionEventFor } from '../lib/outreach/lifecycle.ts'
import { startOAuth, completeOAuth } from '../lib/gmail/oauth.ts'
import { saveSettings, createDraft, approve, sendMessage, type Deps } from '../lib/outreach/service.ts'

const NOW = 1_800_000_000
const genv = { GOOGLE_CLIENT_ID: 'cid.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'cs', PUBLIC_BASE_URL: 'https://app.test' }
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status })
const idToken = (email: string) => 'x.' + Buffer.from(JSON.stringify({ email, email_verified: true })).toString('base64url') + '.y'

function base() {
  const db = new Database(':memory:')
  migrateScan(db); migrateOutreach(db); migrateConnectors(db); migrateAutopilot(db); migrateSequences(db); migrateReplies(db); seedOffers(db)
  return db
}
function mkLead(db: Database.Database, tenant: string, contact: string | null, company = 'Corp') {
  const job = createJob(db, tenant, { business_name: 'Acme', industry: 'x', location: 'y' })
  db.prepare("UPDATE scan_jobs SET status = 'running' WHERE id = ?").run(job)
  const id = randomBytes(12).toString('hex')
  db.prepare('INSERT INTO leads (id, scan_job_id, company, contact, signal, source_url, evidence_excerpt, confidence, score) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, job, `${company} ${id.slice(0, 4)}`, contact, 'Hiring', 'https://n.example/a', 'Co is hiring', 90, 80)
  db.prepare("UPDATE leads SET human_confirmed_at=1800000000, human_confirmed_from='test_review' WHERE id = ?").run(id)
  db.prepare("UPDATE scan_jobs SET status = 'done' WHERE id = ?").run(job) // finished: its gates have run; only leads of a done scan are autopilot's candidates
  return id
}
const BODY = 'bodybodybodybodybodybody'

test('signup while a follow-up is queued cancels it atomically with a terminal reason; retries cannot resurrect it', () => {
  const db = base()
  const lead = mkLead(db, 'A', 'prospect@corp.example')
  // A sent first touch and an active cold sequence with an approved pending step.
  db.prepare("INSERT INTO outreach_messages (id, tenant_id, lead_id, to_email, subject, body, status, sent_at, claimed_at) VALUES ('m1','A',?,'prospect@corp.example','hi',?,'sent',1,1)").run(lead, BODY)
  db.prepare("INSERT INTO sequences (id, tenant_id, lead_id, message_id, to_email, status) VALUES ('sq1','A',?,'m1','prospect@corp.example','active')").run(lead)
  db.prepare("INSERT INTO sequence_steps (tenant_id, sequence_id, step, subject, body, status) VALUES ('A','sq1',2,'Re: hi',?,'approved')").run(BODY)
  // An open warm follow-up thread on the same thread.
  db.prepare("INSERT INTO followup_threads (tenant_id, thread_id, lead_id, to_email, root_message_id, last_activity_at, last_lead_reply_at) VALUES ('A','t1',?,'prospect@corp.example','m1',100,100)").run(lead)
  // One message per lead: the scheduler-held first touch and the manual draft live on their own leads.
  const lead2 = mkLead(db, 'A', 'prospect@corp.example')
  db.prepare("INSERT INTO outreach_messages (id, tenant_id, lead_id, to_email, subject, body, status, hold_reason, hold_until) VALUES ('m2','A',?,'prospect@corp.example','hi',?,'draft','warmup_manual',?)").run(lead2, BODY, NOW + 100)
  const lead3 = mkLead(db, 'A', 'prospect@corp.example')
  // A manual draft to the same address (no hold record): the tenant's own action, must be left alone.
  db.prepare("INSERT INTO outreach_messages (id, tenant_id, lead_id, to_email, subject, body, status) VALUES ('m3','A',?,'prospect@corp.example','manual',?,'draft')").run(lead3, BODY)

  const stopped = recordLifecycleEvent(db, 'signup', '  Prospect@Corp.EXAMPLE ', 'tenant-new', NOW)
  assert.ok(stopped >= 3, `sequence + thread + held draft stopped (got ${stopped})`)

  const seq = db.prepare('SELECT status, stop_reason FROM sequences WHERE id = ?').get('sq1') as { status: string; stop_reason: string }
  assert.deepEqual(seq, { status: 'stopped', stop_reason: 'converted_signup' }, 'terminal conversion reason on the sequence')
  const held = db.prepare('SELECT status, error, hold_reason, hold_until FROM outreach_messages WHERE id = ?').get('m2') as { status: string; error: string; hold_reason: string | null; hold_until: number | null }
  assert.deepEqual(held, { status: 'skipped', error: 'converted_signup', hold_reason: null, hold_until: null }, 'the queued first touch is terminally skipped, never drained later')
  const manual = db.prepare('SELECT status FROM outreach_messages WHERE id = ?').get('m3') as { status: string }
  assert.equal(manual.status, 'draft', "the tenant's own manual draft is untouched")
  const thread = db.prepare('SELECT stopped FROM followup_threads WHERE thread_id = ?').get('t1') as { stopped: string }
  assert.equal(thread.stopped, 'converted_signup')
  const sentRow = db.prepare('SELECT status FROM outreach_messages WHERE id = ?').get('m1') as { status: string }
  assert.equal(sentRow.status, 'sent', 'history is preserved, never rewritten')
  // Experiment attribution snapshots survive (none deleted by the cancel).
  assert.deepEqual(conversionEventFor(db, 'prospect@corp.example'), { kind: 'signup', created_at: NOW })

  // Idempotent: the same event again changes nothing and never errors; statuses stay terminal.
  const again = recordLifecycleEvent(db, 'signup', 'prospect@corp.example', 'tenant-new', NOW + 10)
  assert.equal(again, 0)
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM lifecycle_events').get() as { n: number }).n, 1)
  assert.equal((db.prepare('SELECT status FROM sequences WHERE id = ?').get('sq1') as { status: string }).status, 'stopped')
})

test('ambiguous identity stays unmatched: a same-company signup with a different email cancels nothing', () => {
  const db = base()
  const lead = mkLead(db, 'A', 'pat@corp.example', 'Corp')
  db.prepare("INSERT INTO outreach_messages (id, tenant_id, lead_id, to_email, subject, body, status, hold_reason, hold_until) VALUES ('m9','A',?,'pat@corp.example','hi',?,'draft','warmup_manual',?)").run(lead, BODY, NOW + 100)
  const n = recordLifecycleEvent(db, 'signup', 'sam@corp.example', 'tenant-new', NOW) // same company, different person
  assert.equal(n, 0)
  assert.equal((db.prepare('SELECT status FROM outreach_messages WHERE id = ?').get('m9') as { status: string }).status, 'draft')
})

// An autopilot-enabled tenant past warmup, with a send-recording stub. Returns the pieces the tests assert on.
async function autopilotTenant() {
  const db = base()
  const master = randomBytes(32) // one key: the send path decrypts what completeOAuth encrypted
  const state = new URL(startOAuth(db, 'A', { env: genv, now: NOW })).searchParams.get('state')!
  await completeOAuth(db, 'A', 'c', state, { env: genv, master, now: NOW, fetchImpl: (async () => json({ refresh_token: 'rt', scope: 'https://www.googleapis.com/auth/gmail.send', id_token: idToken('me@acme.example') })) as unknown as typeof fetch })
  saveSettings(db, 'A', { sender_name: 'Pat', postal_address: '1 King St W, Toronto ON M5H 1A1' })
  enable(db, 'A', { version: CONSENT_VERSION, attestations: [...ATTESTATIONS], daily_cap: 3 })
  assert.ok(getState(db, 'A').enabled)
  // Past warmup.
  db.prepare("INSERT INTO outreach_messages (id, tenant_id, lead_id, to_email, subject, body, status, sent_at, claimed_at) VALUES ('w1','A','x1','o1@z.example','s',?,'sent',1,1)").run(BODY)
  db.prepare("INSERT INTO outreach_messages (id, tenant_id, lead_id, to_email, subject, body, status, sent_at, claimed_at) VALUES ('w2','A','x2','o2@z.example','s',?,'sent',2,2)").run(BODY)
  const sent: string[] = []
  const d: Deps & { flags: Record<string, string> } = { flags: { AUTOPILOT_ENABLED: '1', AUTOPILOT_WARMUP: '2' }, env: genv, master, now: NOW, baseUrl: 'https://app.test', fetchImpl: (async (u: string) => String(u).includes('token') ? json({ access_token: 'at' }) : json({}, 404)) as unknown as typeof fetch, sendFn: (async (_t: string, raw: string) => { sent.push(raw); return { id: 'g' } }) as never }
  return { db, sent, d }
}

test('a converted prospect is never an autopilot candidate again - by own contact or by crawled published email', async () => {
  const { db, sent, d } = await autopilotTenant()
  // Converted by own contact; converted via crawled email; and one still-cold prospect.
  mkLead(db, 'A', 'buyer@corp.example')
  const crawl = mkLead(db, 'A', null)
  db.prepare("INSERT INTO lead_enrichments (tenant_id, lead_id, connector, kind, value, label, source_url, source_date, retrieved_at) VALUES ('A', ?, 'sitecrawl', 'domain', 'corp2.example|evidence_own_domain', 'domain-basis-v1:evidence_own_domain', 'https://corp2.example/', '2026-10-22', 1)").run(crawl)
  db.prepare("INSERT INTO lead_enrichments (tenant_id, lead_id, connector, kind, value, label, source_url, source_date, retrieved_at) VALUES ('A', ?, 'sitecrawl', 'email', 'sales@corp2.example', NULL, 'https://corp2.example/contact', '2026-10-22', 2)").run(crawl)
  mkLead(db, 'A', 'cold@prospect.example')
  recordLifecycleEvent(db, 'payment', 'buyer@corp.example', 'tenant-new', NOW)
  recordLifecycleEvent(db, 'signup', 'sales@corp2.example', 'tenant-new-2', NOW)

  const r = await runAutopilot(db, 'A', 'Acme', d)
  const recipients = (db.prepare("SELECT to_email FROM outreach_messages WHERE id NOT IN ('w1','w2')").all() as { to_email: string }[]).map(x => x.to_email)
  assert.ok(!recipients.includes('buyer@corp.example'), 'converted by own contact: excluded')
  assert.ok(!recipients.includes('sales@corp2.example'), 'converted by crawled email: excluded')
  assert.ok(recipients.includes('cold@prospect.example'), 'the still-cold prospect is unaffected')
  assert.equal(sent.length, 1)
  void r
})

test('an unverified signup queues a durable PENDING conversion: no cancels, no exclusion, until ownership is proven', async () => {
  const db = base()
  const lead = mkLead(db, 'A', 'victim@corp.example')
  db.prepare("INSERT INTO outreach_messages (id, tenant_id, lead_id, to_email, subject, body, status, hold_reason, hold_until) VALUES ('m1','A',?,'victim@corp.example','hi',?,'draft','warmup_manual',?)").run(lead, BODY, NOW + 100)
  db.prepare("INSERT INTO sequences (id, tenant_id, lead_id, message_id, to_email, status) VALUES ('sq1','A',?,'m1','victim@corp.example','active')").run(lead)

  // A free signup with a typed (unverified) address must not suppress another tenant's work.
  assert.equal(queuePendingLifecycle(db, 'signup', 'victim@corp.example', 'tenant-new', NOW), true)
  assert.equal((db.prepare('SELECT status FROM outreach_messages WHERE id = ?').get('m1') as { status: string }).status, 'draft', 'nothing canceled while unverified')
  assert.equal((db.prepare('SELECT status FROM sequences WHERE id = ?').get('sq1') as { status: string }).status, 'active')
  assert.equal(conversionEventFor(db, 'victim@corp.example'), null, 'a pending event is not a conversion')

  // And the pending address is STILL an autopilot candidate (no exclusion before verification).
  const { db: db2, sent, d } = await autopilotTenant()
  mkLead(db2, 'A', 'pending@corp.example')
  assert.equal(queuePendingLifecycle(db2, 'signup', 'pending@corp.example', 'tenant-new', NOW), true)
  await runAutopilot(db2, 'A', 'Acme', d)
  assert.equal(sent.length, 1, 'a pending (unverified) conversion excludes nothing')

  // Ownership proven (verification link opened): the queued event activates and the cancel lands.
  const stopped = activateLifecycleFor(db, 'victim@corp.example', NOW + 20)
  assert.ok(stopped >= 2, `held first touch + sequence stopped on activation (got ${stopped})`)
  assert.equal((db.prepare('SELECT status FROM outreach_messages WHERE id = ?').get('m1') as { status: string }).status, 'skipped')
  assert.equal((db.prepare('SELECT status FROM sequences WHERE id = ?').get('sq1') as { status: string }).status, 'stopped')
  assert.deepEqual(conversionEventFor(db, 'victim@corp.example'), { kind: 'signup', created_at: NOW })
  // Idempotent: a second activation (verify + later sign-in both drain) changes nothing.
  assert.equal(activateLifecycleFor(db, 'victim@corp.example', NOW + 30), 0)
})

test('a verified record activates a pending event of the same kind (payment queued unverified, then verified)', () => {
  const db = base()
  const lead = mkLead(db, 'A', 'payer@corp.example')
  db.prepare("INSERT INTO outreach_messages (id, tenant_id, lead_id, to_email, subject, body, status, hold_reason, hold_until) VALUES ('m1','A',?,'payer@corp.example','hi',?,'draft','warmup_manual',?)").run(lead, BODY, NOW + 100)
  assert.equal(queuePendingLifecycle(db, 'payment', 'payer@corp.example', 'tenant-t', NOW), true)
  assert.equal((db.prepare('SELECT status FROM outreach_messages WHERE id = ?').get('m1') as { status: string }).status, 'draft')
  // The same event recorded as verified (e.g. the Stripe replay after verification) activates and cancels.
  const stopped = recordLifecycleEvent(db, 'payment', 'payer@corp.example', 'tenant-t', NOW + 5)
  assert.ok(stopped >= 1)
  assert.equal((db.prepare('SELECT status FROM outreach_messages WHERE id = ?').get('m1') as { status: string }).status, 'skipped')
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM lifecycle_events').get() as { n: number }).n, 1, 'one event row, activated in place')
  assert.equal(recordLifecycleEvent(db, 'payment', 'payer@corp.example', 'tenant-t', NOW + 9), 0, 'replays stay no-ops')
})

test('payment identity resolves to the bound account, never the typed Stripe email; ambiguous ownership stays unmatched', () => {
  const db = base()
  db.exec(`CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, email_verified_at INTEGER);
           CREATE TABLE memberships (tenant_id TEXT NOT NULL, member_id TEXT NOT NULL, role TEXT NOT NULL, PRIMARY KEY (tenant_id, member_id));`)
  // Personal workspace: the tenant id IS the founder's users.id.
  db.prepare("INSERT INTO users (id, email, email_verified_at) VALUES ('t-personal', 'founder@co.example', 100)").run()
  assert.deepEqual(paymentAccountFor(db, 't-personal'), { email: 'founder@co.example', verified: true })
  // Shared workspace, exactly one owner.
  db.prepare("INSERT INTO users (id, email, email_verified_at) VALUES ('u-owner', 'owner@co.example', NULL)").run()
  db.prepare("INSERT INTO memberships (tenant_id, member_id, role) VALUES ('t-shared', 'u-owner', 'owner')").run()
  db.prepare("INSERT INTO users (id, email, email_verified_at) VALUES ('u-member', 'member@co.example', 100)").run()
  db.prepare("INSERT INTO memberships (tenant_id, member_id, role) VALUES ('t-shared', 'u-member', 'operator')").run()
  assert.deepEqual(paymentAccountFor(db, 't-shared'), { email: 'owner@co.example', verified: false }, 'unverified owner: the caller queues pending')
  // Two owners: ambiguous, never guessed.
  db.prepare("INSERT INTO users (id, email, email_verified_at) VALUES ('u-owner2', 'owner2@co.example', 100)").run()
  db.prepare("INSERT INTO memberships (tenant_id, member_id, role) VALUES ('t-shared', 'u-owner2', 'owner')").run()
  assert.equal(paymentAccountFor(db, 't-shared'), null)
  // Unknown tenant: unmatched.
  assert.equal(paymentAccountFor(db, 't-nobody'), null)
})

const USERS_DDL = 'CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, email_verified_at INTEGER)'

test('the send boundary fails closed on a PENDING conversion whose address is already verified', () => {
  const db = base()
  // No conversion at all: sends proceed.
  assert.equal(conversionBlockedNow(db, 'free@corp.example'), false)
  // Pending + unverified account: nothing proven, nothing blocked.
  db.exec(USERS_DDL)
  db.prepare("INSERT INTO users (id, email, email_verified_at) VALUES ('u1', 'pending@corp.example', NULL)").run()
  queuePendingLifecycle(db, 'signup', 'pending@corp.example', 'u1', NOW)
  assert.equal(conversionBlockedNow(db, 'pending@corp.example'), false, 'unverified pending does not block')
  // The account verifies but the activation drain is LOST: the boundary itself must still refuse the send.
  db.prepare("UPDATE users SET email_verified_at = 1 WHERE id = 'u1'").run()
  assert.equal(conversionBlockedNow(db, 'pending@corp.example'), true, 'verified-but-undrained blocks the send')
  // Activated conversions block regardless.
  activateLifecycleFor(db, 'pending@corp.example', NOW)
  assert.equal(conversionBlockedNow(db, 'pending@corp.example'), true)
  // A store without accounts cannot verify anything: pending does not block there.
  const bare = base()
  queuePendingLifecycle(bare, 'signup', 'bare@corp.example', 't', NOW)
  assert.equal(conversionBlockedNow(bare, 'bare@corp.example'), false)
})

test('a send pass completes a verified conversion itself when the boundary drain was lost', async () => {
  const { db, sent, d } = await autopilotTenant()
  db.exec(USERS_DDL)
  db.prepare("INSERT INTO users (id, email, email_verified_at) VALUES ('u9', 'late@corp.example', 1)").run() // already verified
  mkLead(db, 'A', 'late@corp.example')
  assert.equal(queuePendingLifecycle(db, 'signup', 'late@corp.example', 'u9', NOW), true)
  await runAutopilot(db, 'A', 'Acme', d)
  assert.equal(sent.length, 0, 'the pass drained the verified conversion first, so no send went out')
  assert.deepEqual(conversionEventFor(db, 'late@corp.example'), { kind: 'signup', created_at: NOW }, 'the event is activated')
})

test('a conversion proven DURING the token refresh still stops the send: claim ordering alone is not enough', async () => {
  const { db, sent, d } = await autopilotTenant()
  db.exec(USERS_DDL)
  db.prepare("INSERT INTO users (id, email, email_verified_at) VALUES ('u5', 'mid@corp.example', NULL)").run()
  assert.equal(queuePendingLifecycle(db, 'signup', 'mid@corp.example', 'u5', NOW), true) // pending + unverified: the claim must succeed
  const lead = mkLead(db, 'A', 'mid@corp.example')
  const mid = createDraft(db, 'A', lead, 'Acme')
  approve(db, 'A', mid)
  // The verification commits while the access token is being refreshed - inside the await between claim and send.
  const midFlight = { ...d, fetchImpl: (async (u: string) => {
    if (String(u).includes('token')) { db.prepare("UPDATE users SET email_verified_at = 1 WHERE id = 'u5'").run(); return json({ access_token: 'at' }) }
    return json({}, 404)
  }) as unknown as typeof fetch }
  await assert.rejects(sendMessage(db, 'A', mid, midFlight), (e: unknown) => (e as { code?: string }).code === 'converted')
  assert.equal(sent.length, 0, 'no bytes went to Gmail')
  assert.deepEqual(db.prepare('SELECT status, error FROM outreach_messages WHERE id = ?').get(mid), { status: 'skipped', error: 'converted' }, 'terminal skip, never released back to approved')
})

test('sequence step: a conversion proven DURING the token refresh stops the step and terminates the sequence', async () => {
  const db = new Database(':memory:')
  migrateScan(db); migrateOutreach(db); migrateConnectors(db); migrateAutopilot(db); migrateLedger(db); migrateReplies(db); migrateSequences(db); seedOffers(db)
  db.exec(USERS_DDL)
  db.prepare("INSERT INTO users (id, email, email_verified_at) VALUES ('u9', 'seqprospect@corp.example', NULL)").run()
  const master = randomBytes(32)
  const state = new URL(startOAuth(db, 'A', { env: genv, now: NOW, withRead: true })).searchParams.get('state')!
  await completeOAuth(db, 'A', 'c', state, { env: genv, master, now: NOW, fetchImpl: (async () => json({ refresh_token: 'rt', scope: `https://www.googleapis.com/auth/gmail.send ${GMAIL_READ_SCOPE}`, id_token: idToken('me@acme.example') })) as unknown as typeof fetch })
  saveSettings(db, 'A', { sender_name: 'Pat', postal_address: '1 King St W, Toronto ON M5H 1A1' })
  acceptReadConsent(db, 'A'); acceptAutoSequencePolicy(db, 'A', AUTO_SEQUENCE_POLICY)
  const job = createJob(db, 'A', { business_name: 'Acme', industry: 'x', location: 'y' })
  db.prepare("UPDATE scan_jobs SET status = 'running' WHERE id = ?").run(job)
  const leadId = randomBytes(12).toString('hex')
  db.prepare('INSERT INTO leads (id, scan_job_id, company, contact, signal, source_url, evidence_excerpt, confidence, score) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(leadId, job, 'Acme', 'seqprospect@corp.example', 'Hiring roofers', 'https://acme.example/jobs', 'Hiring roofers', 90, 80)
  db.prepare("UPDATE leads SET human_confirmed_at = 1800000000, human_confirmed_from = 'test_review' WHERE id = ?").run(leadId)
  db.prepare("UPDATE scan_jobs SET status = 'done' WHERE id = ?").run(job) // finished: its gates have run; only leads of a done scan are autopilot's candidates
  const mid = randomBytes(12).toString('hex')
  db.prepare("INSERT INTO outreach_messages (id, tenant_id, lead_id, to_email, subject, body, status, sent_at, gmail_id, thread_id) VALUES (?, 'A', ?, ?, 'A quick question', 'This is the sent first touch body.', 'sent', ?, 'g1', 'thread-1')").run(mid, leadId, 'seqprospect@corp.example', NOW)
  const seqId = enrollColdSequence(db, 'A', mid, { businessName: 'Acme' })!
  assert.ok(seqId)
  // Pending conversion, still unverified: the claim must succeed; verification lands inside the token await.
  assert.equal(queuePendingLifecycle(db, 'signup', 'seqprospect@corp.example', 'u9', NOW), true)
  const sent: string[] = []
  const d: Deps & { flags: Record<string, string> } = { flags: { AUTOPILOT_ENABLED: '1', AUTOPILOT_WARMUP: '0', SEQUENCES_ENABLED: '1' }, env: genv, master, now: NOW + 3 * 86400 + 1, baseUrl: 'https://app.test', fetchImpl: (async (u: unknown) => {
    const url = String(u)
    if (url.includes('token')) { db.prepare("UPDATE users SET email_verified_at = 1 WHERE id = 'u9'").run(); return json({ access_token: 'at' }) }
    if (url.includes('/threads/')) return json({ messages: [] })
    return json({}, 404)
  }) as unknown as typeof fetch, sendFn: (async (_t: string, raw: string) => { sent.push(raw); return { id: 'g' } }) as never }
  await runSequences(db, 'A', 'Acme', d)
  assert.equal(sent.length, 0, 'no bytes went to Gmail')
  assert.equal((db.prepare('SELECT status FROM sequences WHERE id = ?').get(seqId) as { status: string }).status, 'stopped', 'sequence terminated')
  assert.deepEqual(db.prepare('SELECT status, claimed_at FROM sequence_steps WHERE sequence_id = ? AND step = 2').get(seqId), { status: 'approved', claimed_at: null }, 'step released inert, never sent')
})
