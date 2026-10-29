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
  assert.ok(last.problems.some((p: string) => /no off-host copy/.test(p)) && last.problems.some((p: string) => /drill FAILED \(key recovery\)/.test(p)), JSON.stringify(last))
  appendFileSync(fx.backup, 'x')
  r = check([]); assert.equal(r.code, 1); assert.match(r.out, /no longer matches its sidecar/)
  assert.ok(!JSON.stringify(sent()).includes(path.dirname(dir)), 'alerts name backups by file name only')
})
