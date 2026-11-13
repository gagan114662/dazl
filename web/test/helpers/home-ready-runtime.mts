// #1040 acceptance 1: Home's Ready tile counts exactly the leads the Leads page shows ready. The real GET /api/leads (stubbed
// session, no network) per scan + the Leads page's split (previewSplit), against homeReady on the same store.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { NextRequest } from 'next/server'
import { setScanDb, setUser } from './tenant-route-db.ts'
import { migrateAllSqlite } from '../../lib/db/sqlite-migrations.ts'
import { previewSplit, type PreviewLead } from '../../lib/journey.ts'
import { GET as leadsGET } from '../../app/api/leads/route.ts'
import { GET as readyGET } from '../../app/api/home/ready/route.ts'
import { homeReady, READY_SCANS_MAX } from '../../lib/outreach/home-ready.ts'

globalThis.fetch = (async () => { throw new Error('Unexpected network call') }) as typeof fetch
const NOW = Math.floor(Date.now() / 1000), DAY = 86400
const recent = new Date(Date.now() - 5 * DAY * 1000).toISOString().slice(0, 10)

function seed() {
  const db = new Database(':memory:'); migrateAllSqlite(db)
  setScanDb(db); setUser({ id: 'A', business_name: 'Acme' })
  let t = 0
  const job = (id: string, user: string, query: string, at: number, testOnly = false) => db.prepare("INSERT INTO scan_jobs (id, user_id, business_name, industry, location, query, icp, status, candidates, created_at) VALUES (?, ?, 'x', ?, ?, ?, NULL, 'running', 5, ?)")
    .run(id, user, testOnly ? 'test only' : '(from request)', testOnly ? 'test only' : '-', query, at + t++)
  // confirmed: the user checked the source themselves (a machine-verified lead also needs a full timing proof to be ready)
  const lead = (id: string, jobId: string, o: { machine?: boolean; confirmed?: boolean; review?: string | null; date?: string | null; at?: number; quarantined?: boolean; fit?: number | null; company?: string; seen?: boolean }) => db.prepare(
    "INSERT INTO leads (id, scan_job_id, company, signal, source_url, confidence, evidence_excerpt, review_reason, event_date, date_status, fit, created_at, quarantined_at, human_confirmed_at, seen_before) VALUES (?, ?, ?, 'opened a new location', 'https://news.example/a', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(id, jobId, o.company ?? `Co ${id}`, o.machine ? 80 : null, o.machine ? `Co ${id} opened a new location` : null, o.review ?? null, o.date ?? null, o.date ? 'verified' : null, o.fit ?? null, o.at ?? NOW - DAY, o.quarantined ? NOW : null, o.confirmed ? NOW - DAY : null, o.seen ? 1 : 0)
  const done = (id: string) => db.prepare("UPDATE scan_jobs SET status = 'done' WHERE id = ?").run(id)
  return { db, job, lead, done }
}
// What a user sees: the REAL GET /api/leads rows (every hold as the Leads page gets it), minus the "seen before" rows Leads
// hides by default, split by Home's "Leads ready" rule (previewSplit), one per company across scans.
async function leadsPageReady(jobIds: string[], since: number) {
  const ids: string[] = [], seen = new Set<string>()
  for (const jobId of jobIds) {
    const res = await leadsGET(new NextRequest(`http://test/api/leads?job_id=${jobId}`))
    assert.equal(res.status, 200)
    const rows = (await res.json() as { leads: (PreviewLead & { created_at: number; seen_before?: number; company: string; company_domain?: string | null })[] }).leads
    for (const l of previewSplit(rows.filter(l => l.created_at >= since && !l.seen_before)).opportunities as unknown as { id: string; company: string; company_domain?: string | null }[]) {
      const k = (l.company_domain || l.company).toLowerCase(); if (!seen.has(k)) { seen.add(k); ids.push(l.id) }
    }
  }
  return ids.sort()
}

test('#1040 Ready tile = what the Leads page shows ready, scan by scan (the real /api/leads route and split)', async () => {
  const { job, lead, done } = seed()
  const J1 = 'a'.repeat(24), J2 = 'b'.repeat(24), JT = 'c'.repeat(24), JB = 'd'.repeat(24)
  job(J1, 'A', 'Dental practices in Ohio that opened a new location', NOW - 3 * DAY)
  lead('ok1', J1, { machine: true, confirmed: true, date: recent }); lead('ok2', J1, { machine: true, confirmed: true, date: recent })
  lead('notiming', J1, { machine: true, date: recent })                              // machine-verified, no timing proof: held
  lead('review', J1, { machine: false, review: 'quote_unconfirmed', date: recent })   // needs your review
  lead('nodate', J1, { machine: true })                                              // no verified date
  lead('rejected', J1, { machine: true, date: recent, quarantined: true })
  lead('old', J1, { machine: true, confirmed: true, date: recent, at: NOW - 40 * DAY })               // found before the window
  done(J1)
  job(J2, 'A', 'Dental practices in Ohio that opened a new location', NOW - 2 * DAY)
  lead('ok3', J2, { machine: true, confirmed: true, date: recent }); lead('unverified', J2, { date: recent })
  lead('again', J2, { machine: true, confirmed: true, date: recent, company: 'Co ok1' })                 // the same company as ok1, found again
  lead('seen', J2, { machine: true, confirmed: true, date: recent, company: 'Co seen', seen: true })      // flagged seen before: hidden on Leads
  done(J2)
  job(JT, 'A', 'a test-only fixture run', NOW - DAY, true); lead('fixture', JT, { machine: true, confirmed: true, date: recent }); done(JT)
  job(JB, 'B', 'Dental practices in Ohio that opened a new location', NOW - DAY); lead('other', JB, { machine: true, confirmed: true, date: recent }); done(JB)
  const since = NOW - 30 * DAY
  const page = await leadsPageReady([J1, J2], since)
  const r = await homeReady('A', NOW)
  assert.equal(r.ready, page.length, `Home ${r.ready} vs the Leads page ${JSON.stringify(page)}`)
  assert.ok(page.length >= 1, `the seed has ready leads, so the equality means something: ${JSON.stringify(page)}`)
  assert.deepEqual(page, ['ok1', 'ok2', 'ok3'], 'the confirmed, dated, in-window leads, each company once, nothing seen before')
  assert.ok(!page.includes('review') && !page.includes('notiming') && !page.includes('nodate') && !page.includes('rejected') && !page.includes('old') && !page.includes('unverified'))
  assert.deepEqual([r.scans_checked, r.scans_in_window], [2, 2], 'the test-only run and the other tenant\'s scan are not counted')
  // where the counted leads are, newest scan first: ok3 in J2; ok1 and ok2 in J1 ("again" is ok1's company, counted once)
  assert.deepEqual(r.scans, [{ job_id: J2, ready: 2 }, { job_id: J1, ready: 1 }])
  assert.equal(r.scans.reduce((n, x) => n + x.ready, 0), r.ready, 'the per-scan counts add up to the tile')
  // the route: 200 no-store with the same answer; 401 signed out
  const ok = await readyGET(); assert.equal(ok.status, 200); assert.equal(ok.headers.get('cache-control'), 'no-store')
  assert.equal((await ok.json() as { ready: number }).ready, r.ready)
  setUser(null); assert.equal((await readyGET()).status, 401)
})

test('#1040 Ready tile: a store that cannot be read answers 503 (never a 0)', async () => {
  seed()
  setScanDb({ prepare: () => { throw new Error('disk I/O error') } } as never)
  const res = await readyGET(); assert.equal(res.status, 503)
  assert.equal('ready' in (await res.json() as object), false)
})

test('#1040 Ready tile: bounded to the newest scans, and it says how many it checked', async () => {
  const { job, lead, done } = seed()
  for (let i = 0; i < READY_SCANS_MAX + 2; i++) { const id = String(i).padStart(2, '0').repeat(12); job(id, 'A', 'Dental practices in Ohio that opened a new location', NOW - 20 * DAY + i); lead(`l${i}`, id, { machine: true, confirmed: true, date: recent }); done(id) }
  const r = await homeReady('A', NOW)
  assert.deepEqual([r.ready, r.scans_checked, r.scans_in_window], [READY_SCANS_MAX, READY_SCANS_MAX, READY_SCANS_MAX + 2])
})
