// Retention (scripts/backup/prune-backups.mts) and the send gate (scripts/backup/send-gate.mts) for issue #360.
// Synthetic backups and off-host names only; neither needs age.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { nameTime, openDest, plainName } from '../scripts/backup/offhost.mts'
import { blockers, sendSafety } from '../scripts/backup/send-safety.mts'

const web = fileURLToPath(new URL('../', import.meta.url))
const T = mkdtempSync(path.join(tmpdir(), 'prune-test-'))
test.after(() => rmSync(T, { recursive: true, force: true }))
let n = 0
const run = (script: string, args: string[], env: Record<string, string> = {}) => {
  const e: Record<string, string | undefined> = { PATH: process.env.PATH, HOME: process.env.HOME, SystemRoot: process.env.SystemRoot, ...env }
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', `scripts/backup/${script}`, ...args], { cwd: web, encoding: 'utf8', env: e as NodeJS.ProcessEnv, timeout: 60_000 })
  let json: Record<string, unknown> = {}
  try { json = JSON.parse(r.stdout.trim().split('\n').at(-1) || '{}') } catch { /* usage errors print no JSON */ }
  return { code: r.status, out: r.stdout + r.stderr, json }
}
const stamp = (t: number) => new Date(t).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')
const HOUR = 3_600_000, DAY = 24 * HOUR
// a backup dir with `count` hourly backups (newest first at now - 1 min), sidecars and a passing drill report
function backups(count: number, opts: { stepMs?: number; drillOk?: boolean } = {}) {
  const dir = path.join(T, `b${++n}`); mkdirSync(dir)
  const names: string[] = []
  for (let i = 0; i < count; i++) {
    const t = Date.now() - 60_000 - i * (opts.stepMs ?? HOUR)
    const f = `dazl-backup-${stamp(t)}-${i.toString(16).padStart(8, '0')}.db`, body = `backup ${i}`
    writeFileSync(path.join(dir, f), body)
    writeFileSync(path.join(dir, f + '.json'), JSON.stringify({ tool: 'dazl-create-backup', sha256: createHash('sha256').update(body).digest('hex'), bytes: body.length, createdAt: new Date(t).toISOString() }))
    names.push(f)
  }
  writeFileSync(path.join(dir, 'drill-report.json'), JSON.stringify({ ok: opts.drillOk ?? true, started_at: new Date().toISOString() }))
  return { dir, names }
}
const offhost = (names: string[]) => { const d = path.join(T, `o${++n}`); mkdirSync(d); for (const b of names) { writeFileSync(path.join(d, b + '.age'), 'age-encryption.org/v1 x'); writeFileSync(path.join(d, b + '.age.json'), '{}') } return d }

test('local retention: keeps the newest RETAIN_LOCAL, deletes older backups with their sidecars, leaves other files', () => {
  const { dir, names } = backups(6)
  writeFileSync(path.join(dir, 'manual-copy.db'), 'x'); writeFileSync(path.join(dir, 'notes.txt'), 'x')
  const r = run('prune-backups.mts', ['--dir', dir], { RETAIN_LOCAL: '4' })
  assert.equal(r.code, 0, r.out); assert.equal(r.json.ok, true)
  assert.deepEqual((r.json.deleted as string[]).sort(), names.slice(4).sort())
  const left = readdirSync(dir)
  for (const f of names.slice(0, 4)) assert.ok(left.includes(f) && left.includes(f + '.json'), `${f} kept`)
  for (const f of names.slice(4)) assert.ok(!left.includes(f) && !left.includes(f + '.json'), `${f} deleted`)
  assert.ok(left.includes('manual-copy.db') && left.includes('notes.txt'), 'files not named by create-backup are never touched')
  const again = run('prune-backups.mts', ['--dir', dir], { RETAIN_LOCAL: '4' })
  assert.equal(again.code, 0); assert.deepEqual(again.json.deleted, [], 'a second run (a retry, another host) deletes nothing more')
})

test('dry run reports what it would delete and deletes nothing', () => {
  const { dir, names } = backups(5)
  const r = run('prune-backups.mts', ['--dir', dir, '--dry-run'], { RETAIN_LOCAL: '2' })
  assert.equal(r.code, 0, r.out); assert.equal(r.json.dry_run, true); assert.equal((r.json.deleted as string[]).length, 3)
  for (const f of names) assert.ok(existsSync(path.join(dir, f)))
})

test('malformed retention numbers refuse the whole run (exit 2) and delete nothing', () => {
  for (const bad of ['0', '-1', 'abc', '1.5', ' ', '1e3', '[]', 'null', '２']) {
    const { dir, names } = backups(3)
    const r = run('prune-backups.mts', ['--dir', dir], { RETAIN_LOCAL: '1', RETAIN_OFFHOST_DAILY: bad })
    if (bad.trim() === '') { assert.equal(r.code, 0, `blank ${JSON.stringify(bad)} is the default`); continue }
    assert.equal(r.code, 2, `${JSON.stringify(bad)}: ${r.out}`); assert.match(r.out, /must be a whole number/)
    for (const f of names) assert.ok(existsSync(path.join(dir, f)), `${JSON.stringify(bad)}: nothing deleted`)
  }
  assert.equal(run('prune-backups.mts', []).code, 2); assert.equal(run('prune-backups.mts', ['--dir']).code, 2)
})

test('fail closed: the newest backup modified, the drill failing or missing, or no backup at all refuses every deletion', () => {
  let b = backups(4); appendFileSync(path.join(b.dir, b.names[0]), 'tampered')
  let r = run('prune-backups.mts', ['--dir', b.dir], { RETAIN_LOCAL: '1' })
  assert.equal(r.code, 1); assert.match(String(r.json.refused), /does not match its sidecar/); assert.equal(readdirSync(b.dir).filter(f => f.endsWith('.db')).length, 4)
  b = backups(4, { drillOk: false }); r = run('prune-backups.mts', ['--dir', b.dir], { RETAIN_LOCAL: '1' })
  assert.equal(r.code, 1); assert.match(String(r.json.refused), /drill report/); assert.equal(readdirSync(b.dir).filter(f => f.endsWith('.db')).length, 4)
  b = backups(4); rmSync(path.join(b.dir, 'drill-report.json')); r = run('prune-backups.mts', ['--dir', b.dir], { RETAIN_LOCAL: '1' })
  assert.equal(r.code, 1); assert.match(String(r.json.refused), /drill report/)
  b = backups(4); writeFileSync(path.join(b.dir, 'drill-report.json'), '[true]'); r = run('prune-backups.mts', ['--dir', b.dir], { RETAIN_LOCAL: '1' })
  assert.equal(r.code, 1, 'a drill report of the wrong shape is not ok')
  r = run('prune-backups.mts', ['--dir', path.join(T, 'missing-dir')]); assert.equal(r.code, 1); assert.match(String(r.json.refused), /no usable local backup/)
})

test('never deleted: unreadable sidecars, future timestamps, and local backups with no off-host copy yet', () => {
  const b = backups(5)
  writeFileSync(path.join(b.dir, b.names[4] + '.json'), '{"createdAt":')
  const fut = `dazl-backup-${stamp(Date.now() + 2 * DAY)}-ffffffff.db`
  writeFileSync(path.join(b.dir, fut), 'f'); writeFileSync(path.join(b.dir, fut + '.json'), JSON.stringify({ sha256: 'x', createdAt: new Date(Date.now() + 2 * DAY).toISOString() }))
  const dest = offhost([b.names[0], b.names[1], b.names[2]]) // names[3] was never copied off-host
  const r = run('prune-backups.mts', ['--dir', b.dir, '--offhost', dest], { RETAIN_LOCAL: '1' })
  assert.equal(r.code, 0, r.out)
  assert.deepEqual((r.json.deleted as string[]).sort(), [b.names[1], b.names[2]].sort())
  const an = (r.json.anomalies as string[]).join('\n')
  assert.match(an, /unreadable sidecar \(kept\)/); assert.match(an, /future timestamp \(kept\)/); assert.match(an, new RegExp(`${b.names[3]}: no off-host copy yet`))
  for (const f of [b.names[3], b.names[4], fut]) assert.ok(existsSync(path.join(b.dir, f)))
  assert.equal(r.json.newest, b.names[0], 'a future-dated backup is never taken as the newest')
})

test('off-host retention: newest hourly, then one per day and one per ISO week; other names untouched', () => {
  // 60 days of copies every 6 hours
  const b = backups(1)
  const names: string[] = []
  for (let i = 0; i < 240; i++) names.push(`dazl-backup-${stamp(Date.now() - 60_000 - i * 6 * HOUR)}-${(i + 1).toString(16).padStart(8, '0')}.db`)
  const dest = offhost(names)
  writeFileSync(path.join(dest, 'dazl-config-20261101T000000Z-00000000.tar.age'), 'x'); writeFileSync(path.join(dest, 'other.age'), 'x'); writeFileSync(path.join(dest, 'dazl-backup-junk.db.age'), 'x')
  writeFileSync(path.join(dest, b.names[0] + '.age.json'), '{}')
  const r = run('prune-backups.mts', ['--dir', b.dir, '--offhost', dest], { RETAIN_OFFHOST_HOURLY: '4', RETAIN_OFFHOST_DAILY: '3', RETAIN_OFFHOST_WEEKLY: '2' })
  assert.equal(r.code, 0, r.out)
  const kept = new Set(readdirSync(dest).filter(f => f.endsWith('.age.json') && f.startsWith('dazl-backup-2')).map(f => f.slice(0, -'.age.json'.length)))
  const all = [b.names[0], ...names].map(x => [x, nameTime(x)!] as const).sort((a, c) => c[1] - a[1])
  const expect = new Set(all.slice(0, 4).map(([x]) => x))
  const bucket = (f: (t: number) => string, k: number) => { const seen = new Set<string>(); for (const [x, t] of all) { const key = f(t); if (seen.has(key)) continue; seen.add(key); if (seen.size > k) break; expect.add(x) } }
  bucket(t => new Date(t).toISOString().slice(0, 10), 3)
  bucket(t => { const d = new Date(t); d.setUTCDate(d.getUTCDate() - (d.getUTCDay() + 6) % 7); return d.toISOString().slice(0, 10) }, 2)
  assert.deepEqual([...kept].sort(), [...expect].sort())
  assert.ok(kept.size >= 4 && kept.size <= 9, `kept ${kept.size}`)
  for (const f of ['dazl-config-20261101T000000Z-00000000.tar.age', 'other.age', 'dazl-backup-junk.db.age']) assert.ok(existsSync(path.join(dest, f)), `${f} untouched`)
  for (const x of kept) if (x !== b.names[0]) assert.ok(existsSync(path.join(dest, x + '.age')), 'a kept copy keeps its ciphertext')
  assert.equal(readdirSync(dest).filter(f => f.startsWith('dazl-backup-2') && f.endsWith('.age')).length, kept.size - 1, 'deleted copies lose both files')
})

test('an unlistable off-host destination refuses the whole run (local backups untouched too)', () => {
  const b = backups(4)
  for (const spec of [path.join(T, 'nowhere'), 'rclone:nocolon']) {
    const r = run('prune-backups.mts', ['--dir', b.dir, '--offhost', spec], { RETAIN_LOCAL: '1', RCLONE_BIN: path.join(T, 'no-rclone') })
    assert.equal(r.code, 1, r.out); assert.match(String(r.json.refused), /off-host destination unreadable/)
  }
  const r = run('prune-backups.mts', ['--dir', b.dir, '--offhost', 'rclone:remote:bucket'], { RETAIN_LOCAL: '1', RCLONE_BIN: path.join(T, 'no-rclone') })
  assert.equal(r.code, 1); assert.match(String(r.json.refused), /rclone not runnable/)
  assert.equal(readdirSync(b.dir).filter(f => f.endsWith('.db')).length, 4)
})

test('offhost helpers: only plain names, timestamps that round-trip', () => {
  for (const bad of ['', '.hidden', '../x', 'a/b', 'a\\b', 'x'.repeat(201), null, 5, {}, ['a']]) assert.equal(plainName(bad), false, JSON.stringify(bad))
  assert.equal(plainName('dazl-backup-20261103T010203Z-0a0b0c0d.db.age'), true)
  assert.equal(nameTime('dazl-backup-20261103T010203Z-x'), Date.UTC(2026, 10, 3, 1, 2, 3))
  for (const bad of ['dazl-backup-20261399T000000Z', 'dazl-backup-20260230T000000Z', 'dazl-backup-2026', 'other-20261103T010203Z']) assert.equal(nameTime(bad), null, bad)
  const d = openDest(path.join(T, 'helper')); mkdirSync(path.join(T, 'helper'))
  assert.throws(() => d.read('../etc/passwd'), /refused file name/); assert.throws(() => d.remove('..'), /refused file name/)
  assert.throws(() => openDest(''), /no off-host destination/); assert.throws(() => openDest('rclone:'), /REMOTE:PATH/)
})

// ---- send gate
function store(rows: { msg?: string[]; steps?: string[]; leaseExp?: number[] }) {
  const f = path.join(T, `s${++n}.db`), db = new Database(f)
  db.exec("CREATE TABLE outreach_messages (id TEXT, status TEXT); CREATE TABLE sequence_steps (id TEXT, status TEXT); CREATE TABLE app_leases (name TEXT, expires_at INTEGER); CREATE TABLE autopilot_settings (enabled INTEGER, paused INTEGER)")
  for (const s of rows.msg ?? []) db.prepare('INSERT INTO outreach_messages VALUES (?, ?)').run('m', s)
  for (const s of rows.steps ?? []) db.prepare('INSERT INTO sequence_steps VALUES (?, ?)').run('s', s)
  for (const e of rows.leaseExp ?? []) db.prepare('INSERT INTO app_leases VALUES (?, ?)').run('tick', e)
  db.close(); return f
}
test('send gate: clear only when nothing is sending or uncertain and every old lease has expired', () => {
  const now = Math.floor(Date.now() / 1000)
  let r = run('send-gate.mts', ['--db', store({ msg: ['sent', 'failed'], leaseExp: [now - 10] })])
  assert.equal(r.code, 0, r.out); assert.equal(r.json.sending_may_be_enabled, true); assert.deepEqual(r.json.blocked_by, [])
  r = run('send-gate.mts', ['--db', store({ msg: ['uncertain', 'sending'], steps: ['uncertain'], leaseExp: [now + 600] })])
  assert.equal(r.code, 1); assert.deepEqual(r.json.blocked_by, ['messages_sending', 'messages_uncertain', 'sequence_steps_unresolved', 'leases_unexpired'])
  assert.match(r.out, /keep AUTOPILOT_KILL=1/)
  // a store without the tables (an older schema) has nothing to reconcile
  const empty = path.join(T, 'empty.db'); new Database(empty).close()
  assert.equal(run('send-gate.mts', ['--db', empty]).code, 0)
})
test('send gate: a missing, unreadable or non-database file is never "clear" (exit 2); usage errors exit 2', () => {
  assert.equal(run('send-gate.mts', ['--db', path.join(T, 'nope.db')]).code, 2)
  const junk = path.join(T, 'junk.db'); writeFileSync(junk, 'not a database at all, just text'.repeat(40))
  const r = run('send-gate.mts', ['--db', junk]); assert.equal(r.code, 2, r.out); assert.match(r.out, /refusing to call it clear/)
  assert.equal(run('send-gate.mts', []).code, 2); assert.equal(run('send-gate.mts', ['--db', '--x']).code, 2)
})
test('send safety counts are shared by the drill and the gate', () => {
  const db = new Database(store({ msg: ['uncertain'] }), { readonly: true })
  try { const s = sendSafety(db); assert.equal(s.messages_uncertain, 1); assert.deepEqual(blockers(s), ['messages_uncertain']) } finally { db.close() }
})
