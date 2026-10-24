import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { migrateScan, createJob } from '../lib/scan/store.ts'
import { migrateOutreach } from '../lib/outreach/store.ts'
import { migrateMemory, saveMemory } from '../lib/memory.ts'
import { createDraft, OutreachError } from '../lib/outreach/service.ts'

// TEST-ONLY fixture, temp file DB. Proves createDraft only reports already_drafted for the real duplicate.
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'cd-err-'))
  const path = join(dir, 't.db')
  const db = new Database(path, { timeout: 0 })
  db.pragma('journal_mode = WAL')
  migrateScan(db); migrateOutreach(db); migrateMemory(db)
  saveMemory(db, 'A', { positioning: 'Synthetic fixture offer for wiring checks.' })
  const job = createJob(db, 'A', { business_name: 'Seller', industry: 'x', location: 'y' })
  db.prepare("UPDATE scan_jobs SET status = 'running' WHERE id = ?").run(job)
  db.prepare('INSERT INTO leads (id,scan_job_id,company,contact,signal,source_url,evidence_excerpt,confidence,score,human_confirmed_at,human_confirmed_from) VALUES (?,?,?,?,?,?,?,?,?,1800000000,?)')
    .run('L1', job, 'Acme Test Co', 'owner@acmetestco.example', 'Acme Test Co is hiring', 'https://news.example.test/a', 'Acme Test Co is hiring', 90, 80, 'test_review')
  return { db, path, done: () => { db.close(); rmSync(dir, { recursive: true, force: true }) } }
}

test('a real duplicate is still reported as already_drafted', () => {
  const f = fixture()
  createDraft(f.db, 'A', 'L1', 'Seller')
  assert.throws(() => createDraft(f.db, 'A', 'L1', 'Seller'), (e: unknown) => e instanceof OutreachError && e.code === 'already_drafted')
  assert.equal((f.db.prepare('SELECT count(*) n FROM outreach_messages').get() as { n: number }).n, 1)
  f.done()
})

test('a locked database is not reported as already_drafted and leaves no row', () => {
  const f = fixture()
  const other = new Database(f.path, { timeout: 0 })
  other.exec('BEGIN IMMEDIATE')
  try {
    assert.throws(() => createDraft(f.db, 'A', 'L1', 'Seller'), (e: unknown) => !(e instanceof OutreachError) && /SQLITE_BUSY/.test(String((e as { code?: string }).code)))
  } finally { other.exec('ROLLBACK'); other.close() }
  assert.equal((f.db.prepare('SELECT count(*) n FROM outreach_messages').get() as { n: number }).n, 0)
  // after the lock is gone the same call succeeds
  assert.ok(createDraft(f.db, 'A', 'L1', 'Seller'))
  f.done()
})
