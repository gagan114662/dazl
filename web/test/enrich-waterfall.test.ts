// #382: Apollo -> PDL as a real fallback waterfall. Stubbed providers (invented company and people); no network, no credits.
import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { randomBytes } from 'node:crypto'
import { enrichLeadContacts, APOLLO_CALLS, PDL_CALLS, MAX_FAILS } from '../lib/enrich/index.ts'
import { migrateScan, createJob } from '../lib/scan/store.ts'
import { migrateConnectors, saveCredential, recentAudit, enrichmentsForLeads } from '../lib/connectors/store.ts'

const master = randomBytes(32)
const ok = (b: unknown) => new Response(JSON.stringify(b), { status: 200 })
const NYC = JSON.stringify({ summary: 'NYC dental', where: ['New York City'], who: ['Practice manager'], signals: [] })
function seed(n = 1, both = true) {
  const db = new Database(':memory:'); migrateScan(db); migrateConnectors(db)
  const jobId = createJob(db, 'u1', { business_name: 'B', industry: 'I', location: 'L' })
  db.prepare("UPDATE scan_jobs SET status = 'running', icp = ? WHERE id = ?").run(NYC, jobId)
  const leads = Array.from({ length: n }, (_, i) => ({ id: `lead${i + 1}`, company: i === 0 ? 'Harbor Dental' : `Harbor Dental ${i + 1}`, company_domain: i === 0 ? 'harbordental.example' : null as string | null }))
  for (const l of leads) db.prepare("INSERT INTO leads (id, scan_job_id, name, company, company_domain, signal, source_url) VALUES (?, ?, '', ?, ?, 'opened', 'https://x.example/1')").run(l.id, jobId, l.company, l.company_domain)
  saveCredential(db, 'u1', 'enrich:apollo', 'test-apollo-key-1234', master)
  if (both) saveCredential(db, 'u1', 'enrich:pdl', 'test-pdl-key-5678', master)
  return { db, jobId, leads }
}
const apolloWith = (people: unknown[], org: unknown = { organization: { name: 'Harbor Dental', website_url: 'https://harbordental.example', city: 'New York', state: 'New York', country: 'United States' } }) => async (url: string) => String(url).includes('organizations/enrich') ? ok(org) : ok({ people })
const PERSON = { name: 'Invented Manager', title: 'Practice Manager', linkedin_url: 'https://profiles.example/m', organization: { name: 'Harbor Dental', primary_domain: 'harbordental.example' } }
const PDL_OK = { data: [{ full_name: 'Pdl Person', job_title: 'Practice Manager', job_company_website: 'harbordental.example', job_company_location_locality: 'new york', job_company_location_region: 'new york', job_company_location_country: 'united states' }] }
type Calls = { apollo: number; pdl: number }
const router = (apollo: (u: string) => Promise<Response>, pdl: () => Promise<Response>, calls: Calls) => (async (u: RequestInfo | URL) => { const s = String(u); if (s.includes('apollo.io')) { calls.apollo++; return apollo(s) } calls.pdl++; return pdl() }) as typeof fetch
const attached = (db: Database.Database, id = 'lead1') => (enrichmentsForLeads(db, 'u1', [id])[id] ?? []).filter(e => e.kind === 'contact').map(e => `${e.connector}:${e.value}`)
const statuses = (db: Database.Database) => (recentAudit(db, 'u1', 50) as { connector: string; status: string }[]).map(a => `${a.connector.replace('enrich:', '')}:${a.status}`).reverse()

for (const [why, apollo] of [
  ['empty', async (u: string) => (u.includes('organizations') ? ok({ organization: { name: 'Harbor Dental', website_url: 'https://harbordental.example', city: 'New York', state: 'New York', country: 'United States' } }) : ok({ people: [] }))],
  ['401', async () => new Response('no', { status: 401 })],
  ['429', async () => new Response('slow', { status: 429 })],
  ['timeout', async () => { throw new DOMException('aborted', 'AbortError') }],
  ['5xx', async () => new Response('x', { status: 503 })],
] as [string, (u: string) => Promise<Response>][]) {
  test(`both keys: Apollo ${why} -> PDL is tried and its valid, agreeing person is attached`, async () => {
    const { db, jobId, leads } = seed(); const calls: Calls = { apollo: 0, pdl: 0 }
    const r = await enrichLeadContacts(db, 'u1', jobId, leads, { fetchImpl: router(apollo, async () => ok(PDL_OK), calls), master })
    assert.deepEqual(attached(db), ['enrich:pdl:Pdl Person - Practice Manager']); assert.deepEqual(r.byProvider, { apollo: 0, pdl: 1 }); assert.equal(calls.pdl, 1)
  })
}

test('Apollo finds a verified person: PDL is not called (and not charged)', async () => {
  const { db, jobId, leads } = seed(); const calls: Calls = { apollo: 0, pdl: 0 }
  await enrichLeadContacts(db, 'u1', jobId, leads, { fetchImpl: router(apolloWith([PERSON]), async () => ok(PDL_OK), calls), master })
  assert.deepEqual(attached(db), ['enrich:apollo:Invented Manager - Practice Manager']); assert.equal(calls.pdl, 0)
})

test('only a PDL key (no Apollo key) still works; only an Apollo key never calls PDL', async () => {
  const a = seed(1, false); const c1: Calls = { apollo: 0, pdl: 0 }
  await enrichLeadContacts(a.db, 'u1', a.jobId, a.leads, { fetchImpl: router(async () => ok({ people: [] }), async () => ok(PDL_OK), c1), master }); assert.equal(c1.pdl, 0)
  const b = seed(1, true); b.db.prepare("DELETE FROM tenant_connectors WHERE connector = 'enrich:apollo'").run(); const c2: Calls = { apollo: 0, pdl: 0 }
  await enrichLeadContacts(b.db, 'u1', b.jobId, b.leads, { fetchImpl: router(async () => ok({ people: [] }), async () => ok(PDL_OK), c2), master })
  assert.deepEqual([c2.apollo, c2.pdl, attached(b.db).length], [0, 1, 1])
})

test('wrong-company results are still rejected, whichever provider returns them: Apollo (other company) falls through, PDL (Pico Rivera) is refused', async () => {
  const { db, jobId, leads } = seed(); const calls: Calls = { apollo: 0, pdl: 0 }
  const wrong = { data: [{ full_name: 'Wrong Person', job_title: 'Manager', job_company_website: 'harbordental.example', job_company_location_locality: 'pico rivera', job_company_location_region: 'california', job_company_location_country: 'united states' }] }
  const other = { ...PERSON, organization: { name: 'Totally Different Co', primary_domain: 'different.example' } }
  const r = await enrichLeadContacts(db, 'u1', jobId, leads, { fetchImpl: router(apolloWith([other]), async () => ok(wrong), calls), master })
  assert.deepEqual(attached(db), []); assert.equal(r.attached, 0); assert.ok(calls.pdl === 1, 'PDL was tried after Apollo yielded nothing usable')
})

test('a bad Apollo key opens only Apollo: later leads skip it visibly and still use PDL; the pass does not end', async () => {
  const { db, jobId, leads } = seed(2); const calls: Calls = { apollo: 0, pdl: 0 }
  const r = await enrichLeadContacts(db, 'u1', jobId, leads, { fetchImpl: router(async () => new Response('no', { status: 401 }), async () => ok(PDL_OK), calls), master })
  assert.equal(calls.apollo, 1, 'one failed attempt, then the circuit is open'); assert.equal(calls.pdl, 2)
  assert.deepEqual(r.skipped.filter(s => s.provider === 'apollo').map(s => s.why), ['circuit_open'])
  assert.ok(statuses(db).includes('apollo:circuit_open') && statuses(db).includes('apollo:auth'))
  assert.deepEqual(attached(db, 'lead2'), ['enrich:pdl:Pdl Person - Practice Manager'], 'the second lead (no domain) takes PDL\'s record because its employer place agrees with the scan geography')
})

test('repeated transient failures open the circuit after MAX_FAILS; exhausted budget is a visible skip, not silent', async () => {
  const { db, jobId, leads } = seed(5); const calls: Calls = { apollo: 0, pdl: 0 }
  await enrichLeadContacts(db, 'u1', jobId, leads, { fetchImpl: router(async () => new Response('slow', { status: 429 }), async () => ok({ data: [] }), calls), master })
  assert.equal(calls.apollo, 4, `lead 1 costs an org + a people call, leads 2 and 3 one failed org call each; the circuit opens at ${MAX_FAILS} failures and leads 4-5 are skipped`); assert.ok(statuses(db).includes('apollo:circuit_open'))
  assert.ok(APOLLO_CALLS >= 1 && PDL_CALLS >= 1)
})

test('a replayed job does not pay again: a lookup this job already made is skipped (found -> stop, empty -> next provider)', async () => {
  const { db, jobId, leads } = seed(); const calls: Calls = { apollo: 0, pdl: 0 }
  const f = router(apolloWith([]), async () => ok(PDL_OK), calls)
  await enrichLeadContacts(db, 'u1', jobId, leads, { fetchImpl: f, master })
  assert.deepEqual([calls.apollo > 0, calls.pdl], [true, 1]); const before = { ...calls }
  const again = await enrichLeadContacts(db, 'u1', jobId, leads, { fetchImpl: f, master })
  assert.deepEqual(calls, before, 'no provider call at all on the replay'); assert.deepEqual(again.skipped.map(s => `${s.provider}:${s.why}`), ['apollo:replayed', 'pdl:replayed'])
  assert.equal(attached(db).length, 1, 'no duplicate rows')
})

test('an exhausted per-tenant budget skips visibly (an audit row), the other provider still runs, and nothing is silently dropped', async () => {
  const { db, jobId, leads } = seed(3); const calls: Calls = { apollo: 0, pdl: 0 }
  const r = await enrichLeadContacts(db, 'u1', jobId, leads, { fetchImpl: router(apolloWith([]), async () => ok(PDL_OK), calls), master, budget: { apollo: 1, pdl: 2 } })
  assert.equal(calls.pdl, 2, 'PDL stops at its own budget'); assert.ok(r.skipped.some(s => s.provider === 'apollo' && s.why === 'budget_exhausted') && r.skipped.some(s => s.provider === 'pdl' && s.why === 'budget_exhausted'))
  assert.ok(statuses(db).includes('apollo:budget_exhausted') && statuses(db).includes('pdl:budget_exhausted'))
})
