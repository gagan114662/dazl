// #1038: the Leads table query - leads across scans, tenant-scoped, sorted by fit or date, 50 a page, with the cards' defaults.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { migrateAllSqlite } from '../lib/db/sqlite-migrations.ts'
import { leadsTable, TABLE_PAGE, parseSort, parsePage } from '../lib/leads/table.ts'

const NOW = Math.floor(Date.now() / 1000)
function seed() {
  const db = new Database(':memory:'); migrateAllSqlite(db)
  let t = 0
  const job = (id: string, user: string, test_only = false) => db.prepare("INSERT INTO scan_jobs (id, user_id, business_name, industry, location, query, icp, status, candidates, created_at) VALUES (?, ?, 'x', ?, ?, 'q', NULL, 'running', 0, ?)")
    .run(id, user, test_only ? 'test only' : '-', test_only ? 'test only' : '-', NOW + t++)
  const lead = (id: string, jobId: string, o: { company?: string; name?: string; fit?: number | null; date?: string | null; at?: number; q?: boolean; seen?: boolean; kind?: string | null } = {}) =>
    db.prepare('INSERT INTO leads (id, scan_job_id, company, name, signal, source_url, fit, event_date, created_at, quarantined_at, seen_before, source_kind) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, jobId, o.company ?? `Co ${id}`, o.name ?? '', `${id} opened a new location`, `https://example.com/${id}`, o.fit ?? null, o.date ?? null, o.at ?? NOW, o.q ? NOW : null, o.seen ? 1 : 0, o.kind ?? null)
  const done = (id: string) => db.prepare("UPDATE scan_jobs SET status = 'done' WHERE id = ?").run(id)
  return { db, job, lead, done }
}
const J1 = 'a'.repeat(24), J2 = 'b'.repeat(24), JB = 'c'.repeat(24), JT = 'd'.repeat(24)

test('#1038 table: across scans, the cards\' defaults, tenant-scoped', () => {
  const { db, job, lead, done } = seed()
  job(J1, 'A'); job(J2, 'A'); job(JB, 'B'); job(JT, 'A', true)
  lead('l1', J1, { fit: 3, date: '2026-11-01' }); lead('l2', J1, { fit: 2, date: '2026-11-09' }); lead('l3', J2, { fit: 3, date: '2026-10-20' })
  lead('poor', J1, { fit: 1 })                      // a poor fit: hidden like on the cards
  lead('seen', J2, { fit: 3, seen: true })          // found again by a later scan: hidden like on the cards
  lead('fix', J2, { fit: 3, kind: 'test' })         // a fixture lead
  lead('other', JB, { fit: 3 })                     // another tenant's
  lead('tonly', JT, { fit: 3 })                     // a test-only run
  for (const j of [J1, J2, JB, JT]) done(j)
  const r = leadsTable(db, 'A')
  assert.deepEqual(r.rows.map(x => x.id).sort(), ['l1', 'l2', 'l3'], 'only A\'s listed leads, from both scans')
  assert.equal(r.total, 3); assert.equal(r.pages, 1); assert.equal(r.page, 1)
  assert.deepEqual(leadsTable(db, 'B').rows.map(x => x.id), ['other'], 'B sees only B\'s')
  assert.deepEqual(leadsTable(db, 'nobody').rows, [], 'an unknown tenant has no rows')
})

test('#1038 table: sort by fit puts the highest fit first, by date the newest event first, and ties are stable', () => {
  const { db, job, lead, done } = seed()
  job(J1, 'A')
  lead('f2', J1, { fit: 2, date: '2026-11-09' }); lead('f3old', J1, { fit: 3, date: '2026-10-01' }); lead('f3new', J1, { fit: 3, date: '2026-11-05' })
  lead('nofit', J1, { fit: null, date: '2026-11-12' }); lead('nodate', J1, { fit: 3 })
  done(J1)
  const fit = leadsTable(db, 'A', { sort: 'fit' }).rows
  assert.equal(fit[0].fit, 3, 'the first row has the maximum fit')
  assert.deepEqual(fit.map(r => r.fit), [3, 3, 3, 2, null], 'fit descending, unscored last')
  const date = leadsTable(db, 'A', { sort: 'date' }).rows
  assert.deepEqual(date.map(r => r.id), ['nofit', 'f2', 'f3new', 'f3old', 'nodate'], 'newest event first, undated last')
  assert.deepEqual(leadsTable(db, 'A', { sort: 'fit' }).rows.map(r => r.id), fit.map(r => r.id), 'the same sort gives the same order again (a reload)')
  assert.equal(parseSort('nonsense'), 'fit'); assert.equal(parseSort('date'), 'date')
})

test('#1038 table: 50 a page, pages cover every row once, an out-of-range page is clamped', () => {
  const { db, job, lead, done } = seed()
  job(J1, 'A')
  for (let i = 0; i < 120; i++) lead(`x${String(i).padStart(3, '0')}`, J1, { fit: 2 + (i % 2), date: `2026-10-${String(1 + (i % 28)).padStart(2, '0')}` })
  done(J1)
  const p1 = leadsTable(db, 'A', { page: 1 }), p2 = leadsTable(db, 'A', { page: 2 }), p3 = leadsTable(db, 'A', { page: 3 })
  assert.equal(p1.total, 120); assert.equal(p1.pages, 3)
  assert.deepEqual([p1.rows.length, p2.rows.length, p3.rows.length], [TABLE_PAGE, TABLE_PAGE, 20])
  const ids = [...p1.rows, ...p2.rows, ...p3.rows].map(r => r.id)
  assert.equal(new Set(ids).size, 120, 'no row twice, none missed')
  assert.equal(leadsTable(db, 'A', { page: 99 }).page, 3, 'past the end shows the last page')
  assert.equal(parsePage('-4'), 1); assert.equal(parsePage('abc'), 1); assert.equal(parsePage('2'), 2)
})

test('#1038 table: state - rejected, drafted (an outreach draft exists), to review; person only when it differs from the company', () => {
  const { db, job, lead, done } = seed()
  job(J1, 'A')
  lead('rev', J1, { fit: 3 }); lead('rej', J1, { fit: 3, q: true }); lead('dr', J1, { fit: 3, name: 'Dana Lee' })
  done(J1)
  db.prepare("INSERT INTO outreach_messages (id, tenant_id, lead_id, to_email, subject, body, status) VALUES ('m1', 'A', 'dr', 'dana@example.com', 'Hello there', 'A body that is long enough to pass the check.', 'draft')").run()
  db.prepare("INSERT INTO outreach_messages (id, tenant_id, lead_id, to_email, subject, body, status) VALUES ('m2', 'B', 'rev', 'x@example.com', 'Hello there', 'A body that is long enough to pass the check.', 'draft')").run()   // another tenant's draft on the same id
  const by = Object.fromEntries(leadsTable(db, 'A').rows.map(r => [r.id, r]))
  assert.equal(by.rev.state, 'review', 'B\'s draft does not make A\'s lead drafted')
  assert.equal(by.rej.state, 'rejected'); assert.equal(by.dr.state, 'drafted')
  assert.equal(by.dr.person, 'Dana Lee'); assert.equal(by.rev.person, null)
})

test('#1038 table: a lead the cards put under Needs your review is its own state, with the held-gate overlay and a date flag', () => {
  const { db, job, lead, done } = seed()
  job(J1, 'A')
  lead('ok', J1, { fit: 3, date: '2026-10-01' }); lead('rr', J1, { fit: 3 }); lead('gate', J1, { fit: 3 })
  db.prepare("UPDATE leads SET review_reason = 'quote_unconfirmed' WHERE id = 'rr'").run()
  db.prepare("UPDATE leads SET event_date_proof = 'page_bound' WHERE id = 'ok'").run()
  done(J1)
  db.prepare("INSERT INTO lead_enrichments (id, lead_id, tenant_id, connector, kind, value, source_url, source_date, retrieved_at) VALUES ('e1', 'gate', 'A', 'scan:gate', 'gate_failed', 'x', 'https://press.example/g', '2026-11-01', ?)").run(NOW)
  const by = Object.fromEntries(leadsTable(db, 'A').rows.map(r => [r.id, r]))
  assert.equal(by.ok.state, 'review'); assert.equal(by.rr.state, 'needs_review'); assert.equal(by.rr.review_reason, 'quote_unconfirmed')
  assert.equal(by.gate.state, 'needs_review', 'a gate-held lead whose review write never landed is still shown held')
  assert.equal(by.gate.review_reason, 'sales_hiring_check_failed')
  assert.equal(by.rr.day_verified, false, 'no date proof: not confirmed'); assert.equal(by.ok.day_verified, true, 'a page-bound dated event is confirmed')
})

test('#1038 table: only a missing table is read as "no drafts"; any other read error fails the read (never an all-to-review table)', () => {
  const { db, job, lead, done } = seed()
  job(J1, 'A'); lead('x', J1, { fit: 3 }); done(J1)
  db.exec('DROP TABLE outreach_messages')
  assert.equal(leadsTable(db, 'A').rows[0].state, 'review', 'no outreach table: no drafts yet')
  const real = db.prepare.bind(db)
  ;(db as unknown as { prepare: (s: string) => unknown }).prepare = (sql: string) => { if (sql.includes('LIMIT')) throw new Error('database is locked'); return real(sql) }
  assert.throws(() => leadsTable(db, 'A'), /database is locked/)
})
