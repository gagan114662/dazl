// #1080: the production backup was never installed (templates with CHANGE-ME, a release directory that moves on every deploy).
// ops/backup/install-prod.sh installs units that run /usr/local/lib/dazl-backup/prod-run.sh, which finds the LIVE release
// (live-release.sh: Caddy's port -> /etc/dazl-prod/ports/<port>.conf) and runs that release's own backup and check;
// restore-offhost.sh restores the newest encrypted off-host copy and proves it. All on a synthetic database
// (test/helpers/recovery-fixture.mts) under a temp root: no systemctl, nothing outside the temp directory.
// Needs age: skipped with the reason when it is missing, a failure when DAZL_REQUIRE_AGE=1 (CI installs it).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { fixtureBackup } from './helpers/recovery-fixture.mts'

const web = fileURLToPath(new URL('../', import.meta.url))
const repo = path.join(web, '..')
const ops = path.join(repo, 'ops/backup')
const hasAge = spawnSync('age', ['--version']).status === 0
if (!hasAge && process.env.DAZL_REQUIRE_AGE === '1') throw new Error('DAZL_REQUIRE_AGE=1 but age is not installed')
const skip = hasAge ? false : 'age is not installed (apt install age)'
const T = mkdtempSync(path.join(tmpdir(), 'backup-install-'))
test.after(() => rmSync(T, { recursive: true, force: true }))

// the box as the scripts see it: a Caddyfile, the port conf deploy-prod.sh writes, and a release directory
const root = path.join(T, 'root'), etc = path.join(T, 'etc'), ports = path.join(etc, 'ports')
const release = path.join(T, 'home', 'dazl-0123abcd-prod')
mkdirSync(ports, { recursive: true }); mkdirSync(release, { recursive: true })
symlinkSync(web.replace(/\/$/, ''), path.join(release, 'web')); symlinkSync(path.join(repo, 'ops'), path.join(release, 'ops'))
const caddy = path.join(etc, 'Caddyfile')
const setLive = (port: number | null) => writeFileSync(caddy, `staging.dazl.ai {\n\treverse_proxy localhost:3204\n}\ndazl.ai, www.dazl.ai {\n\tencode gzip\n${port ? `\treverse_proxy localhost:${port}\n` : ''}}\n`)
setLive(3105); writeFileSync(path.join(ports, '3105.conf'), `DAZL_RELEASE=${release}\n`)
const LIVE = { LIVE_CADDYFILE: caddy, LIVE_PORTCONF_DIR: ports }
const run = (script: string, args: string[], env: Record<string, string> = {}) => {
  const r = spawnSync('bash', [script, ...args], { encoding: 'utf8', env: { PATH: process.env.PATH!, HOME: process.env.HOME!, ...env } as unknown as NodeJS.ProcessEnv, timeout: 120_000 })
  return { code: r.status, out: r.stdout + r.stderr, stdout: r.stdout }
}
const envOf = (file: string): Record<string, string> => Object.fromEntries(readFileSync(file, 'utf8').split('\n').filter(l => /^[A-Z_]+=/.test(l)).map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]))

test('live-release: the release Caddy points at; fails loudly when it cannot tell', () => {
  assert.deepEqual([run(path.join(ops, 'live-release.sh'), [], LIVE).stdout.trim()], [release])
  setLive(3104)   // Caddy switched to a port with no recorded release
  let r = run(path.join(ops, 'live-release.sh'), [], LIVE); assert.equal(r.code, 1); assert.match(r.out, /no .*3104\.conf/)
  writeFileSync(path.join(ports, '3104.conf'), 'DAZL_RELEASE=/tmp/not-a-release\n')
  r = run(path.join(ops, 'live-release.sh'), [], LIVE); assert.equal(r.code, 1); assert.match(r.out, /not a release directory/)
  writeFileSync(path.join(ports, '3104.conf'), `DAZL_RELEASE=${path.join(T, 'home', 'dazl-deadbeef-prod')}\n`)   // pruned
  r = run(path.join(ops, 'live-release.sh'), [], LIVE); assert.equal(r.code, 1); assert.match(r.out, /not a complete release/)
  setLive(null)
  r = run(path.join(ops, 'live-release.sh'), [], LIVE); assert.equal(r.code, 1); assert.match(r.out, /names no reverse_proxy/)
  setLive(3105)
})

test('install -> hourly job -> check -> restore from the off-host copy, with the same counts as the source', { skip }, async () => {
  const fx = await fixtureBackup(path.join(T, 'fx'))
  const id = path.join(T, 'identity.txt'); spawnSync('age-keygen', ['-o', id]); chmodSync(id, 0o600)
  const backups = path.join(T, 'backups'), offhost = path.join(T, 'offhost'), ledger = path.join(T, 'ledger', 'tombstones.jsonl'), recipients = path.join(T, 'recipients.txt')
  mkdirSync(offhost)
  const args = ['--root', root, '--db', fx.source, '--user', 'appuser', '--backup-dir', backups, '--offhost', offhost, '--recipients', recipients, '--ledger', ledger, '--alert-url', 'https://alerts.example/hook']
  const install = (a = args) => run(path.join(ops, 'install-prod.sh'), a)

  // refused before anything is written: no recipients, then a PRIVATE key as recipients
  let r = install(); assert.equal(r.code, 1); assert.match(r.out, /needs the age PUBLIC keys/); assert.ok(!existsSync(path.join(root, 'etc/systemd/system')))
  mkdirSync(path.dirname(path.join(root, recipients)), { recursive: true })
  writeFileSync(path.join(root, recipients), readFileSync(id, 'utf8'))
  r = install(); assert.equal(r.code, 1); assert.match(r.out, /PRIVATE key/); assert.ok(!existsSync(path.join(root, 'etc/systemd/system')))
  const pub = readFileSync(id, 'utf8').match(/public key: (age1\S+)/)![1] + '\n'
  writeFileSync(path.join(root, recipients), pub); writeFileSync(recipients, pub)

  r = install(); assert.equal(r.code, 0, r.out)
  const units = path.join(root, 'etc/systemd/system')
  assert.deepEqual(readdirSync(units).sort(), ['dazl-backup-check.service', 'dazl-backup-check.timer', 'dazl-backup.service', 'dazl-backup.timer'])
  const svc = readFileSync(path.join(units, 'dazl-backup.service'), 'utf8'), chk = readFileSync(path.join(units, 'dazl-backup-check.service'), 'utf8')
  for (const u of [svc, chk]) { assert.match(u, /^User=appuser$/m); assert.match(u, /^EnvironmentFile=\/etc\/dazl-backup\/env$/m); assert.ok(!/CHANGE-ME|dazl-[0-9a-f]{8}-prod/.test(u), 'no placeholder and no release directory in a unit') }
  assert.match(svc, /^ExecStart=\/usr\/bin\/env bash \/usr\/local\/lib\/dazl-backup\/prod-run\.sh backup$/m)
  assert.match(chk, /^ExecStart=\/usr\/bin\/env bash \/usr\/local\/lib\/dazl-backup\/prod-run\.sh check$/m)
  assert.equal(readFileSync(path.join(units, 'dazl-backup.timer'), 'utf8').trim(), readFileSync(path.join(ops, 'dazl-backup.timer'), 'utf8').trim())
  assert.match(r.out, /systemctl enable --now dazl-backup\.timer dazl-backup-check\.timer/); assert.match(r.out, /systemctl start dazl-backup\.service/)
  const envFile = path.join(root, 'etc/dazl-backup/env'), env = envOf(envFile)
  assert.deepEqual([env.DB_PATH, env.BACKUP_DIR, env.OFFHOST_DEST, env.OFFHOST_REQUIRED, env.DAZL_TOMBSTONE_LEDGER, env.OPS_ALERT_WEBHOOK_URL, env.BACKUP_RETENTION], [fx.source, backups, offhost, '1', ledger, 'https://alerts.example/hook', '0'])
  assert.ok(!/DAZL_MASTER_KEY|SECRET|TOKEN/.test(readFileSync(envFile, 'utf8')), 'no secret in the env file')
  assert.ok(existsSync(path.join(root, ledger)), 'the empty ledger was created')

  // idempotent, and an env file the operator edited is kept
  writeFileSync(envFile, readFileSync(envFile, 'utf8') + 'BACKUP_RETENTION_NOTE=edited\n')
  r = install(); assert.equal(r.code, 0, r.out); assert.match(r.out, /exists and is KEPT/); assert.match(readFileSync(envFile, 'utf8'), /BACKUP_RETENTION_NOTE=edited/)
  r = install([...args, '--status']); assert.equal(r.code, 0); assert.match(r.out, /prod-run\.sh: installed = this checkout/); assert.match(r.out, /newest local backup: NONE/)

  // the hourly job, exactly as the unit runs it: the INSTALLED entry point, the env file's settings, the live release
  mkdirSync(path.dirname(ledger), { recursive: true }); writeFileSync(ledger, '')   // on the box install-prod.sh creates it; under --root it is created inside the root
  const jobEnv = { ...env, ...LIVE }
  const entry = path.join(root, 'usr/local/lib/dazl-backup/prod-run.sh')
  r = run(entry, ['backup'], jobEnv); assert.equal(r.code, 0, r.out); assert.match(r.out, /"type":"backup","ok":true,.*"offhost":true/)
  assert.equal(readdirSync(offhost).filter(f => /^dazl-backup-.*\.db\.age$/.test(f)).length, 1)
  for (const f of readdirSync(offhost)) assert.ok(!readFileSync(path.join(offhost, f)).includes('SQLite format 3'), `${f} holds no plaintext database`)
  r = run(entry, ['check'], { ...jobEnv, OPS_ALERT_WEBHOOK_URL: '' }); assert.equal(r.code, 0, r.out); assert.match(r.out, /"type":"backup_check","ok":true/); assert.match(r.out, /"newest_offhost_verified":true/)

  // a stale backup alerts (2 h on the box; 0 s here), through the same entry point
  const alertLog = path.join(T, 'alert.log'), alertCmd = path.join(T, 'alert.sh')
  writeFileSync(alertCmd, `#!/bin/sh\nprintf '%s\\n' "$1" >> ${alertLog}\n`); chmodSync(alertCmd, 0o755)
  await new Promise(res => setTimeout(res, 1100))
  r = run(entry, ['check'], { ...jobEnv, OPS_ALERT_WEBHOOK_URL: '', BACKUP_ALERT_CMD: alertCmd, BACKUP_MAX_AGE_S: '1', DRILL_MAX_AGE_S: '100000' }); assert.equal(r.code, 1, r.out)
  assert.match(readFileSync(alertLog, 'utf8'), /newest backup is \d+s old \(limit 1s\)/)

  // when nobody can tell which release is live the job FAILS (never a silent no-backup)
  setLive(null)
  r = run(entry, ['backup'], jobEnv); assert.equal(r.code, 1); assert.match(r.out, /live-release: /)
  setLive(3105)
  r = run(entry, ['nonsense'], jobEnv); assert.equal(r.code, 2)

  // restore: the newest off-host copy, decrypted with the OFFLINE identity, equals the source row for row
  const out = path.join(T, 'restore')
  r = run(path.join(ops, 'restore-offhost.sh'), ['--offhost', offhost, '--identity', id, '--out', out, '--compare', fx.source]); assert.equal(r.code, 0, r.out)
  const rep = JSON.parse(r.stdout.trim().split('\n').pop()!)
  assert.equal(rep.ok, true); assert.equal(rep.integrity, 'ok'); assert.equal(rep.rows_match, true); assert.ok(rep.rpo_s >= 0 && rep.rpo_s < 600); assert.ok(Number.isInteger(rep.restore_ms) && rep.restore_ms >= 0 && rep.restore_ms === rep.fetch_ms + rep.decrypt_ms + rep.verify_ms)
  const src = new Database(fx.source, { readonly: true }), got = new Database(rep.restored, { readonly: true })
  for (const t of ['users', 'scan_jobs', 'leads']) assert.equal((got.prepare(`SELECT count(*) AS n FROM ${t}`).get() as { n: number }).n, (src.prepare(`SELECT count(*) AS n FROM ${t}`).get() as { n: number }).n, t)
  assert.deepEqual(rep.rows, rep.compare_rows); src.close(); got.close()
  // refusals: an existing --out, an identity others can read, the wrong identity
  r = run(path.join(ops, 'restore-offhost.sh'), ['--offhost', offhost, '--identity', id, '--out', out]); assert.equal(r.code, 2); assert.match(r.out, /already exists/)
  chmodSync(id, 0o644); r = run(path.join(ops, 'restore-offhost.sh'), ['--offhost', offhost, '--identity', id, '--out', path.join(T, 'r2')]); assert.equal(r.code, 2); assert.match(r.out, /readable by others/); chmodSync(id, 0o600)
  const other = path.join(T, 'other.txt'); spawnSync('age-keygen', ['-o', other]); chmodSync(other, 0o600)
  r = run(path.join(ops, 'restore-offhost.sh'), ['--offhost', offhost, '--identity', other, '--out', path.join(T, 'r3')]); assert.equal(r.code, 1); assert.match(r.out, /could not decrypt/)
  // a tampered ciphertext is refused before decryption
  const ct = path.join(offhost, readdirSync(offhost).find(f => /^dazl-backup-.*\.db\.age$/.test(f))!); const bytes = readFileSync(ct); bytes[bytes.length - 5] ^= 0xff; writeFileSync(ct, bytes)
  r = run(path.join(ops, 'restore-offhost.sh'), ['--offhost', offhost, '--identity', id, '--out', path.join(T, 'r4')]); assert.equal(r.code, 1); assert.match(r.out, /does not match its manifest sha256/)

  // uninstall removes the units and the installed scripts, keeps the env file and the backups
  r = install([...args, '--uninstall']); assert.equal(r.code, 0, r.out)
  assert.deepEqual(readdirSync(units), []); assert.ok(!existsSync(entry)); assert.ok(existsSync(envFile)); assert.ok(readdirSync(backups).some(f => f.endsWith('.db')))
})

test('install: usage errors change nothing', () => {
  const r2 = path.join(T, 'root2')
  for (const a of [['--db', 'relative.db'], ['--user', 'bad user'], ['--alert-url', 'http://plain.example/x'], ['--nonsense'], ['--db']]) {
    const r = run(path.join(ops, 'install-prod.sh'), ['--root', r2, ...a]); assert.equal(r.code, 2, `${a.join(' ')}: ${r.out}`); assert.ok(!existsSync(r2))
  }
})
