// The install-time contract between the shipped backup producer and the monitor (issue #360; review hold on
// da8e61bee9): the check unit used to demand /var/lib/dazl-drill/latest.json, a report nothing shipped ever wrote -
// an operator installing per the docs would have been alerted "no readable recovery drill report" forever, and the
// hourly content drill fed nobody. Now restore-drill --report writes the report on EVERY run (pass or fail),
// run-backup.sh writes it to $BACKUP_DIR/drill-report.json by default, backup-check.mts derives the same default
// from --dir, and DRILL_REPORT overrides BOTH sides. Synthetic fixtures only; no age, no rclone, no network.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { fixtureBackup } from './helpers/recovery-fixture.mts'

const web = fileURLToPath(new URL('../', import.meta.url))
const ops = path.join(web, '../ops/backup')
const T = mkdtempSync(path.join(tmpdir(), 'drill-report-'))
test.after(() => rmSync(T, { recursive: true, force: true }))

const drillCli = (args: string[]) => {
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', 'scripts/backup/restore-drill.ts', ...args], { cwd: web, encoding: 'utf8', env: { PATH: process.env.PATH!, HOME: process.env.HOME! } as unknown as NodeJS.ProcessEnv })
  return { code: r.status, out: r.stdout + r.stderr }
}
const report = (p: string) => JSON.parse(readFileSync(p, 'utf8')) as { tool?: string; ok?: boolean; started_at?: string; steps?: { step: string; ok: boolean }[]; reasons?: string[] }

test('restore-drill --report on a good backup: exit 0, a fresh mode-600 report in the shape the monitor reads, no .partial left', async () => {
  const fx = await fixtureBackup(path.join(T, 'good')), out = path.join(T, 'good-report.json')
  const r = drillCli(['--backup', fx.backup, '--report', out])
  assert.equal(r.code, 0, r.out)
  const rep = report(out)
  assert.equal(rep.tool, 'dazl-restore-drill'); assert.equal(rep.ok, true)
  assert.ok(Date.now() - Date.parse(rep.started_at!) < 60_000, 'fresh started_at')
  assert.ok(rep.steps!.length >= 3 && rep.steps!.every(s => s.ok), `every step ok: ${JSON.stringify(rep.steps)}`)
  assert.deepEqual(rep.reasons, [])
  assert.equal(statSync(out).mode & 0o777, 0o600, 'the report is not world-readable')
  assert.ok(!existsSync(out + '.partial'), 'no .partial left behind')
})

test('restore-drill --report on a modified backup: exit 1 and a FRESH failing report naming the failed step; the monitor names it', async () => {
  const fx = await fixtureBackup(path.join(T, 'bad'))
  const bad = path.join(T, 'bad.db'); copyFileSync(fx.backup, bad); copyFileSync(fx.backup + '.json', bad + '.json'); appendFileSync(bad, 'x')
  const out = path.join(T, 'bad-report.json')
  const r = drillCli(['--backup', bad, '--report', out])
  assert.equal(r.code, 1, r.out)
  const rep = report(out)
  assert.equal(rep.ok, false); assert.ok(Date.now() - Date.parse(rep.started_at!) < 60_000, 'a failed drill still leaves a FRESH report')
  assert.ok(rep.steps!.some(s => s.step === 'sidecar sha256' && !s.ok), `the failing step is named: ${JSON.stringify(rep.steps)}`)
  const chk = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', 'scripts/backup/backup-check.mts', '--dir', path.dirname(fx.backup), '--state-dir', path.join(T, 'bad-state'), '--drill-report', out], { cwd: web, encoding: 'utf8', env: { PATH: process.env.PATH!, HOME: process.env.HOME!, BACKUP_ALERT_CMD: 'true' } as unknown as NodeJS.ProcessEnv })
  assert.equal(chk.status, 1); assert.match(chk.stdout, /last recovery drill FAILED \(sidecar sha256\)/)
})

test('restore-drill --report to an unwritable path: the drill passed but the run still fails, saying why', async () => {
  const fx = await fixtureBackup(path.join(T, 'nowrite'))
  const r = drillCli(['--backup', fx.backup, '--report', path.join(T, 'no-such-dir', 'report.json')])
  assert.equal(r.code, 1, 'a demanded report that cannot be written fails the run even when the drill passed')
  assert.match(r.out, /restore drill: PASS/); assert.match(r.out, /the drill report could not be written/)
})

// The shipped pair, run as shipped: no --drill-report flag anywhere, no test-side path substitution.
const unitArgv = (env: Record<string, string>) => {
  const exec = /^ExecStart=(.*)$/m.exec(readFileSync(path.join(ops, 'dazl-backup-check.service'), 'utf8'))![1]
  return exec.replace(/\$\{(\w+)\}/g, (_, k) => env[k] ?? '').split(/\s+/)
}
const runUnit = (env: Record<string, string>) => {
  const argv = unitArgv(env)
  const r = spawnSync(argv[1], [...argv.slice(2), '--state-dir', path.join(T, `unit-st-${Math.random().toString(36).slice(2)}`)], { cwd: web, encoding: 'utf8', env: { PATH: process.env.PATH!, HOME: process.env.HOME!, BACKUP_ALERT_CMD: 'true', OFFHOST_REQUIRED: '0', OFFHOST_DEST: '', ...env } as unknown as NodeJS.ProcessEnv })
  return { code: r.status, out: r.stdout + r.stderr }
}
const runBackup = (env: Record<string, string>) => {
  const r = spawnSync('bash', [path.join(ops, 'run-backup.sh')], { encoding: 'utf8', env: { PATH: process.env.PATH!, HOME: process.env.HOME!, WEB_DIR: web, ...env } as unknown as NodeJS.ProcessEnv })
  return { code: r.status, out: r.stdout + r.stderr }
}

test('installed per the docs: run-backup writes the default report and the shipped check unit reads it; missing, failing or stale stays an honest alert', async () => {
  const fx = await fixtureBackup(path.join(T, 'pair')), bdir = path.join(T, 'pair-backups')
  let r = runBackup({ DB_PATH: fx.source, BACKUP_DIR: bdir })
  assert.equal(r.code, 0, r.out)
  const def = path.join(bdir, 'drill-report.json')
  assert.equal(report(def).ok, true, 'the producer wrote a passing report at the default path')
  r = runUnit({ BACKUP_DIR: bdir })
  assert.equal(r.code, 0, r.out); assert.match(r.out, /"drill_ok":true/)
  // missing: the report is deleted and the next monitor run says so (never a silent green)
  rmSync(def)
  r = runUnit({ BACKUP_DIR: bdir })
  assert.equal(r.code, 1); assert.match(r.out, /no readable recovery drill report/)
  // failing: a drill that failed names its step
  writeFileSync(def, JSON.stringify({ tool: 'dazl-restore-drill', ok: false, started_at: new Date().toISOString(), steps: [{ step: 'restore and compare', ok: false }] }))
  r = runUnit({ BACKUP_DIR: bdir })
  assert.equal(r.code, 1); assert.match(r.out, /last recovery drill FAILED \(restore and compare\)/)
  // stale: the shipped unit allows 7200s; a 3h-old report means the hourly drill stopped reporting
  writeFileSync(def, JSON.stringify({ tool: 'dazl-restore-drill', ok: true, started_at: new Date(Date.now() - 3 * 3600_000).toISOString(), steps: [{ step: 'restore drill', ok: true }] }))
  r = runUnit({ BACKUP_DIR: bdir })
  assert.equal(r.code, 1); assert.match(r.out, /last recovery drill is \d+s old \(limit 7200s\)/)
})

test('DRILL_REPORT overrides BOTH sides; an explicit flag beats the env; an empty value is the default, not a blind spot', async () => {
  const fx = await fixtureBackup(path.join(T, 'ovr')), bdir = path.join(T, 'ovr-backups'), custom = path.join(T, 'ovr-custom', 'report.json')
  let r = runBackup({ DB_PATH: fx.source, BACKUP_DIR: bdir, DRILL_REPORT: custom })
  assert.equal(r.code, 0, r.out)
  assert.equal(report(custom).ok, true, 'the producer honored DRILL_REPORT')
  assert.ok(!existsSync(path.join(bdir, 'drill-report.json')), 'nothing written at the default when overridden')
  r = runUnit({ BACKUP_DIR: bdir, DRILL_REPORT: custom })
  assert.equal(r.code, 0, r.out); assert.match(r.out, /"drill_ok":true/, 'the monitor read the same override with no flag')
  // the flag wins over the env: env points at a failing report, the flag at a passing one
  const failing = path.join(T, 'ovr-failing.json'); writeFileSync(failing, JSON.stringify({ ok: false, started_at: new Date().toISOString(), steps: [{ step: 'restore drill', ok: false }] }))
  let chk = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', 'scripts/backup/backup-check.mts', '--dir', path.dirname(fx.backup), '--state-dir', path.join(T, 'ovr-st-1'), '--drill-report', custom], { cwd: web, encoding: 'utf8', env: { PATH: process.env.PATH!, HOME: process.env.HOME!, BACKUP_ALERT_CMD: 'true', DRILL_REPORT: failing } as unknown as NodeJS.ProcessEnv })
  assert.equal(chk.status, 0, chk.stdout + chk.stderr)
  // an empty flag value and an empty env var both fall back to the default (the fixture's fresh report)
  chk = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', 'scripts/backup/backup-check.mts', '--dir', path.dirname(fx.backup), '--state-dir', path.join(T, 'ovr-st-2'), '--drill-report', ''], { cwd: web, encoding: 'utf8', env: { PATH: process.env.PATH!, HOME: process.env.HOME!, BACKUP_ALERT_CMD: 'true', DRILL_REPORT: '' } as unknown as NodeJS.ProcessEnv })
  assert.equal(chk.status, 0, chk.stdout + chk.stderr); assert.match(chk.stdout, /"drill_ok":true/)
})
