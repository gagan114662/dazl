// #1157 line 2 (Quest live finding, prod cc90b98c, run 8df272f3: "Searching... 0 min" for over a minute on a first scan).
// The page counted the running minutes from claimed_at, which is the scan's lease: it is renewed at every paid reserve and
// settle and at every phase boundary, so on a healthy scan it was always seconds old and the page read "0 min" for the
// whole run - a working scan looked stuck. The status now carries running_since (the scan's first recorded provider call,
// else its claim) and the page counts from it.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { bothEngines } from './helpers/engines.ts'
import { createJob } from '../lib/scan/store-db.ts'
import { readScanStatus } from '../lib/scan/status-read-service.ts'

test('through the real status route: running_since is the first call, not the renewed lease', () => {
  const web = fileURLToPath(new URL('../', import.meta.url))
  const env = { ...process.env, SITECRAWL_ENABLED: '0' } as NodeJS.ProcessEnv
  delete env.NODE_TEST_CONTEXT
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--import', './test/helpers/net-fence.ts', '--loader', './test/helpers/status-route-loader.mjs', '--test', './test/helpers/running-since-runtime.mts'], { cwd: web, env, encoding: 'utf8', timeout: 60000 })
  assert.equal(r.error, undefined)
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.match(r.stdout, /# pass 2/)
})

bothEngines('running_since: owner-scoped first call of any attempt; a retry keeps the scan\'s start; claim before any call', async ({ db }) => {
  const job = await createJob(db, 'A', { business_name: 'b', industry: 'manufacturing', location: 'Bangalore' }, '{}')
  assert.equal((await readScanStatus(db, 'A', job))?.running_since, null)
  await db.run("UPDATE scan_jobs SET status = 'running', claimed_at = 1000, attempts = 1 WHERE id = ?", [job])
  assert.equal((await readScanStatus(db, 'A', job))?.running_since, 1000)
  const ins = "INSERT INTO scan_spend_calls (id, user_id, scan_job_id, attempt, kind, reserve_usd, actual_usd, status, reason, created_at, settled_at) VALUES (?, ?, ?, ?, 'llm.anthropic', 0.08, 0.01, 'settled', NULL, ?, ?)"
  await db.run(ins, ['c1', 'A', job, 1, 1002, 1006])
  await db.run(ins, ['c2', 'A', job, 1, 1010, 1020])
  await db.run("UPDATE scan_jobs SET claimed_at = 1020 WHERE id = ?", [job])   // the lease renewed by the settle: the scan started with its first call
  assert.equal((await readScanStatus(db, 'A', job))?.running_since, 1002)
  // attempt 2 after a lost process: the user has been waiting since the first attempt began
  await db.run("UPDATE scan_jobs SET claimed_at = 1300, attempts = 2 WHERE id = ?", [job])
  await db.run(ins, ['c3', 'A', job, 2, 1301, 1305])
  assert.equal((await readScanStatus(db, 'A', job))?.running_since, 1002)
  // another tenant's rows on the same job id are never read
  await db.run(ins, ['x1', 'B', job, 1, 500, 501])
  assert.equal((await readScanStatus(db, 'A', job))?.running_since, 1002)
})

test('the running page counts its minutes from running_since, never from the lease (claimed_at)', () => {
  const page = readFileSync(new URL('../app/app/leads/leads-client.tsx', import.meta.url), 'utf8')
  assert.doesNotMatch(page, /setStartedAt\(s\.claimed_at/)
  assert.match(page, /setStartedAt\(typeof s\.running_since === 'number' \? s\.running_since : null\)/)
})
