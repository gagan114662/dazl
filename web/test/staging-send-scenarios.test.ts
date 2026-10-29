// scripts/staging-send-scenarios.mts (issue #362 part 2): the six send-safety scenarios pass on the real send code, the
// runner refuses to run outside staging or onto a used or live directory, and its only transport refuses any recipient
// outside the allowlist. Mutation runs (suppression off, reaped claims released, uncertain sends released, replies
// ignored, approval hash unchecked) each failed the matching scenario when this was written; see the PR.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ALLOWLIST, AllowlistError, recordedBody, recordingTransport } from '../scripts/staging-send-scenarios.mts'
import { buildMime } from '../lib/gmail/mime.ts'

const web = fileURLToPath(new URL('../', import.meta.url))
const T = mkdtempSync(path.join(tmpdir(), 'send-scenarios-test-'))
test.after(() => rmSync(T, { recursive: true, force: true }))
const run = (out: string, env: Record<string, string | undefined> = { DAZL_ENV: 'staging' }) => {
  const e = { ...process.env, ...env }; delete e.NODE_TEST_CONTEXT
  for (const [k, v] of Object.entries(env)) if (v === undefined) delete e[k]
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', '--import', './test/helpers/net-fence.ts', 'scripts/staging-send-scenarios.mts', '--out', out], { cwd: web, env: e, encoding: 'utf8', timeout: 120_000 })
  return { code: r.status, out: r.stdout + r.stderr }
}

test('all six scenarios pass; every recorded send went to an allowlisted address', () => {
  const out = path.join(T, 'run')
  const r = run(out)
  assert.equal(r.code, 0, r.out)
  const ev = JSON.parse(readFileSync(path.join(out, 'evidence.json'), 'utf8'))
  assert.equal(ev.ok, true)
  assert.deepEqual(ev.scenarios.map((s: { name: string }) => s.name), ['owned-inbox-handoff', 'reply-stop', 'opt-out', 'bounce', 'uncertain', 'restart'])
  for (const s of ev.scenarios) { assert.ok(s.checks.length >= 3, s.name); assert.ok(s.checks.every((c: { ok: boolean }) => c.ok), JSON.stringify(s)) }
  assert.ok(ev.transport_calls > 0)
  assert.ok(ev.transport_recipients.every((to: string) => ALLOWLIST.has(to) && to.endsWith('@staging.dazl.test')))
  assert.match(ev.sending, /^off: .*recorded hand-off.*nothing is delivered/)
  const owned = ev.scenarios[0].checks.map((c: { what: string }) => c.what)
  for (const w of ['subject is the approved subject', 'body before the footer is exactly the approved words', 'footer unsubscribe link equals the List-Unsubscribe header', 'the link resolves to this message']) assert.ok(owned.includes(w), w)
})

test('refuses: outside staging, onto a non-empty directory, inside the live database directory', () => {
  assert.equal(run(path.join(T, 'prod'), { DAZL_ENV: undefined }).code, 2)
  const used = path.join(T, 'used'); mkdirSync(used); writeFileSync(path.join(used, 'x'), '')
  const r = run(used); assert.equal(r.code, 2); assert.match(r.out, /not empty/)
  const live = path.join(T, 'live'); mkdirSync(live)
  const inside = run(path.join(live, 'scn'), { DAZL_ENV: 'staging', DB_PATH: path.join(live, 'app.db') })
  assert.equal(inside.code, 2); assert.match(inside.out, /inside DB_PATH's directory/)
  assert.equal(existsSync(path.join(live, 'scn')), false)
})

test('the transport refuses a recipient outside the allowlist and records nothing', async () => {
  const log = path.join(T, 'transport.log')
  const mime = (to: string) => Buffer.from(`To: ${to}\r\nSubject: hi\r\n\r\nbody`).toString('base64url')
  const send = recordingTransport(log, 'x')
  await assert.rejects(send('t', mime('someone@gmail.com')), AllowlistError)
  await assert.rejects(send('t', mime('Owner <owner-inbox@staging.dazl.test.evil.example>')), AllowlistError)
  assert.equal(existsSync(log), false)
  assert.deepEqual(Object.keys(await send('t', mime('Owner <owner-inbox@staging.dazl.test>'))), ['id', 'threadId'])
  assert.equal(readFileSync(log, 'utf8').trim().split('\n').length, 1)
})

test('recordedBody decodes what lib/gmail/mime.ts builds, exactly (unicode and line breaks kept)', () => {
  const body = 'Line one, exactly.\nZweite Zeile: \u00fc\u00f1\u00ee\u00e7\u00f8d\u00e9 \u2014 kept.\n\n--\nName'
  const mime = buildMime({ fromName: 'A', fromEmail: 'a@staging.dazl.test', to: 'b@staging.dazl.test', subject: 's', body, messageId: 'm@x', unsubscribeUrl: 'https://staging.dazl.test/u' })
  assert.equal(recordedBody(mime), body)
  assert.equal(recordedBody('To: x\r\n\r\nplain'), null) // not the encoding the app sends: not read as matching
})
