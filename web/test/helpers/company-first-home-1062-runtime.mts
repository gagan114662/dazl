// #1062 live check on prod 23c6533 (PARTIAL): after #1466 the run pages and Past scans read the company-first gate, but three paths still
// did not. (1) Home's "N need your review (in M scans)" and /app/leads/checked?why=needs%20your%20review listed held company-first
// candidates as "Needs your review"; (2) Home's "Latest leads" listed held candidates as leads; (3) the Past scans link text count
// disagreed with the run page's held count (2593ed95: "2 research-only leads" with 3 held). Every view must read the same gate
// (companyFirstResults: the run page's /api/leads held[]), failing closed.
// Real GET /api/home/ready, /api/home/results, /api/campaigns (list + history) and /api/leads handlers on one SQLite store; stubbed session, no network.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { NextRequest } from 'next/server'
import { setScanDb, setUser } from './tenant-route-db.ts'
import { migrateAllSqlite } from '../../lib/db/sqlite-migrations.ts'
import { markCompanyFirstBudget } from '../../lib/company-first/product-discovery.ts'
import { migrateCompanyFirstPublishedDisplay } from '../../lib/people/company-first-published-display.ts'
import { seed } from './company-first-visible-seed.ts'
import { GET as leadsGET } from '../../app/api/leads/route.ts'
import { GET as readyGET } from '../../app/api/home/ready/route.ts'
import { GET as resultsGET } from '../../app/api/home/results/route.ts'
import { GET as campaignsGET } from '../../app/api/campaigns/route.ts'

globalThis.fetch = (async () => { throw new Error('Unexpected network call') }) as typeof fetch
const NOW = Math.floor(Date.now() / 1000), DAY = 86400
const recent = new Date(Date.now() - 10 * DAY * 1000).toISOString().slice(0, 10)   // inside the 45-day company-first window

test('Home (ready lines, checked list, latest leads) and Past scans read the company-first gate: held candidates are never "need your review" or leads', async () => {
  const db = new Database(':memory:'); migrateAllSqlite(db)
  setScanDb(db); setUser({ id: 'A', business_name: 'Acme' })
  const job = (id: string, at: number) => db.prepare("INSERT INTO scan_jobs (id, user_id, business_name, industry, location, query, icp, status, candidates, created_at) VALUES (?, 'A', '(from request)', '-', ?, ?, '{}', 'running', 3, ?)")
    .run(id, '-', 'Find London software companies that raised a Series A round.', at)
  const lead = (id: string, jobId: string, company: string, date: string | null) => db.prepare("INSERT INTO leads (id, scan_job_id, company, name, contact, signal, source_url, confidence, evidence_excerpt, review_reason, event_date, score, created_at) VALUES (?, ?, ?, 'Pat', 'pat@held.test', 'Raised a Series A', 'https://held.example/a', NULL, NULL, 'quote_unconfirmed', ?, 70, ?)")
    .run(id, jobId, company, date, NOW - DAY)
  // The prod shape: a finished company-first scan, its leads all held by its final checks. One has a reviewable reason and an in-window date;
  // two are undated (the time window already makes them research), so the old Past scans text said "2 research-only leads" beside 3 held.
  const cf = 'c'.repeat(24), plain = 'p'.repeat(24)
  job(cf, NOW - 2 * DAY)
  lead('a'.repeat(24), cf, 'Lanesurf', recent); lead('b'.repeat(24), cf, 'TTC Global', null); lead('d'.repeat(24), cf, 'Bask Health', null)
  db.prepare("UPDATE scan_jobs SET status='done', enrich_started_at=?, enrich_finished_at=?, run_budget=? WHERE id=?").run(NOW - DAY, NOW - DAY + 60, markCompanyFirstBudget(null), cf)
  // Control: an ordinary scan whose lead is in the review list still needs review and is still a lead.
  job(plain, NOW - 3 * DAY)
  lead('e'.repeat(24), plain, 'Review Co', recent)
  db.prepare("UPDATE scan_jobs SET status='done' WHERE id=?").run(plain)
  const heldNames = ['Lanesurf', 'TTC Global', 'Bask Health']

  // the run page's gate: no lead shown, all three held
  const run = await (await leadsGET(new NextRequest(`http://test/api/leads?job_id=${cf}`))).json() as { leads: unknown[]; held: { company: string }[] }
  assert.deepEqual([run.leads.length, run.held.map(h => h.company).sort()], [0, [...heldNames].sort()], 'run page: 0 leads, 3 held')

  // (1) Home's ready lines and the checked list (/app/leads/checked reads the same /api/home/ready companies)
  const ready = await (await readyGET(new NextRequest('http://test/api/home/ready'))).json() as { held: { reason: string; count: number }[]; companies: { company: string; ready: boolean; reason: string }[] }
  const byName = new Map(ready.companies.map(c => [c.company, c]))
  for (const n of heldNames) {
    const c = byName.get(n)
    assert.ok(c, `${n} is judged`)
    assert.equal(c.ready, false, `${n} is not ready`)
    assert.notEqual(c.reason, 'needs your review', `${n} is never "needs your review" (it is held by the scan's final checks)`)
    assert.equal(c.reason, 'held by the final checks', `${n}: the reason the run page gives`)
  }
  assert.deepEqual(ready.held.find(h => h.reason === 'needs your review')?.count, 1, 'only the control lead needs review')
  assert.equal(byName.get('Review Co')?.reason, 'needs your review', 'control: an ordinary review lead still needs review')

  // (2) Home's results: latest leads and the new-leads tile count only leads a Leads page shows
  const results = await (await resultsGET(new NextRequest('http://test/api/home/results'))).json() as { tiles: { leads: number }; latest_leads: { company: string }[]; by_signal: { leads: number }[] }
  assert.deepEqual(results.latest_leads.map(l => l.company), ['Review Co'], 'latest leads: the held candidates are not leads')
  assert.equal(results.tiles.leads, 1, 'new leads tile: the held candidates are not counted')
  assert.equal(results.by_signal.reduce((n, r) => n + r.leads, 0), 1, 'by-signal rows still add up to the tile')

  // (3) Past scans (history) and the Campaigns list: the link text counts exactly the run page's held candidates
  for (const url of ['http://test/api/campaigns?view=history', 'http://test/api/campaigns']) {
    const cards = (await (await campaignsGET(new NextRequest(url))).json() as { campaigns: { id: string; next: { label: string }; qualification: { needsReview: number; heldByChecks?: number } }[] }).campaigns
    const c = cards.find(x => x.id === cf)!
    assert.equal(c.qualification.needsReview, 0, `${url}: nothing to review`)
    assert.equal(c.qualification.heldByChecks, run.held.length, `${url}: held by checks = the run page's held count`)
    assert.equal(c.next.label, `${run.held.length} leads are held by checks (read-only): open the run to see why`, `${url}: the link text counts what the run page holds`)
  }
})

// Positive control and the unfinished-checks reason (council on #1475): a company-first scan whose gate SHOWS one lead (River Ledger, verified
// display proof) and holds another (Other Co). The shown lead stays a lead everywhere; only the held one is held. Then a new enrichment
// attempt starts: until the checks finish, every lead of the scan is "final checks not finished", never "needs your review" and never a lead.
test('Home and Past scans: a lead the gate shows stays a lead; until the checks finish nothing of the scan is a lead or needs review', async () => {
  const db = new Database(':memory:'); migrateAllSqlite(db); migrateCompanyFirstPublishedDisplay(db)
  setScanDb(db)
  const s = await seed(db)
  setUser({ id: s.tenant, business_name: 'Seller' })
  db.prepare("UPDATE scan_jobs SET status='done', candidates=2, dropped=0, enrich_started_at=?, enrich_finished_at=? WHERE id=?").run(s.at - 60, s.at, s.id)
  const run = await (await leadsGET(new NextRequest(`http://test/api/leads?job_id=${s.id}`))).json() as { leads: { company: string }[]; held: { company: string }[] }
  assert.deepEqual([run.leads.map(l => l.company), run.held.map(h => h.company)], [['River Ledger'], ['Other Co']], 'run page: one shown, one held')

  const readyOf = async () => new Map((await (await readyGET(new NextRequest('http://test/api/home/ready'))).json() as { companies: { company: string; reason: string }[] }).companies.map(c => [c.company, c.reason]))
  const resultsOf = async () => await (await resultsGET(new NextRequest('http://test/api/home/results'))).json() as { tiles: { leads: number }; latest_leads: { company: string }[] }
  const cardOf = async (url: string) => (await (await campaignsGET(new NextRequest(url))).json() as { campaigns: { id: string; next: { label: string }; qualification: { needsReview: number; sourceChecked: number; heldByChecks?: number } }[] }).campaigns.find(c => c.id === s.id)!

  let ready = await readyOf()
  assert.equal(ready.get('Other Co'), 'held by the final checks', 'the held lead: held by the final checks')
  assert.ok(!['held by the final checks', 'final checks not finished'].includes(ready.get('River Ledger') ?? ''), `the shown lead is judged by its own checks (${ready.get('River Ledger')})`)
  let results = await resultsOf()
  assert.deepEqual([results.tiles.leads, results.latest_leads.map(l => l.company)], [1, ['River Ledger']], 'the shown lead is a lead; the held one is not')
  for (const url of ['http://test/api/campaigns?view=history', 'http://test/api/campaigns']) {
    const c = await cardOf(url)
    assert.deepEqual([c.qualification.sourceChecked, c.qualification.heldByChecks, c.qualification.needsReview], [1, 1, 0], `${url}: the shown lead counted, the held one held`)
  }

  // a new enrichment attempt: the scan's final checks have not run for it yet
  db.prepare('UPDATE scan_jobs SET enrich_started_at = ?, enrich_finished_at = NULL WHERE id = ?').run(Math.floor(Date.now() / 1000) - 60, s.id)
  ready = await readyOf()
  assert.deepEqual([ready.get('River Ledger'), ready.get('Other Co')], ['final checks not finished', 'final checks not finished'], 'checks running: not finished, never "needs your review"')
  results = await resultsOf()
  assert.deepEqual([results.tiles.leads, results.latest_leads], [0, []], 'checks running: no lead of the scan is a lead yet')
  for (const url of ['http://test/api/campaigns?view=history', 'http://test/api/campaigns']) {
    const c = await cardOf(url)
    assert.deepEqual([c.next.label, c.qualification.needsReview], ['Search still running', 0], `${url}: still running`)
  }
})
