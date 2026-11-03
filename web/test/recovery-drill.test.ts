// scripts/backup/recovery-drill.mts on a synthetic backup (test/helpers/recovery-fixture.mts): content, full decryption
// under the recovered key and the send-safety inventory pass; a wrong key, a modified backup and every guard fail.
// The app-readability step needs a production build: test/smoke/recovery-drill.smoke.mjs.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { fixtureBackup } from './helpers/recovery-fixture.mts'

const web = fileURLToPath(new URL('../', import.meta.url))
const T = mkdtempSync(path.join(tmpdir(), 'recovery-drill-test-'))
test.after(() => rmSync(T, { recursive: true, force: true }))
const fx = await fixtureBackup(T)
let n = 0
const drill = (args: string[], env: Record<string, string> = {}) => {
  const e = { ...process.env, ...env }; delete e.NODE_TEST_CONTEXT
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', 'scripts/backup/recovery-drill.mts', ...args], { cwd: web, env: e, encoding: 'utf8', timeout: 60_000 })
  return { code: r.status, out: r.stdout + r.stderr }
}
const base = () => ['--backup', fx.backup, '--key-file', fx.keyFile, '--work-dir', path.join(T, `work-${++n}`)]

test('passes: content restored, every stored secret decrypts under the recovered key, send-safety counts reported', () => {
  const report = path.join(T, 'report.json')
  const r = drill([...base(), '--report', report])
  assert.equal(r.code, 0, r.out)
  const j = JSON.parse(readFileSync(report, 'utf8'))
  assert.equal(j.ok, true)
  assert.deepEqual(j.steps.map((s: { step: string }) => s.step), ['content', 'key recovery', 'send safety (reconcile before enabling sending)'])
  const key = j.steps[1].detail
  assert.equal(key.failed, 0); assert.equal(key.total, 2) // the stored LLM key and the Gmail refresh token
  assert.equal(key.columns['tenant_llm_keys.ciphertext'].decrypted, 1); assert.equal(key.columns['gmail_accounts.refresh_ct'].decrypted, 1)
  assert.equal(typeof j.rpo_at_drill_s, 'number'); assert.ok(j.measured_rto_ms > 0)
  assert.ok(!readFileSync(report, 'utf8').includes('sk-ant-api03'), 'no plaintext in the report')
  assert.ok(!r.out.includes(fx.key), 'no key material in the output')
  assert.equal(existsSync(path.join(T, `work-${n}`)), false, 'the restored copy is deleted')
})

test('a wrong master key fails key recovery and names the columns', () => {
  const wrong = path.join(T, 'wrong.key'); writeFileSync(wrong, randomBytes(32).toString('base64'), { mode: 0o600 })
  const r = drill(['--backup', fx.backup, '--key-file', wrong, '--work-dir', path.join(T, `work-${++n}`)])
  assert.equal(r.code, 1); assert.match(r.out, /FAIL key recovery .*"failed":2/)
})

test('a backup modified after it was taken fails the content step', () => {
  const dir = path.join(T, 'tampered'); mkdirSync(dir)
  const copy = path.join(dir, path.basename(fx.backup)); writeFileSync(copy, readFileSync(fx.backup)); writeFileSync(copy + '.json', readFileSync(fx.backup + '.json'))
  appendFileSync(copy, Buffer.from('x'))
  const r = drill(['--backup', copy, '--key-file', fx.keyFile, '--work-dir', path.join(T, `work-${++n}`)])
  assert.equal(r.code, 1); assert.match(r.out, /FAIL content/)
})

test('refuses: existing work dir, a key file others can read, the live database as the backup, work dir beside it', () => {
  const used = path.join(T, 'used'); mkdirSync(used)
  assert.equal(drill(['--backup', fx.backup, '--key-file', fx.keyFile, '--work-dir', used]).code, 2)
  const open = path.join(T, 'open.key'); writeFileSync(open, readFileSync(fx.keyFile)); chmodSync(open, 0o644)
  assert.match(drill(['--backup', fx.backup, '--key-file', open, '--work-dir', path.join(T, `work-${++n}`)]).out, /chmod 600/)
  assert.match(drill(['--backup', fx.source, '--key-file', fx.keyFile, '--work-dir', path.join(T, `work-${++n}`)], { DB_PATH: fx.source }).out, /never the live database/)
  const beside = drill(['--backup', fx.backup, '--key-file', fx.keyFile, '--work-dir', path.join(path.dirname(fx.source), 'drill')], { DB_PATH: fx.source })
  assert.equal(beside.code, 2); assert.match(beside.out, /inside DB_PATH's directory/)
})

test('unresolved sends and live leases in the backup are counted for reconciliation before sending is re-enabled', async () => {
  const dir = path.join(T, 'unresolved'); mkdirSync(dir)
  const u = await fixtureBackup(dir, (raw, tenant) => {
    const leads = (raw.prepare('SELECT l.id FROM leads l JOIN scan_jobs j ON j.id = l.scan_job_id WHERE j.user_id = ? LIMIT 2').all(tenant) as { id: string }[]).map(l => l.id)
    const ins = raw.prepare("INSERT INTO outreach_messages (id, tenant_id, lead_id, to_email, subject, body, status, claimed_at) VALUES (?, ?, ?, 'x@staging.dazl.test', 'A quick question', 'A synthetic body long enough for the check.', ?, 1)")
    ins.run(randomBytes(12).toString('hex'), tenant, leads[0], 'uncertain'); ins.run(randomBytes(12).toString('hex'), tenant, leads[1], 'sending')
    raw.prepare("INSERT INTO app_leases (name, owner, expires_at) VALUES ('internal-tick', 'old-host', ?)").run(Math.floor(Date.now() / 1000) + 3600)
  })
  const report = path.join(dir, 'report.json')
  const r = drill(['--backup', u.backup, '--key-file', u.keyFile, '--work-dir', path.join(T, `work-${++n}`), '--report', report])
  assert.equal(r.code, 0, r.out)
  const d = JSON.parse(readFileSync(report, 'utf8')).steps[2].detail
  assert.deepEqual([d.messages_uncertain, d.messages_sending, d.leases_unexpired_at_drill], [1, 1, 1])
})
