// #1038: the Leads table query on the Db layer, on SQLite and Postgres - leads across scans, tenant-scoped, sorted by fit or
// date, 50 a page, with the cards' defaults for what is left out and its own state for what needs review.
import assert from 'node:assert/strict'
import type { Db } from '../lib/db/client.ts'
import { leadsTable, TABLE_PAGE, parseSort, parsePage } from '../lib/leads/table.ts'
import { bothEngines } from './helpers/engines.ts'

const NOW = Math.floor(Date.now() / 1000)
const J1 = 'a'.repeat(24), J2 = 'b'.repeat(24), JB = 'c'.repeat(24), JT = 'd'.repeat(24)
type L = { company?: string; name?: string; fit?: number | null; date?: string | null; proof?: string | null; at?: number; q?: boolean; seen?: boolean; kind?: string | null; review?: string | null }

function seeder(db: Db) {
  let t = 0
  return {
    // a scan job is created running (leads can only be added while it runs) and finished by done()
    job: async (id: string, user: string, testOnly = false) => { await db.run("INSERT INTO scan_jobs (id, user_id, business_name, industry, location, status, created_at) VALUES (?, ?, 'x', ?, ?, 'running', ?)", [id, user, testOnly ? 'test only' : '-', testOnly ? 'test only' : '-', NOW + t++]) },
    lead: async (id: string, jobId: string, o: L = {}) => {
      await db.run('INSERT INTO leads (id, scan_job_id, company, name, signal, source_url, fit, event_date, event_date_proof, created_at, quarantined_at, seen_before, source_kind, review_reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [id, jobId, o.company ?? `Co ${id}`, o.name ?? '', `${id} opened a new location`, `https://example.com/${id}`, o.fit ?? null, o.date ?? null, o.proof ?? null, o.at ?? NOW, o.q ? NOW : null, o.seen ? 1 : 0, o.kind ?? null, o.review ?? null])
    },
    done: async (...ids: string[]) => { for (const id of ids) await db.run("UPDATE scan_jobs SET status = 'done' WHERE id = ?", [id]) },
  }
}

bothEngines('#1038 table: across scans, the cards\' defaults, tenant-scoped', async ({ db }) => {
  const { job, lead, done } = seeder(db)
  await job(J1, 'A'); await job(J2, 'A'); await job(JB, 'B'); await job(JT, 'A', true)
  await lead('l1', J1, { fit: 3, date: '2026-11-01' }); await lead('l2', J1, { fit: 2, date: '2026-11-09' }); await lead('l3', J2, { fit: 3, date: '2026-10-20' })
  await lead('poor', J1, { fit: 1 })                      // a poor fit: hidden like on the cards
  await lead('seen', J2, { fit: 3, seen: true })          // found again by a later scan: hidden like on the cards
  await lead('fix', J2, { fit: 3, kind: 'test' })         // a fixture lead
  await lead('other', JB, { fit: 3 })                     // another tenant's
  await lead('tonly', JT, { fit: 3 })                     // a test-only run
  await done(J1, J2, JB, JT)
  const r = await leadsTable(db, 'A')
  assert.deepEqual(r.rows.map(x => x.id).sort(), ['l1', 'l2', 'l3'], 'only A\'s listed leads, from both scans')
  assert.equal(r.total, 3); assert.equal(r.pages, 1); assert.equal(r.page, 1)
  assert.deepEqual((await leadsTable(db, 'B')).rows.map(x => x.id), ['other'], 'B sees only B\'s')
  assert.deepEqual((await leadsTable(db, 'nobody')).rows, [], 'an unknown tenant has no rows')
  assert.equal(typeof r.rows[0].found_at, 'number'); assert.equal(typeof r.rows[0].fit, 'number')
})

bothEngines('#1038 table: sort by fit puts the highest fit first, by date the newest event first, and ties are stable', async ({ db }) => {
  const { job, lead, done } = seeder(db)
  await job(J1, 'A')
  await lead('f2', J1, { fit: 2, date: '2026-11-09' }); await lead('f3old', J1, { fit: 3, date: '2026-10-01' }); await lead('f3new', J1, { fit: 3, date: '2026-11-05' })
  await lead('nofit', J1, { fit: null, date: '2026-11-12' }); await lead('nodate', J1, { fit: 3 })
  await done(J1)
  const fit = (await leadsTable(db, 'A', { sort: 'fit' })).rows
  assert.equal(fit[0].fit, 3, 'the first row has the maximum fit')
  assert.deepEqual(fit.map(r => r.fit), [3, 3, 3, 2, null], 'fit descending, unscored last')
  const date = (await leadsTable(db, 'A', { sort: 'date' })).rows
  assert.deepEqual(date.map(r => r.id), ['nofit', 'f2', 'f3new', 'f3old', 'nodate'], 'newest event first, undated last')
  assert.deepEqual((await leadsTable(db, 'A', { sort: 'fit' })).rows.map(r => r.id), fit.map(r => r.id), 'the same sort gives the same order again (a reload)')
  assert.equal(parseSort('nonsense'), 'fit'); assert.equal(parseSort('date'), 'date')
})

bothEngines('#1038 table: 50 a page, pages cover every row once, an out-of-range page is clamped', async ({ db }) => {
  const { job, lead, done } = seeder(db)
  await job(J1, 'A')
  for (let i = 0; i < 120; i++) await lead(`x${String(i).padStart(3, '0')}`, J1, { fit: 2 + (i % 2), date: `2026-10-${String(1 + (i % 28)).padStart(2, '0')}` })
  await done(J1)
  const p1 = await leadsTable(db, 'A', { page: 1 }), p2 = await leadsTable(db, 'A', { page: 2 }), p3 = await leadsTable(db, 'A', { page: 3 })
  assert.equal(p1.total, 120); assert.equal(p1.pages, 3)
  assert.deepEqual([p1.rows.length, p2.rows.length, p3.rows.length], [TABLE_PAGE, TABLE_PAGE, 20])
  assert.equal(new Set([...p1.rows, ...p2.rows, ...p3.rows].map(r => r.id)).size, 120, 'no row twice, none missed')
  assert.equal((await leadsTable(db, 'A', { page: 99 })).page, 3, 'past the end shows the last page')
  assert.equal(parsePage('-4'), 1); assert.equal(parsePage('abc'), 1); assert.equal(parsePage('2'), 2)
})

bothEngines('#1038 table: state - rejected, drafted (an outreach draft exists), to review; person only when it differs from the company', async ({ db }) => {
  const { job, lead, done } = seeder(db)
  await job(J1, 'A')
  await lead('rev', J1, { fit: 3 }); await lead('rej', J1, { fit: 3, q: true }); await lead('dr', J1, { fit: 3, name: 'Dana Lee' })
  await done(J1)
  const msg = (id: string, tenant: string, lead: string) => db.run("INSERT INTO outreach_messages (id, tenant_id, lead_id, to_email, subject, body, status) VALUES (?, ?, ?, 'x@example.com', 'Hello there', 'A body that is long enough to pass the check.', 'draft')", [id, tenant, lead])
  await msg('m1', 'A', 'dr')
  await msg('m2', 'B', 'rev')   // another tenant's draft on the same lead id
  const by = Object.fromEntries((await leadsTable(db, 'A')).rows.map(r => [r.id, r]))
  assert.equal(by.rev.state, 'review', 'B\'s draft does not make A\'s lead drafted')
  assert.equal(by.rej.state, 'rejected'); assert.equal(by.dr.state, 'drafted')
  assert.equal(by.dr.person, 'Dana Lee'); assert.equal(by.rev.person, null)
})

bothEngines('#1038 table: a lead the cards put under Needs your review is its own state, with the held-gate overlay and a date flag', async ({ db }) => {
  const { job, lead, done } = seeder(db)
  await job(J1, 'A')
  await lead('ok', J1, { fit: 3, date: '2026-10-01', proof: 'page_bound' }); await lead('rr', J1, { fit: 3, review: 'quote_unconfirmed' }); await lead('gate', J1, { fit: 3 })
  await done(J1)
  await db.run("INSERT INTO lead_enrichments (id, lead_id, tenant_id, connector, kind, value, source_url, source_date, retrieved_at) VALUES ('e1', 'gate', 'A', 'scan:gate', 'gate_failed', 'x', 'https://press.example/g', '2026-11-01', ?)", [NOW])
  const by = Object.fromEntries((await leadsTable(db, 'A')).rows.map(r => [r.id, r]))
  assert.equal(by.ok.state, 'review'); assert.equal(by.rr.state, 'needs_review'); assert.equal(by.rr.review_reason, 'quote_unconfirmed')
  assert.equal(by.gate.state, 'needs_review', 'a gate-held lead whose review write never landed is still shown held')
  assert.equal(by.gate.review_reason, 'sales_hiring_check_failed')
  assert.equal(by.rr.day_verified, false, 'no date proof: not confirmed'); assert.equal(by.ok.day_verified, true, 'a page-bound dated event is confirmed')
})

bothEngines('#1038 table: a failed read fails the read (never an all-to-review table)', async ({ db }) => {
  const broken = { ...db, all: () => Promise.reject(new Error('database is locked')) } as unknown as Db
  await assert.rejects(leadsTable(broken, 'A'), /database is locked/)
})
