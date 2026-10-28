// Dated sales / GTM postings from a company's PUBLIC Greenhouse / Lever / Ashby board, for a seed-funded lead. Stubbed JSON, invented
// companies and postings; no network. The board is evidence beside the lead (an enrichment), never a date or verdict for the lead itself.
import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { atsGtmHiring, isGtmRole, domainInText } from '../lib/signals/ats-gtm.ts'
import { enrichJobSignals } from '../lib/signals/index.ts'
import { migrateScan, createJob } from '../lib/scan/store.ts'
import { migrateConnectors, recentAudit } from '../lib/connectors/store.ts'
import { migrateEvents } from '../lib/events/store.ts'

const NOW = Date.parse('2026-10-28T12:00:00Z')
const d = (n: number) => new Date(NOW - n * 86_400_000).toISOString()
const ok = (b: unknown) => new Response(JSON.stringify(b), { status: 200 })
const no = () => new Response('nope', { status: 404 })
const route = (m: Record<string, unknown>) => (async (u: RequestInfo | URL) => { const k = Object.keys(m).find(x => String(u) === x); return k ? ok(m[k]) : no() }) as never

test('isGtmRole: sales / GTM titles yes; engineering, Salesforce developers and sales tax no', () => {
  for (const t of ['Account Executive, London', 'Senior Sales Development Representative', 'Head of Growth', 'GTM Operations Manager', 'Business Development Manager', 'Sales Engineer', 'VP Sales', 'Customer Success Manager', 'Revenue Operations Lead']) assert.equal(isGtmRole(t), true, t)
  for (const t of ['Senior Backend Engineer', 'Salesforce Developer', 'Sales Tax Accountant', 'Software Engineer, Payments', 'Data Scientist', 'Office Manager']) assert.equal(isGtmRole(t), false, t)
})

const GH = 'https://boards-api.greenhouse.io/v1/boards/brightloop'
const ghBoard = {
  [`${GH}/jobs`]: { jobs: [{ id: 1, title: 'Account Executive', updated_at: d(1) }, { id: 2, title: 'Backend Engineer', updated_at: d(1) }, { id: 3, title: 'Head of Sales', updated_at: d(1) }, { id: 4, title: 'SDR', updated_at: d(1) }] },
  [`${GH}/jobs/1`]: { id: 1, title: 'Account Executive', first_published: d(12), updated_at: d(1), absolute_url: 'https://boards.greenhouse.io/brightloop/jobs/1', location: { name: 'London, UK' }, content: '&lt;p&gt;Join Brightloop. Apply at careers@brightloop.io&lt;/p&gt;' },
  [`${GH}/jobs/3`]: { id: 3, title: 'Head of Sales', first_published: d(30), updated_at: d(1), absolute_url: 'https://boards.greenhouse.io/brightloop/jobs/3', location: { name: 'London, UK' }, content: '&lt;p&gt;Lead sales at https://www.brightloop.io&lt;/p&gt;' },
  [`${GH}/jobs/4`]: { id: 4, title: 'SDR', first_published: d(400), updated_at: d(1), absolute_url: 'https://boards.greenhouse.io/brightloop/jobs/4', location: { name: 'London, UK' }, content: 'old' },
}

test('Greenhouse: only fresh GTM postings, dated by first_published (never updated_at); the board names the company domain; engineering is ignored', async () => {
  const g = await atsGtmHiring('Brightloop Ltd', 'brightloop.io', route(ghBoard), { now: NOW })
  assert.ok(g); assert.equal(g!.board, 'greenhouse'); assert.equal(g!.via, 'domain')
  assert.deepEqual(g!.postings.map(p => [p.title, p.date]), [['Account Executive', d(12).slice(0, 10)], ['Head of Sales', d(30).slice(0, 10)]], 'newest first; the 400-day-old SDR and the engineer are out')
  assert.equal(g!.newest, d(12).slice(0, 10)); assert.equal(g!.domain, 'brightloop.io'); assert.equal(g!.url, 'https://boards.greenhouse.io/brightloop')
})

test('a posting with only updated_at (no first_published) is not dated, so it is not evidence', async () => {
  const board = { [`${GH}/jobs`]: ghBoard[`${GH}/jobs`], [`${GH}/jobs/1`]: { id: 1, title: 'Account Executive', updated_at: d(1), absolute_url: 'https://boards.greenhouse.io/brightloop/jobs/1' } }
  assert.equal(await atsGtmHiring('Brightloop', 'brightloop.io', route(board), { now: NOW }), null)
})

test('identity: a domain-less lead needs the Greenhouse board NAME to match the company; a same-token fund or another company is refused', async () => {
  const withName = (name: string) => ({ ...ghBoard, [GH]: { name } })
  assert.ok(await atsGtmHiring('Brightloop', null, route(withName('Brightloop, Inc.')), { now: NOW }))
  assert.equal(await atsGtmHiring('Brightloop', null, route(withName('Brightloop Ventures Fund II')), { now: NOW }), null)
  assert.equal(await atsGtmHiring('Brightloop', null, route(ghBoard), { now: NOW }), null, 'no board name at all: unconfirmed')
})

test('a company domain named inside the postings must agree with the lead’s domain', async () => {
  const other = { ...ghBoard, [`${GH}/jobs/1`]: { ...(ghBoard[`${GH}/jobs/1`] as object), content: '&lt;p&gt;Write to jobs@brightloop.com&lt;/p&gt;' } }
  assert.equal(await atsGtmHiring('Brightloop', 'brightloop.io', route(other), { now: NOW }), null, 'brightloop.com is another company’s site')
  assert.equal(domainInText('see https://www.brightloop.co.uk/jobs', 'brightloop'), 'brightloop.co.uk'); assert.equal(domainInText('nothing here', 'brightloop'), null)
})

test('Lever (createdAt epoch ms) and Ashby (publishedAt, listed only) boards: domain-derived tokens, dated postings', async () => {
  const lever = await atsGtmHiring('Brightloop', 'brightloop.io', route({ 'https://api.lever.co/v0/postings/brightloop?mode=json': [
    { text: 'Account Executive', hostedUrl: 'https://jobs.lever.co/brightloop/a', createdAt: NOW - 5 * 86_400_000, categories: { location: 'London' }, descriptionPlain: 'Join us at brightloop.io' },
    { text: 'Platform Engineer', hostedUrl: 'https://jobs.lever.co/brightloop/b', createdAt: NOW - 5 * 86_400_000 },
    { text: 'Sales Manager', hostedUrl: 'https://jobs.lever.co/brightloop/c', createdAt: 'not a number' },
  ] }), { now: NOW })
  assert.ok(lever); assert.equal(lever!.board, 'lever'); assert.equal(lever!.postings.length, 1); assert.equal(lever!.newest, new Date(NOW - 5 * 86_400_000).toISOString().slice(0, 10))
  const ashby = await atsGtmHiring('Brightloop', 'brightloop.io', route({ 'https://api.ashbyhq.com/posting-api/job-board/brightloop': { jobs: [
    { title: 'Sales Development Representative', jobUrl: 'https://jobs.ashbyhq.com/brightloop/1', isListed: true, publishedAt: d(7), location: 'London' },
    { title: 'Account Executive', jobUrl: 'https://jobs.ashbyhq.com/brightloop/2', isListed: false, publishedAt: d(7) },
  ] } }), { now: NOW })
  assert.ok(ashby); assert.equal(ashby!.board, 'ashby'); assert.equal(ashby!.postings.length, 1)
  // Lever / Ashby carry no company name: with no lead domain they are never used
  assert.equal(await atsGtmHiring('Brightloop', null, route({ 'https://api.lever.co/v0/postings/brightloop?mode=json': [{ text: 'Account Executive', hostedUrl: 'https://jobs.lever.co/brightloop/a', createdAt: NOW - 86_400_000 }] }), { now: NOW }), null)
})

test('no GTM roles, no board, unreachable board: null (nothing invented)', async () => {
  assert.equal(await atsGtmHiring('Brightloop', 'brightloop.io', route({ [`${GH}/jobs`]: { jobs: [{ id: 2, title: 'Backend Engineer' }] } }), { now: NOW }), null)
  assert.equal(await atsGtmHiring('Brightloop', 'brightloop.io', (async () => no()) as never, { now: NOW }), null)
  assert.equal(await atsGtmHiring('Brightloop', 'brightloop.io', (async () => { throw new Error('boom') }) as never, { now: NOW }), null)
})

test('enrichJobSignals: a seed-funded lead gets a dated "N sales/GTM roles posted" enrichment with the board URL and the newest posting date; audited', async () => {
  const db = new Database(':memory:'); migrateScan(db); migrateConnectors(db); migrateEvents(db)
  const jobId = createJob(db, 'u1', { business_name: 'B', industry: 'I', location: 'L' })
  db.prepare("UPDATE scan_jobs SET status = 'running' WHERE id = ?").run(jobId)
  db.prepare("INSERT INTO leads (id, scan_job_id, name, company, company_domain, signal, source_url) VALUES ('lead1', ?, '', 'Brightloop', 'brightloop.io', 'raised a seed round', 'https://news.example/1')").run(jobId)
  // The domain was chosen from the cited page itself (its own domain): the board under it is the company's own.
  db.prepare("INSERT INTO lead_enrichments (id, lead_id, tenant_id, connector, kind, value, label, confidence, source_url, source_date, retrieved_at) VALUES ('D1', 'lead1', 'u1', 'sitecrawl', 'domain', 'brightloop.io|evidence_own_domain', 'x', NULL, 'https://brightloop.io/', '2026-10-28', 1)").run()
  const realNow = Date.now; Date.now = () => NOW
  try { await enrichJobSignals(db, 'u1', jobId, { fetchImpl: route(ghBoard) }) } finally { Date.now = realNow }
  const rows = db.prepare("SELECT connector, kind, value, label, source_url, source_date FROM lead_enrichments WHERE connector = 'signals:greenhouse-gtm'").all() as { connector: string; kind: string; value: string; label: string; source_url: string; source_date: string }[]
  assert.equal(rows.length, 1); assert.equal(rows[0].kind, 'hiring'); assert.equal(rows[0].value, `2 sales/GTM roles posted, newest ${d(12).slice(0, 10)}`)
  assert.equal(rows[0].source_date, d(12).slice(0, 10)); assert.equal(rows[0].source_url, 'https://boards.greenhouse.io/brightloop'); assert.match(rows[0].label, /Account Executive; Head of Sales/)
  assert.ok((recentAudit(db, 'u1', 20) as { connector: string; status: string }[]).some(a => a.connector === 'signals:ats-gtm' && a.status === 'ok'))
  // a lead of a different company with no board: no row, audit empty
  const db2 = new Database(':memory:'); migrateScan(db2); migrateConnectors(db2); migrateEvents(db2)
  const j2 = createJob(db2, 'u1', { business_name: 'B', industry: 'I', location: 'L' }); db2.prepare("UPDATE scan_jobs SET status = 'running' WHERE id = ?").run(j2)
  db2.prepare("INSERT INTO leads (id, scan_job_id, name, company, company_domain, signal, source_url) VALUES ('l2', ?, '', 'Other Co', 'other.example', 'raised a seed round', 'https://news.example/2')").run(j2)
  await enrichJobSignals(db2, 'u1', j2, { fetchImpl: (async () => no()) as never })
  assert.equal((db2.prepare("SELECT count(*) AS n FROM lead_enrichments WHERE connector LIKE '%gtm'").get() as { n: number }).n, 0)
})

test('Juicebox-type identity: a board found under a domain matched only by NAME (probe / link) is shown as unconfirmed, unscored, and never written to the company\u2019s hiring history', async () => {
  const mk = (basis: string | null) => {
    const db = new Database(':memory:'); migrateScan(db); migrateConnectors(db); migrateEvents(db)
    const jobId = createJob(db, 'u1', { business_name: 'B', industry: 'I', location: 'L' }); db.prepare("UPDATE scan_jobs SET status = 'running' WHERE id = ?").run(jobId)
    db.prepare("INSERT INTO leads (id, scan_job_id, name, company, company_domain, signal, source_url) VALUES ('lead1', ?, '', 'Brightloop', 'brightloop.io', 'second office in London', 'https://jobs.example/1')").run(jobId)
    if (basis) db.prepare("INSERT INTO lead_enrichments (id, lead_id, tenant_id, connector, kind, value, label, confidence, source_url, source_date, retrieved_at) VALUES ('D1', 'lead1', 'u1', 'sitecrawl', 'domain', ?, 'x', NULL, 'https://brightloop.io/', '2026-10-28', 1)").run(`brightloop.io|${basis}`)
    return { db, jobId }
  }
  const board = { 'https://boards-api.greenhouse.io/v1/boards/brightloop/jobs': { jobs: [{ title: 'Head of Sales', absolute_url: 'https://boards.greenhouse.io/brightloop/jobs/1' }, { title: 'Backend Engineer' }] }, ...ghBoard }
  for (const basis of ['name_probe', 'evidence_link_text', null]) {
    const { db, jobId } = mk(basis); const realNow = Date.now; Date.now = () => NOW
    try { await enrichJobSignals(db, 'u1', jobId, { fetchImpl: route(board) }) } finally { Date.now = realNow }
    const rows = db.prepare("SELECT connector, value, label, confidence FROM lead_enrichments WHERE kind = 'hiring'").all() as { connector: string; value: string; label: string; confidence: number | null }[]
    assert.ok(rows.length >= 1, String(basis))
    for (const r of rows) { assert.match(r.value, /^Unconfirmed: /, `${basis}: ${r.value}`); assert.equal(r.confidence, null); assert.match(r.label, /company-to-board relationship is not established/) }
    assert.equal((db.prepare("SELECT count(*) AS n FROM company_events WHERE event_type = 'hiring_surge'").get() as { n: number }).n, 0, `${basis}: no hiring-growth event for an unconfirmed board`)
  }
  const own = mk('evidence_own_domain'); const realNow = Date.now; Date.now = () => NOW
  try { await enrichJobSignals(own.db, 'u1', own.jobId, { fetchImpl: route(board) }) } finally { Date.now = realNow }
  const r2 = own.db.prepare("SELECT value, confidence FROM lead_enrichments WHERE kind = 'hiring' ORDER BY value").all() as { value: string; confidence: number | null }[]
  assert.ok(r2.length >= 1 && r2.every(r => !r.value.startsWith('Unconfirmed') && r.confidence !== null), JSON.stringify(r2))
})
