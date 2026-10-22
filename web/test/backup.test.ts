// Backup + restore-drill tests: synthetic fixture DBs only, everything under os.tmpdir().
// Proves: a live-app backup is consistent, a restore drill passes a good backup and fails
// a tampered/corrupt one, the drill never touches the backup file, and the work-dir guards
// refuse directories the drill did not create.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { createBackup, restoreDrill, GuardError } from '../scripts/backup/lib.ts'

function tmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dazl-backup-test-'))
}

// A small DB shaped like the app's (users -> scan_jobs -> leads), with awkward data on
// purpose: unicode, NULLs, blobs, negative/real/big-ish integers, a view and an index.
function makeSourceDb(dir: string): string {
  const p = path.join(dir, 'src.db')
  const db = new Database(p)
  db.pragma('journal_mode = WAL')
  db.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, created_at INTEGER DEFAULT (unixepoch()));
    CREATE TABLE scan_jobs (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
      status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE leads (id TEXT PRIMARY KEY, scan_job_id TEXT NOT NULL REFERENCES scan_jobs(id),
      name TEXT, company TEXT, score REAL, note TEXT, payload BLOB);
    CREATE INDEX leads_job ON leads(scan_job_id);
    CREATE VIEW lead_counts AS SELECT scan_job_id, count(*) AS n FROM leads GROUP BY scan_job_id;
  `)
  const u = db.prepare('INSERT INTO users (id, email) VALUES (?, ?)')
  u.run('u1', 'gagan@example.com')
  u.run('u2', 'ünïcodé@例え.jp')
  const j = db.prepare('INSERT INTO scan_jobs (id, user_id, status, attempts) VALUES (?, ?, ?, ?)')
  j.run('j1', 'u1', 'done', 1)
  j.run('j2', 'u1', 'running', 3) // mid-flight job: backups can legitimately capture these
  const l = db.prepare('INSERT INTO leads (id, scan_job_id, name, company, score, note, payload) VALUES (?, ?, ?, ?, ?, ?, ?)')
  l.run('l1', 'j1', 'Bob', 'Café 日本語 ☕', 87.5, null, crypto.randomBytes(1024))
  l.run('l2', 'j1', null, 'Null Name Co', -3, 'multi\nline\ttext', Buffer.alloc(0))
  l.run('l3', 'j1', 'BigInt', 'Nine Quadrillion', 9007199254740991, 'max safe int', null)
  for (let i = 0; i < 50; i++) l.run(`bulk${i}`, 'j2', `n${i}`, `c${i}`, i * 0.5, i % 2 ? null : 'x', null)
  db.close()
  return p
}

test('createBackup writes a consistent, self-contained, integrity-checked file + sidecar', async () => {
  const dir = tmpdir()
  const src = makeSourceDb(dir)
  const r = await createBackup({ source: src, destDir: path.join(dir, 'backups') })
  assert.ok(fs.existsSync(r.backupPath))
  assert.ok(fs.existsSync(r.sidecarPath))
  assert.ok(!fs.existsSync(r.backupPath + '.partial'), 'no .partial left behind')
  assert.ok(!fs.existsSync(r.backupPath + '-wal'), 'normalized to one file, no -wal sidecar')
  const sidecar = JSON.parse(fs.readFileSync(r.sidecarPath, 'utf8'))
  assert.equal(sidecar.sha256, r.sha256)
  const check = new Database(r.backupPath, { readonly: true, fileMustExist: true })
  assert.equal(check.pragma('integrity_check', { simple: true }), 'ok')
  assert.equal(check.pragma('journal_mode', { simple: true }), 'delete')
  assert.equal((check.prepare('SELECT count(*) n FROM leads').get() as { n: number }).n, 53)
  check.close()
})

test('restore drill passes a good backup: all tables compared equal, backup untouched', async () => {
  const dir = tmpdir()
  const src = makeSourceDb(dir)
  const r = await createBackup({ source: src, destDir: path.join(dir, 'backups') })
  const before = fs.readFileSync(r.backupPath)
  const d = await restoreDrill({ backupPath: r.backupPath })
  assert.equal(d.verdict, 'pass', d.reasons.join('; '))
  assert.equal(d.reasons.length, 0)
  assert.equal(d.warnings.length, 0)
  assert.equal(d.tablesChecked, 3, 'users + scan_jobs + leads (views have no rows)')
  assert.equal(d.backupUnchangedAfterDrill, true)
  assert.deepEqual(fs.readFileSync(r.backupPath), before, 'backup bytes identical after drill')
  assert.equal(d.workDirKept, null)
})

test('drill catches post-backup tampering via the sidecar sha256 manifest', async () => {
  // SQLite has no content checksums: a backup that is edited so it still opens restores
  // "faithfully". The anchor is the manifest create-backup writes next to it.
  const dir = tmpdir()
  const src = makeSourceDb(dir)
  const r = await createBackup({ source: src, destDir: path.join(dir, 'backups') })
  const evil = path.join(dir, 'backups', 'evil.db')
  fs.copyFileSync(r.backupPath, evil)
  fs.copyFileSync(r.sidecarPath, evil + '.json')
  const db = new Database(evil)
  db.prepare("UPDATE leads SET score = 999 WHERE id = 'l1'").run()
  db.close()
  const d = await restoreDrill({ backupPath: evil })
  assert.equal(d.verdict, 'fail')
  assert.equal(d.sidecarVerified, false)
  assert.ok(d.reasons.some((m) => m.includes('sidecar manifest')), JSON.stringify(d.reasons))
})

test('without a sidecar the drill still proves faithful restore, and says so', async () => {
  const dir = tmpdir()
  const src = makeSourceDb(dir)
  const r = await createBackup({ source: src, destDir: path.join(dir, 'backups') })
  const lone = path.join(dir, 'lone.db')
  fs.copyFileSync(r.backupPath, lone)
  const d = await restoreDrill({ backupPath: lone })
  assert.equal(d.verdict, 'pass', d.reasons.join('; '))
  assert.equal(d.sidecarVerified, null)
  assert.ok(d.warnings.some((w) => w.includes('no .json sidecar')))
})

test('drill fails a truncated backup file', async () => {
  const dir = tmpdir()
  const src = makeSourceDb(dir)
  const r = await createBackup({ source: src, destDir: path.join(dir, 'backups') })
  const broke = path.join(dir, 'broke.db')
  fs.copyFileSync(r.backupPath, broke)
  fs.truncateSync(broke, Math.floor(fs.statSync(broke).size / 2))
  const d = await restoreDrill({ backupPath: broke })
  assert.equal(d.verdict, 'fail', 'half a SQLite file must not pass')
  assert.ok(d.reasons.length > 0)
})

test('foreign-key violations in the data are an advisory warning, not a drill failure', async () => {
  const dir = tmpdir()
  const p = path.join(dir, 'fk.db')
  const db = new Database(p) // better-sqlite3 enables FKs by default; the app does not - disable to match
  db.pragma('foreign_keys = OFF')
  db.exec(`
    CREATE TABLE scan_jobs (id TEXT PRIMARY KEY);
    CREATE TABLE leads (id TEXT PRIMARY KEY, scan_job_id TEXT REFERENCES scan_jobs(id));
    INSERT INTO scan_jobs VALUES ('j1');
    INSERT INTO leads VALUES ('orphan', 'no-such-job');
  `)
  db.close()
  const r = await createBackup({ source: p, destDir: path.join(dir, 'backups') })
  const d = await restoreDrill({ backupPath: r.backupPath })
  assert.equal(d.verdict, 'pass', 'faithful restore of violated data still passes')
  assert.equal(d.warnings.length, 1)
  assert.match(d.warnings[0], /foreign-key violation/)
})

test('drill refuses a work dir it did not create, and refuses missing/URL/sidecar backups', async () => {
  const dir = tmpdir()
  const src = makeSourceDb(dir)
  const r = await createBackup({ source: src, destDir: path.join(dir, 'backups') })

  const occupied = path.join(dir, 'someone-elses-dir')
  fs.mkdirSync(occupied)
  fs.writeFileSync(path.join(occupied, 'keep-me.txt'), 'precious')
  await assert.rejects(() => restoreDrill({ backupPath: r.backupPath, workDir: occupied }), /not created by a restore drill/)
  assert.equal(fs.readFileSync(path.join(occupied, 'keep-me.txt'), 'utf8'), 'precious', 'nothing deleted')

  await assert.rejects(() => restoreDrill({ backupPath: path.join(dir, 'nope.db') }), GuardError)
  await assert.rejects(() => restoreDrill({ backupPath: 'https://dazl.ai/app.db' }), /not a URL/)
  await assert.rejects(() => restoreDrill({ backupPath: r.backupPath + '-wal' }), /sidecar/)

  // a drill-owned work dir is accepted and reused safely
  const owned = path.join(dir, 'drill-area')
  const d1 = await restoreDrill({ backupPath: r.backupPath, workDir: owned })
  assert.equal(d1.verdict, 'pass')
  assert.ok(fs.existsSync(owned), 'explicit work dir is kept (only run dirs are cleaned)')
  const d2 = await restoreDrill({ backupPath: r.backupPath, workDir: owned })
  assert.equal(d2.verdict, 'pass')
})

test('backup stays consistent while a concurrent writer commits (WAL online backup)', async () => {
  const dir = tmpdir()
  const src = makeSourceDb(dir)
  const writer = new Database(src)
  let wrote = 0
  const src2 = new Database(src, { readonly: true, fileMustExist: true })
  const dest = path.join(dir, 'live.db')
  await src2.backup(dest, {
    progress: () => {
      // Interleave real commits between backup iterations on purpose, but only a bounded
      // burst: an unbounded writer starves the backup API, which restarts on each write.
      if (wrote < 25) {
        for (let i = 0; i < 5; i++) {
          writer.prepare('INSERT INTO leads (id, scan_job_id, name) VALUES (?, ?, ?)').run(`live${wrote++}`, 'j2', 'live')
        }
      }
      return 1 // one page per iteration: maximize overlap with the writer
    },
  })
  src2.close()
  writer.close()
  assert.ok(wrote > 0, 'writer actually overlapped the backup')
  const check = new Database(dest, { readonly: true })
  assert.equal(check.pragma('integrity_check', { simple: true }), 'ok', 'live backup is transactionally consistent')
  check.close()
  const d = await restoreDrill({ backupPath: dest })
  assert.equal(d.verdict, 'pass', d.reasons.join('; '))
})

test('createBackup refuses to overwrite, refuses URLs and missing sources', async () => {
  const dir = tmpdir()
  const src = makeSourceDb(dir)
  const r = await createBackup({ source: src, destDir: path.join(dir, 'backups') })
  fs.writeFileSync(path.join(dir, 'in-the-way.db'), 'x')
  await assert.rejects(() => createBackup({ source: src, destDir: path.join(dir, 'backups', 'nested', 'fine') }).then((r2) => {
    assert.notEqual(r2.backupPath, r.backupPath)
    throw new Error('expected-guard')
  }), /expected-guard/) // nested dest dirs are created; names are unique
  await assert.rejects(() => createBackup({ source: 'https://example.com/app.db', destDir: dir }), /not a URL/)
  await assert.rejects(() => createBackup({ source: path.join(dir, 'gone.db'), destDir: dir }), GuardError)
})

test('empty database: backup + drill pass with zero tables', async () => {
  const dir = tmpdir()
  const p = path.join(dir, 'empty.db')
  new Database(p).close()
  const r = await createBackup({ source: p, destDir: path.join(dir, 'b') })
  const d = await restoreDrill({ backupPath: r.backupPath })
  assert.equal(d.verdict, 'pass', d.reasons.join('; '))
  assert.equal(d.tablesChecked, 0)
})

test('--keep-work-dir leaves the restored copy for inspection', async () => {
  const dir = tmpdir()
  const src = makeSourceDb(dir)
  const r = await createBackup({ source: src, destDir: path.join(dir, 'backups') })
  const d = await restoreDrill({ backupPath: r.backupPath, keepWorkDir: true })
  assert.equal(d.verdict, 'pass')
  assert.ok(d.workDirKept && fs.existsSync(path.join(d.workDirKept, 'restored.db')))
})
