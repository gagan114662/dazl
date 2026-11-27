// #1089: readiness says whether account mail can leave the host and whether an account can be deleted (lib/ops/launch-checks.ts).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { sqliteDb } from '../lib/db/client.ts'
import { migrateAllSqlite } from '../lib/db/sqlite-migrations.ts'
import { loadMigrations } from '../lib/db/migrate-pg.ts'
import { readiness, resetLaunchReport } from '../lib/ops/health.ts'
import { setErrorSinks, type ErrorRecord } from '../lib/ops/errors.ts'
import type { MailCheck, DeletionCheck } from '../lib/ops/launch-checks.ts'
import { mailSettings, mailCheck, mailCheckSettled, deletionCheck, launchRequired, resetMailCheck, smtpVerify, MAIL_VERIFY_TTL_S, MAIL_VERIFY_FAIL_TTL_S } from '../lib/ops/launch-checks.ts'

const FROM = { SYSTEM_MAIL_FROM: 'dazl <leads@notify.example.test>' }

test('mail settings: both values, a real smtp(s) URL, and never port 25', () => {
  assert.deepEqual(mailSettings({}), { ok: false, reason: 'not_configured' })
  assert.deepEqual(mailSettings({ SYSTEM_MAIL_SMTP_URL: 'smtp://u:p@relay.example.test:587' }), { ok: false, reason: 'not_configured' }, 'no From address')
  assert.deepEqual(mailSettings({ ...FROM, SYSTEM_MAIL_SMTP_URL: 'not a url' }), { ok: false, reason: 'malformed' })
  assert.deepEqual(mailSettings({ ...FROM, SYSTEM_MAIL_SMTP_URL: 'https://relay.example.test' }), { ok: false, reason: 'malformed' })
  assert.deepEqual(mailSettings({ ...FROM, SYSTEM_MAIL_SMTP_URL: 'smtp://localhost:25' }), { ok: false, reason: 'port_25', port: 25 }, 'port 25 cannot leave this class of host')
  // no port in the URL: the port nodemailer itself would use (587, or 465 when secure)
  assert.equal((mailSettings({ ...FROM, SYSTEM_MAIL_SMTP_URL: 'smtp://u:p@relay.example.test' }) as { port: number }).port, 587)
  assert.equal((mailSettings({ ...FROM, SYSTEM_MAIL_SMTP_URL: 'smtp://u:p@relay.example.test?secure=true' }) as { port: number }).port, 465)
  assert.deepEqual(mailSettings({ ...FROM, SYSTEM_MAIL_SMTP_URL: 'smtp://u:p@relay.example.test:587' }), { ok: true, url: 'smtp://u:p@relay.example.test:587', port: 587 })
  assert.equal((mailSettings({ ...FROM, SYSTEM_MAIL_SMTP_URL: 'smtps://u:p@relay.example.test' }) as { port: number }).port, 465)
})

test('mail check: never waits; pending until the first verify, then ok; a failure and a timeout say which; nothing secret in the answer', async () => {
  const env = { ...FROM, SYSTEM_MAIL_SMTP_URL: 'smtp://user:s3cret-key@relay.example.test:587' }
  resetMailCheck()
  let calls = 0, t = 1_000_000
  const good = { verify: async () => { calls++ }, now: () => t }
  assert.deepEqual(mailCheck(env, good), { ok: false, reason: 'verify_pending', port: 587 }, 'the first probe answers at once, before the verify')
  await mailCheckSettled()
  const ok = mailCheck(env, good)
  assert.deepEqual(ok, { ok: true, port: 587, verified_s_ago: 0 })
  t += 120_000
  assert.deepEqual(mailCheck(env, good), { ok: true, port: 587, verified_s_ago: 120 }, 'inside the window: no new session')
  await mailCheckSettled(); assert.equal(calls, 1)
  // after the window the old answer stands while ONE new verify runs; a failure then replaces it
  t += MAIL_VERIFY_TTL_S * 1000
  const failing = { verify: async () => { calls++; throw new Error('535 authentication failed for user s3cret-key') }, now: () => t }
  assert.equal(mailCheck(env, failing).ok, true, 'the last known answer, not a wait')
  await mailCheckSettled()
  const bad = mailCheck(env, failing)
  assert.deepEqual(bad, { ok: false, reason: 'verify_failed', port: 587 }); assert.equal(calls, 2)
  assert.equal(JSON.stringify([ok, bad]).includes('s3cret'), false); assert.equal(JSON.stringify([ok, bad]).includes('relay.example'), false)
  // a failure is retried after 30 s, not 5 minutes: a fixed relay shows as ready soon
  t += 5_000; mailCheck(env, good); await mailCheckSettled(); assert.equal(calls, 2, 'inside the failure window: not retried yet')
  t += MAIL_VERIFY_FAIL_TTL_S * 1000; mailCheck(env, good); await mailCheckSettled(); assert.equal(calls, 3)
  assert.equal(mailCheck(env, good).ok, true, 'the relay was fixed: ready again within the failure window')
  resetMailCheck()
  mailCheck(env, { verify: () => new Promise(() => {}), timeoutMs: 50 }); await mailCheckSettled()
  assert.deepEqual(mailCheck(env, { verify: () => new Promise(() => {}), timeoutMs: 50, now: () => Date.now() }), { ok: false, reason: 'verify_timeout', port: 587 }, 'a server that never answers')
  resetMailCheck()
  let verified = 0
  assert.deepEqual(mailCheck({ ...FROM, SYSTEM_MAIL_SMTP_URL: 'smtp://localhost:25' }, { verify: async () => { verified++ } }), { ok: false, reason: 'port_25', port: 25 }); await mailCheckSettled(); assert.equal(verified, 0, 'port 25 is refused without connecting')
  // a changed URL is verified afresh, never answered from the old URL's result
  resetMailCheck()
  mailCheck(env, { verify: async () => {} }); await mailCheckSettled(); assert.equal(mailCheck(env, { verify: async () => {} }).ok, true)
  const other = { ...FROM, SYSTEM_MAIL_SMTP_URL: 'smtp://user:k@other.example.test:587' }
  assert.equal(mailCheck(other, { verify: async () => { throw new Error('nope') } }).ok, false, 'pending, not the old URL\'s ok'); await mailCheckSettled()
  assert.deepEqual(mailCheck(other, { verify: async () => {} }), { ok: false, reason: 'verify_failed', port: 587 })
})

test('mail check: any number of concurrent probes open ONE SMTP session', async () => {
  const env = { ...FROM, SYSTEM_MAIL_SMTP_URL: 'smtp://user:k@relay.example.test:587' }
  resetMailCheck()
  let calls = 0, release: () => void = () => {}
  const slow = { verify: () => { calls++; return new Promise<void>(r => { release = r }) } }
  for (let i = 0; i < 50; i++) assert.equal(mailCheck(env, slow).ok, false)
  assert.equal(calls, 1, '50 probes while a verify is in flight: one verify')
  release(); await mailCheckSettled()
  for (let i = 0; i < 50; i++) assert.equal(mailCheck(env, slow).ok, true)
  assert.equal(calls, 1)
})

// The real verifier against real sockets on this machine: a server that speaks SMTP, a closed port, a server that says nothing.
test('smtpVerify on real sockets: an SMTP server passes (a URL with no credentials is a connect only); a closed port and a silent server fail', async () => {
  const open: net.Socket[] = [], held: net.Socket[] = []
  const smtp = net.createServer(sock => {
    open.push(sock)
    sock.write('220 fixture ESMTP\r\n')
    sock.on('data', d => { const line = String(d).trim().toUpperCase(); if (line.startsWith('EHLO') || line.startsWith('HELO')) sock.write('250-fixture\r\n250 OK\r\n'); else if (line.startsWith('QUIT')) { sock.write('221 bye\r\n'); sock.end() } else sock.write('250 OK\r\n') })
    sock.on('error', () => {})
  })
  const silent = net.createServer(sock => { held.push(sock); sock.on('error', () => {}) })
  const listen = (s: net.Server) => new Promise<number>(r => s.listen(0, '127.0.0.1', () => r((s.address() as net.AddressInfo).port)))
  const good = await listen(smtp), quiet = await listen(silent)
  const settled = async (url: string, timeoutMs: number) => { resetMailCheck(); const env = { ...FROM, SYSTEM_MAIL_SMTP_URL: url }; mailCheck(env, { verify: smtpVerify, timeoutMs }); await mailCheckSettled(); return mailCheck(env, { verify: smtpVerify, timeoutMs }) }
  try {
    assert.deepEqual(await settled(`smtp://127.0.0.1:${good}`, 3000), { ok: true, port: good, verified_s_ago: 0 }, 'no credentials in the URL: the connect alone passes (stated, not hidden)')
    // the verifier's own timeouts reach nodemailer: the client gives up on the silent server and CLOSES its socket within about
    // the timeout (nodemailer's defaults would hold it for 30 s to 10 minutes, one more abandoned session every retry)
    const t0 = Date.now()
    const q = await settled(`smtp://127.0.0.1:${quiet}`, 600)
    assert.equal(q.ok, false); assert.match((q as { reason: string }).reason, /verify_(timeout|failed)/)
    assert.equal(held.length, 1, 'one session reached the silent server')
    const closedAfter = await new Promise<number>(resolve => { const sock = held[0]; if (sock.destroyed || sock.readableEnded) return resolve(Date.now() - t0); const done = () => resolve(Date.now() - t0); sock.once('close', done); sock.once('end', done); setTimeout(() => resolve(-1), 5000) })
    assert.ok(closedAfter >= 0 && closedAfter < 3000, `the client closed its session ${closedAfter} ms after it started (timeout 600 ms); -1 = still open after 5 s`)
    assert.equal((await settled('smtp://127.0.0.1:1', 1500)).ok, false, 'nothing listens on port 1')
  } finally { for (const h of [...held, ...open]) h.destroy(); smtp.close(); silent.close() }
})

test('deletion check: the ledger must be named and writable; staging is not held to it', () => {
  assert.deepEqual(deletionCheck({}), { ok: false, reason: 'not_configured' })
  assert.deepEqual(deletionCheck({ DAZL_ENV: 'staging' }), { ok: true, skipped: 'staging' })
  const dir = mkdtempSync(path.join(tmpdir(), 'dazl-ledger-'))
  try {
    assert.deepEqual(deletionCheck({ DAZL_TOMBSTONE_LEDGER: path.join(dir, 'ledger.jsonl') }), { ok: true }, 'a file that does not exist yet in a writable directory')
    const f = path.join(dir, 'ro.jsonl'); writeFileSync(f, ''); chmodSync(f, 0o400)
    if (process.getuid?.() !== 0) assert.deepEqual(deletionCheck({ DAZL_TOMBSTONE_LEDGER: f }), { ok: false, reason: 'not_writable' })
    assert.deepEqual(deletionCheck({ DAZL_TOMBSTONE_LEDGER: '/nonexistent-dir-1089/ledger.jsonl' }), { ok: false, reason: 'not_writable' })
    assert.deepEqual(deletionCheck({ DAZL_TOMBSTONE_LEDGER: dir }), { ok: false, reason: 'not_writable' }, 'a directory is not a ledger file')
    const wo = path.join(dir, 'wo.jsonl'); writeFileSync(wo, ''); chmodSync(wo, 0o200)
    if (process.getuid?.() !== 0) assert.deepEqual(deletionCheck({ DAZL_TOMBSTONE_LEDGER: wo }), { ok: false, reason: 'not_writable' }, 'the delete route reads the ledger too')
    assert.equal(launchRequired({}), false); assert.equal(launchRequired({ DAZL_READY_REQUIRES_LAUNCH: '1' }), true); assert.equal(launchRequired({ DAZL_READY_REQUIRES_LAUNCH: 'true' }), false)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

// Review of #1222, finding 2: what readiness REPORTS (lib/ops/health.ts reportLaunchChecks), through the real readiness().
test('launch reporting: a healthy start raises nothing; a settled failure raises one record, once; a recovery and a new failure raise one more', async () => {
  const raw = new Database(':memory:'); migrateAllSqlite(raw)
  const got: ErrorRecord[] = []; const restore = setErrorSinks([r => got.push(r)])
  let mail: MailCheck = { ok: false, reason: 'verify_pending', port: 465 }, deletion: DeletionCheck = { ok: true }
  const probe = () => readiness({ db: async () => sqliteDb(raw), sqliteProbe: () => raw.prepare('SELECT 1').get(), migrations: () => loadMigrations().map(m => m.version), mail: () => mail, deletion: () => deletion })
  const launch = () => got.filter(r => r.where === 'readiness:launch').map(r => r.error.message)
  try {
    resetLaunchReport()
    // a healthy start: the first probe is pending (the check never waits), the second is ok
    assert.deepEqual((await probe()).launch, { ok: false, required: false }); mail = { ok: true, port: 465, verified_s_ago: 0 }
    assert.deepEqual((await probe()).launch, { ok: true, required: false })
    assert.deepEqual(launch(), [], 'pending is not a failure: a healthy start raises no alert')
    // the relay starts failing: one record however many probes see it
    mail = { ok: false, reason: 'verify_failed', port: 465 }
    for (let i = 0; i < 5; i++) await probe()
    assert.deepEqual(launch(), ['not ready for customers: mail:verify_failed'])
    // a pending answer while it is being re-verified changes nothing
    mail = { ok: false, reason: 'verify_pending', port: 465 }; await probe()
    mail = { ok: false, reason: 'verify_failed', port: 465 }; await probe()
    assert.equal(launch().length, 1, 'still the same failure: not reported again')
    // recovered, then failing again: one more
    mail = { ok: true, port: 465, verified_s_ago: 0 }; await probe()
    mail = { ok: false, reason: 'verify_timeout', port: 465 }; await probe(); await probe()
    assert.deepEqual(launch(), ['not ready for customers: mail:verify_failed', 'not ready for customers: mail:verify_timeout'])
    // the ledger goes missing while mail is fine: one record
    mail = { ok: true, port: 465, verified_s_ago: 0 }; await probe(); deletion = { ok: false, reason: 'not_configured' }; await probe(); await probe()
    assert.equal(launch().length, 3); assert.equal(launch()[2], 'not ready for customers: deletion:not_configured')
  } finally { restore(); resetLaunchReport() }
})

// Qodo on #1754: a pending mail verification must not mask the other launch checks.
test('launch reporting: an outbox failure while mail is pending still raises one record, and mail settling does not raise it again', async () => {
  const raw = new Database(':memory:'); migrateAllSqlite(raw)
  const got: ErrorRecord[] = []; const restore = setErrorSinks([r => got.push(r)])
  let mail: MailCheck = { ok: false, reason: 'verify_pending', port: 465 }
  const outbox = { ok: false, reason: 'stale', stored: 2, oldest_age_s: 9999 } as const
  const probe = () => readiness({ db: async () => sqliteDb(raw), sqliteProbe: () => raw.prepare('SELECT 1').get(), migrations: () => loadMigrations().map(m => m.version), mail: () => mail, deletion: () => ({ ok: true }), outbox: async () => outbox })
  const launch = () => got.filter(r => r.where === 'readiness:launch').map(r => r.error.message)
  try {
    resetLaunchReport()
    await probe(); await probe()
    assert.deepEqual(launch(), ['not ready for customers: outbox:stale'], 'the outbox failure reports even though mail is pending')
    mail = { ok: true, port: 465, verified_s_ago: 0 }; await probe()
    assert.equal(launch().length, 1, 'mail settling does not report the same outbox failure again')
  } finally { restore(); resetLaunchReport() }
})
