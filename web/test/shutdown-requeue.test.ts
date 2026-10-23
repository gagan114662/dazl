import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import Database from 'better-sqlite3'

const { claimKeyedJob, runJob, kickRunner, requeueInFlightForShutdown, trackInFlight } = await import('../lib/scan/runner.ts')
const { migrateKeys, saveKey } = await import('../lib/llm/key-store.ts')
const { migrateScan, createJob, getJob, listLeads } = await import('../lib/scan/store.ts')

const KA = 'sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
const QUOTE = 'Northside Builders announced it is hiring three roofing crews for the Toronto market'
const cand = JSON.stringify([{ name: 'Pat', company: 'Northside Builders', contact: null, signal: 'Hiring', source_url: 'https://a.com', score: 80, excerpt: QUOTE, event_date: '2026-10-01' }])
const flush = async () => { for (let i = 0; i < 20; i++) await new Promise(r => setImmediate(r)) }
const wrap = (research: () => Promise<{ text: string; citedUrls: string[] }>) => ({ anthropic: { research }, openai: { research } }) as never
function rig() {
  const db = new Database(':memory:'); migrateScan(db); migrateKeys(db)
  const master = randomBytes(32); saveKey(db, 'A', 'anthropic', KA, master)
  return { db, master, id: createJob(db, 'A', { business_name: 'Acme Roofing', industry: 'roofing', location: 'Toronto' }) }
}

test('requeue returns an in-flight scan to pending, the next claim takes it at once, and the OLD attempt can no longer write or start work', async () => {
  const { db, master, id } = rig()
  let release!: (v: { text: string; citedUrls: string[] }) => void
  let calls = 0
  const providers = wrap(() => { calls++; return new Promise(r => { release = r }) })
  await kickRunner(db, { providers, master, score: false })
  await flush()
  assert.equal(getJob(db, 'A', id)!.status, 'running'); assert.equal(calls, 1)
  assert.equal(requeueInFlightForShutdown(db), 1)
  const j = getJob(db, 'A', id)!
  assert.equal(j.status, 'pending'); assert.equal(j.claimed_at, null); assert.equal(j.attempts, 1, 'attempts counter kept, so MAX_ATTEMPTS still bounds retries')
  const next = claimKeyedJob(db)!   // the new process: claimed immediately, no 20 min wait
  assert.equal(next.id, id); assert.equal(next.attempts, 2)
  release({ text: cand, citedUrls: ['https://a.com'] }) // the old attempt's provider call returns late
  await flush()
  assert.equal(calls, 1, 'old attempt started no new provider work')
  assert.equal(listLeads(db, 'A', id).length, 0, 'old attempt wrote nothing')
  assert.equal(getJob(db, 'A', id)!.status, 'running'); assert.equal(getJob(db, 'A', id)!.attempts, 2)
})

test('requeue is a no-op for rows it does not own: finished, re-claimed, or at MAX_ATTEMPTS', () => {
  const { db, id } = rig()
  const job = claimKeyedJob(db)!
  const done = trackInFlight(job)
  db.prepare("UPDATE scan_jobs SET attempts=2 WHERE id=?").run(id) // reaped and re-claimed elsewhere
  assert.equal(requeueInFlightForShutdown(db), 0); assert.equal(getJob(db, 'A', id)!.status, 'running')
  db.prepare("UPDATE scan_jobs SET status='done', finished_at=1 WHERE id=?").run(id)
  assert.equal(requeueInFlightForShutdown(db), 0); assert.equal(getJob(db, 'A', id)!.status, 'done')
  done()
  assert.equal(requeueInFlightForShutdown(db), 0)
})

test('REAL SIGTERM -> process.exit: the exit hook requeues only this process\'s own running attempts', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'shut-')); const dbPath = join(dir, 'app.db')
  const child = spawn(process.execPath, ['--experimental-strip-types', join(import.meta.dirname, 'helpers/shutdown-child.ts')], { env: { ...process.env, DB_PATH: dbPath, SCAN_MASTER_KEY: '', NODE_ENV: 'test' }, stdio: ['ignore', 'pipe', 'pipe'] })
  let out = '', err = ''
  child.stdout.on('data', d => { out += d }); child.stderr.on('data', d => { err += d })
  await new Promise<void>((res, rej) => { const t = setInterval(() => { if (out.includes('READY')) { clearInterval(t); res() } else if (child.exitCode !== null) { clearInterval(t); rej(new Error('child exited: ' + err)) } }, 50) })
  assert.match(out, /LISTENERS_DELTA=0/, 'we add no SIGTERM listener, so default/Next termination behaviour is never swallowed')
  child.kill('SIGTERM')
  await new Promise(r => child.on('exit', r))
  const db = new Database(dbPath, { readonly: true })
  const row = (id: string) => db.prepare('SELECT status, attempts, claimed_at FROM scan_jobs WHERE id=?').get(id) as { status: string; attempts: number; claimed_at: number | null }
  assert.deepEqual(row('own-job'), { status: 'pending', attempts: 1, claimed_at: null })
  assert.equal(row('other-job').status, 'running', 'untracked row (another process) untouched')
  assert.equal(row('reclaimed-job').status, 'running', 'row re-claimed at a higher attempt untouched')
  assert.equal(row('maxed-job').status, 'running', 'attempt at MAX_ATTEMPTS left to the lease reaper (no free extra retry)')
  db.close()
})
