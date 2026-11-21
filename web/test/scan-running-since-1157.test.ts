// #1157 line 2 (Quest live finding, prod cc90b98c, run 8df272f3: "Searching... 0 min" for over a minute on a first scan).
// The page counted the running minutes from claimed_at, which is the scan's lease: it is renewed at every paid reserve and
// settle and at every phase boundary, so on a healthy scan it was always seconds old and the page read "0 min" for the
// whole run - a working scan looked stuck. The status now carries running_since (when the user started the scan, set once
// and never renewed; null unless the scan is running) and the page counts from it.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { bothEngines } from './helpers/engines.ts'
import { createJob } from '../lib/scan/store-db.ts'
import { readScanStatus } from '../lib/scan/status-read-service.ts'

test('#1157 through the real status route: running_since is when the scan started, not the renewed lease', () => {
  const web = fileURLToPath(new URL('../', import.meta.url))
  const env = { ...process.env, SITECRAWL_ENABLED: '0' } as NodeJS.ProcessEnv
  delete env.NODE_TEST_CONTEXT
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--import', './test/helpers/net-fence.ts', '--loader', './test/helpers/status-route-loader.mjs', '--test', './test/helpers/running-since-runtime.mts'], { cwd: web, env, encoding: 'utf8', timeout: 60000 })
  assert.equal(r.error, undefined)
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.match(r.stdout, /# pass 2/)
})

bothEngines('#1157 running_since: the start while running, never the renewed lease; null when not running', async ({ db }) => {
  const job = await createJob(db, 'A', { business_name: 'b', industry: 'manufacturing', location: 'Bangalore' }, '{}')
  await db.run('UPDATE scan_jobs SET created_at = 1000 WHERE id = ?', [job])
  assert.equal((await readScanStatus(db, 'A', job))?.running_since, null)   // pending: no running time
  await db.run("UPDATE scan_jobs SET status = 'running', claimed_at = 1001, attempts = 1 WHERE id = ?", [job])
  assert.equal((await readScanStatus(db, 'A', job))?.running_since, 1000)
  const ins = "INSERT INTO scan_spend_calls (id, user_id, scan_job_id, attempt, kind, reserve_usd, actual_usd, status, reason, created_at, settled_at) VALUES (?, ?, ?, ?, 'llm.anthropic', 0.08, 0.01, 'settled', NULL, ?, ?)"
  await db.run(ins, ['c1', 'A', job, 1, 1002, 1006])
  await db.run("UPDATE scan_jobs SET claimed_at = 1120 WHERE id = ?", [job])   // the lease renewed by a settle or a phase boundary
  assert.equal((await readScanStatus(db, 'A', job))?.running_since, 1000)
  await db.run("UPDATE scan_jobs SET claimed_at = 0 WHERE id = ?", [job])      // a parked row (claimed_at = 0) is never a start time
  assert.equal((await readScanStatus(db, 'A', job))?.running_since, 1000)
  await db.run("UPDATE scan_jobs SET status = 'pending', claimed_at = NULL WHERE id = ?", [job])   // reaped, waiting for a retry
  assert.equal((await readScanStatus(db, 'A', job))?.running_since, null)
  await db.run("UPDATE scan_jobs SET status = 'running', claimed_at = 1400, attempts = 2 WHERE id = ?", [job])
  assert.equal((await readScanStatus(db, 'A', job))?.running_since, 1000)   // the user has been waiting since they started it
  await db.run("UPDATE scan_jobs SET status = 'done', claimed_at = NULL, finished_at = 1500 WHERE id = ?", [job])
  assert.equal((await readScanStatus(db, 'A', job))?.running_since, null, 'done')
  const failed = await createJob(db, 'A', { business_name: 'b', industry: 'manufacturing', location: 'Bangalore' }, '{}')
  await db.run("UPDATE scan_jobs SET status = 'running', claimed_at = 2001, attempts = 1 WHERE id = ?", [failed])
  await db.run("UPDATE scan_jobs SET status = 'failed', error = 'accounting_uncertain', claimed_at = NULL, finished_at = 2200 WHERE id = ?", [failed])
  assert.equal((await readScanStatus(db, 'A', failed))?.running_since, null, 'failed')
  assert.equal(await readScanStatus(db, 'B', job), undefined)   // another tenant cannot read it
})

test('the running page counts its minutes from running_since, never from the lease (claimed_at)', () => {
  const page = readFileSync(new URL('../app/app/leads/leads-client.tsx', import.meta.url), 'utf8')
  assert.doesNotMatch(page, /setStartedAt\(s\.claimed_at/)
  assert.match(page, /setStartedAt\(typeof s\.running_since === 'number' \? s\.running_since : null\)/)
})
