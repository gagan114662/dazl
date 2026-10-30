// ops/backup/offhost-copy.sh, ops/backup/run-backup.sh and scripts/backup/backup-check.mts (issue #360) on a synthetic
// backup (test/helpers/recovery-fixture.mts). Needs the age binary: skipped with the reason when it is missing, and a
// failure instead when DAZL_REQUIRE_AGE=1 (CI installs age and sets it).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { fixtureBackup } from './helpers/recovery-fixture.mts'

const web = fileURLToPath(new URL('../', import.meta.url))
const ops = path.join(web, '../ops/backup')
const hasAge = spawnSync('age', ['--version']).status === 0
if (!hasAge && process.env.DAZL_REQUIRE_AGE === '1') throw new Error('DAZL_REQUIRE_AGE=1 but age is not installed')
const skip = hasAge ? false : 'age is not installed (apt install age)'
const T = mkdtempSync(path.join(tmpdir(), 'offhost-test-'))
test.after(() => rmSync(T, { recursive: true, force: true }))
const sh = (script: string, args: string[], env: Record<string, string>) => {
  const r = spawnSync('bash', [path.join(ops, script), ...args], { encoding: 'utf8', env: { PATH: process.env.PATH!, HOME: process.env.HOME!, ...env } as unknown as NodeJS.ProcessEnv, timeout: 60_000 })
  return { code: r.status, out: r.stdout + r.stderr }
}
const keys = () => {
  const id = path.join(T, 'identity.txt')
  if (!existsSync(id)) spawnSync('age-keygen', ['-o', id])
  const pub = path.join(T, 'recipients.txt')
  writeFileSync(pub, readFileSync(id, 'utf8').match(/public key: (age1\S+)/)![1] + '\n')
  return { id, pub }
}

test('offhost copy: only ciphertext leaves; it decrypts with the offline identity to the exact backup; manifest checks out', { skip }, async () => {
  const fx = await fixtureBackup(path.join(T, 'a')), { id, pub } = keys()
  const dest = path.join(T, 'dest'); mkdirSync(dest)
  const r = sh('offhost-copy.sh', [fx.backup], { OFFHOST_AGE_RECIPIENTS: pub, OFFHOST_DEST: dest })
  assert.equal(r.code, 0, r.out); assert.match(r.out, /"type":"offhost_copy","ok":true/)
  const files = readdirSync(dest).sort()
  assert.deepEqual(files.map(f => f.replace(/^dazl-backup-.*?\.db/, 'B')), ['B.age', 'B.age.json'])
  for (const f of files) assert.ok(!readFileSync(path.join(dest, f)).includes('SQLite format 3'), `${f} holds no plaintext database`)
  const out = path.join(T, 'decrypted.db')
  assert.equal(spawnSync('age', ['-d', '-i', id, '-o', out, path.join(dest, files[0])]).status, 0)
  assert.ok(readFileSync(out).equals(readFileSync(fx.backup)), 'decrypts to the exact backup bytes')
  const m = JSON.parse(readFileSync(path.join(dest, files[1]), 'utf8'))
  assert.equal(m.source_sha256, JSON.parse(readFileSync(fx.backup + '.json', 'utf8')).sha256)
  assert.equal(m.recipients.length, 1)
})

test('offhost copy refuses: a backup changed after it was taken, a private key as recipient, the backup dir as destination', { skip }, async () => {
  const fx = await fixtureBackup(path.join(T, 'b')), { id, pub } = keys()
  const dest = path.join(T, 'dest-b'); mkdirSync(dest)
  const bad = path.join(T, 'b', 'changed.db'); copyFileSync(fx.backup, bad); copyFileSync(fx.backup + '.json', bad + '.json'); appendFileSync(bad, 'x')
  const r = sh('offhost-copy.sh', [bad], { OFFHOST_AGE_RECIPIENTS: pub, OFFHOST_DEST: dest })
  assert.equal(r.code, 1); assert.match(r.out, /does not match its sidecar/); assert.deepEqual(readdirSync(dest), [])
  assert.equal(sh('offhost-copy.sh', [fx.backup], { OFFHOST_AGE_RECIPIENTS: id, OFFHOST_DEST: dest }).code, 2)
  assert.match(sh('offhost-copy.sh', [fx.backup], { OFFHOST_AGE_RECIPIENTS: pub, OFFHOST_DEST: path.dirname(fx.backup) }).out, /not off-host/)
})

test('run-backup: snapshot, restore check and encrypted off-host copy in one scheduled run', { skip }, async () => {
  const fx = await fixtureBackup(path.join(T, 'c')), { pub } = keys()
  const bdir = path.join(T, 'c-backups'), dest = path.join(T, 'c-dest'); mkdirSync(dest)
  const r = sh('run-backup.sh', [], { DB_PATH: fx.source, BACKUP_DIR: bdir, WEB_DIR: web, OFFHOST_AGE_RECIPIENTS: pub, OFFHOST_DEST: dest })
  assert.equal(r.code, 0, r.out); assert.match(r.out, /"type":"backup","ok":true/)
  assert.equal(readdirSync(bdir).filter(f => f.endsWith('.db')).length, 1)
  assert.equal(readdirSync(dest).filter(f => f.endsWith('.age')).length, 1)
})

test('backup-check: fresh is ok; stale, modified, missing off-host copy and a failed drill each alert, throttled', async () => {
  const fx = await fixtureBackup(path.join(T, 'd'))
  const dir = path.dirname(fx.backup), state = path.join(T, 'd-state'), alerts = path.join(T, 'alerts.log')
  writeFileSync(path.join(T, 'alert.sh'), `echo "$1" >> ${alerts}\n`)
  const check = (args: string[]) => {
    const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', 'scripts/backup/backup-check.mts', '--dir', dir, '--state-dir', state, ...args], { cwd: web, encoding: 'utf8', env: { ...process.env, BACKUP_ALERT_CMD: `${path.join(T, 'alert.sh')}`, OPS_ALERT_WEBHOOK_URL: '' } })
    return { code: r.status, out: r.stdout + r.stderr }
  }
  spawnSync('chmod', ['+x', path.join(T, 'alert.sh')])
  const sent = () => existsSync(alerts) ? readFileSync(alerts, 'utf8').trim().split('\n').map(l => JSON.parse(l)) : []
  assert.equal(check(['--max-age-s', '3600']).code, 0)
  assert.equal(sent().length, 0)
  let r = check(['--max-age-s', '-1'])
  assert.equal(r.code, 1); assert.match(r.out, /newest backup is \d+s old/); assert.equal(sent().length, 1)
  assert.equal(check(['--max-age-s', '-1']).code, 1); assert.equal(sent().length, 1, 'same problem within the interval: not re-sent')
  const report = path.join(T, 'drill.json'); writeFileSync(report, JSON.stringify({ ok: false, started_at: new Date().toISOString(), steps: [{ step: 'key recovery', ok: false }] }))
  r = check(['--offhost-dir', path.join(T, 'nowhere'), '--drill-report', report])
  assert.equal(r.code, 1); const last = sent().at(-1)
  assert.ok(last.problems.some((p: string) => /off-host destination .* unreadable: directory not found/.test(p)) && last.problems.some((p: string) => /drill FAILED \(key recovery\)/.test(p)), JSON.stringify(last))
  appendFileSync(fx.backup, 'x')
  r = check([]); assert.equal(r.code, 1); assert.match(r.out, /no longer matches its sidecar/)
  assert.ok(!JSON.stringify(sent()).includes(path.dirname(dir)), 'alerts name backups by file name only')
})

// The off-host check verifies the copy, not only its manifest (review hold on 1ab2cb3), at a directory or an rclone
// destination, and the shipped service wires the same OFFHOST_DEST the backup copies to.
const checkAt = (local: string, env: Record<string, string>, args: string[] = []) => {
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', 'scripts/backup/backup-check.mts', '--dir', local, '--state-dir', path.join(T, `st-${Math.random().toString(36).slice(2)}`), ...args],
    { cwd: web, encoding: 'utf8', env: { PATH: process.env.PATH!, HOME: process.env.HOME!, BACKUP_ALERT_CMD: 'true', ...env } as unknown as NodeJS.ProcessEnv })
  return { code: r.status, json: JSON.parse(r.stdout.trim().split('\n')[0] || '{}'), out: r.stdout + r.stderr }
}

test('off-host check: a genuine encrypted copy passes; manifest only, truncated, replaced or hash-mismatched copies fail', { skip }, async () => {
  const fx = await fixtureBackup(path.join(T, 'oh')), { pub } = keys(), local = path.dirname(fx.backup)
  const dest = path.join(T, 'oh-dest'); mkdirSync(dest)
  assert.equal(sh('offhost-copy.sh', [fx.backup], { OFFHOST_AGE_RECIPIENTS: pub, OFFHOST_DEST: dest }).code, 0)
  const age = readdirSync(dest).find(f => f.endsWith('.age'))!, ct = path.join(dest, age)
  let r = checkAt(local, { OFFHOST_DEST: dest })
  assert.equal(r.code, 0, r.out); assert.equal(r.json.newest_offhost_verified, true); assert.deepEqual(r.json.problems, [])
  const original = readFileSync(ct)
  writeFileSync(ct, original.subarray(0, original.length - 10)); r = checkAt(local, { OFFHOST_DEST: dest })
  assert.equal(r.code, 1); assert.match(r.json.problems.join(), /truncated or replaced/)
  const flipped = Buffer.from(original); flipped[flipped.length - 1] ^= 0xff; writeFileSync(ct, flipped); r = checkAt(local, { OFFHOST_DEST: dest })
  assert.equal(r.code, 1); assert.match(r.json.problems.join(), /does not match its manifest sha256/)
  rmSync(ct); r = checkAt(local, { OFFHOST_DEST: dest })
  assert.equal(r.code, 1); assert.match(r.json.problems.join(), /is missing \(only its manifest exists\)/)
  writeFileSync(ct, original); assert.equal(checkAt(local, { OFFHOST_DEST: dest }).code, 0, 'restored: ok again')
})

test("off-host check: the review's reproduction (a manifest with a zero hash and no ciphertext) is not healthy", async () => {
  const fx = await fixtureBackup(path.join(T, 'repro')), local = path.dirname(fx.backup)
  const dest = path.join(T, 'repro-dest'); mkdirSync(dest)
  writeFileSync(path.join(dest, 'x.db.age.json'), JSON.stringify({ tool: 'dazl-offhost-copy', copied_at: new Date().toISOString(), ciphertext: 'x.db.age', ciphertext_sha256: '0'.repeat(64), bytes: 100 }))
  const r = checkAt(local, { OFFHOST_DEST: dest })
  assert.equal(r.code, 1); assert.equal(r.json.ok, false); assert.match(r.json.problems.join(), /x\.db\.age is missing/)
})

test('off-host check over rclone (a stand-in rclone CLI): verifies the copy; a missing rclone or a failing remote is a problem', { skip }, async () => {
  const fx = await fixtureBackup(path.join(T, 'rc')), { pub } = keys(), local = path.dirname(fx.backup)
  const store = path.join(T, 'rc-remote'); mkdirSync(store)
  assert.equal(sh('offhost-copy.sh', [fx.backup], { OFFHOST_AGE_RECIPIENTS: pub, OFFHOST_DEST: store }).code, 0)
  // the rclone subcommands backup-check uses, on a local directory standing in for REMOTE:PATH
  const bin = path.join(T, 'fake-rclone'); writeFileSync(bin, `#!/usr/bin/env bash
set -e; root=${store}; sub=$1; shift; while [ "\${1:-}" = --files-only ]; do shift; done
p=\${1#remote:bucket}; p=\${p#/}
case "$sub" in lsf) ls -1 "$root" ;; cat) cat "$root/$p" ;; *) exit 9 ;; esac
`); spawnSync('chmod', ['+x', bin])
  let r = checkAt(local, { OFFHOST_DEST: 'rclone:remote:bucket', RCLONE_BIN: bin })
  assert.equal(r.code, 0, r.out); assert.equal(r.json.newest_offhost_verified, true); assert.equal(r.json.offhost, 'remote:')
  rmSync(path.join(store, readdirSync(store).find(f => f.endsWith('.age'))!))
  r = checkAt(local, { OFFHOST_DEST: 'rclone:remote:bucket', RCLONE_BIN: bin }); assert.equal(r.code, 1); assert.match(r.json.problems.join(), /is missing/)
  r = checkAt(local, { OFFHOST_DEST: 'rclone:remote:bucket', RCLONE_BIN: path.join(T, 'no-such-rclone') })
  assert.equal(r.code, 1); assert.match(r.json.problems.join(), /unreadable: rclone not runnable/)
  const failing = path.join(T, 'failing-rclone'); writeFileSync(failing, '#!/bin/sh\nexit 3\n'); spawnSync('chmod', ['+x', failing])
  r = checkAt(local, { OFFHOST_DEST: 'rclone:remote:bucket', RCLONE_BIN: failing })
  assert.equal(r.code, 1); assert.match(r.json.problems.join(), /unreadable: rclone lsf failed/)
})

test('required but not configured is a problem; not required and not configured is reported, not hidden', async () => {
  const fx = await fixtureBackup(path.join(T, 'req')), local = path.dirname(fx.backup)
  let r = checkAt(local, { OFFHOST_REQUIRED: '1' })
  assert.equal(r.code, 1); assert.match(r.json.problems.join(), /required .* no destination is configured/)
  r = checkAt(local, {}); assert.equal(r.code, 0); assert.equal(r.json.offhost, 'not configured')
})

test('the shipped dazl-backup-check.service, run as systemd would (its ExecStart with the env file): checks OFFHOST_DEST', async () => {
  const fx = await fixtureBackup(path.join(T, 'svc')), local = path.dirname(fx.backup)
  const dest = path.join(T, 'svc-dest'); mkdirSync(dest)
  writeFileSync(path.join(dest, 'x.db.age.json'), JSON.stringify({ tool: 'dazl-offhost-copy', copied_at: new Date().toISOString(), ciphertext: 'x.db.age', ciphertext_sha256: '0'.repeat(64), bytes: 100 }))
  const unit = readFileSync(path.join(ops, 'dazl-backup-check.service'), 'utf8')
  const exec = /^ExecStart=(.*)$/m.exec(unit)![1]
  assert.ok(!/--offhost/.test(exec), 'the destination comes from the env file, not a second setting')
  // the env file: env.example's keys with this test's values (systemd EnvironmentFile), the drill report fresh and ok
  const drill = path.join(T, 'svc-drill.json'); writeFileSync(drill, JSON.stringify({ ok: true, started_at: new Date().toISOString(), steps: [] }))
  const keysIn = [...readFileSync(path.join(ops, 'env.example'), 'utf8').matchAll(/^([A-Z_]+)=/gm)].map(m => m[1])
  for (const k of ['BACKUP_DIR', 'OFFHOST_DEST', 'OFFHOST_REQUIRED']) assert.ok(keysIn.includes(k), `env.example has ${k}`)
  const env: Record<string, string> = { BACKUP_DIR: local, OFFHOST_DEST: dest, OFFHOST_REQUIRED: '1' }
  // systemd expands ${VAR} in ExecStart from the environment; the unit's fixed drill path is pointed at the test's
  const argv = exec.replace(/\$\{(\w+)\}/g, (_, k) => env[k] ?? '').replace('/var/lib/dazl-drill/latest.json', drill).split(/\s+/)
  assert.equal(argv[0], '/usr/bin/env')
  const run = (e: Record<string, string>) => spawnSync(argv[1], [...argv.slice(2), '--state-dir', path.join(T, `svc-st-${Math.random()}`)], { cwd: web, encoding: 'utf8', env: { PATH: process.env.PATH!, HOME: process.env.HOME!, BACKUP_ALERT_CMD: 'true', ...e } as unknown as NodeJS.ProcessEnv })
  let r = run(env)
  assert.equal(r.status, 1, r.stdout + r.stderr); assert.match(r.stdout, /x\.db\.age is missing/)
  r = run({ ...env, OFFHOST_DEST: '' }); assert.equal(r.status, 1); assert.match(r.stdout, /required .* no destination is configured/)
})
