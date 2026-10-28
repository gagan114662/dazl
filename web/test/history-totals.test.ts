import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { migrateScan, createJob } from '../lib/scan/store.ts'
import { historyJobs, historyTotals } from '../lib/scan/history-jobs.ts'
import { sqliteDb } from '../lib/db/client.ts'

// Instinct #288: Home needs complete evidence that a play was written and a scan finished; the history list is the
// newest 20 only. 20 recent failures + 1 older finished scan: the list misses it, the totals count it.
test('historyTotals counts all own searches and finished scans, beyond the newest-20 list; imports, fixtures and other tenants excluded', async () => {
  const raw = new Database(':memory:'); migrateScan(raw)
  const job = (tenant: string, created: number, status: 'done' | 'failed', o: { query?: string | null; csv?: string; fixture?: boolean } = {}) => {
    const id = createJob(raw, tenant, { business_name: 'x', industry: o.fixture ? 'test only' : 'test', location: o.fixture ? 'test only' : 'test' })
    raw.prepare("UPDATE scan_jobs SET status='running' WHERE id=?").run(id)
    raw.prepare('UPDATE scan_jobs SET status=?, error=?, created_at=?, query=?, csv_domain=? WHERE id=?').run(status, status === 'failed' ? 'upstream 502' : null, created, o.query === undefined ? 'Dentists in Ohio' : o.query, o.csv ?? null, id)
    return id
  }
  const older = job('A', 100, 'done')
  for (let k = 0; k < 20; k++) job('A', 200 + k, 'failed')
  job('A', 300, 'done', { query: null, csv: 'acme.com' }); job('A', 301, 'done', { fixture: true }); job('B', 302, 'done')
  const before = JSON.stringify(raw.prepare('SELECT * FROM scan_jobs ORDER BY id').all())
  const db = sqliteDb(raw)
  const list = await historyJobs(db, 'A')
  assert.equal(list.length, 20, 'the list is capped')
  assert.ok(!list.some(j => j.id === older), 'the older finished scan is not in it')
  assert.deepEqual(await historyTotals(db, 'A'), { searches: 21, finished: 1 })
  assert.deepEqual(await historyTotals(db, 'C'), { searches: 0, finished: 0 })
  assert.equal(JSON.stringify(raw.prepare('SELECT * FROM scan_jobs ORDER BY id').all()), before, 'read-only')
})
