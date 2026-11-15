// #1080: the pull-mode off-host copy (scripts/backup/pull-offhost.mts) and the box-side pull marker (backup-check.mts
// OFFHOST_PULL_MARKER). Synthetic encrypted-copy files and manifests in the shape offhost-copy.sh writes (ciphertext bytes
// are arbitrary: the pull checks ciphertext integrity, never decrypts), pulled with the real rsync from a local directory
// standing in for HOST:. The ack's ssh is a stub on PATH. No age, no ssh, no network.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { nameTime, retainedCopies } from '../scripts/backup/offhost.mts'

const web = fileURLToPath(new URL('../', import.meta.url))
const hasRsync = spawnSync('rsync', ['--version']).status === 0
const skip = !hasRsync && 'rsync not installed'
const T = mkdtempSync(path.join(tmpdir(), 'pull-test-'))
test.after(() => rmSync(T, { recursive: true, force: true }))
let n = 0
const HOUR = 3_600_000, DAY = 24 * HOUR
const stamp = (t: number) => new Date(t).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')

// one encrypted copy + its manifest in dir, taken at t
function copy(dir: string, t: number, i: number, o: { kind?: 'backup' | 'ledger'; body?: string; copiedAt?: number; noManifest?: boolean } = {}) {
  const name = o.kind === 'ledger' ? `dazl-ledger-${stamp(t)}.jsonl.age` : `dazl-backup-${stamp(t)}-${i.toString(16).padStart(8, '0')}.db.age`
  const body = o.body ?? `age-encryption.org/v1 ciphertext ${i} ${t}`
  writeFileSync(path.join(dir, name), body)
  if (!o.noManifest) writeFileSync(path.join(dir, `${name}.json`), JSON.stringify({ tool: 'dazl-offhost-copy', ciphertext: name, ciphertext_sha256: createHash('sha256').update(body).digest('hex'), bytes: Buffer.byteLength(body), copied_at: new Date(o.copiedAt ?? t + 30_000).toISOString() }))
  return name
}
function dirs() {
  const box = path.join(T, `box${++n}`), here = path.join(T, `here${n}`)
  mkdirSync(box); mkdirSync(here, { mode: 0o700 })
  // the box's other files must never come across
  writeFileSync(path.join(box, 'dazl-backup-20260101T000000Z-00000000.db'), 'PLAINTEXT backup (local, never pulled)')
  writeFileSync(path.join(box, 'drill-report.json'), '{}')
  writeFileSync(path.join(box, 'x.age.partial'), 'half')
  return { box, here }
}
const alertLog = path.join(T, 'alerts.log'), alertCmd = path.join(T, 'alert.sh')
writeFileSync(alertCmd, `#!/bin/sh\nprintf '%s\\n' "$1" >> ${JSON.stringify(alertLog)}\n`); chmodSync(alertCmd, 0o755)
// a stub `ssh` on PATH for the ack: it records the host it was asked to reach (on the box the key's forced command is a touch)
const bin = path.join(T, 'bin'), ackLog = path.join(T, 'ack.log')
mkdirSync(bin); writeFileSync(path.join(bin, 'ssh'), `#!/bin/sh\nfor a; do last=$a; done\n[ "$last" = unreachable ] && exit 255\nprintf '%s\\n' "$last" >> ${JSON.stringify(ackLog)}\n`); chmodSync(path.join(bin, 'ssh'), 0o755)
const alerts = () => existsSync(alertLog) ? readFileSync(alertLog, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l) as { problems: string[] }) : []
const run = (from: string, to: string, extra: string[] = [], env: Record<string, string> = {}) => {
  if (existsSync(alertLog)) unlinkSync(alertLog)
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', 'scripts/backup/pull-offhost.mts', '--from', from, '--to', to, ...extra],
    { cwd: web, encoding: 'utf8', timeout: 60_000, env: { PATH: `${bin}:${process.env.PATH}`, HOME: process.env.HOME, BACKUP_ALERT_CMD: alertCmd, ...env } as unknown as NodeJS.ProcessEnv })
  let json: Record<string, unknown> = {}
  try { json = JSON.parse(r.stdout.trim().split('\n').at(-1) || '{}') } catch { /* usage errors print no JSON */ }
  return { code: r.status, out: r.stdout + r.stderr, json }
}
const copies = (d: string, prefix = 'dazl-backup-') => readdirSync(d).filter(f => f.startsWith(prefix) && f.endsWith('.age'))
const now = Date.now()

test('#1080 pull: copies and manifests only, checked; append-only (a copy the box drops stays); a second run pulls nothing; the ack reaches the box', { skip }, () => {
  const { box, here } = dirs()
  const names = [copy(box, now - 10 * 60_000, 1), copy(box, now - 70 * 60_000, 2), copy(box, now - 130 * 60_000, 3), copy(box, now - 10 * 60_000, 9, { kind: 'ledger' })]
  if (existsSync(ackLog)) unlinkSync(ackLog)
  const r = run(box, here, ['--ack', 'dazl-offhost-ack'])
  assert.equal(r.code, 0, r.out)
  assert.equal(r.json.ok, true); assert.equal(r.json.pulled, 8); assert.equal(r.json.backups, 3); assert.equal(r.json.ledgers, 1); assert.equal(r.json.acked, true)
  assert.equal(readFileSync(ackLog, 'utf8').trim(), 'dazl-offhost-ack')
  assert.equal(r.json.newest, names[0])
  assert.deepEqual(readdirSync(here).filter(f => !f.startsWith('.')).sort(), names.flatMap(f => [f, `${f}.json`]).sort(), 'no plaintext backup, report or partial file')
  assert.equal(alerts().length, 0)
  unlinkSync(path.join(box, names[1])); unlinkSync(path.join(box, `${names[1]}.json`))
  const r2 = run(box, here)
  assert.equal(r2.code, 0, r2.out); assert.equal(r2.json.pulled, 0); assert.equal(r2.json.backups, 3)
  // an ack that cannot reach the box is a problem (the box would alert that pulls stopped)
  const r3 = run(box, here, ['--ack', 'unreachable'])
  assert.equal(r3.code, 1); assert.match(alerts()[0].problems.join('\n'), /could not record the pull on the box/)
})

test('#1080 pull: a bad copy and a future-dated copy go to .bad and alert; with 48 good copies here nothing is retired while they do', { skip }, () => {
  const { box, here } = dirs()
  copy(box, now - 10 * 60_000, 9, { kind: 'ledger' })
  for (let i = 0; i < 48; i++) copy(box, now - (i + 1) * HOUR, i)
  assert.equal(run(box, here).code, 0)
  const held = copies(here).length
  assert.equal(held, 48)
  const bad = copy(box, now - 5 * 60_000, 100)
  writeFileSync(path.join(box, bad), 'age-encryption.org/v1 TAMPERED')
  const future = copy(box, now - 4 * 60_000, 101, { copiedAt: now + DAY })
  copy(box, now - 3 * 60_000, 102) // a good new copy: the 49th, so one is past retention
  const r = run(box, here)
  assert.equal(r.code, 1, r.out)
  assert.ok(existsSync(path.join(here, '.bad', bad)) && existsSync(path.join(here, '.bad', future)))
  assert.equal(r.json.retired, 0); assert.equal(copies(here).length, 49, 'nothing retired while a copy is in doubt')
  assert.match(alerts()[0].problems.join('\n'), /2 copy\(ies\) failed the manifest check/)
  // the next run does not pull them again: retention and the ack go on, and the set-aside copies still alert
  if (existsSync(ackLog)) unlinkSync(ackLog)
  const r2 = run(box, here, ['--ack', 'dazl-offhost-ack'])
  assert.equal(r2.json.pulled, 0, r2.out); assert.equal(r2.json.retired, 1); assert.equal(r2.json.acked, true)
  assert.match(alerts()[0].problems.join('\n'), /2 copy\(ies\) in \.bad\/: inspect/)
  assert.ok(!existsSync(path.join(here, bad)))
  // after inspection the operator removes them: they stay excluded (never pulled again) and the alert stops
  for (const f of readdirSync(path.join(here, '.bad'))) if (f !== 'names') unlinkSync(path.join(here, '.bad', f))
  const r3 = run(box, here)
  assert.equal(r3.code, 0, r3.out); assert.equal(r3.json.pulled, 0)
})

test('#1080 pull: a box that writes BACKDATED copies (to push real ones out of retention) is caught: alert, nothing retired', { skip }, () => {
  const { box, here } = dirs()
  copy(box, now - 10 * 60_000, 9, { kind: 'ledger' })
  for (let i = 0; i < 48; i++) copy(box, now - 60_000 - i * HOUR, i)
  assert.equal(run(box, here).code, 0)
  const real = copies(here)
  // fakes the box chooses: one per day, older than everything held (they would take the daily and weekly slots)
  for (let d = 3; d < 70; d++) copy(box, now - d * DAY, 500 + d)
  const r = run(box, here)
  assert.equal(r.code, 1, r.out)
  assert.match(alerts()[0].problems.join('\n'), /new copy\(ies\) named older than the newest copy already here/)
  assert.equal(r.json.retired, 0)
  for (const f of real) assert.ok(existsSync(path.join(here, f)), `${f} kept`)
  // the fakes are set aside: later runs neither pull them again nor count them, so no real copy is ever retired for them
  for (let i = 0; i < 2; i++) {
    const again = run(box, here)
    assert.equal(again.json.pulled, 0, again.out); assert.equal(again.json.retired, 0, again.out)
    assert.match(alerts()[0].problems.join('\n'), /copy\(ies\) in \.bad\/: inspect/)
  }
  for (const f of real) assert.ok(existsSync(path.join(here, f)), `${f} still kept`)
  assert.equal(copies(path.join(here, '.bad')).length, 67)
})

test('#1080 pull: the first pull of a box holding a week of hourly copies keeps the policy at once, without an alert', { skip }, () => {
  const { box, here } = dirs()
  for (let i = 0; i < 168; i++) { copy(box, now - 60_000 - i * HOUR, i); copy(box, now - 60_000 - i * HOUR, i, { kind: 'ledger' }) }
  const r = run(box, here)
  assert.equal(r.code, 0, r.out)
  assert.equal(r.json.pulled, 672)
  const base = (f: string) => f.slice(0, -'.age'.length)
  const kept = copies(here)
  assert.equal(kept.length + (r.json.retired as number) / 2, 168)
  assert.ok(kept.length >= 48 && kept.length < 60, String(kept.length))
  assert.equal(new Set(kept.map(base)).size, kept.length)
})

test('#1080 pull: a copy whose manifest arrives a run later is judged against what was held when its ciphertext came (no false backdating)', { skip }, () => {
  const { box, here } = dirs()
  copy(box, now - 10 * 60_000, 9, { kind: 'ledger' }); copy(box, now - 2 * HOUR + 60_000, 1)
  assert.equal(run(box, here).code, 0)
  const late = copy(box, now - 50 * 60_000, 2, { noManifest: true }) // interrupted: ciphertext only
  copy(box, now - 5 * 60_000, 3) // and a newer complete copy
  assert.equal(run(box, here).code, 0)
  const body = readFileSync(path.join(box, late), 'utf8')
  writeFileSync(path.join(box, `${late}.json`), JSON.stringify({ tool: 'dazl-offhost-copy', ciphertext: late, ciphertext_sha256: createHash('sha256').update(body).digest('hex'), bytes: Buffer.byteLength(body), copied_at: new Date(now - 49 * 60_000).toISOString() }))
  const r = run(box, here)
  assert.equal(r.code, 0, r.out); assert.equal(r.json.backups, 3)
  assert.ok(existsSync(path.join(here, late)))
})

test('#1080 pull: a flood of new copies retires at most 3 per run and alerts; a retired copy is never pulled again and is deleted only after 7 days', { skip }, () => {
  const { box, here } = dirs()
  copy(box, now - 10 * 60_000, 9, { kind: 'ledger' })
  for (let i = 0; i < 48; i++) copy(box, now - 70 * 60_000 - i * HOUR, i)
  const first = run(box, here)
  assert.equal(first.code, 0, first.out)
  // 10 new copies in the last hour (a catch-up, or a flood)
  for (let i = 0; i < 10; i++) copy(box, now - 60_000 - i * 6 * 60_000, 200 + i)
  const r = run(box, here)
  assert.equal(r.code, 1, r.out); assert.equal(r.json.retired, 3)
  assert.match(alerts()[0].problems.join('\n'), /backup copies held here are past retention; 3 retired this run/)
  assert.equal(readdirSync(path.join(here, '.retired')).filter(f => f.endsWith('.db.age')).length, 3)
  // the box still holds them: they are not pulled again, and the next run retires the next 3
  const r2 = run(box, here)
  assert.equal(r2.json.pulled, 0, r2.out); assert.equal(r2.json.retired, 3, r2.out)
  // 7 days after retirement they are deleted; their names stay excluded
  for (const f of readdirSync(path.join(here, '.retired'))) if (f.includes('.age')) utimesSync(path.join(here, '.retired', f), new Date(now - 8 * DAY), new Date(now - 8 * DAY))
  const r3 = run(box, here)
  assert.ok((r3.json.purged as number) >= 12, r3.out); assert.equal(r3.json.pulled, 0, r3.out)
})

test('#1080 pull: steady state retention keeps exactly the policy, per kind; a second run retires and pulls nothing', { skip }, () => {
  const { box, here } = dirs()
  const names: string[] = [], ledgers: string[] = []
  for (let i = 0; i < 51; i++) names.push(copy(box, now - 60_000 - i * HOUR, i))
  for (let i = 0; i < 51; i++) ledgers.push(copy(box, now - 60_000 - i * HOUR, i, { kind: 'ledger' }))
  const r = run(box, here)
  assert.equal(r.code, 0, r.out)
  const base = (f: string) => f.slice(0, -'.age'.length)
  const want = retainedCopies(names.map(f => [base(f), nameTime(base(f))!] as [string, number]), { hourly: 48, daily: 14, weekly: 8 })
  assert.deepEqual(new Set(copies(here).map(base)), want)
  const wantL = retainedCopies(ledgers.map(f => [base(f), nameTime(base(f), 'dazl-ledger-')!] as [string, number]), { hourly: 48, daily: 14, weekly: 8 })
  assert.deepEqual(new Set(copies(here, 'dazl-ledger-').map(base)), wantL)
  for (const f of copies(here)) assert.ok(existsSync(path.join(here, `${f}.json`)))
  const r2 = run(box, here)
  assert.equal(r2.code, 0, r2.out); assert.equal(r2.json.pulled, 0); assert.equal(r2.json.retired, 0)
})

test('#1080 pull: stale newest copy, no ledger copy, an unreachable box, nothing here, a manifest missing for over 2 h: each alerts; a manifest still coming is not', { skip }, () => {
  const { box, here } = dirs()
  copy(box, now - 3 * HOUR, 1)
  const r = run(box, here)
  assert.equal(r.code, 1, r.out)
  const p = alerts()[0].problems.join('\n')
  assert.match(p, /newest off-host copy is \d+s old \(limit 7200s\)/)
  assert.match(p, /no deletion-ledger copy here/)
  assert.match(String(run(path.join(T, 'no-such-box'), here).json.problems), /pull failed \(rsync exit \d+\)/)
  const e = dirs()
  assert.equal(run(e.box, e.here).code, 1); assert.match(alerts()[0].problems.join('\n'), /no checked backup copy here/)
  // a ciphertext whose manifest has not arrived: fine for now, a problem once it is 2 h old; never moved to .bad
  const m = dirs()
  copy(m.box, now - 10 * 60_000, 9, { kind: 'ledger' }); copy(m.box, now - 10 * 60_000, 1)
  const fresh = copy(m.box, now - 5 * 60_000, 2, { noManifest: true })
  assert.equal(run(m.box, m.here).code, 0)
  assert.ok(existsSync(path.join(m.here, fresh)) && !existsSync(path.join(m.here, '.bad', fresh)))
  const old = copy(m.box, now - 3 * HOUR, 3, { noManifest: true })
  assert.equal(run(m.box, m.here).code, 1)
  assert.match(alerts()[0].problems.join('\n'), new RegExp(`without a manifest for over 2 h: ${old.replace(/\./g, '\\.')}`))
})

test('#1080 pull: a LATE manifest for a copy older than what was held when its ciphertext came is set aside; a corrupt pending record holds retention', { skip }, () => {
  const { box, here } = dirs()
  copy(box, now - 10 * 60_000, 9, { kind: 'ledger' }); copy(box, now - 30 * 60_000, 1)
  for (let i = 0; i < 49; i++) copy(box, now - 90 * 60_000 - i * HOUR, 10 + i) // 50 hourly copies: past the 48 policy
  assert.equal(run(box, here).code, 0)
  const x = copy(box, now - 4 * HOUR, 2, { noManifest: true }) // ciphertext only, named older than the copy held
  assert.equal(run(box, here).code, 1) // older than 2 h without its manifest: alerts, nothing else
  const body = readFileSync(path.join(box, x), 'utf8')
  writeFileSync(path.join(box, `${x}.json`), JSON.stringify({ tool: 'dazl-offhost-copy', ciphertext: x, ciphertext_sha256: createHash('sha256').update(body).digest('hex'), bytes: Buffer.byteLength(body), copied_at: new Date(now - 4 * HOUR + 30_000).toISOString() }))
  const r = run(box, here)
  assert.equal(r.code, 1, r.out); assert.equal(r.json.retired, 0)
  assert.ok(existsSync(path.join(here, '.bad', x)))
  assert.match(alerts()[0].problems.join('\n'), new RegExp(`named older than the newest copy already here.*${x.replace(/\./g, '\\.')}`))
  // a corrupt pending record: a problem that holds retention (never read as "nothing pending")
  // a corrupt pending record: a problem that holds retention (never read as "nothing pending")
  for (const bad of ['{"truncat', '[]', 'null', '{"x":"1"}']) {
    writeFileSync(path.join(here, '.retired', 'pending.json'), bad)
    copy(box, now - 2 * 60_000, 900 + bad.length) // a new copy: one held copy is now past the policy
    const c = run(box, here)
    assert.equal(c.code, 1, bad); assert.equal(c.json.retired, 0, bad)
    assert.match(alerts()[0].problems.join('\n'), /pending\.json is not valid/, bad)
  }
  // removed after inspection: retention runs again
  unlinkSync(path.join(here, '.retired', 'pending.json'))
  for (const f of readdirSync(path.join(here, '.bad'))) if (f !== 'names') unlinkSync(path.join(here, '.bad', f))
  const ok = run(box, here)
  assert.ok((ok.json.retired as number) > 0, ok.out)
})

test('#1080 pull: a split fake whose pending record was LOST (removed) is still judged, against the newest copy held now', { skip }, () => {
  const { box, here } = dirs()
  copy(box, now - 10 * 60_000, 9, { kind: 'ledger' }); copy(box, now - 30 * 60_000, 1)
  assert.equal(run(box, here).code, 0)
  const x = copy(box, now - 4 * HOUR, 2, { noManifest: true })
  run(box, here)
  const pend = JSON.parse(readFileSync(path.join(here, '.retired', 'pending.json'), 'utf8'))
  assert.ok(x in pend, 'remembered while it waits')
  unlinkSync(path.join(here, '.retired', 'pending.json'))
  const body = readFileSync(path.join(box, x), 'utf8')
  writeFileSync(path.join(box, `${x}.json`), JSON.stringify({ tool: 'dazl-offhost-copy', ciphertext: x, ciphertext_sha256: createHash('sha256').update(body).digest('hex'), bytes: Buffer.byteLength(body), copied_at: new Date(now - 4 * HOUR + 30_000).toISOString() }))
  const r = run(box, here)
  assert.equal(r.code, 1, r.out); assert.equal(r.json.backups, 1)
  assert.ok(existsSync(path.join(here, '.bad', x)))
  // and a stale entry (its ciphertext gone) is dropped from the record
  writeFileSync(path.join(here, '.retired', 'pending.json'), JSON.stringify({ 'dazl-backup-20200101T000000Z-00000000.db.age': 1 }))
  run(box, here)
  assert.deepEqual(JSON.parse(readFileSync(path.join(here, '.retired', 'pending.json'), 'utf8')), {})
})

test('#1080 pull: usage errors exit 2 and touch nothing', () => {
  const { box } = dirs()
  assert.equal(run(box, path.join(T, 'missing-dir')).code, 2)
  assert.equal(run('host:a b', T).code, 2)
  assert.equal(run(box, T, ['--max-age-s', 'soon']).code, 2)
  assert.equal(run(box, T, [], { RETAIN_OFFHOST_HOURLY: '0' }).code, 2)
  assert.equal(run(box, T, [], { RETIRE_MAX_PER_RUN: '0' }).code, 2)
  assert.equal(run('dazl-offhost-pull', T).code, 2, 'a host without its colon is not taken for a local directory')
})

test('#1080 backup-check (on the box): OFFHOST_PULL_MARKER older than OFFHOST_PULL_MAX_AGE_S, or missing, is a problem; fresh is not', () => {
  const marker = path.join(T, 'pulled-marker')
  const check = (env: Record<string, string>) => {
    if (existsSync(alertLog)) unlinkSync(alertLog)
    spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', 'scripts/backup/backup-check.mts', '--dir', path.join(T, 'no-backups-here'), '--state-dir', path.join(T, `state${++n}`)],
      { cwd: web, encoding: 'utf8', timeout: 60_000, env: { PATH: process.env.PATH, HOME: process.env.HOME, BACKUP_ALERT_CMD: alertCmd, ...env } as unknown as NodeJS.ProcessEnv })
    return alerts()[0]?.problems.join('\n') ?? ''
  }
  assert.match(check({ OFFHOST_PULL_MARKER: marker }), /no off-host pull recorded yet/)
  writeFileSync(marker, ''); utimesSync(marker, new Date(now - 4 * HOUR), new Date(now - 4 * HOUR))
  assert.match(check({ OFFHOST_PULL_MARKER: marker }), /the operator machine has not pulled the off-host copies for \d+s \(limit 10800s\)/)
  utimesSync(marker, new Date(), new Date())
  assert.doesNotMatch(check({ OFFHOST_PULL_MARKER: marker }), /pull/, 'a fresh marker is not a problem (the other problems are the empty backup dir)')
  assert.match(check({ OFFHOST_PULL_MARKER: marker, OFFHOST_PULL_MAX_AGE_S: '3h' }), /OFFHOST_PULL_MAX_AGE_S must be a whole number of seconds/)
})
