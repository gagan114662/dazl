import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { migrateScan, listLeads } from '../lib/scan/store.ts'
import { migrateWatch, createWatch, listWatches, watchAction, seenKey, markWatchLeads, runDueWatches, MAX_WATCHES } from '../lib/watch.ts'
import { migratePlans } from '../lib/plans.ts'
import { migrateKeys } from '../lib/llm/key-store.ts'

const ICP = JSON.stringify({ summary: 's', who: [], industries: [], sizes: [], where: [], signals: [], exclude: [] })

function setup() {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  migrateScan(db); migratePlans(db); migrateKeys(db); migrateWatch(db)
  return db
}
function giveKey(db: Database.Database, userId: string) {
  db.prepare("INSERT INTO tenant_llm_keys (tenant_id, vendor, ciphertext, last4, validated_at) VALUES (?, 'anthropic', 'x', '1234', 1)").run(userId)
}
function due(db: Database.Database, watchId: string) {
  db.prepare('UPDATE watches SET next_run_at = 1 WHERE id = ?').run(watchId)
}
function claim(db: Database.Database, jobId: string) {
  db.prepare("UPDATE scan_jobs SET status='running', attempts=attempts+1 WHERE id=?").run(jobId)
}
function addLead(db: Database.Database, jobId: string, over: Record<string, unknown> = {}) {
  const l = { id: Math.random().toString(16).slice(2), name: 'Bob', company: 'Cafe X', company_domain: null, signal: 's', source_url: 'https://example.com/r', score: 80, ...over }
  db.prepare('INSERT INTO leads (id, scan_job_id, name, company, company_domain, signal, source_url, score) VALUES (@id,@scan_job_id,@name,@company,@company_domain,@signal,@source_url,@score)').run({ ...l, scan_job_id: jobId })
}

test('watches made in the same second list in one stable order (created_at, then id)', () => {
  const db = setup()
  for (const [id, at] of [['b', 100], ['c', 100], ['a', 100], ['d', 99]] as const) db.prepare("INSERT INTO watches (id, user_id, query, icp, next_run_at, created_at) VALUES (?, 'u', ?, ?, 0, ?)").run(id, `q ${id}`, ICP, at)
  assert.deepEqual(listWatches(db, 'u').map(w => w.id), ['c', 'b', 'a', 'd'])
})

test('cap of 3 active watches, and no duplicate active query', () => {
  const db = setup()
  for (let i = 0; i < MAX_WATCHES; i++) assert.ok(createWatch(db, 'u', `query ${i}`, ICP).watch)
  assert.match(createWatch(db, 'u', 'query 4th', ICP).error ?? '', /already have 3/)
  // Pause 'query 2' by name: listWatches orders by created_at (whole seconds), so [0] is not reliably the newest.
  const w = listWatches(db, 'u').find(x => x.query === 'query 2')!
  assert.ok(watchAction(db, 'u', w.id, 'pause'))
  assert.match(createWatch(db, 'u', 'query 1', ICP).error ?? '', /already watching/, 'an active dupe is rejected even under the cap')
  const fourth = createWatch(db, 'u', 'query 4th', ICP).watch!
  assert.ok(fourth, 'a paused watch frees a slot')
  assert.equal(createWatch(db, 'u', 'unrelated', ICP).error !== undefined, true, 'still 3 active')
  // a deleted watch frees the query for re-watch
  assert.ok(watchAction(db, 'u', fourth.id, 'delete'))
  assert.ok(createWatch(db, 'u', 'query 4th', ICP).watch)
})

test('a watch with no user key pauses and never creates a trial-funded job', () => {
  const db = setup()
  const w = createWatch(db, 'u', 'funded startups hiring', ICP).watch!
  due(db, w.id)
  const r = runDueWatches(db)
  assert.deepEqual(r, { ran: 0, paused: 1 })
  const after = listWatches(db, 'u')[0]
  assert.equal(after.active, false)
  assert.equal(after.paused_reason, 'no_api_key')
  assert.equal((db.prepare('SELECT count(*) AS n FROM scan_jobs').get() as { n: number }).n, 0, 'no job at all - never trial-funded')
})

test('a watch over the monthly scan quota pauses instead of running', () => {
  const db = setup()
  giveKey(db, 'u')
  const w = createWatch(db, 'u', 'funded startups hiring', ICP).watch!
  for (let i = 0; i < 50; i++) db.prepare("INSERT INTO scan_jobs (id, user_id, business_name, industry, location, status) VALUES (?, 'u', 'b', 'i', 'l', 'done')").run(`old${i}`)
  due(db, w.id)
  const r = runDueWatches(db)
  assert.deepEqual(r, { ran: 0, paused: 1 })
  assert.equal(listWatches(db, 'u')[0].paused_reason, 'quota_exceeded')
})

test('a running user scan defers the watch; it stays active for the next tick', () => {
  const db = setup()
  giveKey(db, 'u')
  const w = createWatch(db, 'u', 'funded startups hiring', ICP).watch!
  db.prepare("INSERT INTO scan_jobs (id, user_id, business_name, industry, location, status) VALUES ('busy', 'u', 'b', 'i', 'l', 'running')").run()
  due(db, w.id)
  const r = runDueWatches(db)
  assert.deepEqual(r, { ran: 0, paused: 0 })
  assert.equal(listWatches(db, 'u')[0].active, true)
})

test('a due watch with key and quota runs weekly and its job is linked', () => {
  const db = setup()
  giveKey(db, 'u')
  const w = createWatch(db, 'u', 'funded startups hiring', ICP).watch!
  due(db, w.id)
  const now = Math.floor(Date.now() / 1000)
  const r = runDueWatches(db, now)
  assert.deepEqual(r, { ran: 1, paused: 0 })
  const job = db.prepare("SELECT * FROM scan_jobs WHERE user_id = 'u'").get() as { watch_id: string; funded_by: string; query: string; icp: string }
  assert.equal(job.watch_id, w.id)
  assert.equal(job.funded_by, 'user', 'watch jobs are funded by the user key')
  const after = listWatches(db, 'u')[0]
  assert.equal(after.last_run_at, now)
  assert.ok((after.next_run_at ?? 0) >= now + 7 * 86400 - 1, 'next run is a week out')
  // not due again right away
  assert.deepEqual(runDueWatches(db, now + 60), { ran: 0, paused: 0 })
})

test('only leads the watch has never seen are flagged new, by domain then name', () => {
  const db = setup()
  giveKey(db, 'u')
  const w = createWatch(db, 'u', 'q', ICP).watch!
  assert.equal(seenKey('Cafe X', 'CafeX.com'), 'cafex.com')
  assert.equal(seenKey('Café X!', null), 'cafx')
  due(db, w.id)
  runDueWatches(db)
  const job1 = (db.prepare("SELECT id FROM scan_jobs WHERE watch_id = ?").get(w.id) as { id: string }).id
  claim(db, job1)
  addLead(db, job1, { company: 'Alpha', company_domain: 'alpha.io' })
  addLead(db, job1, { company: 'Beta Co', company_domain: null })
  assert.equal(markWatchLeads(db, w.id, job1), 2)
  assert.equal(listWatches(db, 'u')[0].new_leads, 2)
  db.prepare("UPDATE scan_jobs SET status='done' WHERE id = ?").run(job1) // the runner finishes the job before the next weekly tick
  // second weekly run: same two companies plus one genuinely new
  due(db, w.id)
  runDueWatches(db)
  const job2 = (db.prepare("SELECT id FROM scan_jobs WHERE watch_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1").get(w.id) as { id: string }).id
  claim(db, job2)
  addLead(db, job2, { company: 'Alpha', company_domain: 'alpha.io' })
  addLead(db, job2, { company: 'Beta Co', company_domain: null })
  addLead(db, job2, { company: 'Gamma', company_domain: 'gamma.dev' })
  assert.equal(markWatchLeads(db, w.id, job2), 1)
  assert.equal(listWatches(db, 'u')[0].new_leads, 1)
  const flagged = (listLeads(db, 'u', job2) as { company: string; watch_new: number }[]).filter(l => l.watch_new === 1)
  assert.equal(flagged.length, 1)
  assert.equal(flagged[0].company, 'Gamma')
})

test('resume re-arms a key-paused watch and it runs on the next tick', () => {
  const db = setup()
  const w = createWatch(db, 'u', 'q', ICP).watch!
  due(db, w.id)
  runDueWatches(db)
  assert.equal(listWatches(db, 'u')[0].active, false)
  giveKey(db, 'u')
  assert.ok(watchAction(db, 'u', w.id, 'resume'))
  due(db, w.id)
  assert.deepEqual(runDueWatches(db), { ran: 1, paused: 0 })
})
