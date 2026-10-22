import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import Database from 'better-sqlite3'
import { migrateScan } from '../lib/scan/store.ts'
import { migrateOutreach } from '../lib/outreach/store.ts'
import { migrateReplies } from '../lib/outreach/replies.ts'
import { migrateLedger } from '../lib/outreach/ledger.ts'
import { saveSettings, suppress, OutreachError } from '../lib/outreach/service.ts'
import { completeOAuth, startOAuth } from '../lib/gmail/oauth.ts'
import { createReopenDraft, editReopen, listReopens, migrateReopen, reopenText, sendReopen, skipReopen, warmAgain, WARM_MIN_DAYS } from '../lib/outreach/reopen.ts'

const master = randomBytes(32)
const env = { GOOGLE_CLIENT_ID: 'cid.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'csecret', PUBLIC_BASE_URL: 'https://app.test' }
const NOW = 1_800_000_000
const days = (n: number) => n * 86400

function setup() {
  const db = new Database(':memory:')
  migrateScan(db); migrateOutreach(db); migrateReplies(db); migrateLedger(db); migrateReopen(db)
  saveSettings(db, 'A', { sender_name: 'G', postal_address: '1 King St W, Toronto ON, Canada', booking_url: null })
  return db
}

const idToken = (email: string) => 'x.' + Buffer.from(JSON.stringify({ email, email_verified: true })).toString('base64url') + '.y'
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status })
function connect(db: Database.Database, tenant: string) {
  const state = new URL(startOAuth(db, tenant, { env, now: NOW })).searchParams.get('state')!
  return completeOAuth(db, tenant, 'code', state, { env, master, now: NOW, fetchImpl: (async () => json({ refresh_token: 'rt', scope: 'openid email https://www.googleapis.com/auth/gmail.send', id_token: idToken('me@acme.example') })) as unknown as typeof fetch })
}

function thread(db: Database.Database, opts: { replyAge?: number; stopped?: string | null; cls?: string; stage?: string; suppressed?: boolean } = {}) {
  const age = opts.replyAge ?? 45
  const tid = `thread-${randomBytes(4).toString('hex')}`
  const lid = `lead-${randomBytes(4).toString('hex')}`
  const email = `pat-${randomBytes(3).toString('hex')}@acme.com`
  db.prepare("INSERT INTO scan_jobs (id, user_id, business_name, industry, location, status) VALUES (?, 'A', 'b', 'i', 'l', 'running')").run(tid.replace('thread', 'job'))
  db.prepare("INSERT INTO leads (id, scan_job_id, name, company, contact, signal, source_url, stage) VALUES (?, ?, 'Pat', 'Acme', 'pat@acme.com', 'hiring AEs', 'https://n.com/a', ?)").run(lid, tid.replace('thread', 'job'), opts.stage ?? null)
  db.prepare("UPDATE scan_jobs SET status = 'done' WHERE id = ?").run(tid.replace('thread', 'job'))
  db.prepare('INSERT INTO outreach_messages (id, tenant_id, lead_id, to_email, subject, body, status, sent_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(randomBytes(12).toString('hex'), 'A', lid, email, 'Quick question for Acme', 'Hi Pat, saw the news. Body text here.', 'sent', NOW - days(50))
  db.prepare('INSERT INTO followup_threads (tenant_id, thread_id, lead_id, to_email, root_message_id, last_activity_at, last_lead_reply_at, followups_sent, stopped) VALUES (?, ?, ?, ?, ?, ?, ?, 2, ?)').run('A', tid, lid, email, 'root@x', NOW - days(age), NOW - days(age), opts.stopped ?? null)
  if (opts.cls) db.prepare('INSERT INTO inbound_messages (gmail_id, tenant_id, thread_id, lead_id, from_email, excerpt, classification, received_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(randomBytes(8).toString('hex'), 'A', tid, lid, 'pat@acme.com', 'sounds interesting, not right now', opts.cls, NOW - days(age))
  if (opts.suppressed) suppress(db, 'A', email, 'unsubscribe')
  return { tid, lid }
}

test('warmAgain: qualifies 30-90 day silence; excludes stopped, opted-out, negative, suppressed, booked, too-fresh and too-old', () => {
  const db = setup()
  const good = thread(db, { cls: 'positive' })
  thread(db, { replyAge: 10 })   // too fresh
  thread(db, { replyAge: 120 })  // too old
  thread(db, { stopped: 'replied_again' })
  thread(db, { cls: 'opt_out' })
  thread(db, { cls: 'negative' })
  thread(db, { stage: 'booked_call', cls: 'positive' })
  thread(db, { cls: 'positive', suppressed: true })
  const w = warmAgain(db, 'A', NOW)
  assert.equal(w.length, 1)
  assert.equal(w[0].thread_id, good.tid)
  assert.match(w[0].reply_excerpt, /sounds interesting/)
  // tenant isolation
  assert.equal(warmAgain(db, 'B', NOW).length, 0)
})

test('one re-open per thread ever; draft is editable, then send sends exactly the reviewed body and stops the sequence', async () => {
  const db = setup()
  await connect(db, 'A')
  const { tid } = thread(db, { cls: 'positive' })
  createReopenDraft(db, 'A', tid, 'Dazl')
  assert.throws(() => createReopenDraft(db, 'A', tid, 'Dazl'), /already_created/)
  assert.equal(warmAgain(db, 'A', NOW).length, 0) // drafted threads leave the queue
  const r = listReopens(db, 'A')
  assert.equal(r.length, 1)
  assert.equal(r[0].reopen!.status, 'draft')
  editReopen(db, 'A', tid, 'Hi Pat,\n\nCircling back on the AE hiring note. Still worth a short call?\n\nThanks,')
  const sent: { raw: string; threadId?: string }[] = []
  const fakeSend = (async (_t: string, raw: string, _f: unknown, threadId?: string) => { sent.push({ raw, threadId }); return { id: 'g1' } }) as never
  await sendReopen(db, 'A', tid, { env, now: NOW, master, sendFn: fakeSend, fetchImpl: ((async () => ({ ok: true, json: async () => ({ access_token: 'x' }) })) as never) })
  assert.equal(sent.length, 1)
  const mime = Buffer.from(sent[0].raw, 'base64url').toString()
  const sentBody = Buffer.from(mime.split('\r\n\r\n')[1] ?? '', 'base64').toString()
  assert.match(sentBody, /Circling back on the AE hiring note/) // the EDITED body went out
  assert.match(sentBody, /unsubscribe/i)

  const after = listReopens(db, 'A')[0]
  assert.equal(after.reopen!.status, 'sent')
  assert.equal((db.prepare('SELECT stopped FROM followup_threads WHERE thread_id = ?').get(tid) as { stopped: string }).stopped, 'reopened')
  await assert.rejects(() => sendReopen(db, 'A', tid, { now: NOW, master }), /already_sent/)
})

test('skip is final; suppressed address cannot be drafted or sent; bad edits rejected', async () => {
  const db = setup()
  const a = thread(db, { cls: 'positive' })
  skipReopen // typing guard
  createReopenDraft(db, 'A', a.tid, 'Dazl')
  assert.throws(() => editReopen(db, 'A', a.tid, 'short'), /bad_body/)
  skipReopen(db, 'A', a.tid)
  assert.throws(() => skipReopen(db, 'A', a.tid), /final/)
  await assert.rejects(() => sendReopen(db, 'A', a.tid, { now: NOW, master }), /final/)
  const b = thread(db, { cls: 'positive', suppressed: true })
  assert.throws(() => createReopenDraft(db, 'A', b.tid, 'Dazl'), (e) => e instanceof OutreachError && e.code === 'suppressed')
})

test('reopenText quotes their last reply and stays template-based (no LLM spend)', () => {
  const t = reopenText({ company: 'Acme', name: 'Pat Quinn', signal: 'hiring AEs', source_url: 'https://n.com/a' }, 'interesting, maybe later', 'Dazl')
  assert.match(t, /^Hi Pat,/)
  assert.match(t, /"interesting, maybe later"/)
  assert.ok(t.length >= 20 && t.length <= 3000)
  assert.ok(WARM_MIN_DAYS === 30)
})

test('held lead blocks re-open drafting and existing re-open sending',async()=>{
 const db=setup(); await connect(db,'A')
 const {tid,lid}=thread(db,{cls:'positive'})
 db.prepare('UPDATE leads SET fit=0,intent=NULL WHERE id=?').run(lid)
 assert.throws(()=>createReopenDraft(db,'A',tid,'Dazl'),/lead_ungraded/)
 db.prepare('UPDATE leads SET fit=4,intent=3 WHERE id=?').run(lid)
 createReopenDraft(db,'A',tid,'Dazl')
 db.prepare('UPDATE leads SET fit=0,intent=NULL WHERE id=?').run(lid)
 await assert.rejects(sendReopen(db,'A',tid),/lead_ungraded/)
})
