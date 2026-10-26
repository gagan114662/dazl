import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { migrateScan, createJob } from '../lib/scan/store.ts'
import { migrateConnectors } from '../lib/connectors/store.ts'
import { migrateTinyfish, resetTinyfishState } from '../lib/search/tinyfish.ts'
import { findPeople, parseProfileHit, peopleQuery, LABEL } from '../lib/people/people-search.ts'

// Person-first people search from public profile SEARCH RESULTS only. TEST-ONLY fixtures, TinyFish stubbed, no network.
const hit = (url: string, title: string, snippet = '') => ({ url, title, snippet, date: null })

test('query: company and buyer roles quoted, restricted to public profiles', () => {
  assert.equal(peopleQuery('Acme Logistics', ['HR manager', 'Head of People']), 'site:linkedin.com/in "Acme Logistics" ("HR manager" OR "Head of People")')
  assert.equal(peopleQuery('Acme', []), null)
})

test('parse: name and title only when the result line names the company; profile URLs only', () => {
  assert.deepEqual(parseProfileHit(hit('https://www.linkedin.com/in/jane-doe-123', 'Jane Doe - Head of HR - Acme Logistics | LinkedIn'), 'Acme Logistics Inc.'), { name: 'Jane Doe', title: 'Head of HR' })
  assert.deepEqual(parseProfileHit(hit('https://ca.linkedin.com/in/ana-lopez', 'Ana López – HR Manager at Acme Logistics | LinkedIn'), 'Acme Logistics'), { name: 'Ana López', title: 'HR Manager' })
  assert.equal(parseProfileHit(hit('https://www.linkedin.com/in/jane-doe', 'Jane Doe - Head of HR - Rival Corp | LinkedIn'), 'Acme Logistics'), null) // other company
  assert.equal(parseProfileHit(hit('https://www.linkedin.com/company/acme', 'Acme Logistics - Head of HR | LinkedIn'), 'Acme Logistics'), null) // not a profile
  assert.equal(parseProfileHit(hit('https://www.linkedin.com/in/x', 'Top 10 HR managers - Acme Logistics | LinkedIn'), 'Acme Logistics'), null) // not a name
})

function setup(icp: unknown) {
  const db = new Database(':memory:'); migrateScan(db); migrateConnectors(db); migrateTinyfish(db); resetTinyfishState()
  const job = createJob(db, 'A', { business_name: 'Seller', industry: 'x', location: 'y' })
  db.prepare("UPDATE scan_jobs SET status = 'running', icp = ? WHERE id = ?").run(JSON.stringify(icp), job)
  db.prepare('INSERT INTO leads (id,scan_job_id,company,contact,signal,source_url,evidence_excerpt,confidence,score) VALUES (?,?,?,?,?,?,?,?,?)')
    .run('L1', job, 'Acme Logistics', null, 'Acme Logistics is hiring', 'https://news.example.test/a', 'Acme Logistics is hiring', 90, 80)
  return { db, job }
}
const ICP = { summary: 's', who: ['HR manager', 'Head of People'], industries: [], sizes: [], where: ['Ohio'], signals: [], exclude: [], country: 'US', language: 'en' }
const env = { TINYFISH_API_KEY: 'k', TINYFISH_TENANT_DAILY: '50' }

test('stores matching people as labelled person enrichments with the profile URL; sends the buyer market', async () => {
  const { db, job } = setup(ICP)
  const urls: string[] = []
  const f = (async (u: string) => { urls.push(u); return new Response(JSON.stringify({ results: [
    { url: 'https://www.linkedin.com/in/jane-doe-1', title: 'Jane Doe - Head of HR - Acme Logistics | LinkedIn', snippet: '' },
    { url: 'https://www.linkedin.com/in/bob-ray', title: 'Bob Ray - Truck Driver - Acme Logistics | LinkedIn', snippet: '' },
    { url: 'https://www.linkedin.com/in/ann-lee', title: 'Ann Lee - HR Manager - Rival Corp | LinkedIn', snippet: '' },
  ] })) }) as unknown as typeof fetch
  const n = await findPeople(db, 'A', job, { env, fetchImpl: f })
  assert.equal(n, 1)
  const rows = db.prepare("SELECT connector, kind, value, label, source_url FROM lead_enrichments").all()
  assert.deepEqual(rows, [{ connector: 'search:people', kind: 'person', value: 'Jane Doe, Head of HR', label: LABEL, source_url: 'https://www.linkedin.com/in/jane-doe-1' }])
  const q = new URL(urls[0]).searchParams
  assert.ok(q.get('query')!.startsWith('site:linkedin.com/in "Acme Logistics"')); assert.equal(q.get('location'), 'US')
})

test('off without TinyFish, with the kill switch, or with no buyer roles: no search at all', async () => {
  let calls = 0
  const f = (async () => { calls++; return new Response('{"results":[]}') }) as unknown as typeof fetch
  for (const [icp, e] of [[ICP, {}], [ICP, { ...env, PEOPLE_SEARCH_ENABLED: '0' }], [{ ...ICP, who: [] }, env]] as const) {
    const { db, job } = setup(icp)
    assert.equal(await findPeople(db, 'A', job, { env: e as Record<string, string>, fetchImpl: f }), 0)
  }
  assert.equal(calls, 0)
})
