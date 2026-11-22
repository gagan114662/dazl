// #1136 (follow-up to #683): the Leads history card of a past scan says what its Campaigns card says, counted from the leads
// as they stand now, never the scan-time "N need your review" for leads no check can make ready.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { migrateAllSqlite } from '../lib/db/sqlite-migrations.ts'
import { sqliteDb } from '../lib/db/client.ts'
import { campaignsLimit, historyCampaigns, listCampaigns } from '../lib/outreach/campaigns.ts'
import { campaignStatus, historyStatus, runStatusOf, runTone } from '../lib/run-status.ts'
import { historyJobs } from '../lib/scan/history-jobs.ts'
import type { ScanRecord } from '../lib/scan/scan-outcome.ts'

const recent = new Date(Date.now() - 10 * 86_400_000).toISOString().slice(0, 10)
let t = 1000
function job(db: Database.Database, id: string, query: string, icp: string | null, verified: number, review: number, testOnly = false) {
  db.prepare("INSERT INTO scan_jobs (id, user_id, business_name, industry, location, query, icp, status, candidates, created_at) VALUES (?, 'A', 'x', ?, ?, ?, ?, 'running', 5, ?)")
    .run(id, testOnly ? 'test only' : '(from request)', testOnly ? 'test only' : '-', query, icp, t++)
  return () => db.prepare("UPDATE scan_jobs SET status = 'done', verified = ?, needs_review = ?, dropped = 0 WHERE id = ?").run(verified, review, id)
}
const lead = (db: Database.Database, jobId: string, id: string, o: { review?: string; machine?: boolean; date?: string }) =>
  db.prepare("INSERT INTO leads (id, scan_job_id, company, signal, source_url, confidence, evidence_excerpt, review_reason, event_date) VALUES (?, ?, ?, 'hiring a receptionist', 'https://news.example/a', ?, ?, ?, ?)")
    .run(id, jobId, `Co ${id}`, o.machine ? 80 : null, o.machine ? `Co ${id} is hiring a receptionist` : null, o.review ?? null, o.date ?? null)
const NYC = 'Dental practices in New York hiring front desk staff', LONDON = 'Find London UK companies hiring sales account executives.'

function store() {
  const db = new Database(':memory:'); migrateAllSqlite(db)
  const nyc = job(db, 'jn', NYC, JSON.stringify({ window_days: 90 }), 0, 2)          // recorded: 2 need your review
  lead(db, 'jn', 'n1', { review: 'outside_window_undated' }); lead(db, 'jn', 'n2', { review: 'counterparty_signal', date: recent }); nyc()
  const lon = job(db, 'jl', LONDON, null, 1, 0)                                        // recorded: 1 source-checked
  lead(db, 'jl', 'l1', { machine: true, date: recent }); lon()                          // DEFAULT-DENY: no required-check pass
  const fx = job(db, 'jt', 'a test-only fixture run', null, 0, 1, true)                // Campaigns does not list test-only runs
  lead(db, 'jt', 't1', { review: 'outside_window_undated' }); fx()
  // a CSV import: no query, so Campaigns does not list it either
  db.prepare("INSERT INTO scan_jobs (id, user_id, business_name, industry, location, query, status, candidates, created_at, csv_domain) VALUES ('jc', 'A', 'x', 'csv', 'csv', NULL, 'running', 1, ?, 'acme.example')").run(t++)
  lead(db, 'jc', 'c1', { review: 'outside_window_undated' }); db.prepare("UPDATE scan_jobs SET status = 'done', verified = 0, needs_review = 1, dropped = 0 WHERE id = 'jc'").run()
  return db
}
// what GET /api/campaigns answers (app/api/campaigns/route.ts), and what the Leads history reads
async function both(db: Database.Database) {
  const jobs = await historyJobs(sqliteDb(db), 'A') as unknown as (ScanRecord & { id: string })[]
  const byId = new Map(jobs.map(j => [j.id, j]))
  const cards = new Map(listCampaigns(db, 'A', 20).map(c => campaignStatus(c, (byId.get(c.id) as never) ?? null)).map(c => [c.id, c]))
  return { jobs: byId, cards }
}

test('#1136: the NYC research-only run - the history card is its Campaigns card, never the scan-time "need your review"', async () => {
  const { jobs, cards } = await both(store())
  const j = jobs.get('jn')!, c = cards.get('jn')!
  assert.equal(runStatusOf(j).tag, 'Needs your review', 'what the history said before: the scan-time count')
  const h = historyStatus(j, c)
  assert.equal(h.current, true)
  assert.deepEqual([h.run.tag, h.run.label, h.next], [c.run!.tag, c.run!.label, { text: c.next.label, href: c.next.href }])
  assert.equal(h.run.tag, 'Research only'); assert.doesNotMatch(h.run.label, /[1-9] needs? your review/)
  assert.match(h.next!.text, /Change the search/)
  assert.equal(runTone(h.run), 'grey', 'not the lavender of a review a check can resolve')
})

test('#1136: the London Test B run (a required check never passed) - research only on both, not "Leads found"', async () => {
  const { jobs, cards } = await both(store())
  const j = jobs.get('jl')!, c = cards.get('jl')!
  assert.equal(runStatusOf(j).tag, 'Leads found', 'the scan-time verdict')
  const h = historyStatus(j, c)
  assert.deepEqual([h.run.tag, h.run.label], [c.run!.tag, c.run!.label]); assert.equal(h.run.tag, 'Research only')
})

test('#1136: a scan Campaigns does not list (a test-only run, a CSV import), or any scan while the campaigns read failed, keeps its recorded status and says so', async () => {
  const { jobs, cards } = await both(store())
  assert.equal(cards.has('jt'), false)
  const h = historyStatus(jobs.get('jt')!, undefined)
  assert.equal(h.current, false); assert.deepEqual(h.run, runStatusOf(jobs.get('jt')!)); assert.deepEqual(h.next, h.run.next)
  assert.equal(historyStatus(jobs.get('jn')!, undefined).current, false, 'the read failed: recorded, flagged')
  assert.equal(cards.has('jc'), false, 'a CSV import is not a campaign'); assert.equal(historyStatus(jobs.get('jc')!, undefined).current, false, 'so its card is flagged as recorded')
})

test('#1136: /api/campaigns?limit covers the whole history (20), never more; anything else is the default 10', () => {
  assert.deepEqual(['20', '5', '1', '50', null, '', '0', '-3', '2.5', 'x'].map(campaignsLimit), [20, 5, 1, 20, 10, 10, 10, 10, 10, 10])
  const db = new Database(':memory:'); migrateAllSqlite(db)
  for (let i = 0; i < 14; i++) job(db, `j${i}`, `search ${i}`, null, 0, 0)()
  assert.equal(listCampaigns(db, 'A', campaignsLimit('20')).length, 14, 'every one of the newest 20 scans the history lists'); assert.equal(listCampaigns(db, 'A').length, 10)
})

test('#1136: one pill colour rule', () => {
  const r = (group: string, tag: string) => runTone({ group, tag } as never)
  assert.deepEqual([r('results', 'Leads found'), r('results', 'Leads found (counts not recorded)'), r('results', 'Needs your review'), r('results', 'Research only'), r('results', 'Not verified yet'), r('running', 'Running'), r('technical', 'Stopped'), r('no_match', 'None passed')],
    ['mint', 'mint', 'lav', 'grey', 'grey', 'peach', 'pink', 'grey'])
})

// ---- Hermes-PC review of 3eb33576 / XHawk ----

// HIST-BATCH (finding 2): what GET /api/campaigns?view=history answers for the Leads page - the same pill and label as the full Campaigns card
async function history(db: Database.Database) {
  const jobs = await historyJobs(sqliteDb(db), 'A') as unknown as (ScanRecord & { id: string })[]
  const byId = new Map(jobs.map(j => [j.id, j]))
  return new Map((await historyCampaigns(db, sqliteDb(db), 'A', jobs.map(j => j.id))).map(c => campaignStatus(c, (byId.get(c.id) as never) ?? null)).map(c => [c.id, c]))
}

test('#1136 HIST-BATCH: the bounded history read gives every listed scan the same pill and label as its full Campaigns card (NYC, London DEFAULT-DENY)', async () => {
  const db = store()
  const { cards } = await both(db), h = await history(db)
  for (const id of ['jn', 'jl']) {
    const c = cards.get(id)!, r = h.get(id)!
    assert.deepEqual([r.run!.tag, r.run!.label, r.run!.group], [c.run!.tag, c.run!.label, c.run!.group], id)
    assert.deepEqual(r.next, c.next, `${id}: a non-result run's next step is the record's own, on both`)
  }
  assert.equal(h.get('jn')!.run!.tag, 'Research only'); assert.equal(h.get('jl')!.run!.tag, 'Research only')
  assert.equal(h.has('jt'), false, 'a test-only run is not a campaign'); assert.equal(h.has('jc'), false, 'nor is a CSV import')
})

test('#1136 HIST-BATCH: a run with a review a check can resolve, one with passed leads, and a rejected lead - the history split equals the full one', async () => {
  const db = new Database(':memory:'); migrateAllSqlite(db)
  const a = job(db, 'ja', 'Dental practices in Boston hiring front desk staff', JSON.stringify({ window_days: 90 }), 1, 1)
  lead(db, 'ja', 'a1', { machine: true, date: recent }); lead(db, 'ja', 'a2', { review: 'low_confidence', date: recent }); lead(db, 'ja', 'a3', { review: 'low_confidence', date: recent }); a()
  db.prepare("UPDATE leads SET quarantined_at = 1 WHERE id = 'a3'").run()
  const { cards } = await both(db), h = await history(db)
  const c = cards.get('ja')!, r = h.get('ja')!
  assert.deepEqual([r.run!.tag, r.run!.label], [c.run!.tag, c.run!.label])
  const q = (x: typeof c.qualification) => [x.sourceChecked, x.confirmedByYou, x.needsReview, x.research, x.unverified, x.heldResearch, x.heldResearchSourceChecked, x.rejected]
  assert.deepEqual(q(r.qualification), q(c.qualification))
})

test('#1136 HIST-BATCH: the history read is a bounded number of queries, whatever the lead count (20 scans x 250 leads)', async () => {
  const count = async (leadsPerJob: number) => {
    const db = new Database(':memory:'); migrateAllSqlite(db)
    const ids: string[] = []
    for (let i = 0; i < 20; i++) {
      const id = `b${i}`; ids.push(id); const done = job(db, id, `Dental practices in city ${i} hiring front desk staff`, JSON.stringify({ window_days: 90 }), 0, leadsPerJob)
      const ins = db.prepare("INSERT INTO leads (id, scan_job_id, company, signal, source_url, confidence, evidence_excerpt, review_reason, event_date) VALUES (?, ?, ?, 'hiring', 'https://news.example/a', ?, ?, ?, ?)")
      db.transaction(() => { for (let k = 0; k < leadsPerJob; k++) ins.run(`${id}-${k}`, id, `Co ${id}-${k}`, k % 2 ? 80 : null, k % 2 ? 'quote' : null, k % 3 ? 'low_confidence' : null, recent) })()
      done()
    }
    let n = 0
    const real = db.prepare.bind(db)
    ;(db as unknown as { prepare: typeof db.prepare }).prepare = ((sql: string) => { n++; return real(sql) }) as typeof db.prepare
    const out = await historyCampaigns(db, sqliteDb(db), 'A', ids)
    assert.equal(out.length, 20)
    return n
  }
  const small = await count(1), big = await count(250)
  // 64: one more fixed read since #1037 (the buyer-reach rows of every listed scan's review leads, ONE query whatever the lead count)
  assert.ok(big <= 64, `bounded: ${big} queries for 20 x 250 leads`)
  assert.equal(big, small, `independent of the lead count: ${small} vs ${big}`)
})

test('#1136 TIE-SEQ (finding 3): more than 20 same-second scans - every history card of the newest 20 has its Campaigns row (created_at, insert_seq order)', async () => {
  const db = new Database(':memory:'); migrateAllSqlite(db)
  for (let i = 0; i < 25; i++) {
    db.prepare("INSERT INTO scan_jobs (id, user_id, business_name, industry, location, query, status, candidates, created_at) VALUES (?, 'A', 'x', '(from request)', '-', ?, 'done', 1, 5000)").run(`s${String(i).padStart(2, '0')}`, `same-second search ${i}`)
  }
  // insert_seq is the order both engines agree on; here it runs opposite to SQLite's physical (rowid) order, as a Postgres heap may,
  // so a read that leans on physical order instead of insert_seq picks a different 20
  db.prepare('UPDATE scan_jobs SET insert_seq = 1000 - rowid').run()
  const jobs = await historyJobs(sqliteDb(db), 'A') as unknown as { id: string }[]
  assert.equal(jobs.length, 20)
  const full = new Set(listCampaigns(db, 'A', 20).map(c => c.id))
  for (const j of jobs) assert.ok(full.has(j.id), `history card ${j.id} has a Campaigns row (current: true)`)
  const bounded = new Set((await historyCampaigns(db, sqliteDb(db), 'A', jobs.map(j => j.id))).map(c => c.id))
  for (const j of jobs) assert.ok(bounded.has(j.id), `history card ${j.id} has its current split`)
})
