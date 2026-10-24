import { migrateConnectors } from '../lib/connectors/store.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import Database from 'better-sqlite3'
import { migrateScan } from '../lib/scan/store.ts'
import { migrateOutreach } from '../lib/outreach/store.ts'
import { migrateReplies } from '../lib/outreach/replies.ts'
import { migrateLedger } from '../lib/outreach/ledger.ts'
import { migrateSequences } from '../lib/outreach/sequences.ts'
import { migrateAutopilot } from '../lib/outreach/autopilot.ts'
import { saveSettings } from '../lib/outreach/service.ts'
import { completeOAuth, startOAuth } from '../lib/gmail/oauth.ts'
import { createReopenDraft, migrateReopen, sendReopen } from '../lib/outreach/reopen.ts'
const master = randomBytes(32)
const env = { GOOGLE_CLIENT_ID: 'cid.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'csecret', PUBLIC_BASE_URL: 'https://app.test' }
const NOW = 1_800_000_000
const idToken = (e: string) => 'x.' + Buffer.from(JSON.stringify({ email: e, email_verified: true })).toString('base64url') + '.y'
const json = (o: unknown) => new Response(JSON.stringify(o), { status: 200 })
async function seed(db: Database.Database) {
  migrateScan(db); migrateOutreach(db); migrateConnectors(db); migrateReplies(db); migrateLedger(db); migrateReopen(db); migrateAutopilot(db); migrateSequences(db)
  saveSettings(db, 'A', { sender_name: 'G', postal_address: '1 King St W, Toronto ON, Canada', booking_url: null })
  const state = new URL(startOAuth(db, 'A', { env, now: NOW })).searchParams.get('state')!
  await completeOAuth(db, 'A', 'code', state, { env, master, now: NOW, fetchImpl: (async () => json({ refresh_token: 'rt', scope: 'openid email https://www.googleapis.com/auth/gmail.send', id_token: idToken('me@acme.example') })) as unknown as typeof fetch })
  db.prepare("INSERT INTO scan_jobs (id,user_id,business_name,industry,location,status) VALUES ('job-x','A','b','i','l','running')").run()
  db.prepare("INSERT INTO leads (id,scan_job_id,name,company,contact,signal,source_url) VALUES ('lead-x','job-x','Pat','Acme','pat@acme.com','hiring','https://n.com/a')").run()
  db.prepare("INSERT INTO leads (id,scan_job_id,name,company,contact,signal,source_url) VALUES ('lead-y','job-x','Q','Other','z@acme.com','hiring','https://n.com/b')").run(); 
  db.prepare("UPDATE scan_jobs SET status='done' WHERE id='job-x'").run()
  db.prepare("INSERT INTO outreach_messages (id,tenant_id,lead_id,to_email,subject,body,status,sent_at) VALUES ('m1','A','lead-x','pat@acme.com','Quick question','Hi Pat, body text here for the first mail.','sent',?)").run(NOW - 86400 * 50)
  db.prepare("INSERT INTO followup_threads (tenant_id,thread_id,lead_id,to_email,root_message_id,last_activity_at,last_lead_reply_at,followups_sent) VALUES ('A','t1','lead-x','pat@acme.com','r@x',?,?,2)").run(NOW - 86400 * 45, NOW - 86400 * 45)
  db.prepare("INSERT INTO inbound_messages (gmail_id,tenant_id,thread_id,lead_id,from_email,excerpt,classification,received_at) VALUES ('g','A','t1','lead-x','pat@acme.com','sounds interesting','positive',?)").run(NOW - 86400 * 45)
  db.prepare("UPDATE leads SET human_confirmed_at = 1 WHERE id = 'lead-x'").run()
  createReopenDraft(db, 'A', 't1', 'Dazl')
}
const tf = (async () => ({ ok: true, json: async () => ({ access_token: 'x' }) })) as never
async function attempt(db: Database.Database) {
  let sends = 0
  const fake = (async () => { sends++; return { id: 'g' } }) as never
  let err = ''
  try { await sendReopen(db, 'A', 't1', { env, now: NOW, master, sendFn: fake, fetchImpl: tf }) } catch (e) { err = (e as Error).message }
  return { sends, err }
}
const uncertainIn: Record<string, (db: Database.Database) => void> = {
  outreach_messages: db => { db.prepare("INSERT INTO outreach_messages (id,tenant_id,lead_id,to_email,subject,body,status,claimed_at,sent_at) VALUES ('m2','A','lead-y','z@acme.com','s','bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb','uncertain',?,?)").run(NOW - 100, NOW - 100) },
  followup_messages: db => { db.prepare("INSERT INTO followup_messages (tenant_id,thread_id,step,status,created_at) VALUES ('A','t-other',0,'uncertain',?)").run(NOW - 100) },
  sequence_steps: db => { db.exec("PRAGMA foreign_keys=OFF"); db.prepare("INSERT INTO sequence_steps (tenant_id,sequence_id,step,subject,body,status,claimed_at) VALUES ('A','seq-x',1,'s','bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb','uncertain',?)").run(NOW - 100) },
}
for (const [table, mut] of Object.entries(uncertainIn)) {
  test(`an uncertain send in ${table} stops a re-open send (0 sends, draft kept)`, async () => {
    const db = new Database(':memory:'); await seed(db); mut(db)
    const r = await attempt(db)
    assert.equal(r.sends, 0); assert.match(r.err, /already_uncertain/)
    assert.equal((db.prepare("SELECT status FROM reopen_messages WHERE thread_id='t1'").get() as { status: string }).status, 'draft')
  })
}
test('another tenant\'s uncertain send does not block; with none uncertain the re-open sends once', async () => {
  const db = new Database(':memory:'); await seed(db)
  db.prepare("INSERT INTO outreach_messages (id,tenant_id,lead_id,to_email,subject,body,status,claimed_at,sent_at) VALUES ('m9','B','lead-y','z@acme.com','s','bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb','uncertain',?,?)").run(NOW - 100, NOW - 100)
  const r = await attempt(db)
  assert.equal(r.sends, 1); assert.equal(r.err, '')
})

// Reverse direction: a re-open whose send outcome was never recorded ('approved' claim) is an unresolved send for the account.
import { anyUncertainSend, accountSendCount } from '../lib/outreach/send-budget.ts'
import { sendMessage } from '../lib/outreach/service.ts'
test('an unresolved re-open claim stops the first-email send for the same tenant only (0 sends)', async () => {
  const db = new Database(':memory:'); await seed(db)
  db.prepare("UPDATE reopen_messages SET status='approved' WHERE tenant_id='A' AND thread_id='t1'").run()
  assert.equal(anyUncertainSend(db, 'A'), true)
  assert.equal(anyUncertainSend(db, 'B'), false)
  db.prepare("UPDATE leads SET human_confirmed_at=? WHERE id='lead-y'").run(NOW - 10)
  db.prepare("INSERT INTO outreach_messages (id,tenant_id,lead_id,to_email,subject,body,status) VALUES ('m3','A','lead-y','z@acme.com','s','bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb','approved')").run()
  let sends = 0, err = ''
  try { await sendMessage(db, 'A', 'm3', { env, now: NOW, master, sendFn: (async () => { sends++; return { id: 'g' } }) as never, fetchImpl: tf } as never) } catch (e) { err = (e as Error).message }
  assert.equal(sends, 0); assert.match(err, /already_uncertain/)
  assert.equal((db.prepare("SELECT status FROM outreach_messages WHERE id='m3'").get() as { status: string }).status, 'approved')
})
test('a draft, skipped or sent re-open is not an unresolved send; sent re-opens count in the 24h budget', async () => {
  const db = new Database(':memory:'); await seed(db)
  assert.equal(anyUncertainSend(db, 'A'), false)
  db.prepare("UPDATE reopen_messages SET status='skipped'").run(); assert.equal(anyUncertainSend(db, 'A'), false)
  const before = accountSendCount(db, 'A', NOW)
  db.prepare("UPDATE reopen_messages SET status='sent', sent_at=?").run(NOW - 60)
  assert.equal(anyUncertainSend(db, 'A'), false)
  assert.equal(accountSendCount(db, 'A', NOW), before + 1)
  assert.equal(accountSendCount(db, 'B', NOW), 0)
})
test('reads are safe when the re-open table does not exist yet and create nothing', () => {
  const db = new Database(':memory:'); migrateScan(db); migrateOutreach(db); migrateConnectors(db)
  assert.equal(anyUncertainSend(db, 'A'), false)
  assert.equal(accountSendCount(db, 'A', NOW), 0)
  assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE name='reopen_messages'").get(), undefined)
})

// Resolution of an unresolved re-open claim: user choice only, never an automatic retry or unlock.
import { resolveReopen } from '../lib/outreach/reopen.ts'
const st = (db: Database.Database) => (db.prepare("SELECT status FROM reopen_messages WHERE thread_id='t1'").get() as { status: string }).status
test('resolveReopen: only an approved claim resolves; draft/sent/skipped and other tenants are refused unchanged', async () => {
  const db = new Database(':memory:'); await seed(db)
  assert.throws(() => resolveReopen(db, 'A', 't1', 'sent'), /not_uncertain/); assert.equal(st(db), 'draft')
  assert.throws(() => resolveReopen(db, 'B', 't1', 'sent'), /not_found/)
  db.prepare("UPDATE reopen_messages SET status='approved'").run()
  assert.throws(() => resolveReopen(db, 'B', 't1', 'retry'), /not_found/); assert.equal(st(db), 'approved')
  for (const s of ['sent', 'skipped']) { db.prepare("UPDATE reopen_messages SET status=?").run(s); assert.throws(() => resolveReopen(db, 'A', 't1', 'retry'), /not_uncertain/); assert.equal(st(db), s) }
})
test('resolveReopen sent: recorded as sent (user word, no gmail id), account unlocked, nothing is sent', async () => {
  const db = new Database(':memory:'); await seed(db)
  db.prepare("UPDATE reopen_messages SET status='approved'").run(); assert.equal(anyUncertainSend(db, 'A'), true)
  resolveReopen(db, 'A', 't1', 'sent', NOW)
  const row = db.prepare("SELECT status, gmail_id, sent_at FROM reopen_messages").get() as { status: string; gmail_id: string | null; sent_at: number }
  assert.deepEqual(row, { status: 'sent', gmail_id: null, sent_at: NOW })
  assert.equal(anyUncertainSend(db, 'A'), false)
  assert.throws(() => resolveReopen(db, 'A', 't1', 'sent'), /not_uncertain/) // second click changes nothing
})
test('resolveReopen retry: back to a draft, no send happens, and it needs a fresh Send to go out (exactly once)', async () => {
  const db = new Database(':memory:'); await seed(db)
  db.prepare("UPDATE reopen_messages SET status='approved'").run()
  const blocked = await attempt(db); assert.equal(blocked.sends, 0); assert.match(blocked.err, /send_uncertain/)
  resolveReopen(db, 'A', 't1', 'retry'); assert.equal(st(db), 'draft'); assert.equal(anyUncertainSend(db, 'A'), false)
  const r = await attempt(db); assert.equal(r.sends, 1); assert.equal(r.err, ''); assert.equal(st(db), 'sent')
})

// Cap: a re-open takes a slot from the shared 24h budget from the moment it is claimed.
import { DAILY_CAP } from '../lib/outreach/service.ts'
const fillSent = (db: Database.Database, n: number) => { db.prepare("INSERT INTO scan_jobs (id,user_id,business_name,industry,location,status) VALUES ('job-c','A','b','i','l','running')").run(); for (let k = 0; k < n; k++) { db.prepare("INSERT INTO leads (id,scan_job_id,name,company,contact,signal,source_url) VALUES (?,'job-c','Q','Co','z@acme.com','hiring','https://n.com/c')").run('lead-c' + k); db.prepare("INSERT INTO outreach_messages (id,tenant_id,lead_id,to_email,subject,body,status,claimed_at,sent_at) VALUES (?,?,?,?,?,?,?,?,?)").run('cap' + k, 'A', 'lead-c' + k, `c${k}@acme.com`, 's', 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 'sent', NOW - 60, NOW - 60) } }
test('re-open at the cap edge: the last slot sends, one more is refused with the draft kept and no claim left', async () => {
  const db = new Database(':memory:'); await seed(db); fillSent(db, DAILY_CAP - 1)
  const ok = await attempt(db); assert.equal(ok.sends, 1); assert.equal(ok.err, '')
  const db2 = new Database(':memory:'); await seed(db2); fillSent(db2, DAILY_CAP)
  const no = await attempt(db2); assert.equal(no.sends, 0); assert.match(no.err, /daily_cap/)
  const row = db2.prepare("SELECT status, sent_at FROM reopen_messages").get() as { status: string; sent_at: number | null }
  assert.deepEqual(row, { status: 'draft', sent_at: null }); assert.equal(anyUncertainSend(db2, 'A'), false)
})
test('an old draft claimed now counts from the claim time, not its creation date', async () => {
  const db = new Database(':memory:'); await seed(db)
  db.prepare("UPDATE reopen_messages SET created_at=?, status='approved', sent_at=?").run(NOW - 86400 * 40, NOW - 30)
  assert.equal(accountSendCount(db, 'A', NOW), 1)
  db.prepare("UPDATE reopen_messages SET sent_at=?").run(NOW - 86400 * 2); assert.equal(accountSendCount(db, 'A', NOW), 0)
})
test('no schema change: the table keeps its original columns, and a successful send records the delivery time', async () => {
  const db = new Database(':memory:'); await seed(db)
  const cols = (db.prepare('PRAGMA table_info(reopen_messages)').all() as { name: string }[]).map(c => c.name).sort()
  assert.deepEqual(cols, ['body', 'created_at', 'gmail_id', 'lead_id', 'sent_at', 'status', 'tenant_id', 'thread_id', 'to_email'])
  assert.equal((await attempt(db)).sends, 1)
  assert.equal((db.prepare("SELECT sent_at FROM reopen_messages").get() as { sent_at: number }).sent_at, NOW)
})

// Active vs uncertain: a claim younger than SENDING_STALE_S may still be delivering and cannot be resolved.
import { SENDING_STALE_S } from '../lib/outreach/service.ts'
test('while the send is still running, resolve (either way) is refused; the one send finishes once and nothing is reset', async () => {
  const db = new Database(':memory:'); await seed(db)
  let release!: () => void; let sends = 0
  const gate = new Promise<void>(r => { release = r })
  const slow = (async () => { sends++; await gate; return { id: 'g1' } }) as never
  const p = sendReopen(db, 'A', 't1', { env, now: NOW, master, sendFn: slow, fetchImpl: tf })
  await new Promise(r => setTimeout(r, 20))
  assert.equal(st(db), 'approved')
  for (const as of ['retry', 'sent'] as const) { assert.throws(() => resolveReopen(db, 'A', 't1', as, NOW + 5), /send_in_progress/); assert.equal(st(db), 'approved') }
  assert.equal((await attempt(db)).sends, 0) // a second click while active is refused too
  release(); await p
  assert.equal(sends, 1); assert.equal(st(db), 'sent')
  assert.equal((db.prepare("SELECT gmail_id FROM reopen_messages").get() as { gmail_id: string }).gmail_id, 'g1')
})
test('a crashed claim (older than the lease) becomes resolvable; sent keeps the claim time, retry returns a draft that sends once on a fresh Send', async () => {
  const mk = async () => { const db = new Database(':memory:'); await seed(db); db.prepare("UPDATE reopen_messages SET status='approved', sent_at=?").run(NOW - SENDING_STALE_S - 1); return db }
  const a = await mk(); assert.equal(anyUncertainSend(a, 'A'), true)
  resolveReopen(a, 'A', 't1', 'sent', NOW); assert.equal(st(a), 'sent')
  assert.equal((a.prepare('SELECT sent_at FROM reopen_messages').get() as { sent_at: number }).sent_at, NOW - SENDING_STALE_S - 1)
  assert.equal(anyUncertainSend(a, 'A'), false)
  const b = await mk(); resolveReopen(b, 'A', 't1', 'retry', NOW); assert.equal(st(b), 'draft')
  assert.equal((b.prepare('SELECT sent_at FROM reopen_messages').get() as { sent_at: number | null }).sent_at, null)
  const r = await attempt(b); assert.equal(r.sends, 1); assert.equal(st(b), 'sent')
})
test('a claim confirmed sent keeps counting only while its claim time is inside 24h', async () => {
  const db = new Database(':memory:'); await seed(db)
  db.prepare("UPDATE reopen_messages SET status='approved', sent_at=?").run(NOW - 3600)
  resolveReopen(db, 'A', 't1', 'sent', NOW); assert.equal(accountSendCount(db, 'A', NOW), 1)
  assert.equal(accountSendCount(db, 'A', NOW + 86400), 0)
})
test('in-process operation: resolve is refused while this process is still sending, even when the lease clock says it is old', async () => {
  const db = new Database(':memory:'); await seed(db)
  let release!: () => void; const gate = new Promise<void>(r => { release = r })
  const p = sendReopen(db, 'A', 't1', { env, now: NOW, master, sendFn: (async () => { await gate; return { id: 'g3' } }) as never, fetchImpl: tf })
  await new Promise(r => setTimeout(r, 20))
  for (const as of ['retry', 'sent'] as const) assert.throws(() => resolveReopen(db, 'A', 't1', as, NOW + 5 * SENDING_STALE_S), /send_in_progress/)
  assert.equal(st(db), 'approved'); release(); await p; assert.equal(st(db), 'sent')
  // finished: no longer in flight, and a sent row is not resolvable
  assert.throws(() => resolveReopen(db, 'A', 't1', 'retry', NOW + 5 * SENDING_STALE_S), /not_uncertain/)
})
test('stale original completes after another process reset the row AND a second claim exists: the newer claim is not overwritten', async () => {
  const db = new Database(':memory:'); await seed(db)
  let release1!: () => void; const gate1 = new Promise<void>(r => { release1 = r })
  const p1 = sendReopen(db, 'A', 't1', { env, now: NOW, master, sendFn: (async () => { await gate1; return { id: 'orig' } }) as never, fetchImpl: tf })
  await new Promise(r => setTimeout(r, 20))
  // another process resets the row and a second claim starts (simulated directly; this process's lock does not cover it)
  db.prepare("UPDATE reopen_messages SET status='approved', sent_at=? WHERE thread_id='t1'").run(NOW + 700)
  release1()
  await assert.rejects(p1, /send_uncertain/)
  const row = db.prepare("SELECT status, sent_at, gmail_id FROM reopen_messages").get() as { status: string; sent_at: number; gmail_id: string | null }
  assert.deepEqual(row, { status: 'approved', sent_at: NOW + 700, gmail_id: null })
})
test('stale original completes after the row was reset to a draft (no newer claim): closed as sent; after a skip or a user mark-sent it is not overwritten', async () => {
  const run = async (mut: (db: Database.Database) => void) => {
    const db = new Database(':memory:'); await seed(db)
    let rel!: () => void; const gate = new Promise<void>(r => { rel = r })
    const p = sendReopen(db, 'A', 't1', { env, now: NOW, master, sendFn: (async () => { await gate; return { id: 'orig' } }) as never, fetchImpl: tf })
    await new Promise(r => setTimeout(r, 20)); mut(db); rel()
    const out = await p.then(() => 'ok', e => (e as Error).message)
    return { out, row: db.prepare("SELECT status, gmail_id FROM reopen_messages").get() as { status: string; gmail_id: string | null } }
  }
  assert.deepEqual(await run(db => db.prepare("UPDATE reopen_messages SET status='draft', sent_at=NULL").run()), { out: 'ok', row: { status: 'sent', gmail_id: 'orig' } })
  assert.deepEqual(await run(db => db.prepare("UPDATE reopen_messages SET status='skipped'").run()), { out: 'send_uncertain', row: { status: 'skipped', gmail_id: null } })
  assert.deepEqual(await run(db => db.prepare("UPDATE reopen_messages SET status='sent'").run()), { out: 'send_uncertain', row: { status: 'sent', gmail_id: null } })
})
