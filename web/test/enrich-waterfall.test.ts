// #382: with both keys configured, enrichment is a real Apollo -> PDL fallback waterfall. Apollo empty / 401 / 429 /
// transport failure (timeout) falls back to PDL for that lead; an exhausted provider is skipped visibly, never
// re-billed; a lead that already carries an enrich contact is never re-billed on replay; wrong-company records are
// still rejected through the fallback; a dead provider never silently ends the research for the remaining leads.
// Stubbed provider responses and invented companies: no network, no credits, no real keys.
import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { randomBytes } from 'node:crypto'
import { enrichLeadContacts } from '../lib/enrich/index.ts'
import { migrateScan, createJob } from '../lib/scan/store.ts'
import { migrateConnectors, saveCredential, recentAudit, enrichmentsForLeads, addEnrichment } from '../lib/connectors/store.ts'

const master = randomBytes(32)
const ok = (b: unknown) => new Response(JSON.stringify(b), { status: 200 })
const NYC_ICP = JSON.stringify({ summary: 'NYC dental', where: ['New York City'], who: ['Practice manager'], signals: [] })

function seed(nLeads = 1) {
  const db = new Database(':memory:'); migrateScan(db); migrateConnectors(db)
  const jobId = createJob(db, 'u1', { business_name: 'B', industry: 'I', location: 'L' })
  db.prepare("UPDATE scan_jobs SET status = 'running', icp = ? WHERE id = ?").run(NYC_ICP, jobId)
  const leads = []
  for (let i = 1; i <= nLeads; i++) {
    db.prepare("INSERT INTO leads (id, scan_job_id, name, company, company_domain, signal, source_url, fit, intent, action, why) VALUES (?, ?, '', ?, NULL, 'opened a new practice', 'https://x.example/1', 4, 3, 4, 'New dental practice in Sunnyside.')").run(`lead${i}`, jobId, `Practice ${i}`)
    leads.push({ id: `lead${i}`, company: `Practice ${i}`, company_domain: null })
  }
  saveCredential(db, 'u1', 'enrich:apollo', 'test-apollo-key-1234', master)
  saveCredential(db, 'u1', 'enrich:pdl', 'test-pdl-key-5678', master)
  return { db, jobId, leads }
}
const PDL_NY = { full_name: 'Maya Chen', job_title: 'Practice Manager', linkedin_url: 'https://linkedin.com/in/mc', job_company_website: null, job_company_location_locality: 'New York', job_company_location_region: 'New York', job_company_location_country: 'United States' }
// Apollo fixtures; PDL answers the New York candidate. Call log proves who was billed.
function waterfall(apollo: (u: string) => Response | Promise<Response>, calls: string[]) {
  return (async (url: RequestInfo | URL) => {
    const u = String(url); calls.push(u)
    if (u.includes('api.apollo.io')) return apollo(u)
    if (u.includes('peopledatalabs')) return ok({ data: [PDL_NY], status: 200 })
    return new Response('no', { status: 404 })
  }) as never
}
const contacts = (db: Database.Database, id: string) => (enrichmentsForLeads(db, 'u1', [id])[id] ?? []).filter(e => e.kind === 'contact').map(e => `${e.connector}:${e.value}`)
const statuses = (db: Database.Database) => (recentAudit(db, 'u1', 30) as { connector: string; status: string }[]).map(a => `${a.connector}:${a.status}`)

test('Apollo empty (org and people) falls back to PDL and attaches the agreeing candidate', async () => {
  const { db, jobId, leads } = seed(); const calls: string[] = []
  await enrichLeadContacts(db, 'u1', jobId, leads, { fetchImpl: waterfall(() => ok({}), calls), master })
  assert.deepEqual(contacts(db, 'lead1'), ['enrich:pdl:Maya Chen - Practice Manager'])
  assert.ok(calls.some(u => u.includes('organizations/enrich')) && calls.some(u => u.includes('peopledatalabs')), 'Apollo org leg ran, then PDL'); assert.equal(calls.filter(u => u.includes('mixed_people')).length, 0, 'no lead domain and an empty org: Apollo people search has no domain to key on, PDL is the fallback')
  assert.ok(statuses(db).includes('enrich:apollo:empty') && statuses(db).includes('enrich:pdl:ok'), JSON.stringify(statuses(db)))
})

test('Apollo 401: PDL takes over for every lead, Apollo is never re-billed after the first auth failure', async () => {
  const { db, jobId, leads } = seed(3); const calls: string[] = []
  await enrichLeadContacts(db, 'u1', jobId, leads, { fetchImpl: waterfall(() => new Response('no', { status: 401 }), calls), master })
  assert.equal(calls.filter(u => u.includes('api.apollo.io')).length, 1, 'one Apollo call, then dead for the pass')
  assert.equal(calls.filter(u => u.includes('peopledatalabs')).length, 3, 'PDL served all three leads')
  for (const l of leads) assert.deepEqual(contacts(db, l.id), [`enrich:pdl:Maya Chen - Practice Manager`])
  const st = statuses(db)
  assert.ok(st.includes('enrich:apollo:auth'))
  assert.ok(st.includes('skipped: apollo auth earlier this pass'.replace(/^/, 'enrich:apollo:')), JSON.stringify(st))
})

test('Apollo 429 (budget/rate exhausted): visible skip, PDL fallback, no Apollo retry burn', async () => {
  const { db, jobId, leads } = seed(2); const calls: string[] = []
  await enrichLeadContacts(db, 'u1', jobId, leads, { fetchImpl: waterfall(() => new Response('no', { status: 429 }), calls), master })
  assert.equal(calls.filter(u => u.includes('api.apollo.io')).length, 1)
  assert.equal(calls.filter(u => u.includes('peopledatalabs')).length, 2)
  const st = statuses(db)
  assert.ok(st.includes('enrich:apollo:rate_limited') && st.includes('enrich:apollo:skipped: apollo rate_limited earlier this pass'), JSON.stringify(st))
})

test('Apollo transport failure (timeout-shaped throw) falls back to PDL for that lead and Apollo stays up for the next', async () => {
  const { db, jobId, leads } = seed(2); const calls: string[] = []
  let orgCalls = 0
  const apollo = (u: string) => {
    if (u.includes('organizations/enrich')) { orgCalls++; if (orgCalls === 1) throw new TypeError('fetch failed'); return ok({ organization: { name: 'Practice 2', website_url: 'https://practice2.example', city: 'New York', state: 'New York', country: 'United States' } }) }
    if (u.includes('mixed_people')) return ok({ people: [{ name: 'Sam Osei', title: 'Owner', linkedin_url: null, organization: { name: 'Practice 2', primary_domain: null } }] })
    return ok({})
  }
  await enrichLeadContacts(db, 'u1', jobId, leads, { fetchImpl: waterfall(async (u: string) => apollo(u), calls), master })
  assert.deepEqual(contacts(db, 'lead1'), ['enrich:pdl:Maya Chen - Practice Manager'], 'lead 1 fell back')
  assert.deepEqual(contacts(db, 'lead2'), ['enrich:apollo:Sam Osei - Owner'], 'lead 2 used Apollo: a one-off transport failure is not a dead key')
})

test('a lead Apollo enriches is never billed twice: PDL is not called, and a replayed pass bills nothing', async () => {
  const { db, jobId, leads } = seed(); const calls: string[] = []
  const apollo = (u: string) => u.includes('organizations/enrich') ? ok({ organization: { name: 'Practice 1', estimated_num_employees: 9, industry: 'Dental', website_url: 'https://practice1.example', city: 'New York', state: 'New York', country: 'United States' } }) : ok({ people: [{ name: 'Sam Osei', title: 'Owner', linkedin_url: null, organization: { name: 'Practice 1', primary_domain: 'practice1.example' } }] })
  await enrichLeadContacts(db, 'u1', jobId, leads, { fetchImpl: waterfall(apollo, calls), master })
  assert.deepEqual(contacts(db, 'lead1'), ['enrich:apollo:Sam Osei - Owner'])
  assert.equal(calls.filter(u => u.includes('peopledatalabs')).length, 0, 'Apollo attached: PDL never runs for that lead')
  calls.length = 0
  await enrichLeadContacts(db, 'u1', jobId, leads, { fetchImpl: waterfall(apollo, calls), master })
  assert.equal(calls.filter(u => u.includes('api.apollo.io') || u.includes('peopledatalabs')).length, 0, 'replay bills nothing')
  assert.ok(statuses(db).includes('enrich:apollo:skipped: already enriched'), JSON.stringify(statuses(db)))
})

test('a lead enriched by a PRIOR PDL run is not re-billed to Apollo on replay either', async () => {
  const { db, jobId, leads } = seed()
  addEnrichment(db, 'u1', 'lead1', { connector: 'enrich:pdl', kind: 'contact', value: 'Maya Chen - Practice Manager', label: 'People Data Labs', confidence: 70, source_url: 'https://x.example/1', source_date: '2026-10-30', retrieved_at: 1 })
  const calls: string[] = []
  await enrichLeadContacts(db, 'u1', jobId, leads, { fetchImpl: waterfall(() => ok({}), calls), master })
  assert.equal(calls.length, 0)
})

test('wrong-company PDL results are still rejected through the fallback; an Apollo rejection does not let PDL attach a mismatch', async () => {
  const { db, jobId, leads } = seed(); const calls: string[] = []
  const f = (async (url: RequestInfo | URL) => {
    const u = String(url); calls.push(u)
    if (u.includes('api.apollo.io')) return ok({})
    if (u.includes('peopledatalabs')) return ok({ data: [{ ...PDL_NY, job_company_location_locality: 'Pico Rivera', job_company_location_region: 'California' }], status: 200 })
    return new Response('no', { status: 404 })
  }) as never
  await enrichLeadContacts(db, 'u1', jobId, leads, { fetchImpl: f, master })
  assert.deepEqual(contacts(db, 'lead1'), [], 'nothing attached')
  assert.ok(statuses(db).some(s => s.startsWith('enrich:pdl:contact rejected: location mismatch')), JSON.stringify(statuses(db)))
})

test('Apollo dead and PDL auth-failing: research does not silently end - every lead carries an audited reason', async () => {
  const { db, jobId, leads } = seed(2); const calls: string[] = []
  const f = (async (url: RequestInfo | URL) => {
    const u = String(url); calls.push(u)
    if (u.includes('api.apollo.io')) return new Response('no', { status: 401 })
    if (u.includes('peopledatalabs')) return new Response('no', { status: 401 })
    return new Response('no', { status: 404 })
  }) as never
  await enrichLeadContacts(db, 'u1', jobId, leads, { fetchImpl: f, master })
  assert.deepEqual(contacts(db, 'lead1'), []); assert.deepEqual(contacts(db, 'lead2'), [])
  assert.equal(calls.filter(u => u.includes('peopledatalabs')).length, 1, 'PDL dead after its own auth failure')
  const st = statuses(db)
  for (const want of ['enrich:apollo:auth', 'enrich:pdl:auth', 'enrich:apollo:skipped: apollo auth earlier this pass', 'enrich:pdl:skipped: pdl auth earlier this pass']) assert.ok(st.includes(want), `${want} in ${JSON.stringify(st)}`)
})
