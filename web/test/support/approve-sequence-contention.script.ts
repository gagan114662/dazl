// Isolated regression for IMM2's approve().immediate() nested inside approveSequence's deferred outer txn.
import { createRequire } from 'node:module'
// Repo web dir: set DAZL_REPO_WEB or run from <repo>/web. Requires the candidate approve() (IMM2) on disk.
const WEB = process.env.DAZL_REPO_WEB ?? process.cwd()
const Database = createRequire(WEB + '/package.json')('better-sqlite3') as typeof import('better-sqlite3')
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fork } from 'node:child_process'
const { migrateScan, createJob } = await import(WEB + '/lib/scan/store.ts')
const { migrateOutreach } = await import(WEB + '/lib/outreach/store.ts')
const { migrateAutopilot } = await import(WEB + '/lib/outreach/autopilot.ts')
const { migrateLedger } = await import(WEB + '/lib/outreach/ledger.ts')
const { migrateReplies, acceptReadConsent } = await import(WEB + '/lib/outreach/replies.ts')
const { migrateSequences, createSequence, approveSequence } = await import(WEB + '/lib/outreach/sequences.ts')
const { approve, saveSettings } = await import(WEB + '/lib/outreach/service.ts')

if (process.argv[2] === 'hold') {
  const db = new Database(process.argv[3]); db.pragma('journal_mode = WAL')
  db.prepare('BEGIN IMMEDIATE').run(); db.prepare('CREATE TABLE IF NOT EXISTS holdmark (v INTEGER)').run()
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(process.argv[4]))
  db.prepare('COMMIT').run(); process.exit(0)
}

const NOW = 1800000000
function setup(path: string, timeout?: number) {
  const db = new Database(path, timeout === undefined ? {} : { timeout })
  db.pragma('journal_mode = WAL')
  migrateScan(db); migrateOutreach(db); migrateAutopilot(db); migrateLedger(db); migrateReplies(db); migrateSequences(db)
  db.prepare("INSERT INTO gmail_accounts (tenant_id, email, refresh_ct, status, read_granted) VALUES ('A','bench@example.invalid','not-a-credential','active',1)").run()
  saveSettings(db, 'A', { sender_name: 'Pat', postal_address: '1 King St W, Toronto ON M5H 1A1' })
  acceptReadConsent(db, 'A')
  const job = createJob(db, 'A', { business_name: 'Acme', industry: 'x', location: 'y' })
  db.prepare("UPDATE scan_jobs SET status = 'running' WHERE id = ?").run(job)
  db.prepare('INSERT INTO leads (id,scan_job_id,company,contact,signal,source_url,evidence_excerpt,confidence,human_confirmed_at,human_confirmed_from) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run('L1', job, 'Acme', 'lead@acme.example', 'Hiring roofers', 'https://acme.example/jobs', 'Hiring roofers', 90, NOW, 'test_review')
  db.prepare("INSERT INTO outreach_messages (id,tenant_id,lead_id,to_email,subject,body) VALUES ('M1','A','L1','lead@acme.example','A quick question','This is a draft message for review.')").run()
  const seq = createSequence(db, 'A', 'M1')
  return { db, seq }
}
const counts = (db: import('better-sqlite3').Database) => ({
  msg: db.prepare("SELECT status, approved_hash IS NOT NULL AS hashed FROM outreach_messages WHERE id='M1'").get(),
  steps: db.prepare('SELECT status, count(*) n FROM sequence_steps GROUP BY status').all(),
  seq: db.prepare('SELECT status FROM sequences').get(),
  ctx: (db.prepare("SELECT count(*) n FROM outreach_signal_context WHERE message_id='M1'").get() as { n: number }).n,
})

const dir = mkdtempSync(join(tmpdir(), 'nested-')), path = join(dir, 't.db')

// 1. nested happy path
{
  const { db, seq } = setup(path)
  approveSequence(db, 'A', seq, (id: string) => approve(db, 'A', id, true), NOW)
  console.log('1 happy:', JSON.stringify(counts(db)))
  db.close()
}
rmSync(path); rmSync(path + '-wal', { force: true }); rmSync(path + '-shm', { force: true })

// 2. inner throw (gmail row deleted -> approve precheck throws) rolls back the outer txn atomically
{
  const { db, seq } = setup(path)
  db.prepare('DELETE FROM outreach_settings').run()  // approve-only precheck: throws sender_identity_missing INSIDE the outer txn
  let threw = ''
  try { approveSequence(db, 'A', seq, (id: string) => approve(db, 'A', id, true), NOW) } catch (e) { threw = (e as { code?: string }).code ?? String(e) }
  console.log('2 rollback:', JSON.stringify({ threw, ...counts(db) }))
  db.close()
}
rmSync(path); rmSync(path + '-wal', { force: true }); rmSync(path + '-shm', { force: true })

// 3. contention, timeout 0: outer deferred txn's first write under a held lock
{
  const { db, seq } = setup(path, 0)
  const other = new Database(path, { timeout: 0 }); other.exec('BEGIN IMMEDIATE'); other.exec('CREATE TABLE IF NOT EXISTS x (v INTEGER)')
  let threw = '', cls = ''
  try { approveSequence(db, 'A', seq, (id: string) => approve(db, 'A', id, true), NOW) } catch (e) { threw = (e as { code?: string }).code ?? ''; cls = (e as Error).constructor.name }
  other.exec('ROLLBACK'); other.close()
  console.log('3 busy-timeout0:', JSON.stringify({ threw, cls, ...counts(db) }))
  // lock gone: retry succeeds
  approveSequence(db, 'A', seq, (id: string) => approve(db, 'A', id, true), NOW)
  console.log('3 retry-after-release:', JSON.stringify(counts(db)))
  db.close()
}
rmSync(path); rmSync(path + '-wal', { force: true }); rmSync(path + '-shm', { force: true })

// 4. contention, default timeout vs 1.5s child-process hold: does the deferred write-first txn wait?
{
  const { db, seq } = setup(path)
  const child = fork(process.argv[1], ['hold', path, '1500'], { stdio: 'ignore' })
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 600)
  const t0 = Date.now()
  let outcome = 'ok'
  try { approveSequence(db, 'A', seq, (id: string) => approve(db, 'A', id, true), NOW) } catch (e) { outcome = (e as { code?: string }).code ?? String(e) }
  console.log('4 wait-then-acquire:', JSON.stringify({ outcome, elapsed_ms: Date.now() - t0, ...counts(db) }))
  await new Promise(r => child.on('exit', r))
  db.close()
}
rmSync(dir, { recursive: true, force: true })
