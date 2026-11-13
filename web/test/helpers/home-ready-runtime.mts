// #1040 acceptance 1: Home's Ready tile counts exactly the leads the Leads page shows ready. The real GET /api/leads (stubbed
// session, no network) per scan + the Leads page's split (previewSplit), against homeReady on the same store.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { NextRequest } from 'next/server'
import { setScanDb, setUser } from './tenant-route-db.ts'
import { migrateAllSqlite } from '../../lib/db/sqlite-migrations.ts'
import { heldReason, type PreviewLead } from '../../lib/journey.ts'
import { companyKey } from '../../lib/scan/evidence.ts'
import { GET as leadsGET } from '../../app/api/leads/route.ts'
import { GET as readyGET } from '../../app/api/home/ready/route.ts'
import { homeReady, READY_LEADS_MAX } from '../../lib/outreach/home-ready.ts'
const READY_SCANS_MAX = 10   // the old scan bound: the whole window is judged now, so more scans than this must all count

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
  const lead = (id: string, jobId: string, o: { machine?: boolean; confirmed?: boolean; review?: string | null; date?: string | null; at?: number; quarantined?: boolean; fit?: number | null; company?: string; seen?: boolean; domain?: string; source?: string }) => db.prepare(
    "INSERT INTO leads (id, scan_job_id, company, signal, source_url, confidence, evidence_excerpt, review_reason, event_date, date_status, fit, created_at, quarantined_at, human_confirmed_at, seen_before, company_domain, source_kind) VALUES (?, ?, ?, 'opened a new location', 'https://news.example/a', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(id, jobId, o.company ?? `Co ${id}`, o.machine ? 80 : null, o.machine ? `Co ${id} opened a new location` : null, o.review ?? null, o.date ?? null, o.date ? 'verified' : null, o.fit ?? null, o.at ?? NOW - DAY, o.quarantined ? NOW : null, o.confirmed ? NOW - DAY : null, o.seen ? 1 : 0, o.domain ?? null, o.source ?? null)
  const done = (id: string) => db.prepare("UPDATE scan_jobs SET status = 'done' WHERE id = ?").run(id)
  return { db, job, lead, done }
}
// What a user sees: the REAL GET /api/leads rows (every hold as the Leads page gets it), minus rejected rows and the
// "seen before" rows Leads hides by default; one verdict per company (the first time it is met, newest scan first): ready,
// or Home's own hold reason (heldReason).
async function leadsPageVerdicts(jobIds: string[], since: number) {
  // every judged lead's own verdict from the real route, then one per company (same domain or same normalised name):
  // ready when any of its leads is, else the reason of the first one met
  const groups: { keys: Set<string>; ready: string | null; reason: string }[] = []
  for (const jobId of jobIds) {
    const res = await leadsGET(new NextRequest(`http://test/api/leads?job_id=${jobId}`))
    assert.equal(res.status, 200)
    const rows = (await res.json() as { leads: (PreviewLead & { created_at: number; seen_before?: number; quarantined_at?: unknown; source_kind?: string | null; company: string; company_domain?: string | null })[] }).leads
    for (const l of rows.filter(l => l.created_at >= since && !l.seen_before && !l.quarantined_at && l.source_kind !== 'test')) {
      const keys = [l.company_domain ? `d:${l.company_domain.toLowerCase()}` : '', `n:${companyKey(l.company)}`].filter(k => k.length > 2)
      let g = groups.find(x => keys.some(k => x.keys.has(k)))
      const why = heldReason(l)
      if (!g) { g = { keys: new Set(), ready: why ? null : l.id, reason: why ?? '' }; groups.push(g) } else if (!why && !g.ready) g.ready = l.id
      for (const k of keys) g.keys.add(k)
    }
  }
  const held: Record<string, number> = {}
  for (const g of groups) if (!g.ready) held[g.reason] = (held[g.reason] ?? 0) + 1
  return { ready: groups.filter(g => g.ready).map(g => g.ready as string).sort(), held, judged: groups.length }
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
  // newest scan first, as the tile walks them
  const v = await leadsPageVerdicts([J2, J1], since), page = v.ready
  const r = await homeReady('A', NOW)
  assert.equal(r.ready, page.length, `Home ${r.ready} vs the Leads page ${JSON.stringify(page)}`)
  assert.ok(page.length >= 1, `the seed has ready leads, so the equality means something: ${JSON.stringify(page)}`)
  assert.deepEqual(page, ['again', 'ok2', 'ok3'], 'the confirmed, dated, in-window leads, each company once ("again" is ok1\'s company, met first in the newer scan), nothing seen before')
  assert.ok(!page.includes('ok1') && !page.includes('review') && !page.includes('notiming') && !page.includes('nodate') && !page.includes('rejected') && !page.includes('old') && !page.includes('unverified'))
  assert.deepEqual([r.scans_checked, r.scans_in_window], [2, 2], 'the test-only run and the other tenant\'s scan are not counted')
  // where the counted leads are, newest scan first: ok3 in J2; ok1 and ok2 in J1 ("again" is ok1's company, counted once)
  assert.deepEqual(r.scans, [{ job_id: J2, ready: 2 }, { job_id: J1, ready: 1 }])
  assert.equal(r.scans.reduce((n, x) => n + x.ready, 0), r.ready, 'the per-scan counts add up to the tile')
  // the breakdown: the same reasons and counts the real Leads route gives, one company once, and it adds up
  assert.deepEqual(Object.fromEntries(r.held.map(h => [h.reason, h.count])), v.held)
  assert.deepEqual(v.held, { 'needs your review': 1, 'event timing unknown': 2, 'source not verified': 1 }, 'review; notiming + nodate (machine-verified, no timing proof); unverified')
  assert.equal(r.ready + r.held.reduce((n, h) => n + h.count, 0), r.judged); assert.equal(r.judged, v.judged)
  assert.equal(r.judged, 7, 'rejected, older, seen-before, fixture and the other tenant\'s leads are not judged; Co ok1 once')
  // each line opens where its leads are: one scan -> that scan; several -> null (the page then opens the list of scans)
  assert.deepEqual(r.held.map(h => [h.reason, h.job_id, h.scans]), [['event timing unknown', J1, 1], ['needs your review', J1, 1], ['source not verified', J2, 1]])
  // the route: 200 no-store with the same answer; 401 signed out
  const ok = await readyGET(); assert.equal(ok.status, 200); assert.equal(ok.headers.get('cache-control'), 'no-store')
  assert.equal((await ok.json() as { ready: number }).ready, r.ready)
  setUser(null); assert.equal((await readyGET()).status, 401)
})

test('#1040 Ready tile: a held company found by two scans counts once, and its line then spans the scans; another tenant sees none of it', async () => {
  const { job, lead, done } = seed()
  const J1 = 'a'.repeat(24), J2 = 'b'.repeat(24)
  job(J1, 'A', 'Dental practices in Ohio that opened a new location', NOW - 3 * DAY); lead('r1', J1, { review: 'quote_unconfirmed', date: recent, company: 'Same Co' }); lead('r2', J1, { review: 'quote_unconfirmed', date: recent }); done(J1)
  job(J2, 'A', 'Dental practices in Ohio that opened a new location', NOW - 2 * DAY); lead('r3', J2, { review: 'quote_unconfirmed', date: recent, company: 'Same Co' }); lead('r4', J2, { review: 'quote_unconfirmed', date: recent }); done(J2)
  const r = await homeReady('A', NOW)
  assert.deepEqual([r.ready, r.judged], [0, 3]); assert.deepEqual(r.held, [{ reason: 'needs your review', count: 3, job_id: null, scans: 2 }])
  const b = await homeReady('B', NOW)
  assert.deepEqual([b.ready, b.judged, b.held, b.scans_in_window], [0, 0, [], 0])
})

// independent review of d92adb00: R1 (ready wins), R2 (scans with nothing to judge take no slot), R4 (domain or name)
test('#1040 Ready tile: ready wins over a newer held lead of the same company; hidden-only scans take no slot; one company by domain or name', async () => {
  const { job, lead, done } = seed()
  const OLD = 'a'.repeat(24), NEW = 'b'.repeat(24)
  job(OLD, 'A', 'Dental practices in Ohio that opened a new location', NOW - 20 * DAY)
  lead('old-ready', OLD, { machine: true, confirmed: true, date: recent, company: 'Same Co', at: NOW - 20 * DAY })
  lead('acme1', OLD, { machine: true, confirmed: true, date: recent, company: 'Acme', domain: 'acme.com', at: NOW - 20 * DAY })
  lead('acme2', OLD, { machine: true, confirmed: true, date: recent, company: 'Acme', at: NOW - 20 * DAY })
  lead('acme3', OLD, { machine: true, confirmed: true, date: recent, company: 'Acme, Inc.', domain: 'acme.com', at: NOW - 20 * DAY })
  done(OLD)
  job(NEW, 'A', 'Dental practices in Ohio that opened a new location', NOW - 2 * DAY); lead('new-review', NEW, { review: 'quote_unconfirmed', date: recent, company: 'Same Co' }); done(NEW)
  // ten newer scans whose only leads are hidden as a poor fit, rejected, or seen before: nothing the tile can judge
  for (let i = 0; i < READY_SCANS_MAX; i++) { const id = `c${String(i).padStart(2, '0')}`.repeat(8); job(id, 'A', 'Dental practices in Ohio that opened a new location', NOW - DAY + i)
    lead(`h${i}`, id, { machine: true, confirmed: true, date: recent, fit: 1 }); lead(`q${i}`, id, { machine: true, confirmed: true, date: recent, quarantined: true }); lead(`s${i}`, id, { machine: true, confirmed: true, date: recent, seen: true }); done(id) }
  const r = await homeReady('A', NOW)
  assert.deepEqual([r.scans_checked, r.scans_in_window], [2, 2], 'the ten scans with nothing to judge are not scans to check')
  assert.deepEqual([r.ready, r.judged, r.held], [2, 2, []], 'Same Co is ready (its older lead is), Acme is one company by domain or name')
  assert.deepEqual(r.scans, [{ job_id: OLD, ready: 2 }], 'the tile opens the scan whose Leads page shows them ready')
  const v = await leadsPageVerdicts([NEW, OLD], NOW - 30 * DAY)
  assert.deepEqual([v.ready.length, v.judged, v.held], [r.ready, r.judged, {}])
})

test('#1040 Ready tile: a store that cannot be read answers 503 (never a 0)', async () => {
  seed()
  setScanDb({ prepare: () => { throw new Error('disk I/O error') } } as never)
  const res = await readyGET(); assert.equal(res.status, 503)
  assert.equal('ready' in (await res.json() as object), false)
})

test('#1040 Ready tile: the whole 30-day window is judged, however many scans (no "newest 10")', async () => {
  const { job, lead, done } = seed()
  for (let i = 0; i < READY_SCANS_MAX + 2; i++) { const id = String(i).padStart(2, '0').repeat(12); job(id, 'A', 'Dental practices in Ohio that opened a new location', NOW - 20 * DAY + i); lead(`l${i}`, id, { machine: true, confirmed: true, date: recent }); done(id) }
  const r = await homeReady('A', NOW)
  assert.deepEqual([r.ready, r.judged, r.scans_checked, r.scans_in_window, r.capped, r.leads_checked, r.leads_in_window], [12, 12, 12, 12, false, 12, 12])
  assert.equal(r.companies.length, 12); assert.ok(r.companies.every(c => c.ready))
  assert.ok(READY_LEADS_MAX >= 600)
})

// Review (Hermes-PC) at 14037ed4, finding 2: the three limit cases, scaled down through the limits argument. The number is
// a lower bound and says so (capped), scans_checked counts only scans judged completely, and the counts of leads are true.
test('#1040 Ready tile: past the lead limit the answer says it stopped, and never counts a scan it did not finish', async () => {
  { // 3 newest scans of 2 needs-review leads each, an older scan of 2 ready leads; limit 6
    const { job, lead, done } = seed()
    for (let i = 0; i < 3; i++) { const id = `n${i}`.repeat(12); job(id, 'A', 'Dental practices in Ohio that opened a new location', NOW - 5 * DAY + i); for (let k = 0; k < 2; k++) lead(`rv${i}${k}`, id, { review: 'quote_unconfirmed', date: recent }); done(id) }
    const old = 'o0'.repeat(12); job(old, 'A', 'Dental practices in Ohio that opened a new location', NOW - 20 * DAY); for (let k = 0; k < 2; k++) lead(`rd${k}`, old, { machine: true, confirmed: true, date: recent, at: NOW - 20 * DAY }); done(old)
    const r = await homeReady('A', NOW, { maxLeads: 6 })
    assert.deepEqual([r.ready, r.capped, r.scans_checked, r.scans_in_window, r.leads_checked, r.leads_in_window], [0, true, 3, 4, 6, 8], 'the older scan was not reached: capped, 3 of 4 scans')
    const all = await homeReady('A', NOW)
    assert.deepEqual([all.ready, all.capped, all.scans_checked], [2, false, 4], 'without the limit the 2 ready leads count') }
  { // 5 scans of 2 ready leads; limit 6: three scans judged, not four
    const { job, lead, done } = seed()
    for (let i = 0; i < 5; i++) { const id = `p${i}`.repeat(12); job(id, 'A', 'Dental practices in Ohio that opened a new location', NOW - 5 * DAY + i); for (let k = 0; k < 2; k++) lead(`ok${i}${k}`, id, { machine: true, confirmed: true, date: recent }); done(id) }
    const r = await homeReady('A', NOW, { maxLeads: 6 })
    assert.deepEqual([r.ready, r.capped, r.scans_checked, r.scans_in_window, r.leads_checked, r.leads_in_window], [6, true, 3, 5, 6, 10]) }
  { // one scan holding more leads than one read returns: capped, and that scan is not "checked"
    const { job, lead, done } = seed()
    const id = 'q0'.repeat(12); job(id, 'A', 'Dental practices in Ohio that opened a new location', NOW - 5 * DAY); for (let k = 0; k < 5; k++) lead(`big${k}`, id, { machine: true, confirmed: true, date: recent }); done(id)
    const r = await homeReady('A', NOW, { perScan: 3 })
    assert.deepEqual([r.ready, r.capped, r.scans_checked, r.scans_in_window, r.leads_checked, r.leads_in_window], [3, true, 0, 1, 3, 5]) }
})

// finding 4: the required-check hold and fixture leads
test('#1040 Ready tile: a lead held by a required check is counted under that reason; a fixture lead in a real scan is never counted', async () => {
  const { db, job, lead, done } = seed()
  const J = 'a'.repeat(24), L = 'b'.repeat(24)
  job(J, 'A', 'Dental practices in Ohio that opened a new location', NOW - 3 * DAY)
  lead('real', J, { machine: true, confirmed: true, date: recent }); lead('fx', J, { machine: true, confirmed: true, date: recent, source: 'test', company: 'Fixture Co' }); done(J)
  // a sales-hiring request with no pass record for its required check (DEFAULT-DENY, #1062): the confirmed lead is held by it
  db.prepare("INSERT INTO scan_jobs (id, user_id, business_name, industry, location, query, icp, status, candidates, created_at) VALUES (?, 'A', 'x', '(from request)', '-', 'Find London UK companies hiring sales account executives.', ?, 'running', 3, ?)").run(L, JSON.stringify({ signals: ['hiring sales account executives'] }), NOW - 2 * DAY)
  lead('gated', L, { machine: true, confirmed: true, date: recent, company: 'Gated Co' }); done(L)
  const r = await homeReady('A', NOW)
  assert.deepEqual([r.ready, r.judged], [1, 2], 'the fixture lead is not judged')
  assert.deepEqual(r.held, [{ reason: 'a required check has not passed', count: 1, job_id: L, scans: 1 }])
  assert.deepEqual(r.companies.map(c => [c.lead_id, c.ready, c.reason]), [['gated', false, 'a required check has not passed'], ['real', true, '']])
  assert.ok(!r.companies.some(c => c.company === 'Fixture Co'))
})
