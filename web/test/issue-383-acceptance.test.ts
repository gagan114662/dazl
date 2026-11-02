// #383 ACCEPTANCE HARNESS - one executable fixture per acceptance criterion of the issue
// ("Filter decision-maker enrichment by buyer role before truncating results"). Offline fixtures
// only: no provider is called. Criteria text from the issue; each test names the criterion it pins.
//   1. A fixture company whose relevant buyer is beyond the first five unfiltered employees returns
//      the buyer (the role filter reaches retrieval BEFORE the page cap).
//   2. A former employee and an assistant-to-the-buyer are rejected, never attached.
//   3. No person is inferred from a generic inbox (mailbox-shaped names never attach; a lead whose
//      only contact is a generic inbox gets EMPTY best-person fields, never an invented person).
//   4. Named verified-gated vs search-result-only contacts are shown separately (distinct named
//      sources; the public search result keeps its "not verified as current" label).
import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { randomBytes } from 'node:crypto'
import { apolloPeopleSearch } from '../lib/enrich/apollo.ts'
import { pdlPeopleSearch } from '../lib/enrich/pdl.ts'
import { enrichLeadContacts } from '../lib/enrich/index.ts'
import { migrateScan, createJob } from '../lib/scan/store.ts'
import { migrateConnectors, saveCredential, addEnrichment, enrichmentsForLeads } from '../lib/connectors/store.ts'
import { bestPeople } from '../lib/people/best-person.ts'
import { contactsFromEnrichments, PEOPLE_SOURCE } from '../lib/people/rank.ts'
import { sqliteDb } from '../lib/db/client.ts'

const master = randomBytes(32)
const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 })
const ORG_RESP = { organization: { name: 'Acme Inc', estimated_num_employees: 86, industry: 'Software', founded_year: 2019, website_url: 'https://acme.com' } }
const person = (name: string, title: string | null, org: string | null = 'Acme Inc') => ({ name, title, linkedin_url: `https://linkedin.com/in/${name.replace(/\W+/g, '').toLowerCase()}`, organization: org ? { name: org, primary_domain: 'acme.com' } : null })

const SITE_KEY = 'seller-site.com'
let decClock = 1000
function confirm(db: Database.Database, jobId: string, offerId: string, text: string) {
  db.prepare('INSERT INTO seller_decisions (id,tenant_id,actor_id,job_id,site,offer_id,hypothesis_id,kind,text,action,source_url,source_quote,source_checked_at,created_at,version) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,1)')
    .run(randomBytes(8).toString('hex'), 'u1', 'actor1', jobId, SITE_KEY, offerId, `h-${randomBytes(4).toString('hex')}`, 'persona', text, 'confirm', null, null, null, decClock++)
}
function seed(opts: { confirmed?: string[] } = {}) {
  const db = new Database(':memory:')
  migrateScan(db); migrateConnectors(db)
  const jobId = createJob(db, 'u1', { business_name: 'B', industry: 'I', location: 'L' })
  db.prepare("UPDATE scan_jobs SET status = 'running' WHERE id = ?").run(jobId)
  db.prepare('UPDATE scan_jobs SET icp = ?, icp_inferred = 0 WHERE id = ?').run(JSON.stringify({ who: ['VP Sales'], research: { v: 1, site: 'https://seller-site.com', offers: [{ i: 'o1', n: 'Flags' }], hyps: [], q: null, ans: null } }), jobId)
  for (const t of opts.confirmed ?? []) confirm(db, jobId, 'o1', t)
  db.prepare("INSERT INTO leads (id, scan_job_id, name, company, company_domain, signal, source_url, score) VALUES ('lead1', ?, '', 'Acme', 'acme.com', 'hiring', 'https://x.com/1', 50)").run(jobId)
  saveCredential(db, 'u1', 'enrich:apollo', 'test-apollo-key-1234', master)
  return { db, jobId, leads: [{ id: 'lead1', company: 'Acme', company_domain: 'acme.com', score: 50 }] }
}

test('criterion 1: the fixture company whose buyer is beyond the first five unfiltered employees returns the buyer', async () => {
  const { db, jobId, leads } = seed({ confirmed: ['VP Sales'] })
  const bodies: Record<string, unknown>[] = []
  await enrichLeadContacts(db, 'u1', jobId, leads, { fetchImpl: (async (url: RequestInfo | URL, init?: RequestInit) => {
    const u = String(url)
    if (u.includes('organizations/enrich')) return ok(ORG_RESP)
    const body = JSON.parse(String(init?.body)); bodies.push(body)
    if (body.person_titles) return ok({ people: [person('Jane Buyer', 'VP Sales')] }) // filtered page: the buyer
    return ok({ people: [person('A One', 'Recruiter'), person('B Two', 'Intern'), person('C Three', 'Designer'), person('D Four', 'Analyst'), person('E Five', 'Coach')] }) // unfiltered first five: buyer absent
  }) as never, master })
  const contacts = enrichmentsForLeads(db, 'u1', ['lead1']).lead1.filter(r => r.kind === 'contact')
  assert.deepEqual(contacts.map(r => r.value), ['Jane Buyer - VP Sales'], 'the buyer the unfiltered page omitted is returned')
  assert.equal(bodies.filter(b => b.person_titles).length, 1, 'the reviewed role reached retrieval')
})

test('criterion 2: the former employee and the assistant-to-the-buyer are rejected, never attached', async () => {
  const { db, jobId, leads } = seed({ confirmed: ['VP Sales'] })
  await enrichLeadContacts(db, 'u1', jobId, leads, { fetchImpl: (async (url: RequestInfo | URL) => {
    if (String(url).includes('organizations/enrich')) return ok(ORG_RESP)
    return ok({ people: [person('Aide Adams', 'Executive Assistant to the CEO'), person('Former Fred', 'VP Sales', 'Other Corp'), person('Past Pam', 'Former VP of Sales'), person('Jane Buyer', 'VP Sales')] })
  }) as never, master })
  const rows = enrichmentsForLeads(db, 'u1', ['lead1']).lead1
  assert.deepEqual(rows.filter(r => r.kind === 'contact').map(r => r.value), ['Jane Buyer - VP Sales'])
  const rejected = rows.filter(r => r.kind === 'contact_rejected')
  assert.equal(rejected.filter(r => r.label === 'contact_role_mismatch').length, 2, 'assistant-to and past-title both named as role rejections')
  assert.ok(!JSON.stringify(rows).includes('Former Fred'), 'the former employee is never attached')
})

test('criterion 3a: a mailbox-shaped provider result is not a person (Apollo and PDL boundaries)', async () => {
  const apollo = await apolloPeopleSearch('k', { domain: 'acme.com', name: 'Acme' }, (async (_u: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body))
    if (body.q_organization_domains) return ok({ people: [person('info@acme.com', 'VP Sales'), person('Jane Buyer', 'VP Sales')] })
    return ok({ people: [] })
  }) as never, 5, { titles: ['VP Sales'] })
  assert.deepEqual(apollo.map(p => p.name), ['Jane Buyer'], 'a generic inbox never becomes an Apollo person')
  const pdl = await pdlPeopleSearch('k', 'Acme', (async () => ok({ data: [{ full_name: 'sales@acme.com', job_title: 'VP Sales', job_company_name: 'acme', job_company_website: 'acme.com' }, { full_name: 'Jane Buyer', job_title: 'VP Sales', job_company_name: 'acme', job_company_website: 'acme.com' }] })) as never, 5)
  assert.deepEqual(pdl.map(p => p.name), ['Jane Buyer'], 'a generic inbox never becomes a PDL person')
})

test('criterion 3b: a lead whose only contact is a generic inbox gets EMPTY best-person fields, not an invented person', async () => {
  const { db, jobId } = seed()
  addEnrichment(db, 'u1', 'lead1', { connector: 'enrich:apollo', kind: 'email', value: 'info@acme.com', label: 'Apollo', confidence: 70, source_url: 'https://x.com/1', source_date: '2026-11-02', retrieved_at: 1 })
  const best = await bestPeople(sqliteDb(db), 'u1', [{ lead_id: 'lead1', job_id: jobId }])
  assert.deepEqual(best.get('lead1'), { best_person: '', best_person_title: '', best_person_link: '', best_person_found_via: '' }, 'nothing is invented from a generic inbox')
})

test('criterion 4: named provider-verified-gated and search-result-only contacts are shown separately', async () => {
  const { db, jobId, leads } = seed({ confirmed: ['VP Sales'] })
  await enrichLeadContacts(db, 'u1', jobId, leads, { fetchImpl: (async (url: RequestInfo | URL) => {
    if (String(url).includes('organizations/enrich')) return ok(ORG_RESP)
    return ok({ people: [person('Jane Buyer', 'VP Sales')] })
  }) as never, master })
  addEnrichment(db, 'u1', 'lead1', { connector: 'search:people', kind: 'person', value: 'Sam Maybe, VP Sales', label: 'public search result (profile title), not verified as current staff', confidence: null, source_url: 'https://linkedin.com/in/sammaybe', source_date: '2026-11-02', retrieved_at: 1 })
  const rows = enrichmentsForLeads(db, 'u1', ['lead1']).lead1
  const ranked = contactsFromEnrichments(rows, 'VP Sales')
  assert.equal(ranked.length, 2, 'both classes are listed for the lead')
  const sources = ranked.map(r => PEOPLE_SOURCE[r.connector] ?? r.connector)
  assert.ok(sources.includes('a public LinkedIn search result (not verified as current)'), 'the search-result-only contact is named as such')
  assert.ok(sources.includes('Apollo (provider search result, not verified as current)'), 'the provider contact is named with its own source')
  assert.notEqual(PEOPLE_SOURCE['search:people'], PEOPLE_SOURCE['enrich:apollo'], 'the two classes are never merged into one label')
  const stored = rows.find(r => r.kind === 'person')
  assert.equal(stored?.label, 'public search result (profile title), not verified as current staff', 'the stored label itself carries the not-verified wording')
})
