// #1080: the production backup was never installed (templates with CHANGE-ME, a release directory that moves on every deploy).
// ops/backup/install-prod.sh installs units that run /usr/local/lib/dazl-backup/prod-run.sh, which finds the LIVE release
// (live-release.sh: Caddy's port -> /etc/dazl-prod/ports/<port>.conf) and runs that release's own backup and check;
// restore-offhost.sh restores the newest encrypted off-host copy and proves it. All on a synthetic database
// (test/helpers/recovery-fixture.mts) under a temp root: no systemctl, nothing outside the temp directory.
// Needs age: skipped with the reason when it is missing, a failure when DAZL_REQUIRE_AGE=1 (CI installs it).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
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
  // the app's own run env names the ledger: the installer reads it from there (as data), so the copy is of the file the app writes
  const appEnv = path.join(T, 'app-run.env'); writeFileSync(appEnv, `PORT=3104\nexport DAZL_TOMBSTONE_LEDGER='${ledger}'\nDAZL_MASTER_KEY=not-read\n`)
  const args = ['--root', root, '--db', fx.source, '--user', 'appuser', '--backup-dir', backups, '--offhost', offhost, '--recipients', recipients, '--app-env', appEnv, '--alert-url', 'https://alerts.example/hook']
  const install = (a = args) => run(path.join(ops, 'install-prod.sh'), a)

  // refused before anything is written: no recipients, then a PRIVATE key as recipients
  let r = install(); assert.equal(r.code, 1); assert.match(r.out, /needs the age PUBLIC keys/); assert.ok(!existsSync(path.join(root, 'etc/systemd/system')))
  mkdirSync(path.dirname(path.join(root, recipients)), { recursive: true })
  writeFileSync(path.join(root, recipients), readFileSync(id, 'utf8'))
  r = install(); assert.equal(r.code, 1); assert.match(r.out, /PRIVATE key/); assert.ok(!existsSync(path.join(root, 'etc/systemd/system')))
  const pub = readFileSync(id, 'utf8').match(/public key: (age1\S+)/)![1] + '\n'
  writeFileSync(path.join(root, recipients), pub); writeFileSync(recipients, pub)

  // a --ledger that is not the app's own, and a system directory as the backup directory, are refused; nothing written
  r = install([...args, '--ledger', path.join(T, 'elsewhere.jsonl')]); assert.equal(r.code, 1); assert.match(r.out, /is not the app's DAZL_TOMBSTONE_LEDGER/)
  r = install([...args, '--backup-dir', '/var/lib']); assert.equal(r.code, 2); assert.match(r.out, /refusing to use the system directory/)
  for (const d of ['/var/lib/', '//', '/var//backups/', '/etc/../var/lib']) { r = install([...args, '--backup-dir', d]); assert.equal(r.code, 2, `${d}: ${r.out}`) }
  r = install([...args.map(a => a === appEnv ? path.join(T, 'typo.env') : a)]); assert.equal(r.code, 2); assert.match(r.out, /--app-env .* is not a readable file/)
  assert.ok(!existsSync(path.join(root, 'etc/systemd/system')))

  r = install(); assert.equal(r.code, 0, r.out)
  assert.ok(!/WARNING: .*DAZL_TOMBSTONE_LEDGER/.test(r.out), 'the app names its ledger: no warning')
  const mode = (f: string) => (statSync(f).mode & 0o777).toString(8)
  assert.deepEqual([mode(path.join(root, 'etc/dazl-backup')), mode(path.join(root, 'etc/dazl-backup/env')), mode(path.join(root, backups)), mode(path.join(root, ledger)), mode(path.join(root, 'usr/local/lib/dazl-backup/prod-run.sh'))], ['750', '640', '700', '600', '755'])
  const units = path.join(root, 'etc/systemd/system')
  assert.deepEqual(readdirSync(units).sort(), ['dazl-backup-check.service', 'dazl-backup-check.timer', 'dazl-backup.service', 'dazl-backup.timer'])
  const svc = readFileSync(path.join(units, 'dazl-backup.service'), 'utf8'), chk = readFileSync(path.join(units, 'dazl-backup-check.service'), 'utf8')
  for (const u of [svc, chk]) { assert.match(u, /^User=appuser$/m); assert.match(u, /^EnvironmentFile=\/etc\/dazl-backup\/env$/m); assert.ok(!/CHANGE-ME|dazl-[0-9a-f]{8}-prod/.test(u), 'no placeholder and no release directory in a unit') }
  assert.match(svc, /^ExecStart=\/usr\/bin\/env bash \/usr\/local\/lib\/dazl-backup\/prod-run\.sh backup$/m)
  assert.match(chk, /^ExecStart=\/usr\/bin\/env bash \/usr\/local\/lib\/dazl-backup\/prod-run\.sh check$/m)
  assert.equal(readFileSync(path.join(units, 'dazl-backup.timer'), 'utf8').trim(), readFileSync(path.join(ops, 'dazl-backup.timer'), 'utf8').trim())
  assert.match(r.out, /systemctl enable --now dazl-backup\.timer dazl-backup-check\.timer/); assert.match(r.out, /systemctl start dazl-backup\.service/)
  const envFile = path.join(root, 'etc/dazl-backup/env'), env = envOf(envFile)
  assert.deepEqual([env.DB_PATH, env.BACKUP_DIR, env.OFFHOST_DEST, env.OFFHOST_REQUIRED, env.DAZL_TOMBSTONE_LEDGER, env.OPS_ALERT_WEBHOOK_URL, env.BACKUP_RETENTION], [fx.source, backups, offhost, '1', ledger, 'https://alerts.example/hook', '1'], 'retention is ON as installed')
  assert.match(r.out, /retention ON: at most 48 local copies/)
  assert.deepEqual([env.RETAIN_LOCAL, env.RETAIN_OFFHOST_HOURLY, env.RETAIN_OFFHOST_DAILY, env.RETAIN_OFFHOST_WEEKLY], ['48', '48', '14', '8'])
  assert.ok(!/DAZL_MASTER_KEY|SECRET|TOKEN/.test(readFileSync(envFile, 'utf8')), 'no secret in the env file')
  assert.ok(existsSync(path.join(root, ledger)), 'the empty ledger was created')

  // idempotent, and an env file the operator edited is kept
  chmodSync(path.join(root, backups), 0o750)   // the operator changed the existing directory: a re-run leaves it alone
  r = install(); assert.equal(r.code, 0, r.out); assert.match(r.out, /already has these settings/)   // same options: a plain re-run is fine
  writeFileSync(envFile, readFileSync(envFile, 'utf8').replace(/^OFFHOST_DEST=.*$/m, 'OFFHOST_DEST=').replace(/^OFFHOST_REQUIRED=1$/m, 'OFFHOST_REQUIRED=0') + 'BACKUP_RETENTION_NOTE=edited\n')
  // the file on the box says "local only" while the command asks for an off-host copy: the install STOPS and names the settings
  r = install(); assert.equal(r.code, 1, r.out); assert.match(r.out, /differs from the options given in: .*OFFHOST_DEST/); assert.match(r.out, /OFFHOST_REQUIRED/)
  r = install([...args, '--keep-env']); assert.equal(r.code, 0, r.out); assert.match(r.out, /exists and is KEPT/)
  // --keep-env never covers a ledger path that is not the app's own
  const kept = readFileSync(envFile, 'utf8'); writeFileSync(envFile, kept.replace(/^DAZL_TOMBSTONE_LEDGER=.*$/m, 'DAZL_TOMBSTONE_LEDGER=/var/lib/other/x.jsonl'))
  r = install([...args, '--keep-env']); assert.equal(r.code, 1, r.out); assert.match(r.out, /copies the ledger .* but the app writes/); writeFileSync(envFile, kept); assert.match(readFileSync(envFile, 'utf8'), /BACKUP_RETENTION_NOTE=edited/)
  writeFileSync(envFile, readFileSync(envFile, 'utf8').replace(/^OFFHOST_DEST=$/m, `OFFHOST_DEST=${offhost}`).replace(/^OFFHOST_REQUIRED=0$/m, 'OFFHOST_REQUIRED=1'))
  r = install([...args, '--keep-env']); assert.equal(r.code, 0, r.out)
  assert.match(r.out, /already exists: left as it is/); assert.equal(mode(path.join(root, backups)), '750')
  // an app env with no ledger: installed on the default path, with the warning that the app is not writing one
  const root3 = path.join(T, 'root3'), bare = path.join(T, 'bare.env'); writeFileSync(bare, 'PORT=3104\n')
  r = install(['--root', root3, '--db', fx.source, '--user', 'appuser', '--backup-dir', backups, '--app-env', bare, '--no-start']); assert.equal(r.code, 0, r.out)
  assert.match(r.out, /WARNING: .* sets no DAZL_TOMBSTONE_LEDGER/); assert.match(r.out, /LOCAL ONLY/); assert.match(r.out, /--no-start: nothing enabled/)
  // retention can be left off, but never silently: the installer says how many days the disk lasts
  const root4 = path.join(T, 'root4')
  r = install(['--root', root4, '--db', fx.source, '--user', 'appuser', '--backup-dir', backups, '--app-env', bare, '--no-start', '--no-retention']); assert.equal(r.code, 0, r.out)
  assert.match(r.out, /WARNING: retention is OFF \(--no-retention\): nothing is ever deleted\. \d+ MB of backups a day, \d+ MB free: the disk is FULL in about \d+ days/)
  assert.equal(envOf(path.join(root4, 'etc/dazl-backup/env')).BACKUP_RETENTION, '0')
  assert.equal(envOf(path.join(root3, 'etc/dazl-backup/env')).DAZL_TOMBSTONE_LEDGER, '/var/lib/dazl-ledger/tombstones.jsonl')
  r = install([...args, '--status']); assert.equal(r.code, 0); assert.match(r.out, /prod-run\.sh: installed = this checkout/); assert.match(r.out, /newest local backup: NONE/)

  // the hourly job, exactly as the unit runs it: the INSTALLED entry point, the env file's settings, the live release
  mkdirSync(path.dirname(ledger), { recursive: true }); writeFileSync(ledger, '')   // on the box install-prod.sh creates it; under --root it is created inside the root
  assert.equal(env.DAZL_TOMBSTONE_LEDGER, ledger, "the app's own ledger path, read from its run env")
  const jobEnv = { ...env, ...LIVE }
  const entry = path.join(root, 'usr/local/lib/dazl-backup/prod-run.sh')
  r = run(entry, ['backup'], jobEnv); assert.equal(r.code, 0, r.out); assert.match(r.out, /"type":"backup","ok":true,.*"offhost":true/)
  assert.equal(readdirSync(offhost).filter(f => /^dazl-backup-.*\.db\.age$/.test(f)).length, 1)
  for (const f of readdirSync(offhost)) assert.ok(!readFileSync(path.join(offhost, f)).includes('SQLite format 3'), `${f} holds no plaintext database`)
  r = run(entry, ['check'], { ...jobEnv, OPS_ALERT_WEBHOOK_URL: '' }); assert.equal(r.code, 0, r.out); assert.match(r.out, /"type":"backup_check","ok":true/); assert.match(r.out, /"newest_offhost_verified":true/)

  // a stale backup alerts (2 h on the box; 0 s here), through the same entry point
  const alertLog = path.join(T, 'alert.log'), alertCmd = path.join(T, 'alert.sh')
  writeFileSync(alertCmd, `#!/bin/sh\nprintf '%s\\n' "$1" >> ${alertLog}\n`); chmodSync(alertCmd, 0o755)
  await new Promise(res => setTimeout(res, 2300))   // the age is whole seconds and must EXCEED the limit
  r = run(entry, ['check'], { ...jobEnv, OPS_ALERT_WEBHOOK_URL: '', BACKUP_ALERT_CMD: alertCmd, BACKUP_MAX_AGE_S: '1', DRILL_MAX_AGE_S: '100000' }); assert.equal(r.code, 1, r.out)
  assert.match(readFileSync(alertLog, 'utf8'), /newest backup is \d+s old \(limit 1s\)/)

  // low space alerts through the same check: under the free-space floor, and (retention off) too few days until full
  r = run(entry, ['check'], { ...jobEnv, OPS_ALERT_WEBHOOK_URL: '', BACKUP_ALERT_CMD: alertCmd, BACKUP_MIN_FREE_MB: '999999999', BACKUP_ALERT_EVERY_S: '0' }); assert.equal(r.code, 1, r.out)
  assert.match(readFileSync(alertLog, 'utf8'), /backup directory filesystem has \d+ MB free \(limit 999999999 MB\)/)
  r = run(entry, ['check'], { ...jobEnv, OPS_ALERT_WEBHOOK_URL: '', BACKUP_ALERT_CMD: alertCmd, BACKUP_RETENTION: '0', BACKUP_MIN_DAYS_LEFT: '999999999', BACKUP_ALERT_EVERY_S: '0' }); assert.equal(r.code, 1, r.out)
  assert.match(readFileSync(alertLog, 'utf8'), /retention is off \(BACKUP_RETENTION is not 1\) and the backup directory filesystem is full in about \d+ days/)
  r = run(entry, ['check'], { ...jobEnv, OPS_ALERT_WEBHOOK_URL: '' }); assert.equal(r.code, 0, r.out); assert.match(r.out, /"retention":"on"/); assert.match(r.out, /"backup_dir_free_mb":\d+/)

  // retention through the installed entry point: more runs than the limits leave exactly the limits, locally and off-host
  const small = { ...jobEnv, RETAIN_LOCAL: '2', RETAIN_OFFHOST_HOURLY: '2', RETAIN_OFFHOST_DAILY: '1', RETAIN_OFFHOST_WEEKLY: '1' }
  for (let i = 0; i < 3; i++) { await new Promise(res => setTimeout(res, 1100)); r = run(entry, ['backup'], small); assert.equal(r.code, 0, r.out) }
  const localDbs = readdirSync(backups).filter(f => /^dazl-backup-.*\.db$/.test(f)).sort(), remoteCts = readdirSync(offhost).filter(f => /^dazl-backup-.*\.db\.age$/.test(f)).sort()
  assert.equal(localDbs.length, 2, `4 runs, RETAIN_LOCAL=2: ${localDbs.join(' ')}`); assert.equal(remoteCts.length, 2, `off-host keeps 2: ${remoteCts.join(' ')}`)
  assert.deepEqual(remoteCts.map(f => f.replace(/\.age$/, '')), localDbs, 'the two newest, on both sides')
  assert.equal(readdirSync(offhost).filter(f => /^dazl-backup-.*\.db\.age\.json$/.test(f)).length, 2, 'manifests pruned with their copies')
  // with retention off the same runs delete nothing
  for (let i = 0; i < 2; i++) { await new Promise(res => setTimeout(res, 1100)); r = run(entry, ['backup'], { ...small, BACKUP_RETENTION: '0' }); assert.equal(r.code, 0, r.out) }
  assert.equal(readdirSync(backups).filter(f => /^dazl-backup-.*\.db$/.test(f)).length, 4)
  r = run(entry, ['backup'], small); assert.equal(r.code, 0, r.out); assert.equal(readdirSync(backups).filter(f => /^dazl-backup-.*\.db$/.test(f)).length, 2, 'and the next run with it on prunes back to the limit')

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
  // through rclone (a stand-in `rclone` that serves a directory): an OLDER copy with a later file name, a damaged manifest and a
  // stray file are at the destination too; the newest by copied_at is restored and each skipped one is named
  const remote = path.join(T, 'remote'); mkdirSync(remote)
  const good = readdirSync(offhost).find(f => /^dazl-backup-.*\.db\.age$/.test(f))!
  for (const f of [good, `${good}.json`]) copyFileSync(path.join(offhost, f), path.join(remote, f))
  const older = 'dazl-backup-29991231T000000Z-ffffffff.db.age', man = JSON.parse(readFileSync(path.join(offhost, `${good}.json`), 'utf8'))
  writeFileSync(path.join(remote, older), 'not the newest'); writeFileSync(path.join(remote, `${older}.json`), JSON.stringify({ ...man, ciphertext: older, copied_at: '2020-01-01T00:00:00' }))   // older, later name, and a copied_at with no zone
  writeFileSync(path.join(remote, 'dazl-backup-20200101T000000Z-00000000.db.age.json'), '{ not json')
  writeFileSync(path.join(remote, 'dazl-backup-20200102T000000Z-00000001.db.age.json'), JSON.stringify({ ...man, ciphertext: '../../etc/passwd' }))
  const fakeBin = path.join(T, 'fakebin'); mkdirSync(fakeBin)
  writeFileSync(path.join(fakeBin, 'rclone'), `#!/usr/bin/env bash\nset -euo pipefail\nmap() { case "$1" in fake:*) echo "${remote}/\${1#fake:}" ;; *) echo "$1" ;; esac; }\ncase "$1" in\n  lsf) shift; pat=; while [ $# -gt 1 ]; do case "$1" in --include) pat=$2; shift 2 ;; *) shift ;; esac; done; cd "$(map "$1")"; for f in *; do [[ $f == $pat ]] && echo "$f"; done; true ;;\n  copyto) cp -- "$(map "$2")" "$(map "$3")" ;;\n  *) echo "fake rclone: $1 not supported" >&2; exit 9 ;;\nesac\n`); chmodSync(path.join(fakeBin, 'rclone'), 0o755)
  const viaRclone = path.join(T, 'restore-rclone')
  r = run(path.join(ops, 'restore-offhost.sh'), ['--offhost', 'rclone:fake:', '--identity', id, '--out', viaRclone, '--compare', fx.source], { PATH: `${fakeBin}:${process.env.PATH}` }); assert.equal(r.code, 0, r.out)
  const rep2 = JSON.parse(r.stdout.trim().split('\n').pop()!); assert.equal(rep2.rows_match, true); assert.equal(path.basename(rep2.restored), good.replace(/\.age$/, ''))
  assert.match(r.out, /WARNING: manifest dazl-backup-20200101T000000Z-00000000\.db\.age\.json skipped \(not readable JSON\)/); assert.match(r.out, /WARNING: manifest dazl-backup-20200102T000000Z-00000001\.db\.age\.json skipped \(not a dazl-offhost-copy manifest for its own file\)/)
  // counts that differ from --compare: exit 1 and the restored copy is removed
  const fewer = path.join(T, 'fewer.db'); copyFileSync(fx.source, fewer); { const d = new Database(fewer); d.exec('PRAGMA foreign_keys=OFF; DELETE FROM leads'); d.close() }
  if ((new Database(fx.source, { readonly: true }).prepare('SELECT count(*) AS n FROM leads').get() as { n: number }).n > 0) {
    r = run(path.join(ops, 'restore-offhost.sh'), ['--offhost', offhost, '--identity', id, '--out', path.join(T, 'r0'), '--compare', fewer]); assert.equal(r.code, 1, r.out); assert.match(r.out, /"rows_match":false/)
    assert.deepEqual(readdirSync(path.join(T, 'r0')).filter(f => f.endsWith('.db')), [])
  }
  // refusals: an existing --out, an identity others can read, the wrong identity
  r = run(path.join(ops, 'restore-offhost.sh'), ['--offhost', offhost, '--identity', id, '--out', out]); assert.equal(r.code, 2); assert.match(r.out, /already exists/)
  chmodSync(id, 0o644); r = run(path.join(ops, 'restore-offhost.sh'), ['--offhost', offhost, '--identity', id, '--out', path.join(T, 'r2')]); assert.equal(r.code, 2); assert.match(r.out, /readable by others/); chmodSync(id, 0o600)
  const other = path.join(T, 'other.txt'); spawnSync('age-keygen', ['-o', other]); chmodSync(other, 0o600)
  r = run(path.join(ops, 'restore-offhost.sh'), ['--offhost', offhost, '--identity', other, '--out', path.join(T, 'r3')]); assert.equal(r.code, 1); assert.match(r.out, /could not decrypt/)
  // a tampered ciphertext is refused before decryption
  const ct = path.join(offhost, readdirSync(offhost).filter(f => /^dazl-backup-.*\.db\.age$/.test(f)).sort().pop()!);   // the newest: the one a restore takes
  const bytes = readFileSync(ct); bytes[bytes.length - 5] ^= 0xff; writeFileSync(ct, bytes)
  r = run(path.join(ops, 'restore-offhost.sh'), ['--offhost', offhost, '--identity', id, '--out', path.join(T, 'r4')]); assert.equal(r.code, 1); assert.match(r.out, /does not match its manifest sha256/)
  // a copy that decrypts to something else than the manifest says: failed, and NO plaintext is left behind
  const lie = JSON.parse(readFileSync(path.join(remote, `${good}.json`), 'utf8')); writeFileSync(path.join(remote, `${good}.json`), JSON.stringify({ ...lie, source_sha256: '0'.repeat(64) }))
  r = run(path.join(ops, 'restore-offhost.sh'), ['--offhost', remote, '--identity', id, '--out', path.join(T, 'r5')]); assert.equal(r.code, 1); assert.match(r.out, /does not match the manifest's source_sha256/)
  assert.deepEqual(readdirSync(path.join(T, 'r5')).filter(f => f.endsWith('.db')), [], 'no decrypted database left after a failed restore')

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
