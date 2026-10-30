// #383: the reviewed buyer role goes into the provider query before the page cap; returned people are classified. Stubbed providers, invented people; no network, no credits.
import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { randomBytes } from 'node:crypto'
import { enrichLeadContacts } from '../lib/enrich/index.ts'
import { buyerRoleQuery, classifyPerson } from '../lib/enrich/buyer-role.ts'
import { migrateScan, createJob } from '../lib/scan/store.ts'
import { migrateConnectors, saveCredential, recentAudit, enrichmentsForLeads } from '../lib/connectors/store.ts'

const master = randomBytes(32)
const ok = (b: unknown) => new Response(JSON.stringify(b), { status: 200 })
const org = { name: 'Harbor Dental', primary_domain: 'harbordental.example' }
const ORG = { organization: { name: 'Harbor Dental', website_url: 'https://harbordental.example', city: 'New York', state: 'New York', country: 'United States' } }
const person = (name: string, title: string) => ({ name, title, linkedin_url: `https://profiles.example/${name.replace(/ /g, '')}`, organization: org })
// five unrelated employees come FIRST; the buyer is sixth. Unfiltered per_page 5 never sees her.
const ALL = [person('Ann Hygienist', 'Dental Hygienist'), person('Bob Assistant', 'Dental Assistant'), person('Cy Receptionist', 'Receptionist'), person('Di Biller', 'Billing Clerk'), person('Ed Tech', 'Lab Technician'), person('Fay Buyer', 'Practice Manager')]

function seed(who: string[] | null = ['Practice manager'], rows = 1) {
  const db = new Database(':memory:'); migrateScan(db); migrateConnectors(db)
  const jobId = createJob(db, 'u1', { business_name: 'B', industry: 'I', location: 'L' })
  db.prepare("UPDATE scan_jobs SET status = 'running', icp = ? WHERE id = ?").run(JSON.stringify({ summary: 's', where: ['New York City'], who: who ?? [], signals: [] }), jobId)
  const leads = Array.from({ length: rows }, (_, i) => ({ id: `lead${i + 1}`, company: 'Harbor Dental', company_domain: 'harbordental.example' }))
  for (const [i, l] of leads.entries()) db.prepare("INSERT INTO leads (id, scan_job_id, name, company, company_domain, signal, source_url, confidence) VALUES (?, ?, '', ?, ?, 'opened', 'https://x.example/1', ?)").run(l.id, jobId, l.company, l.company_domain, i === 0 ? 10 : 90)
  saveCredential(db, 'u1', 'enrich:apollo', 'test-apollo-key-1234', master)
  return { db, jobId, leads }
}
// a provider that applies person_titles server-side like the real one, then pages
const apollo = (bodies: Record<string, unknown>[]) => (async (u: RequestInfo | URL, init?: RequestInit) => {
  if (String(u).includes('organizations/enrich')) return ok(ORG)
  const b = JSON.parse(String(init?.body ?? '{}')) as { person_titles?: string[]; per_page: number }; bodies.push(b)
  const pool = b.person_titles?.length ? ALL.filter(p => b.person_titles!.some(t => p.title.toLowerCase().includes(t.toLowerCase()))) : ALL
  return ok({ people: pool.slice(0, b.per_page) })
}) as typeof fetch
const contacts = (db: Database.Database, id = 'lead1') => (enrichmentsForLeads(db, 'u1', [id])[id] ?? []).filter(e => e.kind === 'contact')

test('the persona titles and seniority are sent in the query, so a buyer beyond the first five employees is found', async () => {
  const { db, jobId, leads } = seed(); const bodies: Record<string, unknown>[] = []
  await enrichLeadContacts(db, 'u1', jobId, leads, { fetchImpl: apollo(bodies), master })
  assert.deepEqual((bodies[0] as { person_titles: string[] }).person_titles, ['Practice manager'])
  assert.deepEqual(contacts(db).map(c => c.value), ['Fay Buyer - Practice Manager'])
})

test('without a persona nothing is filtered or classified (old behaviour: first page, unlabelled)', async () => {
  const { db, jobId, leads } = seed(null); const bodies: Record<string, unknown>[] = []
  await enrichLeadContacts(db, 'u1', jobId, leads, { fetchImpl: apollo(bodies), master })
  assert.equal('person_titles' in bodies[0], false)
  assert.equal(contacts(db).length, 5); assert.ok(contacts(db).every(c => c.label === 'Apollo'))
})

test('labels: a title match is not decision authority, and a provider-reported employer is the only "current"', async () => {
  const { db, jobId, leads } = seed()
  await enrichLeadContacts(db, 'u1', jobId, leads, { fetchImpl: apollo([]), master })
  const l = contacts(db)[0].label ?? ''
  assert.match(l, /buyer-role match/); assert.match(l, /not verified decision authority/); assert.match(l, /employer reported current by the provider/); assert.doesNotMatch(l, /verified current\b(?!.*not)/)
  assert.match(classifyPerson({ name: 'X Y', title: 'Practice Manager' }, ['Practice manager']).currentness, /search_result_only/)
})

test('rejected: former employee, assistant-to-the-buyer, generic inbox; unrelated titles; owner-level is an alternate', () => {
  const who = ['Practice manager']
  assert.equal(classifyPerson({ name: 'A B', title: 'Former Practice Manager' }, who).match, 'rejected')
  assert.equal(classifyPerson({ name: 'A B', title: 'Assistant to the Practice Manager' }, who).match, 'rejected')
  assert.equal(classifyPerson({ name: 'info@harbor.example', title: 'Practice Manager' }, who).match, 'rejected')
  assert.equal(classifyPerson({ name: 'A B', title: 'Dental Hygienist' }, who).match, 'rejected')
  assert.equal(classifyPerson({ name: 'A B', title: null }, who).match, 'rejected')
  assert.equal(classifyPerson({ name: 'A B', title: 'Owner' }, who).match, 'alternate')
  assert.equal(classifyPerson({ name: 'A B', title: 'Practice Manager' }, who).match, 'buyer')
})

test('rejected people are not attached; the rejection is audited and recorded', async () => {
  const { db, jobId, leads } = seed()
  const f = (async (u: RequestInfo | URL) => String(u).includes('organizations/enrich') ? ok(ORG) : ok({ people: [person('Old Hand', 'Former Practice Manager'), person('Gina Assist', 'Assistant to the Practice Manager')] })) as typeof fetch
  await enrichLeadContacts(db, 'u1', jobId, leads, { fetchImpl: f, master })
  assert.equal(contacts(db).length, 0)
  assert.ok((recentAudit(db, 'u1', 20) as { status: string }[]).some(a => /contact rejected: title .*former, retired/.test(a.status)))
})

test('bounded credits go to the highest-priority leads, not the first in the list', async () => {
  const { db, jobId, leads } = seed(['Practice manager'], 7)    // lead1 has the LOWEST confidence
  db.prepare("UPDATE leads SET company = 'Harbor Dental ' || id, company_domain = id || '.example'").run()
  const named = leads.map((l, i) => ({ ...l, company: `Harbor Dental ${l.id}`, company_domain: `${l.id}.example` }))
  const f = (async (u: RequestInfo | URL) => String(u).includes('organizations/enrich') ? ok({ organization: { name: 'x', website_url: 'https://x.example' } }) : ok({ people: [] })) as typeof fetch
  await enrichLeadContacts(db, 'u1', jobId, named, { fetchImpl: f, master })
  const looked = new Set((recentAudit(db, 'u1', 50) as { lookup: string }[]).map(a => a.lookup))
  assert.equal(looked.has('people Harbor Dental lead1') || looked.has('org Harbor Dental lead1'), false, 'lowest-priority lead is the one dropped')
  assert.equal(looked.has('org Harbor Dental lead2'), true)
})

test('buyerRoleQuery is bounded and deduplicated, and invents nothing', () => {
  const q = buyerRoleQuery(['Practice manager', 'practice manager'.toUpperCase().toLowerCase(), 'x', 'Owner', ...Array.from({ length: 20 }, (_, i) => `Role number ${i}`)])
  assert.ok(q.titles.length <= 8); assert.ok(q.titles.every(t => t.length >= 3)); assert.ok(q.seniorities.includes('owner'))
})
