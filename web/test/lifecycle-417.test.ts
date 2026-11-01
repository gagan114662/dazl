// #417: a prospect's signup/payment stops queued acquisition work for their EXACT email - atomically,
// idempotently, with a terminal reason and attribution preserved - and future cold plays never pick them up.
// Ambiguous identity (same company, different email) matches nothing. No sends: fixtures + stubbed transport.
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
import { migrateReplies } from '../lib/outreach/replies.ts'
import { recordLifecycleEvent, conversionEventFor } from '../lib/outreach/lifecycle.ts'
import { startOAuth, completeOAuth } from '../lib/gmail/oauth.ts'
import { saveSettings, type Deps } from '../lib/outreach/service.ts'

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

test('a converted prospect is never an autopilot candidate again - by own contact or by crawled published email', async () => {
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
  // Converted by own contact; converted via crawled email; and one still-cold prospect.
  mkLead(db, 'A', 'buyer@corp.example')
  const crawl = mkLead(db, 'A', null)
  db.prepare("INSERT INTO lead_enrichments (tenant_id, lead_id, connector, kind, value, label, source_url, source_date, retrieved_at) VALUES ('A', ?, 'sitecrawl', 'domain', 'corp2.example|evidence_own_domain', 'domain-basis-v1:evidence_own_domain', 'https://corp2.example/', '2026-10-22', 1)").run(crawl)
  db.prepare("INSERT INTO lead_enrichments (tenant_id, lead_id, connector, kind, value, label, source_url, source_date, retrieved_at) VALUES ('A', ?, 'sitecrawl', 'email', 'sales@corp2.example', NULL, 'https://corp2.example/contact', '2026-10-22', 2)").run(crawl)
  mkLead(db, 'A', 'cold@prospect.example')
  recordLifecycleEvent(db, 'payment', 'buyer@corp.example', 'tenant-new', NOW)
  recordLifecycleEvent(db, 'signup', 'sales@corp2.example', 'tenant-new-2', NOW)

  const sent: string[] = []
  const d: Deps & { flags: Record<string, string> } = { flags: { AUTOPILOT_ENABLED: '1', AUTOPILOT_WARMUP: '2' }, env: genv, master, now: NOW, baseUrl: 'https://app.test', fetchImpl: (async (u: string) => String(u).includes('token') ? json({ access_token: 'at' }) : json({}, 404)) as unknown as typeof fetch, sendFn: (async (_t: string, raw: string) => { sent.push(raw); return { id: 'g' } }) as never }
  const r = await runAutopilot(db, 'A', 'Acme', d)
  const recipients = (db.prepare("SELECT to_email FROM outreach_messages WHERE id NOT IN ('w1','w2')").all() as { to_email: string }[]).map(x => x.to_email)
  assert.ok(!recipients.includes('buyer@corp.example'), 'converted by own contact: excluded')
  assert.ok(!recipients.includes('sales@corp2.example'), 'converted by crawled email: excluded')
  assert.ok(recipients.includes('cold@prospect.example'), 'the still-cold prospect is unaffected')
  assert.equal(sent.length, 1)
  void r
})
