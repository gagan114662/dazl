import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { edgarFunding, atsHiring, enrichJobSignals, nameTokens, topTitles } from '../lib/signals/index.ts'
import { migrateScan, createJob } from '../lib/scan/store.ts'
import { migrateConnectors, recentAudit } from '../lib/connectors/store.ts'
import { migrateEvents } from '../lib/events/store.ts'

const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 })
const notFound = () => new Response('nope', { status: 404 })

const EDGAR_HIT = {
  hits: { hits: [
    { _id: '0001904455-26-000001:primary_doc.xml', _source: { display_names: ['Zymtrace Inc  (CIK 0001904455)'], file_date: '2026-09-14', adsh: '0001904455-26-000001', ciks: ['0001904455'], form: 'D' } },
    { _id: '0001904455-26-000002:primary_doc.xml', _source: { display_names: ['Unrelated Holdings LP  (CIK 0001904455)'], file_date: '2026-10-01', adsh: '0001904455-26-000002', ciks: ['0001904455'], form: 'D' } },
  ] },
}

test('edgarFunding: matches entity tokens, takes latest matching filing, builds an archives URL', async () => {
  const f = await edgarFunding('Zymtrace', async () => ok(EDGAR_HIT))
  assert.ok(f)
  assert.equal(f.date, '2026-09-14') // the Unrelated Holdings hit is newer but must not match
  assert.equal(f.entity, 'Zymtrace Inc')
  assert.equal(f.url, 'https://www.sec.gov/Archives/edgar/data/1904455/000190445526000001/primary_doc.xml')
})

test('edgarFunding: no matching entity, bad status and junk all yield null', async () => {
  assert.equal(await edgarFunding('Zymtrace', async () => ok({ hits: { hits: [EDGAR_HIT.hits.hits[1]] } })), null)
  assert.equal(await edgarFunding('Zymtrace', async () => notFound()), null)
  assert.equal(await edgarFunding('Zymtrace', async () => { throw new Error('boom') }), null)
})

test('nameTokens: strips suffixes and punctuation', () => {
  assert.deepEqual(nameTokens('Zymtrace, Inc.'), ['zymtrace'])
  assert.deepEqual(nameTokens('Northside Builders Ltd'), ['northside', 'builders'])
})

const GH_OK = { jobs: [{ title: 'Founding Engineer', absolute_url: 'https://careers.acme.com/positions/1' }, { title: 'Head of Sales', absolute_url: 'https://careers.acme.com/positions/2' }] }

test('atsHiring: greenhouse hit returns roles and titles; 404s fall through', async () => {
  const h = await atsHiring('Acme', 'acme.com', async (url) => String(url).includes('greenhouse') ? ok(GH_OK) : notFound())
  assert.ok(h)
  assert.equal(h.board, 'greenhouse')
  assert.equal(h.openRoles, 2)
  assert.deepEqual(h.titles, ['Founding Engineer', 'Head of Sales'])
  assert.equal(h.url, 'https://boards.greenhouse.io/acme', 'a 2-role count cites the board page, not the first posting')
})

test('atsHiring: lever array and ashby jobs parse; nothing found yields null', async () => {
  const lever = await atsHiring('Acme', 'acme.com', async (url) => String(url).includes('lever') ? ok([{ text: 'AE', hostedUrl: 'https://jobs.lever.co/acme/1' }]) : notFound())
  assert.equal(lever?.board, 'lever')
  assert.equal(lever?.url, 'https://jobs.lever.co/acme/1', 'a single-role board links that role')
  const ashby = await atsHiring('Acme', 'acme.com', async (url) => String(url).includes('ashby') ? ok({ jobs: [{ title: 'AE', jobUrl: 'https://jobs.ashbyhq.com/acme/1' }] }) : notFound())
  assert.equal(ashby?.board, 'ashby')
  assert.equal(await atsHiring('Acme', 'acme.com', async () => notFound()), null)
})

test('topTitles: dedupes reposted roles before capping at three', () => {
  const jobs = [
    { text: 'AI Deployment Strategist' }, { text: 'AI Deployment Strategist' }, { text: 'AI Deployment Strategist' },
    { text: 'sales operations manager' }, { text: 'Sales Operations Manager' }, { text: 'RevOps Lead' }, { text: 'Data Engineer' },
  ]
  // one distinct title per role family, case-insensitive; first-seen casing kept
  assert.deepEqual(topTitles(jobs, (j: { text: string }) => j.text), ['AI Deployment Strategist', 'sales operations manager', 'RevOps Lead'])
  assert.deepEqual(topTitles([], (j: { text: string }) => j.text), [])
})

test('atsHiring: lever board with the same role posted per location yields distinct titles, full count kept', async () => {
  const postings = [
    { text: 'AI Deployment Strategist', hostedUrl: 'https://jobs.lever.co/acme/1' },
    { text: 'AI Deployment Strategist', hostedUrl: 'https://jobs.lever.co/acme/2' },
    { text: 'AI Deployment Strategist', hostedUrl: 'https://jobs.lever.co/acme/3' },
    { text: 'Senior Sales Operations Manager, Americas', hostedUrl: 'https://jobs.lever.co/acme/4' },
  ]
  const h = await atsHiring('Acme', 'acme.com', async (url) => String(url).includes('lever') ? ok(postings) : notFound())
  assert.ok(h)
  assert.equal(h.board, 'lever')
  assert.equal(h.openRoles, 4) // count reflects every posting, duplicates included
  assert.deepEqual(h.titles, ['AI Deployment Strategist', 'Senior Sales Operations Manager, Americas'])
})

test('enrichJobSignals: writes enrichment rows with source url+date and audits; silent on total failure', async () => {
  const db = new Database(':memory:')
  migrateScan(db); migrateConnectors(db); migrateEvents(db)
  const jobId = createJob(db, 'u1', { business_name: 'B', industry: 'I', location: 'L' })
  db.prepare("UPDATE scan_jobs SET status = 'running' WHERE id = ?").run(jobId)
  db.prepare("INSERT INTO leads (id, scan_job_id, name, company, company_domain, signal, source_url) VALUES ('lead1', ?, '', 'Zymtrace', 'zymtrace.com', 'raised seed', 'https://x.com/1')").run(jobId)
  const fetchImpl = async (url: RequestInfo | URL) => {
    const u = String(url)
    if (u.includes('efts.sec.gov')) return ok(EDGAR_HIT)
    if (u.includes('greenhouse')) return ok(GH_OK)
    return notFound()
  }
  await enrichJobSignals(db, 'u1', jobId, { fetchImpl: fetchImpl as never })
  const rows = db.prepare('SELECT connector, kind, value, source_url, source_date FROM lead_enrichments WHERE lead_id = ?').all('lead1') as { connector: string; kind: string; value: string; source_url: string; source_date: string }[]
  const kinds = rows.map(r => `${r.connector}:${r.kind}`).sort()
  assert.ok(kinds.includes('signals:sec-edgar:funding'))
  assert.ok(kinds.includes('signals:greenhouse:hiring'))
  for (const r of rows) { assert.ok(r.source_url.startsWith('https://')); assert.match(r.source_date, /^\d{4}-\d{2}-\d{2}$/) }
  const st = (recentAudit(db, 'u1', 10) as { connector: string; status: string }[]).map(a => `${a.connector}:${a.status}`)
  assert.ok(st.includes('signals:sec-edgar:ok') && st.includes('signals:ats:ok'))
  // total failure: no rows, no throw
  await enrichJobSignals(db, 'u1', jobId, { fetchImpl: (async () => notFound()) as never })
})

test('enrichJobSignals: name-only board match (null domain) is not attached as corroboration', async () => {
  const db = new Database(':memory:')
  migrateScan(db); migrateConnectors(db); migrateEvents(db)
  const jobId = createJob(db, 'u1', { business_name: 'B', industry: 'I', location: 'L' })
  db.prepare("UPDATE scan_jobs SET status = 'running' WHERE id = ?").run(jobId)
  // one-token company, no resolved domain: a same-named board/fund must not attach
  db.prepare("INSERT INTO leads (id, scan_job_id, name, company, company_domain, signal, source_url) VALUES ('lead9', ?, '', 'Vesta', NULL, 'raised seed', 'https://x.com/9')").run(jobId)
  const EDGAR_FUND = { hits: { hits: [{ _id: '0002139575-26-000001:primary_doc.xml', _source: { display_names: ['Vesta Ventures Fund II, LP  (CIK 0002139575)'], file_date: '2026-07-01', adsh: '0002139575-26-000001', ciks: ['0002139575'], form: 'D' } }] } }
  const fetchImpl = async (url: RequestInfo | URL) => {
    const u = String(url)
    if (u.includes('efts.sec.gov')) return ok(EDGAR_FUND)
    if (u.includes('ashby')) return ok({ jobs: [{ title: 'Product Manager', jobUrl: 'https://jobs.ashbyhq.com/vesta/abc' }] })
    return notFound()
  }
  await enrichJobSignals(db, 'u1', jobId, { fetchImpl: fetchImpl as never })
  const rows = db.prepare('SELECT connector FROM lead_enrichments WHERE lead_id = ?').all('lead9')
  assert.deepEqual(rows, [])
})

test('atsHiring: a multi-role lever or ashby count never cites one arbitrary posting', async () => {
  const lever = await atsHiring('Acme', 'acme.com', async (url) => String(url).includes('lever') ? ok([{ text: 'AE', hostedUrl: 'https://jobs.lever.co/acme/1' }, { text: 'SDR', hostedUrl: 'https://jobs.lever.co/acme/2' }]) : notFound())
  assert.equal(lever?.openRoles, 2)
  assert.equal(lever?.url, 'https://jobs.lever.co/acme')
  const ashby = await atsHiring('Acme', 'acme.com', async (url) => String(url).includes('ashby') ? ok({ jobs: [{ title: 'AE', jobUrl: 'https://jobs.ashbyhq.com/acme/1' }, { title: 'SDR', jobUrl: 'https://jobs.ashbyhq.com/acme/2' }] }) : notFound())
  assert.equal(ashby?.url, 'https://jobs.ashbyhq.com/acme')
})

test('atsHiring: a single role with no posting url falls back to the board page', async () => {
  const gh = await atsHiring('Acme', 'acme.com', async (url) => String(url).includes('greenhouse') ? ok({ jobs: [{ title: 'Head of Sales' }] }) : notFound())
  assert.equal(gh?.openRoles, 1)
  assert.equal(gh?.url, 'https://boards.greenhouse.io/acme')
})

test('enrichJobSignals: ownership lost (alive false) stops the stale attempt - nothing written; a mid-run flip stops after the current lead', async () => {
  const db = new Database(':memory:')
  migrateScan(db); migrateConnectors(db); migrateEvents(db)
  const jobId = createJob(db, 'u1', { business_name: 'B', industry: 'I', location: 'L' })
  db.prepare("UPDATE scan_jobs SET status = 'running' WHERE id = ?").run(jobId)
  db.prepare("INSERT INTO leads (id, scan_job_id, name, company, company_domain, signal, source_url) VALUES ('lead1', ?, '', 'Zymtrace', 'zymtrace.com', 'raised seed', 'https://x.com/1')").run(jobId)
  db.prepare("INSERT INTO leads (id, scan_job_id, name, company, company_domain, signal, source_url) VALUES ('lead2', ?, '', 'Vesta', 'vesta.com', 'raised seed', 'https://x.com/2')").run(jobId)
  const fetchImpl = (async (url: RequestInfo | URL) => {
    const u = String(url)
    if (u.includes('efts.sec.gov')) return ok(EDGAR_HIT)
    if (u.includes('greenhouse')) return ok(GH_OK)
    return notFound()
  }) as never
  await enrichJobSignals(db, 'u1', jobId, { fetchImpl, alive: () => false })
  assert.equal((db.prepare('SELECT COUNT(*) c FROM lead_enrichments').get() as { c: number }).c, 0, 'a stale attempt writes no evidence')
  assert.equal((db.prepare('SELECT COUNT(*) c FROM connector_audit').get() as { c: number }).c, 0, 'and no audit rows')
  let calls = 0
  await enrichJobSignals(db, 'u1', jobId, { fetchImpl, alive: () => { calls++; return calls <= 1 } }) // alive for lead1, lost before lead2
  assert.ok((db.prepare('SELECT COUNT(*) c FROM lead_enrichments WHERE lead_id = ?').get('lead1') as { c: number }).c > 0, 'lead1 written before the loss')
  assert.equal((db.prepare('SELECT COUNT(*) c FROM lead_enrichments WHERE lead_id = ?').get('lead2') as { c: number }).c, 0, 'lead2 never written by the stale attempt')
  db.close()
})
