// Replacement-host restore drill, full mode (issue #360): the whole host-loss path on synthetic data, end to end.
// A production-shaped backup (test/helpers/recovery-fixture.mts) is copied off-host by the shipped
// ops/backup/offhost-copy.sh, the secrets/config by scripts/backup/config-backup.mts (master key excluded, its own
// identity); then, as on a replacement host, scripts/backup/replacement-drill.mts fetches and decrypts both with the
// separately held identities and the recovered master key, and starts THIS checkout's production build on the restored
// copy with sending disabled. Every check must pass: copy and config restored, keys separate, every secret decrypts, a
// real password sign-in, a scan accepted and read back, scans/leads/key status read, the tick refused. Prints the
// dated report. NOT part of `npm test`; run after a build, with age installed:
//   npm run test:smoke:replacement
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { root, notRun } from './harness.mjs'

if (!existsSync(path.join(root, '.next/BUILD_ID'))) notRun('no production build (run npm run build first)')
if (spawnSync('age', ['--version']).status !== 0) notRun('age is not installed (apt install age)')
const { fixtureBackup } = await import('../helpers/recovery-fixture.mts')
const T = mkdtempSync(path.join(tmpdir(), 'dazl-replacement-smoke-'))
try {
  const fx = await fixtureBackup(path.join(T, 'old-host'))
  const pair = name => {
    const id = path.join(T, `${name}-identity.txt`), pub = path.join(T, `${name}-recipients.txt`)
    assert.equal(spawnSync('age-keygen', ['-o', id]).status, 0); chmodSync(id, 0o600)
    writeFileSync(pub, readFileSync(id, 'utf8').match(/public key: (age1\S+)/)[1] + '\n')
    return { id, pub }
  }
  const data = pair('data'), cfg = pair('config')
  const dest = path.join(T, 'offhost'); mkdirSync(dest)
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, OFFHOST_AGE_RECIPIENTS: data.pub, OFFHOST_DEST: dest }
  const copy = spawnSync('bash', [path.join(root, '../ops/backup/offhost-copy.sh'), fx.backup], { encoding: 'utf8', env })
  assert.equal(copy.status, 0, copy.stdout + copy.stderr)
  const etc = path.join(T, 'etc'); mkdirSync(etc)
  writeFileSync(path.join(etc, 'env'), `NODE_ENV=production\nDAZL_MASTER_KEY=${fx.key}\nSTRIPE_SECRET_KEY=sk_test_synthetic\n`)
  writeFileSync(path.join(etc, 'Caddyfile'), 'dazl.ai {\n  reverse_proxy 127.0.0.1:3100\n}\n')
  const cb = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', 'scripts/backup/config-backup.mts', '--state-dir', path.join(T, 'state')], { cwd: root, encoding: 'utf8', env: { ...env, CONFIG_FILES: `${etc}/env ${etc}/Caddyfile`, CONFIG_AGE_RECIPIENTS: cfg.pub } })
  assert.equal(cb.status, 0, cb.stdout + cb.stderr)
  // the old host is gone: only the off-host destination and the separately held keys remain
  rmSync(path.join(T, 'old-host', 'live'), { recursive: true, force: true }); rmSync(path.join(T, 'old-host', 'backups'), { recursive: true, force: true })
  const reports = path.join(T, 'reports')
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', 'scripts/backup/replacement-drill.mts', '--offhost', dest, '--identity', data.id, '--config-identity', cfg.id, '--key-file', fx.keyFile,
    '--work-dir', path.join(T, 'replacement'), '--app', root, '--report-dir', reports, '--manual', 'provision=0,install=0,dns=0', '--rpo-target-s', '3600', '--rto-target-s', '14400'], { cwd: root, encoding: 'utf8', timeout: 600_000 })
  console.log(r.stdout + r.stderr)
  const json = readdirSync(reports).find(f => /^restore-report-\d{8}T\d{6}Z\.json$/.test(f)), md = readdirSync(reports).find(f => f.endsWith('.md'))
  assert.ok(json && md, 'a dated JSON and markdown report')
  const j = JSON.parse(readFileSync(path.join(reports, json), 'utf8'))
  console.log(readFileSync(path.join(reports, md), 'utf8'))
  assert.equal(r.status, 0)
  assert.equal(j.ok, true)
  assert.deepEqual(Object.entries(j.checks).filter(([, v]) => v !== true), [], 'every check passed')
  for (const k of ['sign_in', 'scan', 'read', 'decrypt', 'sending_disabled', 'config_and_secrets_restored', 'keys_separate']) assert.equal(j.checks[k], true, k)
  assert.equal(j.targets.rpo_met, true); assert.equal(j.targets.rto_met, true); assert.equal(j.measured.rto_complete, true)
  const text = readFileSync(path.join(reports, json), 'utf8')
  for (const s of [fx.key, 'sk_test_synthetic', 'AGE-SECRET-KEY']) assert.ok(!text.includes(s), 'the report holds no key or secret')
  console.log(`ok   replacement-host drill: RPO ${j.measured.rpo_s} s, automated ${j.measured.automated_s} s, app ready ${j.measured.app_ready_ms} ms`)
} finally { rmSync(T, { recursive: true, force: true }) }
