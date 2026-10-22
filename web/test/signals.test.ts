import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { edgarFunding, atsHiring, enrichJobSignals, nameTokens } from '../lib/signals/index.ts'
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
  assert.equal(h.url, 'https://careers.acme.com/positions/1')
})

test('atsHiring: lever array and ashby jobs parse; nothing found yields null', async () => {
  const lever = await atsHiring('Acme', 'acme.com', async (url) => String(url).includes('lever') ? ok([{ text: 'AE', hostedUrl: 'https://jobs.lever.co/acme/1' }]) : notFound())
  assert.equal(lever?.board, 'lever')
  const ashby = await atsHiring('Acme', 'acme.com', async (url) => String(url).includes('ashby') ? ok({ jobs: [{ title: 'AE', jobUrl: 'https://jobs.ashbyhq.com/acme/1' }] }) : notFound())
  assert.equal(ashby?.board, 'ashby')
  assert.equal(await atsHiring('Acme', 'acme.com', async () => notFound()), null)
})

test('enrichJobSignals: writes enrichment rows with source url+date and audits; silent on total failure', async () => {
  const db = new Database(':memory:')
  migrateScan(db); migrateConnectors(db); migrateEvents(db)
  const jobId = createJob(db, 'u1', { business_name: 'B', industry: 'I', location: 'L' })
  db.prepare("UPDATE scan_jobs SET status = 'running' WHERE id = ?").run(jobId)
  db.prepare("INSERT INTO leads (id, scan_job_id, name, company, signal, source_url) VALUES ('lead1', ?, '', 'Zymtrace', 'raised seed', 'https://x.com/1')").run(jobId)
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
