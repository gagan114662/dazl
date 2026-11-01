// Dated sales / GTM postings from a company's PUBLIC Greenhouse / Lever / Ashby board, for a seed-funded lead. Stubbed JSON, invented
// companies and postings; no network. The board is evidence beside the lead (an enrichment), never a date or verdict for the lead itself.
import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { atsGtmHiring, atsGtmBoard, isGtmRole, domainInText, domainsInText, dedupeTitles, boardTitleAudit, boardCoverageRow, checkedAuditRows, checkedCoverageRow, postingEvidence } from '../lib/signals/ats-gtm.ts'
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
  const rows = db.prepare("SELECT connector, kind, value, label, source_url, source_date FROM lead_enrichments WHERE connector = 'signals:greenhouse-gtm' AND value LIKE '%sales/GTM role%'").all() as { connector: string; kind: string; value: string; label: string; source_url: string; source_date: string }[]
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
  const board = { ...ghBoard, [`${GH}/jobs/1`]: { ...(ghBoard[`${GH}/jobs/1`] as object), content: '&lt;p&gt;Join Brightloop in London&lt;/p&gt;' }, [`${GH}/jobs/3`]: { ...(ghBoard[`${GH}/jobs/3`] as object), content: '&lt;p&gt;Lead sales&lt;/p&gt;' } }   // postings that name no company domain at all
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

// ---- #273 review: identity must be established independently; contradictory company domains across ALL included postings fail closed ----
function leadDb(domain: string | null, basis: string | null) {
  const db = new Database(':memory:'); migrateScan(db); migrateConnectors(db); migrateEvents(db)
  const jobId = createJob(db, 'u1', { business_name: 'B', industry: 'I', location: 'L' }); db.prepare("UPDATE scan_jobs SET status = 'running' WHERE id = ?").run(jobId)
  db.prepare("INSERT INTO leads (id, scan_job_id, name, company, company_domain, signal, source_url) VALUES ('lead1', ?, '', 'Brightloop', ?, 'raised a seed round', 'https://news.example/1')").run(jobId, domain)
  if (domain && basis) db.prepare("INSERT INTO lead_enrichments (id, lead_id, tenant_id, connector, kind, value, label, confidence, source_url, source_date, retrieved_at) VALUES ('D1', 'lead1', 'u1', 'sitecrawl', 'domain', ?, 'x', NULL, 'https://brightloop.io/', '2026-10-28', 1)").run(`${domain}|${basis}`)
  return { db, jobId }
}
const gh = (content1: string, content3 = 'Lead sales') => ({
  ...ghBoard, [GH]: { name: 'Brightloop, Inc.' },
  [`${GH}/jobs/1`]: { ...(ghBoard[`${GH}/jobs/1`] as object), content: content1 }, [`${GH}/jobs/3`]: { ...(ghBoard[`${GH}/jobs/3`] as object), content: content3 },
})
async function enrich(db: Database.Database, jobId: string, board: Record<string, unknown>) {
  const realNow = Date.now; Date.now = () => NOW
  try { await enrichJobSignals(db, 'u1', jobId, { fetchImpl: route(board) }) } finally { Date.now = realNow }
  return {
    gtm: db.prepare("SELECT value, label, confidence FROM lead_enrichments WHERE connector LIKE 'signals:%-gtm' AND value LIKE '%sales/GTM role%'").all() as { value: string; label: string; confidence: number | null }[],
    events: (db.prepare("SELECT count(*) AS n FROM company_events WHERE event_type = 'hiring_surge'").get() as { n: number }).n,
  }
}

test('enrichJobSignals: a lead with NO domain and a Greenhouse board whose NAME equals the company is Unconfirmed, no confidence, no history (the board’s own name claim is not proof)', async () => {
  const { db, jobId } = leadDb(null, null)
  const r = await enrich(db, jobId, gh('Join Brightloop in London'))
  assert.equal(r.gtm.length, 1); assert.match(r.gtm[0].value, /^Unconfirmed: 2 sales\/GTM roles/); assert.equal(r.gtm[0].confidence, null); assert.match(r.gtm[0].label, /not established/); assert.equal(r.events, 0)
})
test('enrichJobSignals: a heuristic (name-probe) domain stays Unconfirmed; an established domain is scored', async () => {
  const probe = leadDb('brightloop.io', 'name_probe'); const a = await enrich(probe.db, probe.jobId, gh('Join Brightloop in London'))
  assert.match(a.gtm[0].value, /^Unconfirmed:/); assert.equal(a.gtm[0].confidence, null); assert.equal(a.events, 0)
  const own = leadDb('brightloop.io', 'evidence_own_domain'); const b = await enrich(own.db, own.jobId, gh('Join Brightloop in London'))
  assert.doesNotMatch(b.gtm[0].value, /Unconfirmed/); assert.equal(b.gtm[0].confidence, 70)
})
test('enrichJobSignals: a LATER posting naming a different company domain (brightloop.com) is not masked by the first (brightloop.io): the board corroborates nothing', async () => {
  for (const [domain, basis] of [['brightloop.io', 'evidence_own_domain'], ['brightloop.io', 'name_probe'], [null, null]] as const) {
    const { db, jobId } = leadDb(domain, basis)
    const r = await enrich(db, jobId, gh('Write to jobs@brightloop.io', 'Write to jobs@brightloop.com'))
    assert.deepEqual(r.gtm, [], `${domain}/${basis}: contradictory boards write nothing, not even an unconfirmed row`); assert.equal(r.events, 0)
  }
})
test('enrichJobSignals: several company domains inside ONE posting (brightloop.io and brightloop.com) are contradictory too', async () => {
  const { db, jobId } = leadDb('brightloop.io', 'evidence_own_domain')
  const r = await enrich(db, jobId, gh('Apply at jobs@brightloop.io or see https://brightloop.com/careers'))
  assert.deepEqual(r.gtm, [])
})
test('contradictory domains across Lever and Ashby postings fail closed as well; agreeing ones pass', async () => {
  const lever = (a: string, b: string) => ({ 'https://api.lever.co/v0/postings/brightloop?mode=json': [
    { text: 'Account Executive', hostedUrl: 'https://jobs.lever.co/brightloop/a', createdAt: NOW - 5 * 86_400_000, descriptionPlain: a },
    { text: 'Sales Manager', hostedUrl: 'https://jobs.lever.co/brightloop/b', createdAt: NOW - 6 * 86_400_000, descriptionPlain: b }] })
  assert.equal(await atsGtmHiring('Brightloop', 'brightloop.io', route(lever('see brightloop.io', 'email x@brightloop.com')), { now: NOW }), null)
  assert.ok(await atsGtmHiring('Brightloop', 'brightloop.io', route(lever('see https://brightloop.io', 'email x@brightloop.io')), { now: NOW }))
  const ashby = (a: string, b: string) => ({ 'https://api.ashbyhq.com/posting-api/job-board/brightloop': { jobs: [
    { title: 'Sales Development Representative', jobUrl: 'https://jobs.ashbyhq.com/brightloop/1', isListed: true, publishedAt: d(7), descriptionPlain: a },
    { title: 'Account Executive', jobUrl: 'https://jobs.ashbyhq.com/brightloop/2', isListed: true, publishedAt: d(8), descriptionPlain: b }] } })
  assert.equal(await atsGtmHiring('Brightloop', 'brightloop.io', route(ashby('https://brightloop.io', 'https://brightloop.com')), { now: NOW }), null)
  assert.equal(await atsGtmHiring('Brightloop', null, route(ashby('https://brightloop.io', 'https://brightloop.com')), { now: NOW }), null, 'also without a lead domain')
})

test('HTML link: a posting that SAYS brightloop.io while its company-website link points to brightloop.com is a conflict (board writes nothing)', async () => {
  assert.deepEqual(domainsInText('<p>Join us at brightloop.io</p><a href="https://www.brightloop.com/careers">Company website</a>', 'brightloop').sort(), ['brightloop.com', 'brightloop.io'])
  assert.deepEqual(domainsInText('&lt;p&gt;Join us at brightloop.io&lt;/p&gt;&lt;a href=&quot;https://brightloop.com&quot;&gt;site&lt;/a&gt;', 'brightloop').sort(), ['brightloop.com', 'brightloop.io'], 'Greenhouse sends escaped HTML')
  assert.deepEqual(domainsInText('<a href="brightloop.io/jobs">Apply</a> <a href="mailto:jobs@brightloop.io">mail</a> at brightloop.io', 'brightloop'), ['brightloop.io'], 'agreeing text and links stay one domain')
  const html = '<p>Join Brightloop at brightloop.io</p><a href="https://brightloop.com">Company website</a>'
  const gh = await atsGtmBoard('Brightloop', 'brightloop.io', route({ ...ghBoard, [`${GH}/jobs/1`]: { ...(ghBoard[`${GH}/jobs/1`] as object), content: html.replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;') } }), { now: NOW })
  assert.deepEqual(gh, { hiring: null, contradictory: true })
  const lever = await atsGtmBoard('Brightloop', 'brightloop.io', route({ 'https://api.lever.co/v0/postings/brightloop?mode=json': [{ text: 'Account Executive', hostedUrl: 'https://jobs.lever.co/brightloop/a', createdAt: NOW - 5 * 86_400_000, description: html }] }), { now: NOW })
  assert.deepEqual(lever, { hiring: null, contradictory: true })
  const ashby = await atsGtmBoard('Brightloop', 'brightloop.io', route({ 'https://api.ashbyhq.com/posting-api/job-board/brightloop': { jobs: [{ title: 'Account Executive', jobUrl: 'https://jobs.ashbyhq.com/brightloop/1', isListed: true, publishedAt: d(7), descriptionHtml: html }] } }), { now: NOW })
  assert.deepEqual(ashby, { hiring: null, contradictory: true })
})

test('plain text AND html both supplied: the plain text says brightloop.io, the HTML link says brightloop.com -> contradictory on Lever and Ashby (and Greenhouse content+description), through real enrichment', async () => {
  const plain = 'Apply at brightloop.io Company website', html = '<p>Apply at brightloop.io</p><a href="https://brightloop.com">Company website</a>'
  const lever = { 'https://api.lever.co/v0/postings/brightloop?mode=json': [{ text: 'Account Executive', hostedUrl: 'https://jobs.lever.co/brightloop/a', createdAt: NOW - 5 * 86_400_000, descriptionPlain: plain, description: html }] }
  const ashby = { 'https://api.ashbyhq.com/posting-api/job-board/brightloop': { jobs: [{ title: 'Account Executive', jobUrl: 'https://jobs.ashbyhq.com/brightloop/1', isListed: true, publishedAt: d(7), descriptionPlain: plain, descriptionHtml: html }] } }
  const green = gh('&lt;p&gt;Apply at brightloop.io&lt;/p&gt;'); (green[`${GH}/jobs/1`] as Record<string, unknown>).description = html
  for (const [name, board] of [['lever', lever], ['ashby', ashby], ['greenhouse', green]] as const) {
    assert.deepEqual(await atsGtmBoard('Brightloop', 'brightloop.io', route(board), { now: NOW }), { hiring: null, contradictory: true }, name)
    for (const basis of ['evidence_own_domain', 'name_probe', null]) {
      const { db, jobId } = leadDb('brightloop.io', basis); const r = await enrich(db, jobId, board)
      assert.deepEqual(r.gtm, [], `${name}/${basis}: a contradictory board writes nothing`); assert.equal(r.events, 0)
    }
  }
  // the same payloads with an AGREEING html link are not a conflict
  const ok = { 'https://api.lever.co/v0/postings/brightloop?mode=json': [{ text: 'Account Executive', hostedUrl: 'https://jobs.lever.co/brightloop/a', createdAt: NOW - 5 * 86_400_000, descriptionPlain: plain, description: html.replace('brightloop.com', 'brightloop.io') }] }
  assert.equal((await atsGtmBoard('Brightloop', 'brightloop.io', route(ok), { now: NOW })).contradictory, false)
})

test('per-posting evidence: role title, the posting URL, its publish date, board + location and the retrieval time are saved per posting; the board update date is only a label', async () => {
  const { db, jobId } = leadDb('brightloop.io', 'evidence_own_domain'); await enrich(db, jobId, ghBoard)
  const rows = db.prepare("SELECT value, label, confidence, source_url, source_date, retrieved_at FROM lead_enrichments WHERE connector = 'signals:greenhouse-gtm' AND value LIKE '% - posted %' ORDER BY value").all() as { value: string; label: string; confidence: number | null; source_url: string; source_date: string; retrieved_at: number }[]
  assert.ok(rows.length >= 1, JSON.stringify(rows))
  const ae = rows.find(r => r.value.startsWith('Account Executive'))!
  assert.equal(ae.value, `Account Executive - posted ${d(12).slice(0, 10)}`); assert.equal(ae.source_url, 'https://boards.greenhouse.io/brightloop/jobs/1'); assert.equal(ae.source_date, d(12).slice(0, 10))
  assert.equal(ae.label, `London, UK; Greenhouse; board updated ${d(1).slice(0, 10)}`); assert.equal(ae.confidence, 70); assert.ok(ae.retrieved_at > 0)
  assert.ok(rows.every(r => r.source_date !== d(1).slice(0, 10)), 'updated_at is never the posting date')
  const u = leadDb('brightloop.io', 'name_probe'); await enrich(u.db, u.jobId, gh('Join Brightloop in London', 'Lead sales'))
  const un = u.db.prepare("SELECT value, confidence FROM lead_enrichments WHERE connector = 'signals:greenhouse-gtm' AND value LIKE '%- posted %'").all() as { value: string; confidence: number | null }[]
  assert.ok(un.length >= 1 && un.every(r => r.value.startsWith('Unconfirmed: ') && r.confidence === null), 'a board not established as the lead’s stays unconfirmed per posting too')
})

test('a contradictory board writes no per-posting evidence either', async () => {
  const { db, jobId } = leadDb('brightloop.io', 'evidence_own_domain'); await enrich(db, jobId, gh('Write to jobs@brightloop.io', 'Write to jobs@brightloop.com'))
  assert.equal((db.prepare("SELECT count(*) AS n FROM lead_enrichments WHERE value LIKE '% - posted %'").get() as { n: number }).n, 0)
})

test('open-status: a posting whose own text says it is closed / filled / expired is not evidence on any board, even if the board still lists it', async () => {
  const closedText = 'This position is closed. Thanks to everyone who applied.'
  const g = gh(`&lt;p&gt;${closedText} jobs@brightloop.io&lt;/p&gt;`, 'Lead sales jobs@brightloop.io')
  const board = await atsGtmBoard('Brightloop', 'brightloop.io', route(g), { now: NOW })
  assert.deepEqual(board.hiring?.postings.map(p => p.title), ['Head of Sales'], 'only the open posting survives')
  const allClosed = gh(`&lt;p&gt;${closedText}&lt;/p&gt;`, 'This job has expired.')
  assert.equal((await atsGtmBoard('Brightloop', 'brightloop.io', route(allClosed), { now: NOW })).hiring, null)
  const lever = { 'https://api.lever.co/v0/postings/brightloop?mode=json': [{ text: 'Account Executive', hostedUrl: 'https://jobs.lever.co/brightloop/a', createdAt: NOW - 5 * 86_400_000, descriptionPlain: 'This position has been filled. brightloop.io' }] }
  assert.equal((await atsGtmBoard('Brightloop', 'brightloop.io', route(lever), { now: NOW })).hiring, null)
  const ashby = { 'https://api.ashbyhq.com/posting-api/job-board/brightloop': { jobs: [{ title: 'Account Executive', jobUrl: 'https://jobs.ashbyhq.com/brightloop/1', isListed: true, publishedAt: d(7), descriptionPlain: 'Applications are closed. brightloop.io' }] } }
  assert.equal((await atsGtmBoard('Brightloop', 'brightloop.io', route(ashby), { now: NOW })).hiring, null)
})

test('board adapters take the role from the posting’s own JSON title: a non-sales posting never becomes sales-hiring evidence, whatever the board or any index calls it', async () => {
  const lever = { 'https://api.lever.co/v0/postings/brightloop?mode=json': [
    { text: 'Backend Engineer', hostedUrl: 'https://jobs.lever.co/brightloop/a', createdAt: NOW - 5 * 86_400_000, descriptionPlain: 'Account Executive wanted. brightloop.io' },
    { text: 'Account Executive', hostedUrl: 'https://jobs.lever.co/brightloop/b', createdAt: NOW - 5 * 86_400_000, descriptionPlain: 'brightloop.io' }] }
  assert.deepEqual((await atsGtmBoard('Brightloop', 'brightloop.io', route(lever), { now: NOW })).hiring?.postings.map(p => p.title), ['Account Executive'], 'only the posting whose own title is a sales role')
  const gh2 = { [GH + '/jobs']: { jobs: [{ id: 9, title: 'Backend Engineer' }] }, [`${GH}/jobs/9`]: { id: 9, title: 'Backend Engineer', first_published: d(5), absolute_url: 'https://boards.greenhouse.io/brightloop/jobs/9', content: 'Account Executive. brightloop.io' } }
  assert.equal((await atsGtmBoard('Brightloop', 'brightloop.io', route(gh2), { now: NOW })).hiring, null)
  const ashby = { 'https://api.ashbyhq.com/posting-api/job-board/brightloop': { jobs: [{ title: 'Backend Engineer', jobUrl: 'https://jobs.ashbyhq.com/brightloop/1', isListed: true, publishedAt: d(7), descriptionPlain: 'Account Executive. brightloop.io' }] } }
  assert.equal((await atsGtmBoard('Brightloop', 'brightloop.io', route(ashby), { now: NOW })).hiring, null)
})

test('specific hiring evidence persists beyond generic top3; aggregate remains date-unknown context, never exact-role proof', async () => {
  const db = new Database(':memory:'); migrateScan(db); migrateConnectors(db); migrateEvents(db)
  const jobId = createJob(db, 'u1', { business_name: 'B', industry: 'I', location: 'L' })
  db.prepare("UPDATE scan_jobs SET status='running',query=?,icp=? WHERE id=?").run('Companies hiring a CRM administrator', JSON.stringify({ signals: ['hiring a CRM administrator'] }), jobId)
  db.prepare("INSERT INTO leads (id,scan_job_id,company,company_domain,signal,source_url) VALUES ('lead1',?,'Brightloop','brightloop.io','hiring','https://news.example/1')").run(jobId)
  db.prepare("INSERT INTO lead_enrichments (id,lead_id,tenant_id,connector,kind,value,confidence,source_url,source_date,retrieved_at) VALUES ('D1','lead1','u1','sitecrawl','domain','brightloop.io|evidence_own_domain',NULL,'https://brightloop.io/','2026-10-28',1)").run()
  const jobs = Array.from({ length: 6 }, (_, i) => ({ id: i + 1, title: i === 5 ? 'CRM Admin' : 'Account Executive' }))
  const m: Record<string, unknown> = { [`${GH}/jobs`]: { jobs } }
  for (const j of jobs) m[`${GH}/jobs/${j.id}`] = { ...j, first_published: d(20), absolute_url: `https://boards.greenhouse.io/brightloop/jobs/${j.id}`, content: 'https://brightloop.io', location: { name: 'London' } }
  const realNow = Date.now; Date.now = () => NOW
  try { await enrichJobSignals(db, 'u1', jobId, { fetchImpl: route(m), creditEnrichment: false }) } finally { Date.now = realNow }
  const rows = db.prepare("SELECT value,label,source_url,source_date FROM lead_enrichments WHERE kind='hiring'").all() as { value: string; label: string | null; source_url: string; source_date: string }[]
  const generic = rows.find(r => r.value.includes('6 open roles'))!
  assert.ok(generic); assert.match(generic.value, /generic hiring; posting date unknown/); assert.doesNotMatch(generic.label ?? '', /Requested role:/)
  const specific = rows.find(r => r.value.startsWith('CRM Admin - posted'))!
  assert.ok(specific); assert.match(specific.label!, /Requested role: CRM administrator/); assert.equal(specific.source_url, 'https://boards.greenhouse.io/brightloop/jobs/6'); assert.equal(specific.source_date, d(20).slice(0, 10))
  db.close()
})

// --- #533: board-title audit trail + coverage metadata -----------------------------------------------
test('#533 audit: every listed title beyond the dated postings is stored as a hiring-role row, and a coverage row says exactly what the sample covers', async () => {
  const db = new Database(':memory:'); migrateScan(db); migrateConnectors(db); migrateEvents(db)
  const jobId = createJob(db, 'u1', { business_name: 'B', industry: 'I', location: 'L' })
  db.prepare("UPDATE scan_jobs SET status = 'running' WHERE id = ?").run(jobId)
  db.prepare("INSERT INTO leads (id, scan_job_id, name, company, company_domain, signal, source_url) VALUES ('lead1', ?, '', 'Brightloop', 'brightloop.io', 'raised a seed round', 'https://news.example/1')").run(jobId)
  db.prepare("INSERT INTO lead_enrichments (id, lead_id, tenant_id, connector, kind, value, label, confidence, source_url, source_date, retrieved_at) VALUES ('D1', 'lead1', 'u1', 'sitecrawl', 'domain', 'brightloop.io|evidence_own_domain', 'x', NULL, 'https://brightloop.io/', '2026-10-28', 1)").run()
  const realNow = Date.now; Date.now = () => NOW
  try { await enrichJobSignals(db, 'u1', jobId, { fetchImpl: route(ghBoard) }) } finally { Date.now = realNow }
  type Row = { connector: string; kind: string; value: string; label: string; confidence: number | null }
  const all = db.prepare("SELECT connector, kind, value, label, confidence FROM lead_enrichments WHERE kind IN ('hiring-role', 'hiring-board-coverage') ORDER BY value").all() as Row[]
  const gtmAudit = all.filter(r => r.kind === 'hiring-role' && r.connector === 'signals:greenhouse-gtm')
  assert.deepEqual(gtmAudit.map(r => r.value), ['SDR'])
  assert.match(gtmAudit[0].label, /sales\/GTM titles only/); assert.match(gtmAudit[0].label, /posting date was not read/); assert.equal(gtmAudit[0].confidence, null)
  const genAudit = all.filter(r => r.kind === 'hiring-role' && r.connector === 'signals:greenhouse')
  assert.deepEqual(genAudit.map(r => r.value), ['SDR'])
  assert.match(genAudit[0].label, /all listed titles/)
  const cov = all.filter(r => r.kind === 'hiring-board-coverage')
  assert.equal(cov.length, 2)
  const gtmCov = cov.find(r => r.connector === 'signals:greenhouse-gtm')!
  assert.match(gtmCov.value, /3 sales\/GTM-role titles only: 2 dated posting rows \+ 1 more as audit rows/); assert.ok(!gtmCov.value.includes('TRUNCATED'))
  const genCov = cov.find(r => r.connector === 'signals:greenhouse')!
  assert.match(genCov.value, /4 all listed titles: 3 named in the aggregate row \+ 1 more as audit rows/)
  assert.match(gtmCov.label, /not a hiring signal/); assert.equal(gtmCov.confidence, null)
  for (const r of all.filter(r => r.kind === 'hiring-role')) assert.ok(['SDR'].includes(r.value))
})

test('#533 truncation: a 60-title board stores at most 50 audit titles and the coverage row says the sample is TRUNCATED, never complete', async () => {
  const many: Record<string, unknown> = { [`${GH}/jobs`]: { jobs: Array.from({ length: 60 }, (_, i) => ({ id: i + 1, title: `Account Executive ${String(i + 1).padStart(2, '0')}` })) } }
  for (let i = 1; i <= 4; i++) many[`${GH}/jobs/${i}`] = { id: i, title: `Account Executive ${String(i).padStart(2, '0')}`, first_published: d(10), absolute_url: `https://boards.greenhouse.io/brightloop/jobs/${i}`, content: 'Apply at https://www.brightloop.io' }
  const g = (await atsGtmBoard('Brightloop', 'brightloop.io', route(many), { now: NOW })).hiring
  assert.ok(g); assert.equal(g!.listedCount, 60); assert.equal(g!.allTitles.length, 50)
  const auditRows = boardTitleAudit(g!, NOW / 1000, '2026-10-28', null)
  assert.equal(auditRows.length, 47, 'F-A: the 4th detailed posting has no dated row (only the top 3 are stored), so its title MUST get an audit row')
  const datedTitles = postingEvidence(g!, NOW / 1000, null).map(r => r.value.split(' - posted ')[0])
  assert.equal(datedTitles.length, 3)
  const dropped = ['Account Executive 01', 'Account Executive 02', 'Account Executive 03', 'Account Executive 04'].filter(t => !datedTitles.includes(t))
  assert.equal(dropped.length, 1, 'exactly one of the 4 detailed postings has no dated row')
  assert.ok(auditRows.some(r => r.value === dropped[0]), 'F-A regression: the exact 4th detailed title is in the audit store, not lost from both stores')
  assert.ok(!auditRows.some(r => datedTitles.includes(r.value)), 'the 3 titles with dated rows stay out of the audit store')
  const cov = boardCoverageRow(g!, auditRows.length, Math.min(g!.postings.length, 3), NOW / 1000, '2026-10-28')
  assert.match(cov.value, /60 sales\/GTM-role titles only: 3 dated posting rows \+ 47 more as audit rows/)
  assert.match(cov.value, /TRUNCATED at 50 - a title beyond the sample is not disproved/)
  assert.ok(!cov.value.includes('complete'))
})

test('#533 filtered pass: a requested-role-filtered board labels its audit and coverage as the matching subset, not the board', async () => {
  const g = (await atsGtmBoard('Brightloop', 'brightloop.io', route(ghBoard), { now: NOW, roleMatch: t => /account executive/i.test(t) })).hiring
  assert.ok(g); assert.equal(g!.titleFilter, 'role-match')
  assert.deepEqual(g!.allTitles, ['Account Executive'])
  for (const r of boardTitleAudit(g!, NOW / 1000, '2026-10-28', null)) assert.match(r.label, /requested-role matches only/)
  const cov = boardCoverageRow(g!, 0, Math.min(g!.postings.length, 3), NOW / 1000, '2026-10-28')
  assert.match(cov.value, /requested-role-matching titles only/)
})

test('#533 unconfirmed: the heuristic note propagates to audit rows, which stay unscored', async () => {
  const g = (await atsGtmBoard('Brightloop', 'brightloop.io', route(ghBoard), { now: NOW })).hiring
  assert.ok(g)
  const rows = boardTitleAudit(g!, NOW / 1000, '2026-10-28', 'entity matched by name only (heuristic, not independently confirmed)')
  assert.ok(rows.length > 0)
  for (const r of rows) { assert.match(r.value, /^Unconfirmed: /); assert.match(r.label, /entity matched by name only/); assert.equal(r.confidence, null) }
})

test('#533 F-B zero-match: an attributed board with no fresh matching posting leaves an audit + coverage trail instead of looking unchecked', async () => {
  const stale = { [`${GH}/jobs`]: { jobs: [{ id: 1, title: 'SDR', updated_at: d(1) }, { id: 2, title: 'Backend Engineer', updated_at: d(1) }] },
    [`${GH}/jobs/1`]: { id: 1, title: 'SDR', first_published: d(400), absolute_url: 'https://boards.greenhouse.io/brightloop/jobs/1', content: 'old' } }
  const board = await atsGtmBoard('Brightloop', 'brightloop.io', route(stale), { now: NOW })
  assert.equal(board.hiring, null, 'no fresh GTM posting: no signal, as before')
  assert.ok(board.checked, 'F-B: the fetched listing outcome is reported')
  assert.equal(board.checked!.listedCount, 1); assert.deepEqual(board.checked!.allTitles, ['SDR'])
  const audits = checkedAuditRows(board.checked!, 90, NOW / 1000, '2026-10-28', null)
  assert.equal(audits.length, 1); assert.equal(audits[0].value, 'SDR')
  assert.match(audits[0].label, /posting date read as older than the last 90 days; no dated evidence row was stored/)
  assert.equal(audits[0].confidence, null)
  const cov = checkedCoverageRow(board.checked!, 90, NOW / 1000, '2026-10-28')
  assert.match(cov.value, /0 fresh postings in the last 90 days across the full listing \(1 sales\/GTM-role titles only, all posting dates read\); 1 stored as audit rows/)
  assert.ok(!cov.value.includes('TRUNCATED'))
  // fetch failure still stores nothing - the remaining gap is explicit, not papered over
  const failed = await atsGtmBoard('Brightloop', 'brightloop.io', route({}), { now: NOW })
  assert.equal(failed.hiring, null); assert.equal(failed.checked, null)
})

test('#533 F-B zero-match integration: enrichJobSignals stores the zero-match trail for an attributed stale board', async () => {
  const db = new Database(':memory:'); migrateScan(db); migrateConnectors(db); migrateEvents(db)
  const jobId = createJob(db, 'u1', { business_name: 'B', industry: 'I', location: 'L' })
  db.prepare("UPDATE scan_jobs SET status = 'running' WHERE id = ?").run(jobId)
  db.prepare("INSERT INTO leads (id, scan_job_id, name, company, company_domain, signal, source_url) VALUES ('lead1', ?, '', 'Brightloop', 'brightloop.io', 'raised a seed round', 'https://news.example/1')").run(jobId)
  db.prepare("INSERT INTO lead_enrichments (id, lead_id, tenant_id, connector, kind, value, label, confidence, source_url, source_date, retrieved_at) VALUES ('D1', 'lead1', 'u1', 'sitecrawl', 'domain', 'brightloop.io|evidence_own_domain', 'x', NULL, 'https://brightloop.io/', '2026-10-28', 1)").run()
  const stale = { [`${GH}/jobs`]: { jobs: [{ id: 1, title: 'SDR', updated_at: d(1) }] },
    [`${GH}/jobs/1`]: { id: 1, title: 'SDR', first_published: d(400), absolute_url: 'https://boards.greenhouse.io/brightloop/jobs/1', content: 'old' } }
  const realNow = Date.now; Date.now = () => NOW
  try { await enrichJobSignals(db, 'u1', jobId, { fetchImpl: route(stale), creditEnrichment: false }) } finally { Date.now = realNow }
  const audits = db.prepare("SELECT value, label, confidence FROM lead_enrichments WHERE kind = 'hiring-role'").all() as { value: string; label: string; confidence: number | null }[]
  assert.deepEqual(audits.map(r => r.value), ['SDR'])
  assert.match(audits[0].label, /posting date read as older than the last 90 days/)
  const cov = db.prepare("SELECT value FROM lead_enrichments WHERE kind = 'hiring-board-coverage'").all() as { value: string }[]
  assert.ok(cov.some(r => /0 fresh postings in the last 90 days/.test(r.value)), 'gtm zero-match coverage row stored')
  assert.ok(cov.some(r => /1 all listed titles/.test(r.value) || /Board listing: 1/.test(r.value)), 'generic pass still records its own listing coverage')
  db.close()
})

test('#533 F-B empty board: an attributed listing with zero titles stores a complete-listing coverage row (not a sample)', async () => {
  const db = new Database(':memory:'); migrateScan(db); migrateConnectors(db); migrateEvents(db)
  const jobId = createJob(db, 'u1', { business_name: 'B', industry: 'I', location: 'L' })
  db.prepare("UPDATE scan_jobs SET status = 'running' WHERE id = ?").run(jobId)
  db.prepare("INSERT INTO leads (id, scan_job_id, name, company, company_domain, signal, source_url) VALUES ('lead1', ?, '', 'Brightloop', 'brightloop.io', 'raised a seed round', 'https://news.example/1')").run(jobId)
  const empty = { [`${GH}/jobs`]: { jobs: [] } }
  const realNow = Date.now; Date.now = () => NOW
  try { await enrichJobSignals(db, 'u1', jobId, { fetchImpl: route(empty), creditEnrichment: false }) } finally { Date.now = realNow }
  const cov = db.prepare("SELECT connector, value FROM lead_enrichments WHERE kind = 'hiring-board-coverage'").all() as { connector: string; value: string }[]
  const gen = cov.find(r => r.connector === 'signals:greenhouse')!
  assert.ok(gen); assert.match(gen.value, /0 titles listed \(all listed titles\) - the listing itself was empty/)
  const gtm = cov.find(r => r.connector === 'signals:greenhouse-gtm')!
  assert.ok(gtm, 'gtm pass also records its zero on the empty attributed board'); assert.match(gtm.value, /0 sales\/GTM-role titles only listed on an empty board listing/)
  db.close()
})

test('#533 F-E GH detail failure: a title whose date was never read gets no freshness claim and the coverage row says freshness was not established', async () => {
  const failDetail = { [`${GH}/jobs`]: { jobs: [{ id: 1, title: 'SDR', updated_at: d(1) }] } } // detail endpoint absent from the fixture -> fetch fails
  const board = await atsGtmBoard('Brightloop', 'brightloop.io', route(failDetail), { now: NOW })
  assert.equal(board.hiring, null)
  assert.ok(board.checked); assert.equal(board.checked!.rawTotal, 1); assert.equal(board.checked!.rawUnread, 1); assert.equal(board.checked!.rawDatedStale, 0)
  const audits = checkedAuditRows(board.checked!, 90, NOW / 1000, '2026-10-28', null)
  assert.equal(audits.length, 1)
  assert.match(audits[0].label, /posting date was not read - freshness unknown/)
  assert.doesNotMatch(audits[0].label, /older than the last 90 days/, 'no freshness claim from an unread date')
  const cov = checkedCoverageRow(board.checked!, 90, NOW / 1000, '2026-10-28')
  assert.match(cov.value, /0 fresh postings in the last 90 days among the 0 of 1 listed postings whose dates were read; freshness of the rest was not established/)
  assert.doesNotMatch(cov.value, /across the full listing/, 'partial date coverage never claims the full listing')
})

test('#533 F-E GH beyond the detail cap: titles 5+ are never date-checked, get unknown-freshness rows, and the coverage row scopes the 0-fresh claim to the 4 read', async () => {
  const six = { [`${GH}/jobs`]: { jobs: Array.from({ length: 6 }, (_, i) => ({ id: i + 1, title: `SDR ${i + 1}`, updated_at: d(1) })) } }
  for (let i = 1; i <= 4; i++) six[`${GH}/jobs/${i}`] = { id: i, title: `SDR ${i}`, first_published: d(400), absolute_url: `https://boards.greenhouse.io/brightloop/jobs/${i}`, content: 'old' }
  const board = await atsGtmBoard('Brightloop', 'brightloop.io', route(six), { now: NOW })
  assert.equal(board.hiring, null)
  assert.ok(board.checked); assert.equal(board.checked!.rawTotal, 6); assert.equal(board.checked!.rawDatedStale, 4); assert.equal(board.checked!.rawUnread, 2)
  assert.deepEqual(board.checked!.datedStale, ['SDR 1', 'SDR 2', 'SDR 3', 'SDR 4'])
  const audits = checkedAuditRows(board.checked!, 90, NOW / 1000, '2026-10-28', null)
  assert.equal(audits.length, 6)
  for (const r of audits.filter(r => ['SDR 1', 'SDR 2', 'SDR 3', 'SDR 4'].includes(r.value))) assert.match(r.label, /posting date read as older than the last 90 days/)
  for (const r of audits.filter(r => ['SDR 5', 'SDR 6'].includes(r.value))) { assert.match(r.label, /posting date was not read - freshness unknown/); assert.doesNotMatch(r.label, /older than/) }
  const cov = checkedCoverageRow(board.checked!, 90, NOW / 1000, '2026-10-28')
  assert.match(cov.value, /0 fresh postings in the last 90 days among the 4 of 6 listed postings whose dates were read; freshness of the rest was not established/)
})

test('#533 F-E Lever zero-match: listing dates are read for every entry, so the full-listing 0-fresh claim stands', async () => {
  const lever = { 'https://api.lever.co/v0/postings/brightloop?mode=json': [
    { text: 'SDR', hostedUrl: 'https://jobs.lever.co/brightloop/a', createdAt: NOW - 400 * 86_400_000, descriptionPlain: 'sales. brightloop.io' },
    { text: 'Account Executive', hostedUrl: 'https://jobs.lever.co/brightloop/b', createdAt: NOW - 200 * 86_400_000, descriptionPlain: 'sales. brightloop.io' }] }
  const board = await atsGtmBoard('Brightloop', 'brightloop.io', route(lever), { now: NOW })
  assert.equal(board.hiring, null)
  assert.ok(board.checked); assert.equal(board.checked!.rawTotal, 2); assert.equal(board.checked!.rawDatedStale, 2); assert.equal(board.checked!.rawUnread, 0); assert.equal(board.checked!.rawFreshExcluded, 0)
  const cov = checkedCoverageRow(board.checked!, 90, NOW / 1000, '2026-10-28')
  assert.match(cov.value, /0 fresh postings in the last 90 days across the full listing \(2 sales\/GTM-role titles only, all posting dates read\)/)
})

test('#533 F-E fresh-but-closed is outside the 0-fresh claim: a closed fresh posting neither counts as evidence nor supports absence', async () => {
  const closed = { [`${GH}/jobs`]: { jobs: [{ id: 1, title: 'SDR', updated_at: d(1) }] },
    [`${GH}/jobs/1`]: { id: 1, title: 'SDR', first_published: d(5), absolute_url: 'https://boards.greenhouse.io/brightloop/jobs/1', content: 'This job has expired.' } }
  const board = await atsGtmBoard('Brightloop', 'brightloop.io', route(closed), { now: NOW })
  assert.equal(board.hiring, null)
  assert.ok(board.checked); assert.equal(board.checked!.rawFreshExcluded, 1); assert.equal(board.checked!.rawDatedStale, 0)
  const cov = checkedCoverageRow(board.checked!, 90, NOW / 1000, '2026-10-28')
  assert.match(cov.value, /freshness of the rest was not established; 1 fresh excluded as closed or unusable, outside this claim/)
  assert.doesNotMatch(cov.value, /across the full listing/)
})

test('#533 dedupeTitles: case-insensitive distinct, each capped at 120 chars, the list capped at 50', () => {
  const titles = ['Account Executive', 'account executive', ' Head of Sales ', ...Array.from({ length: 60 }, (_, i) => `Role ${i}`)]
  const out = dedupeTitles(titles)
  assert.equal(out.length, 50)
  assert.deepEqual(out.slice(0, 2), ['Account Executive', 'Head of Sales'])
  assert.equal(dedupeTitles(['x'.repeat(200)])[0].length, 120)
})
