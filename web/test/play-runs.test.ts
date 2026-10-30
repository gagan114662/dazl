// #351: the Plays page reaches every run of a saved play, not only the last: each run's date, status, lead counts and
// a link to that run's own leads. Tenant-scoped on both engines; synthetic rows only.
import assert from 'node:assert/strict'
import { bothEngines } from './helpers/engines.ts'
import { createWatch } from '../lib/watch.ts'
import { createMonitor } from '../lib/monitors.ts'
import { playRuns } from '../lib/play-runs.ts'
import type { Db } from '../lib/db/client.ts'

const A = 'a'.repeat(32), B = 'b'.repeat(32)
const NOW = 1_800_000_000, DAY = 86400
let n = 0
const id24 = () => (++n).toString(16).padStart(24, '0')
async function job(db: Db, user: string, at: number, status: string, watchId: string | null, leads: { new?: boolean }[]) {
  const id = id24()
  await db.run("INSERT INTO scan_jobs (id, user_id, business_name, industry, location, query, status, created_at, watch_id) VALUES (?, ?, 'x', '(from request)', '-', 'q', 'running', ?, ?)", [id, user, at, watchId])
  for (const l of leads) await db.run("INSERT INTO leads (id, scan_job_id, company, signal, source_url, watch_new) VALUES (?, ?, 'Co', 'hiring', 'https://n.example/a', ?)", [id24(), id, l.new ? 1 : 0])
  await db.run('UPDATE scan_jobs SET status = ? WHERE id = ?', [status, id])
  return id
}

bothEngines('#351 a weekly play lists all its runs, newest first, with leads and new leads; only its own', async ({ db }) => {
  const w = (await createWatch(db, A, 'Dental practices hiring front desk', '{"summary":"s"}', null, NOW)).watch!
  const j1 = await job(db, A, NOW + 7 * DAY, 'done', w.id, [{ new: true }, {}])
  const j2 = await job(db, A, NOW + 14 * DAY, 'done', w.id, [{ new: true }, { new: true }, {}])
  const j3 = await job(db, A, NOW + 21 * DAY, 'failed', w.id, [])
  await job(db, A, NOW + 22 * DAY, 'done', null, [{}]) // a one-off search: not this play's run
  assert.deepEqual(await playRuns(db, A, 'watch', w.id), [
    { job_id: j3, at: NOW + 21 * DAY, status: 'failed', leads: 0, new_leads: 0 },
    { job_id: j2, at: NOW + 14 * DAY, status: 'done', leads: 3, new_leads: 2 },
    { job_id: j1, at: NOW + 7 * DAY, status: 'done', leads: 2, new_leads: 1 },
  ])
  assert.equal(await playRuns(db, B, 'watch', w.id), null, 'another account: not found')
  assert.equal(await playRuns(db, A, 'monitor', w.id), null, 'wrong kind: not found')
})

bothEngines('#351 a scheduled monitor lists its runs from its run log; another account cannot read them', async ({ db }) => {
  const m = await createMonitor(db, A, { query: 'Plumbers in Leeds' }, NOW)
  assert.ok('id' in m)
  const jobs: string[] = []
  for (const [i, nw] of [[1, 2], [2, 0]] as const) {
    const j = await job(db, A, NOW + i * DAY, 'done', null, [{}, {}])
    await db.run('INSERT INTO monitor_runs (id, monitor_id, job_id, ran_at, new_count) VALUES (?, ?, ?, ?, ?)', [id24(), m.id, j, NOW + i * DAY, nw])
    jobs.push(j)
  }
  assert.deepEqual((await playRuns(db, A, 'monitor', m.id))!.map(r => [r.job_id, r.leads, r.new_leads]), [[jobs[1], 2, 0], [jobs[0], 2, 2]])
  assert.equal(await playRuns(db, B, 'monitor', m.id), null)
  // A play with no runs yet: an empty list, not "not found".
  const w = (await createWatch(db, A, 'Roofers in Ohio', '{"summary":"s"}', null, NOW)).watch!
  assert.deepEqual(await playRuns(db, A, 'watch', w.id), [])
})
