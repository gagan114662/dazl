import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { NextRequest } from 'next/server'
import { setScanDb, setUser } from './tenant-route-db.ts'
import { migrateScan, createQueryJob } from '../../lib/scan/store.ts'
import { migrateKeys } from '../../lib/llm/key-store.ts'
import { GET as statusGET } from '../../app/api/scan/status/route.ts'

// Isolated in-memory fixture, two tenants, real route handler, no network. Not live data.
const fetchCalls: string[] = []
globalThis.fetch = (async (u: unknown) => { fetchCalls.push(String(u)); throw new Error('Unexpected network call') }) as typeof fetch
const A = { id: 'A', business_name: 'Acme' }, B = { id: 'B', business_name: 'Beta' }
const get = (id: string) => new NextRequest(`http://localhost/api/scan/status?job_id=${id}&passive=1`, { method: 'GET' })
const snap = (db: Database.Database) => JSON.stringify(['scan_source_runs', 'scan_jobs', 'leads', 'lead_sources'].map(t => db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all()))

test('status source_runs: owner rows verbatim (null stays null), not-recorded list, B and unknown ids identical 404, unauth 401, GET writes nothing', async () => {
  const db = new Database(':memory:')
  migrateScan(db); migrateKeys(db)
  setScanDb(db)
  const jobA = createQueryJob(db, 'A', { query: 'AMARKERQUERY9f3k' })
  const jobA2 = createQueryJob(db, 'A', { query: 'AMARKERNOROWS9f3k' })
  const jobB = createQueryJob(db, 'B', { query: 'BMARKERQUERY7h2m' })
  db.prepare("UPDATE scan_jobs SET status='running'").run()
  db.prepare("UPDATE scan_jobs SET status='done', candidates=1, verified=0, needs_review=0, dropped=1, drop_reasons='{\"excerpt_not_on_page\":1}'")
    .run()
  const ins = db.prepare('INSERT INTO scan_source_runs (job_id,attempt,collector,status,evidence_count,candidate_count,verified_count,review_count,inserted_count) VALUES (?,?,?,?,?,?,?,?,?)')
  ins.run(jobA, 1, 'search:tinyfish', 'ok', null, 1, 0, 0, 0)      // evidence_count unknown, must stay null
  ins.run(jobA, 1, 'rss', 'unavailable', null, null, null, null, 0) // candidate_count unknown, must stay null, never 0
  ins.run(jobB, 1, 'search:BMARKERCOLLECTOR7h2m', 'ok', 5, 7, 2, 1, 3)
  const before = snap(db)
  const body = async (r: Response) => ({ status: r.status, json: JSON.parse(await r.text()) as Record<string, unknown>, text: '' })

  setUser(A)
  const a = await statusGET(get(jobA)); const aText = await a.text(); const aj = JSON.parse(aText)
  assert.equal(a.status, 200)
  assert.deepEqual(aj.source_runs, [
    { attempt: 1, collector: 'rss', status: 'unavailable', evidence_count: null, candidate_count: null, verified_count: null, review_count: null, inserted_count: 0 },
    { attempt: 1, collector: 'search:tinyfish', status: 'ok', evidence_count: null, candidate_count: 1, verified_count: 0, review_count: 0, inserted_count: 0 },
  ])
  assert.deepEqual(aj.not_recorded, ['search_queries', 'raw_search_hits', 'fetched_pages'])
  assert.deepEqual(aj.quality, { candidates: 1, passed: 0, needs_review: 0, dropped: 1, drop_reasons: { excerpt_not_on_page: 1 } }, 'existing quality field unchanged')
  assert.ok(!aText.includes('BMARKER'), 'no B marker in A\'s response')

  const a2 = JSON.parse(await (await statusGET(get(jobA2))).text())
  assert.deepEqual(a2.source_runs, [], 'a job with no recorded rows gets an empty list, not invented rows')
  assert.deepEqual(a2.not_recorded, ['search_queries', 'raw_search_hits', 'fetched_pages'])

  setUser(B)
  const bOwn = await statusGET(get(jobB)); const bText = await bOwn.text()
  assert.equal(bOwn.status, 200)
  assert.ok(bText.includes('BMARKERCOLLECTOR7h2m') && !bText.includes('"collector":"search:tinyfish"') && !bText.includes('AMARKER'), 'B sees only B rows')
  const cross = await statusGET(get(jobA)); const crossText = await cross.text()
  const none = await statusGET(get('0'.repeat(24))); const noneText = await none.text()
  assert.equal(cross.status, 404); assert.equal(none.status, 404)
  assert.equal(crossText, noneText, 'another tenant\'s id is indistinguishable from a nonexistent id')
  assert.ok(!crossText.includes('tinyfish') && !crossText.includes('AMARKER'))

  setUser(null)
  assert.equal((await statusGET(get(jobA))).status, 401)
  assert.equal(snap(db), before, 'GETs wrote nothing')
  assert.deepEqual(fetchCalls, [], 'no network')
  void body
})
