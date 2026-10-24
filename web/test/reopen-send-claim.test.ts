import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import Database from 'better-sqlite3'
import { migrateScan } from '../lib/scan/store.ts'
import { migrateOutreach } from '../lib/outreach/store.ts'
import { migrateReplies } from '../lib/outreach/replies.ts'
import { migrateLedger } from '../lib/outreach/ledger.ts'
import { saveSettings, suppress } from '../lib/outreach/service.ts'
import { completeOAuth, startOAuth } from '../lib/gmail/oauth.ts'
import { createReopenDraft, migrateReopen, sendReopen } from '../lib/outreach/reopen.ts'
const master = randomBytes(32)
const env = { GOOGLE_CLIENT_ID: 'cid.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'csecret', PUBLIC_BASE_URL: 'https://app.test' }
const NOW = 1_800_000_000
const idToken = (email: string) => 'x.' + Buffer.from(JSON.stringify({ email, email_verified: true })).toString('base64url') + '.y'
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status })
function mk() {
  const db = new Database(':memory:')
  migrateScan(db); migrateOutreach(db); migrateReplies(db); migrateLedger(db); migrateReopen(db)
  saveSettings(db, 'A', { sender_name: 'G', postal_address: '1 King St W, Toronto ON, Canada', booking_url: null })
  return db
}
async function seed(db: Database.Database) {
  const state = new URL(startOAuth(db, 'A', { env, now: NOW })).searchParams.get('state')!
  await completeOAuth(db, 'A', 'code', state, { env, master, now: NOW, fetchImpl: (async () => json({ refresh_token: 'rt', scope: 'openid email https://www.googleapis.com/auth/gmail.send', id_token: idToken('me@acme.example') })) as unknown as typeof fetch })
  const tid = 'thread-x1', lid = 'lead-x1', email = 'pat@acme.com'
  db.prepare("INSERT INTO scan_jobs (id, user_id, business_name, industry, location, status) VALUES ('job-x1','A','b','i','l','running')").run()
  db.prepare("INSERT INTO leads (id, scan_job_id, name, company, contact, signal, source_url) VALUES (?, 'job-x1','Pat','Acme','pat@acme.com','hiring AEs','https://n.com/a')").run(lid)
  db.prepare("UPDATE scan_jobs SET status='done' WHERE id='job-x1'").run()
  db.prepare("INSERT INTO outreach_messages (id, tenant_id, lead_id, to_email, subject, body, status, sent_at) VALUES ('m1','A',?,?,'Quick question for Acme','Hi Pat, body text here for the first mail.','sent',?)").run(lid, email, NOW - 86400 * 50)
  db.prepare('INSERT INTO followup_threads (tenant_id, thread_id, lead_id, to_email, root_message_id, last_activity_at, last_lead_reply_at, followups_sent, stopped) VALUES (?,?,?,?,?,?,?,2,NULL)').run('A', tid, lid, email, 'root@x', NOW - 86400 * 45, NOW - 86400 * 45)
  db.prepare("INSERT INTO inbound_messages (gmail_id, tenant_id, thread_id, lead_id, from_email, excerpt, classification, received_at) VALUES ('gx','A',?,?,'pat@acme.com','sounds interesting','positive',?)").run(tid, lid, NOW - 86400 * 45)
  db.prepare('UPDATE leads SET human_confirmed_at = 1 WHERE id = ?').run(lid)
  createReopenDraft(db, 'A', tid, 'Dazl')
  return tid
}
const tokenFetch = (async () => ({ ok: true, json: async () => ({ access_token: 'x' }) })) as never
import { skipReopen, listReopens } from '../lib/outreach/reopen.ts'
test('concurrent sendReopen on one draft sends exactly once; the loser is told the outcome is not settled', async () => {
  const db = mk(); const tid = await seed(db)
  let sends = 0
  const slow = (async () => { sends++; await new Promise(r => setTimeout(r, 50)); return { id: 'g' + sends } }) as never
  const d = { env, now: NOW, master, sendFn: slow, fetchImpl: tokenFetch }
  const res = await Promise.allSettled([sendReopen(db, 'A', tid, d), sendReopen(db, 'A', tid, d)])
  assert.equal(sends, 1)
  assert.deepEqual(res.map(r => r.status).sort(), ['fulfilled', 'rejected'])
  const rej = res.find(r => r.status === 'rejected') as PromiseRejectedResult
  assert.match(String(rej.reason), /send_uncertain|already_sent/)
  assert.equal(listReopens(db, 'A')[0].reopen!.status, 'sent')
})
test('a send that throws is never resent: claim stays, retry and skip are refused', async () => {
  const db = mk(); const tid = await seed(db)
  let sends = 0
  const flaky = (async () => { sends++; throw new Error('timeout_after_possible_delivery') }) as never
  const d = { env, now: NOW, master, sendFn: flaky, fetchImpl: tokenFetch }
  await assert.rejects(sendReopen(db, 'A', tid, d), /send_uncertain/)
  assert.equal(listReopens(db, 'A')[0].reopen!.status, 'approved')
  await assert.rejects(sendReopen(db, 'A', tid, d), /send_uncertain/)
  assert.throws(() => skipReopen(db, 'A', tid), /send_uncertain/)
  assert.equal(sends, 1)
})
test('a check that fails before the claim leaves the draft untouched (no claim taken, no send)', async () => {
  const db = mk(); const tid = await seed(db)
  let sends = 0
  const ok = (async () => { sends++; return { id: 'g' } }) as never
  suppress(db, 'A', 'pat@acme.com', 'unsubscribe')
  await assert.rejects(sendReopen(db, 'A', tid, { env, now: NOW, master, sendFn: ok, fetchImpl: tokenFetch }), /suppressed/)
  assert.equal(listReopens(db, 'A')[0].reopen!.status, 'draft')
  assert.equal(sends, 0)
})

// Cross-process stale read: the row is read as 'draft', then another writer claims it before the UPDATE runs.
function claimAfterRead(db: Database.Database, tid: string) {
  const wrapped = new Proxy(db, {
    get(t, k, r) {
      if (k !== 'prepare') return Reflect.get(t, k, r) instanceof Function ? (Reflect.get(t, k, r) as Function).bind(t) : Reflect.get(t, k, r)
      return (sql: string) => {
        const st = t.prepare(sql)
        if (!/^SELECT \* FROM reopen_messages/.test(sql)) return st
        return new Proxy(st, { get(s, kk) {
          if (kk !== 'get') return (s as never as Record<string, unknown>)[kk as string] instanceof Function ? ((s as never as Record<string, Function>)[kk as string]).bind(s) : (s as never as Record<string, unknown>)[kk as string]
          return (...a: unknown[]) => { const row = (s.get as Function).apply(s, a); t.prepare("UPDATE reopen_messages SET status='approved' WHERE thread_id=?").run(tid); return row }
        } })
      }
    },
  })
  return wrapped as Database.Database
}
import { editReopen } from '../lib/outreach/reopen.ts'
test('edit that read a draft but lost the claim race changes nothing', async () => {
  const db = mk(); const tid = await seed(db)
  const before = (db.prepare('SELECT body FROM reopen_messages WHERE thread_id=?').get(tid) as { body: string }).body
  assert.throws(() => editReopen(claimAfterRead(db, tid), 'A', tid, 'Hi Pat,\n\nA completely different reviewed body that should never land.\n\nThanks,'), /not_editable/)
  assert.equal((db.prepare('SELECT body FROM reopen_messages WHERE thread_id=?').get(tid) as { body: string }).body, before)
})
test('skip that read a draft but lost the claim race does not overwrite the claim', async () => {
  const db = mk(); const tid = await seed(db)
  assert.throws(() => skipReopen(claimAfterRead(db, tid), 'A', tid), /send_uncertain/)
  assert.equal((db.prepare('SELECT status FROM reopen_messages WHERE thread_id=?').get(tid) as { status: string }).status, 'approved')
})
