// #1080: the pull-mode off-host copy (scripts/backup/pull-offhost.mts). Synthetic encrypted-copy files and manifests in
// the shape offhost-copy.sh writes (ciphertext bytes are arbitrary: the pull checks ciphertext integrity, never decrypts),
// pulled with the real rsync from a local directory standing in for HOST:DIR. No age, no ssh, no network.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { nameTime, retainedCopies } from '../scripts/backup/offhost.mts'

const web = fileURLToPath(new URL('../', import.meta.url))
const hasRsync = spawnSync('rsync', ['--version']).status === 0
const T = mkdtempSync(path.join(tmpdir(), 'pull-test-'))
test.after(() => rmSync(T, { recursive: true, force: true }))
let n = 0
const HOUR = 3_600_000
const stamp = (t: number) => new Date(t).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')

// one encrypted copy + its manifest in dir, taken at t, copied `lagMs` later
function copy(dir: string, t: number, i: number, o: { kind?: 'backup' | 'ledger'; lagMs?: number; body?: string } = {}) {
  const name = o.kind === 'ledger' ? `dazl-ledger-${stamp(t)}.jsonl.age` : `dazl-backup-${stamp(t)}-${i.toString(16).padStart(8, '0')}.db.age`
  const body = o.body ?? `age-encryption.org/v1 ciphertext ${i}`
  writeFileSync(path.join(dir, name), body)
  writeFileSync(path.join(dir, `${name}.json`), JSON.stringify({ tool: 'dazl-offhost-copy', ciphertext: name, ciphertext_sha256: createHash('sha256').update(body).digest('hex'), bytes: Buffer.byteLength(body), copied_at: new Date(t + (o.lagMs ?? 30_000)).toISOString() }))
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
const alertLog = path.join(T, 'alerts.log')
const alertCmd = path.join(T, 'alert.sh')
writeFileSync(alertCmd, `#!/bin/sh\nprintf '%s\\n' "$1" >> ${JSON.stringify(alertLog)}\n`); chmodSync(alertCmd, 0o755)
const alerts = () => existsSync(alertLog) ? readFileSync(alertLog, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l) as { problems: string[] }) : []
const run = (from: string, to: string, extra: string[] = [], env: Record<string, string> = {}) => {
  if (existsSync(alertLog)) unlinkSync(alertLog)
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', 'scripts/backup/pull-offhost.mts', '--from', from, '--to', to, ...extra],
    { cwd: web, encoding: 'utf8', timeout: 60_000, env: { PATH: process.env.PATH, HOME: process.env.HOME, BACKUP_ALERT_CMD: alertCmd, ...env } as unknown as NodeJS.ProcessEnv })
  let json: Record<string, unknown> = {}
  try { json = JSON.parse(r.stdout.trim().split('\n').at(-1) || '{}') } catch { /* usage errors print no JSON */ }
  return { code: r.status, out: r.stdout + r.stderr, json }
}
const now = Date.now()

test('#1080 pull: copies and manifests only, checked; append-only (a copy the box drops stays here); a second run pulls nothing', { skip: !hasRsync && 'rsync not installed' }, () => {
  const { box, here } = dirs()
  const names = [copy(box, now - 10 * 60_000, 1), copy(box, now - 70 * 60_000, 2), copy(box, now - 130 * 60_000, 3), copy(box, now - 10 * 60_000, 9, { kind: 'ledger' })]
  const r = run(box, here)
  assert.equal(r.code, 0, r.out)
  assert.equal(r.json.ok, true); assert.equal(r.json.pulled, 8); assert.equal(r.json.backups, 3); assert.equal(r.json.ledgers, 1)
  assert.equal(r.json.newest, names[0])
  assert.ok((r.json.newest_age_s as number) < 600)
  assert.deepEqual(readdirSync(here).filter(f => !f.startsWith('.')).sort(), names.flatMap(f => [f, `${f}.json`]).sort(), 'no plaintext backup, report or partial file')
  assert.equal(alerts().length, 0)
  // the box loses (or prunes) a copy: it stays here
  unlinkSync(path.join(box, names[1])); unlinkSync(path.join(box, `${names[1]}.json`))
  const r2 = run(box, here)
  assert.equal(r2.code, 0, r2.out); assert.equal(r2.json.pulled, 0); assert.equal(r2.json.backups, 3)
})

test('#1080 pull: a copy that does not match its manifest is set aside in .bad and alerts; nothing is pruned while it does', { skip: !hasRsync && 'rsync not installed' }, () => {
  const { box, here } = dirs()
  copy(box, now - 10 * 60_000, 9, { kind: 'ledger' })
  const good = copy(box, now - 70 * 60_000, 2)
  const bad = copy(box, now - 10 * 60_000, 1)
  writeFileSync(path.join(box, bad), 'age-encryption.org/v1 TAMPERED') // the ciphertext no longer matches its manifest
  const r = run(box, here)
  assert.equal(r.code, 1, r.out)
  assert.ok(existsSync(path.join(here, '.bad', bad)) && !existsSync(path.join(here, bad)))
  assert.equal(r.json.newest, good, 'the newest CHECKED copy')
  assert.equal(r.json.deleted, 0)
  assert.match(alerts()[0].problems.join('\n'), /1 copy\(ies\) failed the manifest check: dazl-backup-/)
})

test('#1080 pull: stale newest copy, no ledger copy, an unreachable box: each alerts (exit 1)', { skip: !hasRsync && 'rsync not installed' }, () => {
  const { box, here } = dirs()
  copy(box, now - 3 * HOUR, 1)
  const r = run(box, here)
  assert.equal(r.code, 1, r.out)
  const p = alerts()[0].problems.join('\n')
  assert.match(p, /newest off-host copy is \d+s old \(limit 7200s\)/)
  assert.match(p, /no deletion-ledger copy here/)
  const gone = run(path.join(T, 'no-such-box'), here)
  assert.equal(gone.code, 1)
  assert.match(alerts()[0].problems.join('\n'), /pull failed \(rsync exit \d+\)/)
  const empty = dirs()
  const e = run(empty.box, empty.here)
  assert.match(alerts()[0].problems.join('\n'), /no checked backup copy here/); assert.equal(e.code, 1)
})

test('#1080 pull: retention keeps exactly the box policy (48 hourly + 14 daily + 8 weekly), separately for ledger copies', { skip: !hasRsync && 'rsync not installed' }, () => {
  const { box, here } = dirs()
  const names: string[] = []
  for (let i = 0; i < 24 * 20; i += 3) names.push(copy(box, now - 60_000 - i * HOUR, i)) // every 3 h for 20 days
  const ledgers: string[] = []
  for (let i = 0; i < 60; i++) ledgers.push(copy(box, now - 60_000 - i * HOUR, i, { kind: 'ledger' }))
  const r = run(box, here)
  assert.equal(r.code, 0, r.out)
  const base = (f: string) => f.slice(0, -'.age'.length)
  const want = retainedCopies(names.map(f => [base(f), nameTime(base(f))!] as [string, number]), { hourly: 48, daily: 14, weekly: 8 })
  const kept = readdirSync(here).filter(f => f.startsWith('dazl-backup-') && f.endsWith('.age')).map(base)
  assert.deepEqual(new Set(kept), want)
  assert.ok(kept.length < names.length)
  const wantLedgers = retainedCopies(ledgers.map(f => [base(f), nameTime(base(f), 'dazl-ledger-')!] as [string, number]), { hourly: 48, daily: 14, weekly: 8 })
  assert.deepEqual(new Set(readdirSync(here).filter(f => f.startsWith('dazl-ledger-') && f.endsWith('.age')).map(base)), wantLedgers)
  assert.ok(wantLedgers.size >= 48 && wantLedgers.size < 60)
  for (const f of kept) assert.ok(existsSync(path.join(here, `${f}.age.json`)), 'each kept copy keeps its manifest')
})

test('#1080 pull: usage errors exit 2 and touch nothing', () => {
  const { box } = dirs()
  assert.equal(run(box, path.join(T, 'missing-dir')).code, 2)
  assert.equal(run('host:/a b', T).code, 2)
  assert.equal(run(box, T, ['--max-age-s', 'soon']).code, 2)
  assert.equal(run(box, T, [], { RETAIN_OFFHOST_HOURLY: '0' }).code, 2)
})
