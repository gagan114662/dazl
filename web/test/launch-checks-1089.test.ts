// #1089: readiness says whether account mail can leave the host and whether an account can be deleted (lib/ops/launch-checks.ts).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { mailSettings, mailCheck, deletionCheck, resetMailCheck, smtpVerify, MAIL_VERIFY_TTL_S } from '../lib/ops/launch-checks.ts'

const FROM = { SYSTEM_MAIL_FROM: 'dazl <leads@notify.example.test>' }

test('mail settings: both values, a real smtp(s) URL, and never port 25', () => {
  assert.deepEqual(mailSettings({}), { ok: false, reason: 'not_configured' })
  assert.deepEqual(mailSettings({ SYSTEM_MAIL_SMTP_URL: 'smtp://u:p@relay.example.test:587' }), { ok: false, reason: 'not_configured' }, 'no From address')
  assert.deepEqual(mailSettings({ ...FROM, SYSTEM_MAIL_SMTP_URL: 'not a url' }), { ok: false, reason: 'malformed' })
  assert.deepEqual(mailSettings({ ...FROM, SYSTEM_MAIL_SMTP_URL: 'https://relay.example.test' }), { ok: false, reason: 'malformed' })
  assert.deepEqual(mailSettings({ ...FROM, SYSTEM_MAIL_SMTP_URL: 'smtp://localhost:25' }), { ok: false, reason: 'port_25', port: 25 }, 'port 25 cannot leave this class of host')
  assert.deepEqual(mailSettings({ ...FROM, SYSTEM_MAIL_SMTP_URL: 'smtp://localhost' }), { ok: false, reason: 'port_25', port: 25 }, 'a bare smtp:// URL means port 25')
  assert.deepEqual(mailSettings({ ...FROM, SYSTEM_MAIL_SMTP_URL: 'smtp://u:p@relay.example.test:587' }), { ok: true, url: 'smtp://u:p@relay.example.test:587', port: 587 })
  assert.equal((mailSettings({ ...FROM, SYSTEM_MAIL_SMTP_URL: 'smtps://u:p@relay.example.test' }) as { port: number }).port, 465)
})

test('mail check: ok only after a verify that succeeded; a failure and a timeout say which; the answer never carries the host or the secret', async () => {
  const env = { ...FROM, SYSTEM_MAIL_SMTP_URL: 'smtp://user:s3cret-key@relay.example.test:587' }
  resetMailCheck()
  let calls = 0, t = 1_000_000
  const ok = await mailCheck(env, { verify: async () => { calls++ }, now: () => t })
  assert.deepEqual(ok, { ok: true, port: 587, verified_s_ago: 0 })
  t += 120_000
  assert.deepEqual(await mailCheck(env, { verify: async () => { calls++ }, now: () => t }), { ok: true, port: 587, verified_s_ago: 120 }, 'inside the cache window: no new connection')
  assert.equal(calls, 1)
  t += MAIL_VERIFY_TTL_S * 1000
  const bad = await mailCheck(env, { verify: async () => { calls++; throw new Error('535 authentication failed for user s3cret-key') }, now: () => t })
  assert.deepEqual(bad, { ok: false, reason: 'verify_failed', port: 587 }); assert.equal(calls, 2, 'verified again after the window')
  assert.equal(JSON.stringify([ok, bad]).includes('s3cret'), false); assert.equal(JSON.stringify([ok, bad]).includes('relay.example'), false)
  assert.deepEqual(await mailCheck(env, { verify: async () => { calls++ }, now: () => t + 1000 }), bad, 'a failure is cached too')
  resetMailCheck()
  assert.deepEqual(await mailCheck(env, { verify: () => new Promise(() => {}), timeoutMs: 50 }), { ok: false, reason: 'verify_timeout', port: 587 }, 'a server that never answers')
  resetMailCheck()
  let verified = 0
  assert.deepEqual(await mailCheck({ ...FROM, SYSTEM_MAIL_SMTP_URL: 'smtp://localhost:25' }, { verify: async () => { verified++ } }), { ok: false, reason: 'port_25', port: 25 }); assert.equal(verified, 0, 'port 25 is refused without connecting')
  // a changed URL is verified afresh, never answered from the old URL's result
  resetMailCheck()
  await mailCheck(env, { verify: async () => {} })
  assert.equal((await mailCheck({ ...FROM, SYSTEM_MAIL_SMTP_URL: 'smtp://user:k@other.example.test:587' }, { verify: async () => { throw new Error('nope') } })).ok, false)
})

// The real verifier against real sockets on this machine: a server that speaks SMTP, a closed port, a server that says nothing.
test('smtpVerify on real sockets: an SMTP server passes; a closed port and a silent server fail', async () => {
  const open: net.Socket[] = []
  const smtp = net.createServer(sock => {
    open.push(sock)
    sock.write('220 fixture ESMTP\r\n')
    sock.on('data', d => { const line = String(d).trim().toUpperCase(); if (line.startsWith('EHLO') || line.startsWith('HELO')) sock.write('250-fixture\r\n250 OK\r\n'); else if (line.startsWith('QUIT')) { sock.write('221 bye\r\n'); sock.end() } else sock.write('250 OK\r\n') })
    sock.on('error', () => {})
  })
  const held: net.Socket[] = []
  const silent = net.createServer(sock => { held.push(sock); sock.on('error', () => {}) })
  const listen = (s: net.Server) => new Promise<number>(r => s.listen(0, '127.0.0.1', () => r((s.address() as net.AddressInfo).port)))
  const good = await listen(smtp), quiet = await listen(silent)
  try {
    resetMailCheck()
    assert.deepEqual(await mailCheck({ ...FROM, SYSTEM_MAIL_SMTP_URL: `smtp://127.0.0.1:${good}` }, { verify: smtpVerify, timeoutMs: 3000 }), { ok: true, port: good, verified_s_ago: 0 })
    resetMailCheck()
    const q = await mailCheck({ ...FROM, SYSTEM_MAIL_SMTP_URL: `smtp://127.0.0.1:${quiet}` }, { verify: smtpVerify, timeoutMs: 600 })
    assert.equal(q.ok, false); assert.match((q as { reason: string }).reason, /verify_(timeout|failed)/)
    resetMailCheck()
    const c = await mailCheck({ ...FROM, SYSTEM_MAIL_SMTP_URL: 'smtp://127.0.0.1:1' }, { verify: smtpVerify, timeoutMs: 1500 })
    assert.equal(c.ok, false, 'nothing listens on port 1')
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
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
