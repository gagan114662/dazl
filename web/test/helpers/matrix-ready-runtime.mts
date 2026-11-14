// #1099 / review of #1210, finding 1: the matrix's "ready" column with READY leads present, compared with Home's own count
// (homeReady) on the same store. Run by test/matrix-score-1099.test.ts with the scan-route loader (homeReady uses the app's
// path aliases and scan store).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { setScanDb, setUser } from './tenant-route-db.ts'
import { migrateAllSqlite } from '../../lib/db/sqlite-migrations.ts'
import { homeReady } from '../../lib/outreach/home-ready.ts'
import { measureCase, verdict } from '../../scripts/matrix-score.mts'

const NOW = Math.floor(Date.now() / 1000), DAY = 86400
const recent = new Date(Date.now() - 5 * DAY * 1000).toISOString().slice(0, 10)
type L = { company?: string; machine?: boolean; confirmed?: boolean; review?: string | null; date?: string | null; q?: boolean; fit?: number | null; domain?: string | null; at?: number }

test('matrix ready and held equal Home\'s on the same scan, with ready leads: exact numbers, ready winning over a held twin met first', async () => {
  const db = new Database(':memory:'); migrateAllSqlite(db); setScanDb(db); setUser({ id: 'A', business_name: 'Acme' })
  const J = 'a'.repeat(24)
  db.prepare("INSERT INTO scan_jobs (id, user_id, business_name, industry, location, query, icp, status, candidates, created_at) VALUES (?, 'A', 'x', '(from request)', '-', 'Dental practices in Ohio that opened a new location', NULL, 'running', 9, ?)").run(J, NOW - DAY)
  let seq = 0
  const lead = (id: string, o: L) => db.prepare("INSERT INTO leads (id, scan_job_id, company, signal, source_url, confidence, evidence_excerpt, review_reason, event_date, date_status, fit, created_at, quarantined_at, human_confirmed_at, seen_before, company_domain, source_kind) VALUES (?, ?, ?, 'opened a new location', 'https://news.example/a', ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, NULL)")
    .run(id, J, o.company ?? `Co ${id}`, o.machine ? 80 : null, o.machine ? `Co ${id} opened a new location` : null, o.review ?? null, o.date ?? null, o.date ? 'verified' : null, o.fit ?? null, NOW - DAY - seq++, o.q ? NOW : null, o.confirmed ? NOW - DAY : null, o.domain ?? null)
  // the Leads list orders by fit, then confidence, then newest: fit puts the HELD twin first and its ready twin second
  lead('twinheld', { machine: true, company: 'Twin Dental', domain: 'twin.example', fit: 5 })                                        // held (no date), met first
  lead('twinready', { machine: true, confirmed: true, date: recent, company: 'Twin Dental Group', domain: 'twin.example', fit: 3 })   // the same company, ready, met second: ready wins
  lead('ok1', { machine: true, confirmed: true, date: recent, fit: 4 }); lead('ok2', { machine: true, confirmed: true, date: recent, fit: 4 })
  lead('dupheld', { machine: true, company: 'Co ok1', fit: 2 })                                                                       // a held lead of a ready company: still one ready company
  lead('notiming', { machine: true, date: recent, fit: 4 }); lead('review', { review: 'quote_unconfirmed', date: recent, fit: 4 }); lead('nodate', { machine: true, fit: 4 })
  lead('rej', { machine: true, confirmed: true, date: recent, q: true, fit: 4 })                                                      // rejected: not counted
  db.prepare("UPDATE scan_jobs SET status = 'done' WHERE id = ?").run(J)
  const order = (db.prepare('SELECT id FROM leads WHERE scan_job_id = ? ORDER BY (fit IS NULL), fit DESC').all(J) as { id: string }[]).map(r => r.id)
  assert.ok(order.indexOf('twinheld') < order.indexOf('twinready'), 'the held twin is met before its ready twin')
  const m = measureCase(db, 'A', J, { expect: { location_keywords: ['x'], category_keywords: ['x'] } }, new Date(NOW * 1000))
  const h = await homeReady('A', NOW)
  const homeHeld: Record<string, number> = {}; for (const x of h.held) homeHeld[x.reason] = x.count
  assert.equal(m.ready, 3, 'Twin Dental (ready wins), Co ok1, Co ok2')
  assert.deepEqual(m.held, { 'event timing unknown': 2, 'needs your review': 1 }, 'exactly the three held companies, each with Home\'s own reason')
  assert.equal(m.ready, h.ready, 'the same ready count as Home\'s tile'); assert.deepEqual(m.held, homeHeld, 'the same held map as Home')
  assert.equal(m.leads, 8, 'eight listed leads: the rejected one is not counted')
  assert.equal(verdict(m, { ready_leads_min: 3, named_contact_min_pct: 0, dated_source_min_pct: 0, location_category_match_min_pct: 0, per_case_confirm_cap_usd: 0.5 }).pass, true)
  assert.equal(verdict(m, { ready_leads_min: 4, named_contact_min_pct: 0, dated_source_min_pct: 0, location_category_match_min_pct: 0, per_case_confirm_cap_usd: 0.5 }).pass, false)
})
