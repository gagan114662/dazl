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
    { url: 'https://www.linkedin.com/in/jane-doe-1', title: 'Jane Doe - Head of HR - Acme Logistics | LinkedIn', snippet: 'Columbus, Ohio, United States - Head of HR - Acme Logistics' },
    { url: 'https://www.linkedin.com/in/bob-ray', title: 'Bob Ray - Truck Driver - Acme Logistics | LinkedIn', snippet: 'Columbus, Ohio' },
    { url: 'https://www.linkedin.com/in/ann-lee', title: 'Ann Lee - HR Manager - Rival Corp | LinkedIn', snippet: 'Columbus, Ohio' },
    { url: 'https://www.linkedin.com/in/cal-same', title: 'Cal Same - Head of HR - Acme Logistics | LinkedIn', snippet: 'Pico Rivera, California, United States' },
    { url: 'https://www.linkedin.com/in/nowhere-nell', title: 'Nell Nowhere - HR Manager - Acme Logistics | LinkedIn', snippet: 'Head of HR at Acme Logistics' },
  ] })) }) as unknown as typeof fetch
  const n = await findPeople(db, 'A', job, { env, fetchImpl: f })
  assert.equal(n, 1)
  const rows = db.prepare("SELECT connector, kind, value, label, source_url FROM lead_enrichments WHERE kind <> 'contact_rejected'").all()
  assert.deepEqual(rows, [{ connector: 'search:people', kind: 'person', value: 'Jane Doe, Head of HR', label: LABEL, source_url: 'https://www.linkedin.com/in/jane-doe-1' }])
  const q = new URL(urls[0]).searchParams
  assert.ok(q.get('query')!.startsWith('site:linkedin.com/in "Acme Logistics"')); assert.equal(q.get('location'), 'US')
})

test('a same-name company in another place is not attached: a result naming another state, or no place at all, is dropped when the request names a place', async () => {
  const { db, job } = setup(ICP)
  const f = (async () => new Response(JSON.stringify({ results: [
    { url: 'https://www.linkedin.com/in/cal-same', title: 'Cal Same - Head of HR - Acme Logistics | LinkedIn', snippet: 'Pico Rivera, California, United States' },
    { url: 'https://www.linkedin.com/in/nowhere-nell', title: 'Nell Nowhere - HR Manager - Acme Logistics | LinkedIn', snippet: 'Head of HR at Acme Logistics' },
  ] }))) as unknown as typeof fetch
  assert.equal(await findPeople(db, 'A', job, { env, fetchImpl: f }), 0)
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM lead_enrichments WHERE kind <> 'contact_rejected'").get() as { n: number }).n, 0, 'nothing is attached')
  // ... but each refusal is recorded on the lead with its marker, and the search went on to the other results
  const refused = db.prepare("SELECT value, label, source_url FROM lead_enrichments WHERE kind = 'contact_rejected' ORDER BY value").all() as { value: string; label: string; source_url: string }[]
  assert.deepEqual(refused.map(r => r.label).sort(), ['contact_location_mismatch', 'contact_location_unconfirmed'])
  assert.ok(refused.some(r => r.value === 'contact rejected: location mismatch Pico Rivera, California vs Ohio' && r.source_url === 'https://www.linkedin.com/in/cal-same'), JSON.stringify(refused))
  // no place in the request: no demand (global requests are unchanged)
  const g = setup({ ...ICP, where: [] }); assert.equal(await findPeople(g.db, 'A', g.job, { env, fetchImpl: f }), 2)
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

test('parse: past roles and a contradictory current employer are refused (Instinct #193 review)', () => {
  const u = 'https://www.linkedin.com/in/jane-doe'
  // current Rival employee whose snippet only mentions Acme as history
  assert.equal(parseProfileHit(hit(u, 'Jane Doe - HR Manager - Rival Corp | LinkedIn', 'Previously at Acme Logistics'), 'Acme Logistics'), null)
  assert.equal(parseProfileHit(hit(u, 'Jane Doe - Former HR Manager at Acme Logistics | LinkedIn'), 'Acme Logistics'), null)
  assert.equal(parseProfileHit(hit(u, 'Jane Doe - Ex-Head of HR - Acme Logistics | LinkedIn'), 'Acme Logistics'), null)
  assert.equal(parseProfileHit(hit(u, 'Jane Doe - HR Manager - Acme Logistics (previously Rival) | LinkedIn'), 'Acme Logistics'), null)
  assert.deepEqual(parseProfileHit(hit(u, 'Jane Doe - HR Manager - Acme Logistics | LinkedIn'), 'Acme Logistics'), { name: 'Jane Doe', title: 'HR Manager' })
})

const okFetch = (async () => new Response(JSON.stringify({ results: [{ url: 'https://www.linkedin.com/in/jane-doe-1', title: 'Jane Doe - Head of HR - Acme Logistics | LinkedIn', snippet: '' }] }))) as unknown as typeof fetch

test('tenant: another tenant job id stores nothing and searches nothing', async () => {
  const { db, job } = setup(ICP)
  let calls = 0
  const f = (async () => { calls++; return okFetch('' as never) }) as unknown as typeof fetch
  assert.equal(await findPeople(db, 'B', job, { env, fetchImpl: f }), 0)
  assert.equal(calls, 0); assert.equal((db.prepare('SELECT COUNT(*) n FROM lead_enrichments').get() as { n: number }).n, 0)
})

test('quarantined leads are never researched', async () => {
  const { db, job } = setup(ICP)
  db.prepare("UPDATE leads SET quarantined_at = 1 WHERE id = 'L1'").run()
  let calls = 0
  const f = (async () => { calls++; return okFetch('' as never) }) as unknown as typeof fetch
  assert.equal(await findPeople(db, 'A', job, { env, fetchImpl: f }), 0); assert.equal(calls, 0)
})

test('caps: company budget is 5 searches; the tenant daily cap stops the pass', async () => {
  const { db, job } = setup(ICP)
  for (let i = 2; i <= 8; i++) db.prepare('INSERT INTO leads (id,scan_job_id,company,contact,signal,source_url,evidence_excerpt,confidence,score) VALUES (?,?,?,?,?,?,?,?,?)').run(`L${i}`, job, `Company ${i} Ltd`, null, 's', 'https://x.example.test/', 'e', 90, 50)
  let calls = 0
  const f = (async () => { calls++; return new Response('{"results":[]}') }) as unknown as typeof fetch
  await findPeople(db, 'A', job, { env: { ...env, TINYFISH_TENANT_DAILY: '50' }, fetchImpl: f })
  assert.equal(calls, 5)
  calls = 0
  // tenant daily cap of 2 (already 5 used above would exceed it): a fresh db with cap 2 allows exactly 2 searches
  const capped = setup(ICP)
  for (let i = 2; i <= 8; i++) capped.db.prepare('INSERT INTO leads (id,scan_job_id,company,contact,signal,source_url,evidence_excerpt,confidence,score) VALUES (?,?,?,?,?,?,?,?,?)').run(`L${i}`, capped.job, `Company ${i} Ltd`, null, 's', 'https://x.example.test/', 'e', 90, 50)
  await findPeople(capped.db, 'A', capped.job, { env: { ...env, TINYFISH_TENANT_DAILY: '2' }, fetchImpl: f })
  assert.equal(calls, 2)
})

test('deadline: a hung search is abandoned and the pass returns', async () => {
  const { db, job } = setup(ICP)
  const hang = (() => new Promise(() => {})) as unknown as typeof fetch
  const t0 = Date.now()
  assert.equal(await findPeople(db, 'A', job, { env, fetchImpl: hang, deadlineMs: 50 }), 0)
  assert.ok(Date.now() - t0 < 2000)
})

test('parse: one role, one employer; trailing mentions of the company never attach a different current employer (Instinct #193 recheck)', () => {
  const u = 'https://www.linkedin.com/in/jane-doe'
  for (const t of [
    'Jane Doe - HR Manager at Rival Corp - Advisor to Acme Logistics | LinkedIn',
    'Jane Doe - HR Manager - Rival Corp - Acme Logistics customer | LinkedIn',
    'Jane Doe - HR Manager at Acme Logistics - Rival Corp | LinkedIn', // two employers: ambiguous
    'Jane Doe - HR Manager - Acme Logistics Partners | LinkedIn',      // different company containing the words
    'Jane Doe - Acme Logistics | LinkedIn',                              // no role
  ]) assert.equal(parseProfileHit(hit(u, t), 'Acme Logistics'), null, t)
  assert.deepEqual(parseProfileHit(hit(u, 'Jane Doe - HR Manager - Acme Logistics Inc. | LinkedIn'), 'Acme Logistics'), { name: 'Jane Doe', title: 'HR Manager' })
  assert.deepEqual(parseProfileHit(hit(u, 'Jane Doe - HR Manager at Acme Logistics | LinkedIn'), 'Acme Logistics'), { name: 'Jane Doe', title: 'HR Manager' })
})

test('New York City request: a profile result in Rome, NY is not attached; the New York, NY one is', async () => {
  const icp = { ...ICP, where: ['New York, NY'] }
  const { db, job } = setup(icp)
  const f = (async () => new Response(JSON.stringify({ results: [
    { url: 'https://www.linkedin.com/in/rome-rita', title: 'Rita Rome - Head of HR - Acme Logistics | LinkedIn', snippet: 'Rome, New York, United States' },
    { url: 'https://www.linkedin.com/in/nyc-nick', title: 'Nick Nyc - Head of HR - Acme Logistics | LinkedIn', snippet: 'New York, New York, United States' },
  ] }))) as unknown as typeof fetch
  assert.equal(await findPeople(db, 'A', job, { env, fetchImpl: f }), 1)
  assert.deepEqual((db.prepare("SELECT value FROM lead_enrichments WHERE kind = 'person'").all() as { value: string }[]).map(r => r.value), ['Nick Nyc, Head of HR'])
  assert.deepEqual(db.prepare("SELECT label FROM lead_enrichments WHERE kind = 'contact_rejected'").all(), [{ label: 'contact_location_mismatch' }], 'Rome, NY is refused and marked')
})
