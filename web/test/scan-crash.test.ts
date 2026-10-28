// A scan run that crashes (an exception escapes runJob's own failure handling) is marked failed, not left 'running'
// for the stale-lease reaper, and recorded through the scrubbed error monitor, on both the legacy runner and the queue
// runner. The alert hook (OPS_ALERT_WEBHOOK_URL) is exercised with a stubbed fetch; nothing leaves the process.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import Database from 'better-sqlite3'
import { setErrorSinks, type ErrorRecord } from '../lib/ops/errors.ts'

const { kickRunner } = await import('../lib/scan/runner.ts')
const { kickQueueRunner } = await import('../lib/scan/queue-runner.ts')
const { failCrashedJob } = await import('../lib/scan/crash.ts')
const { migrateKeys, saveKey } = await import('../lib/llm/key-store.ts')
const { migrateScan, createJob, getJob } = await import('../lib/scan/store.ts')
const { SqliteQueue } = await import('../lib/queue/sqlite.ts')

const TA = '0123456789abcdef0123456789abcdef' // a users.id
const flush = async () => { for (let i = 0; i < 20; i++) await new Promise(r => setImmediate(r)) }

function capture(): { got: ErrorRecord[]; restore: () => void } {
  const got: ErrorRecord[] = []
  return { got, restore: setErrorSinks([r => got.push(r)]) }
}

test('legacy runner: a crashing scan job is marked failed (crashed) and an error record is written, with the alert hook called', async () => {
  const db = new Database(':memory:'); migrateScan(db); migrateKeys(db)
  const master = randomBytes(32); saveKey(db, TA, 'anthropic', 'sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', master)
  const id = createJob(db, TA, { business_name: 'Acme Roofing', industry: 'roofing', location: 'Toronto' })
  const providers = { anthropic: { research: async () => { throw new Error('provider must not be reached') } } } as never
  const { got, restore } = capture()
  const posted: string[] = []
  const realFetch = globalThis.fetch
  process.env.OPS_ALERT_WEBHOOK_URL = 'https://alerts.example.test/hook'
  globalThis.fetch = (async (_u: string, init: RequestInit) => { posted.push(String(init.body)); return new Response('ok') }) as typeof fetch
  try {
    // the job's clock throws before runJob's own try: the rejection escapes runJob, as a crash would
    await kickRunner(db, { providers, master, score: false, jobBudgetMs: 60_000, clock: () => { throw new Error('clock broke for jane.doe@example.com') } })
    await flush()
  } finally { restore(); globalThis.fetch = realFetch; delete process.env.OPS_ALERT_WEBHOOK_URL }
  const j = getJob(db, TA, id)!
  assert.deepEqual([j.status, j.error, j.claimed_at], ['failed', 'crashed', null])
  assert.equal(got.length, 1)
  assert.deepEqual([got[0].source, got[0].where, got[0].tenant, got[0].ref], ['worker', 'scan-runner', TA, id])
  assert.equal(got[0].error.message, 'clock broke for [email]')
  assert.equal(posted.length, 1)
  assert.equal(JSON.parse(posted[0]).fingerprint, got[0].fingerprint)
  assert.ok(!posted[0].includes('jane'))
  // the slot was released: the next job is claimed (its provider error then takes the normal retry path)
  const id2 = createJob(db, TA, { business_name: 'Acme Roofing', industry: 'roofing', location: 'Toronto' })
  const quiet = setErrorSinks([])
  try { await kickRunner(db, { providers, master, score: false }); await flush() } finally { quiet() }
  assert.equal((db.prepare('SELECT attempts FROM scan_jobs WHERE id = ?').get(id2) as { attempts: number }).attempts, 1)
  db.close()
})

test('queue runner: a crashing executor fails the domain row (crashed) and the queue item, and writes an error record', async () => {
  const db = new Database(':memory:')
  db.exec(`CREATE TABLE scan_jobs (id TEXT PRIMARY KEY, user_id TEXT, status TEXT, attempts INTEGER DEFAULT 0, created_at INTEGER,
    claimed_at INTEGER, error TEXT, finished_at INTEGER, business_name TEXT, industry TEXT, location TEXT, query TEXT, icp TEXT,
    sources TEXT, funded_by TEXT, watch_id TEXT, csv_domain TEXT);
    CREATE TABLE tenant_llm_keys (tenant_id TEXT, vendor TEXT, created_at INTEGER);`)
  const id = randomBytes(12).toString('hex')
  db.prepare("INSERT INTO scan_jobs (id, user_id, status, attempts, created_at, funded_by) VALUES (?, ?, 'pending', 0, ?, 'trial')").run(id, TA, Math.floor(Date.now() / 1000))
  const { got, restore } = capture()
  try {
    await kickQueueRunner(db, {}, async () => { throw new TypeError('executor exploded at 203.0.113.7') })
    await flush()
  } finally { restore() }
  const row = db.prepare('SELECT status, error, claimed_at, attempts FROM scan_jobs WHERE id = ?').get(id)
  assert.deepEqual(row, { status: 'failed', error: 'crashed', claimed_at: null, attempts: 1 })
  assert.equal(new SqliteQueue(db).get(id)!.status, 'failed') // not re-queued for another crash
  assert.equal(got.length, 1)
  assert.deepEqual([got[0].where, got[0].tenant, got[0].ref, got[0].error.name, got[0].error.message], ['queue-runner', TA, id, 'TypeError', 'executor exploded at [ip]'])
  db.close()
})

test('a crash from an attempt that no longer owns the row changes nothing (re-claimed, cancelled or finished)', () => {
  const db = new Database(':memory:'); migrateScan(db)
  const id = createJob(db, TA, { business_name: 'B', industry: 'i', location: 'l' })
  db.prepare("UPDATE scan_jobs SET status = 'running', attempts = 2 WHERE id = ?").run(id)
  const { got, restore } = capture()
  try {
    assert.equal(failCrashedJob(db, { id, user_id: TA, attempts: 1 }, new Error('late crash'), 'scan-runner'), false)
    db.prepare("UPDATE scan_jobs SET status = 'done' WHERE id = ?").run(id)
    assert.equal(failCrashedJob(db, { id, user_id: TA, attempts: 2 }, new Error('late crash'), 'scan-runner'), false)
  } finally { restore() }
  assert.equal(getJob(db, TA, id)!.status, 'done')
  assert.equal(got.length, 2) // still recorded
  db.close()
})

// Each case runs in its own process: process-level listeners are global.
function child(script: string): ReturnType<typeof spawnSync> {
  const env = { ...process.env }; delete env.NODE_TEST_CONTEXT
  return spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', '--import', './test/helpers/net-fence.ts', '--input-type=module', '-e', script],
    { cwd: fileURLToPath(new URL('../', import.meta.url)), env, encoding: 'utf8', timeout: 30000 })
}

test('unhandled rejections are recorded; the process keeps the behaviour it had (Next keeps serving, bare Node still exits)', () => {
  const body = `
    const { recordProcessErrors } = await import('./lib/ops/process-errors.ts')
    recordProcessErrors()
    Promise.reject(new Error('worker lost for jane@example.com'))
    await new Promise(r => setTimeout(r, 50))
    console.log('STILL_RUNNING')`
  const withNext = child(`process.on('unhandledRejection', () => {}) /* stands in for Next's listener */\n${body}`)
  assert.equal(withNext.status, 0, String(withNext.stderr))
  assert.match(String(withNext.stdout), /STILL_RUNNING/)
  const rec = String(withNext.stderr).split('\n').filter(l => l.startsWith('{')).map(l => JSON.parse(l))
  assert.equal(rec.length, 1)
  assert.deepEqual([rec[0].source, rec[0].where, rec[0].error.message], ['process', 'unhandledRejection', 'worker lost for [email]'])

  const bare = child(body)
  assert.notEqual(bare.status, 0, 'with no other listener the rejection still ends the process, as Node does by default')
  assert.doesNotMatch(String(bare.stdout), /STILL_RUNNING/)
  assert.match(String(bare.stderr), /"where":"unhandledRejection"/)
  assert.ok(!String(bare.stderr).includes('jane@example.com') || /Error: worker lost for jane@example.com/.test(String(bare.stderr)), 'the only raw copy is Node\'s own crash print')
})
