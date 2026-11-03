// #383: the reviewed buyer role filters decision-maker retrieval BEFORE the page cap. Without it the
// first unfiltered Apollo page (5 people) can omit the buyer entirely and no later display ranking
// recovers a person never fetched. Pinned here: titles go into the query; REVIEWED means an explicit
// seller_decisions confirm row (a submitted profile alone is NOT review - presence in JSON proves
// authorship of the payload, not approval of the titles); an unreviewed persona (model-inferred,
// request-fallback, or merely submitted) never narrows retrieval; an empty filtered page makes NO
// extra query (fallback cost not account-verified: fail closed, audited); a later reject supersedes
// an earlier confirm; decisions never cross offer IDs; former employees and assistant-to/past titles
// are rejected at the source with a named reason; nameless/generic results never become a person;
// bounded enrichment goes to the highest-priority leads first. Offline fixtures only - no provider is called.
import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { randomBytes } from 'node:crypto'
import { apolloPeopleSearch } from '../lib/enrich/apollo.ts'
import { enrichLeadContacts, reviewedBuyerTitles } from '../lib/enrich/index.ts'
import { migrateScan, createJob } from '../lib/scan/store.ts'
import { migrateConnectors, saveCredential, recentAudit, enrichmentsForLeads } from '../lib/connectors/store.ts'

const master = randomBytes(32)
const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 })
const ORG_RESP = { organization: { name: 'Acme Inc', estimated_num_employees: 86, industry: 'Software', founded_year: 2019, website_url: 'https://acme.com' } }
const person = (name: string, title: string | null, org: string | null = 'Acme Inc') => ({ name, title, linkedin_url: `https://linkedin.com/in/${name.replace(/\W+/g, '').toLowerCase()}`, organization: org ? { name: org, primary_domain: 'acme.com' } : null })

const SITE = 'https://seller-site.com'
const SITE_KEY = 'seller-site.com' // siteKey(SITE): decisions are stored keyed, like decisionRows writes them
let decClock = 1000
function decide(db: Database.Database, jobId: string, offerId: string, text: string, action: 'confirm' | 'reject', at?: number) {
  db.prepare('INSERT INTO seller_decisions (id,tenant_id,actor_id,job_id,site,offer_id,hypothesis_id,kind,text,action,source_url,source_quote,source_checked_at,created_at,version) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,1)')
    .run(randomBytes(8).toString('hex'), 'u1', 'actor1', jobId, SITE_KEY, offerId, `h-${randomBytes(4).toString('hex')}`, 'persona', text, action, null, null, null, at ?? decClock++)
}

function seed(opts: { who?: string[]; inferred?: number; confirmed?: string[]; confirmedOffer?: string; leads?: { id: string; company: string; score: number }[] } = {}) {
  const db = new Database(':memory:')
  migrateScan(db); migrateConnectors(db)
  const jobId = createJob(db, 'u1', { business_name: 'B', industry: 'I', location: 'L' })
  db.prepare("UPDATE scan_jobs SET status = 'running' WHERE id = ?").run(jobId)
  if (opts.who) db.prepare('UPDATE scan_jobs SET icp = ?, icp_inferred = ? WHERE id = ?').run(JSON.stringify({ who: opts.who, research: { v: 1, site: SITE, offers: [{ i: 'o1', n: 'Flags' }], hyps: [], q: null, ans: null } }), opts.inferred ?? 0, jobId)
  for (const t of opts.confirmed ?? []) decide(db, jobId, opts.confirmedOffer ?? 'o1', t, 'confirm')
  const leads = (opts.leads ?? [{ id: 'lead1', company: 'Acme', score: 50 }])
  for (const l of leads) db.prepare("INSERT INTO leads (id, scan_job_id, name, company, company_domain, signal, source_url, score) VALUES (?, ?, '', ?, ?, 'hiring', 'https://x.com/1', ?)").run(l.id, jobId, l.company, `${l.company.toLowerCase()}.com`, l.score)
  saveCredential(db, 'u1', 'enrich:apollo', 'test-apollo-key-1234', master)
  return { db, jobId, leads: leads.map(l => ({ id: l.id, company: l.company, company_domain: `${l.company.toLowerCase()}.com`, score: l.score })) }
}

test('apolloPeopleSearch: the reviewed titles go into the query before the page cap; none invented', async () => {
  const bodies: Record<string, unknown>[] = []
  const fetchImpl = (async (_url: RequestInfo | URL, init?: RequestInit) => { bodies.push(JSON.parse(String(init?.body))); return ok({ people: [] }) }) as never
  await apolloPeopleSearch('k', { domain: 'acme.com', name: 'Acme' }, fetchImpl, 5, { titles: ['VP Sales', 'Head of Growth'] })
  assert.deepEqual(bodies[0].person_titles, ['VP Sales', 'Head of Growth'])
  assert.equal(bodies[0].per_page, 5, 'the cap is unchanged - the filter arrives before it')
  assert.ok(!('person_seniorities' in bodies[0]), 'no seniority is invented from title words')
  await apolloPeopleSearch('k', { domain: 'acme.com', name: 'Acme' }, fetchImpl, 5, { titles: ['', '  '] })
  assert.ok(!('person_titles' in bodies[1]), 'blank reviewed titles add no filter')
})

test('buyer beyond the first five unfiltered people is returned by the role-filtered query', async () => {
  const { db, jobId, leads } = seed({ who: ['VP Sales'], confirmed: ['VP Sales'] })
  const bodies: Record<string, unknown>[] = []
  const fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const u = String(url)
    if (u.includes('organizations/enrich')) return ok(ORG_RESP)
    const body = JSON.parse(String(init?.body)); bodies.push(body)
    if (body.person_titles) return ok({ people: [person('Jane Buyer', 'VP Sales')] }) // the role-filtered page
    return ok({ people: [person('A One', 'Recruiter'), person('B Two', 'Intern'), person('C Three', 'Designer'), person('D Four', 'Analyst'), person('E Five', 'Coach')] }) // the unfiltered first page: buyer absent
  }) as never
  await enrichLeadContacts(db, 'u1', jobId, leads, { fetchImpl, master })
  assert.equal(bodies.filter(b => b.person_titles).length, 1, 'exactly one role-filtered people query')
  assert.equal(bodies.length, 1, 'no fallback when the filtered page has results')
  const rows = enrichmentsForLeads(db, 'u1', ['lead1']).lead1
  const contacts = rows.filter(r => r.kind === 'contact')
  assert.deepEqual(contacts.map(r => r.value), ['Jane Buyer - VP Sales'], 'the buyer the unfiltered page omitted is attached')
})

test('an empty role-filtered page makes NO extra query: the fallback cost is not account-verified, so it fails closed, audited', async () => {
  const { db, jobId, leads } = seed({ who: ['VP Sales'], confirmed: ['VP Sales'] })
  const bodies: Record<string, unknown>[] = []
  const fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const u = String(url)
    if (u.includes('organizations/enrich')) return ok(ORG_RESP)
    const body = JSON.parse(String(init?.body)); bodies.push(body)
    return ok({ people: [] })
  }) as never
  await enrichLeadContacts(db, 'u1', jobId, leads, { fetchImpl, master })
  assert.equal(bodies.length, 1, 'exactly one people query: no unfiltered fallback burn')
  assert.ok(bodies[0].person_titles)
  const rows = enrichmentsForLeads(db, 'u1', ['lead1']).lead1
  assert.deepEqual(rows.filter(r => r.kind === 'contact'), [], 'nobody is attached when the reviewed persona matches no one')
  const st = (recentAudit(db, 'u1', 20) as { status: string }[]).map(a => a.status)
  assert.ok(st.includes('role-filtered people search empty; no unfiltered fallback: extra query cost not account-verified'), 'the held fallback is visible, never silent')
  assert.ok(st.includes('enrich:apollo:empty') || st.includes('empty'), 'the people claim settles empty, not ok')
})

test('an UNREVIEWED persona never narrows retrieval: model-inferred, request-fallback AND merely-submitted ICPs get the plain unfiltered query', async () => {
  for (const [inferred, label] of [[1, 'model-inferred'], [2, 'request-fallback'], [0, 'submitted-not-confirmed']] as const) {
    const { db, jobId, leads } = seed({ who: ['VP Sales'], inferred })
    const bodies: Record<string, unknown>[] = []
    await enrichLeadContacts(db, 'u1', jobId, leads, { fetchImpl: (async (url: RequestInfo | URL, init?: RequestInit) => {
      const u = String(url)
      if (u.includes('organizations/enrich')) return ok(ORG_RESP)
      bodies.push(JSON.parse(String(init?.body)))
      return ok({ people: [person('Jane Buyer', 'Revenue Lead')] })
    }) as never, master })
    assert.equal(bodies.length, 1, `${label}: one unfiltered query`)
    assert.ok(!('person_titles' in bodies[0]), `${label}: the unreviewed persona is not sent to the provider`)
    assert.deepEqual(reviewedBuyerTitles(db, jobId), [], `${label}: no reviewed persona`)
    const rows = enrichmentsForLeads(db, 'u1', ['lead1']).lead1
    assert.deepEqual(rows.filter(r => r.kind === 'contact').map(r => r.value), ['Jane Buyer - Revenue Lead'], `${label}: recall is the pre-filter behavior, unchanged`)
  }
})

test('PDL parity: the same post-fetch role classification rejects past/assistant titles with no extra PDL query', async () => {
  const db = new Database(':memory:')
  migrateScan(db); migrateConnectors(db)
  const jobId = createJob(db, 'u1', { business_name: 'B', industry: 'I', location: 'L' })
  db.prepare("UPDATE scan_jobs SET status = 'running' WHERE id = ?").run(jobId)
  db.prepare("INSERT INTO leads (id, scan_job_id, name, company, company_domain, signal, source_url) VALUES ('lead1', ?, '', 'Acme', 'acme.com', 'hiring', 'https://x.com/1')").run(jobId)
  saveCredential(db, 'u1', 'enrich:pdl', 'test-pdl-key-5678', master)
  let pdlCalls = 0
  await enrichLeadContacts(db, 'u1', jobId, [{ id: 'lead1', company: 'Acme', company_domain: 'acme.com' }], { fetchImpl: (async () => {
    pdlCalls++
    return ok({ data: [
      { full_name: 'Aide Adams', job_title: 'Executive Assistant to the CEO', linkedin_url: 'https://li/aide' },
      { full_name: 'Past Pam', job_title: 'Former VP of Sales', linkedin_url: 'https://li/pam' },
      { full_name: 'Jane Buyer', job_title: 'VP Sales', linkedin_url: 'https://li/jane' },
    ] })
  }) as never, master })
  assert.equal(pdlCalls, 1, 'one PDL query: classification is post-fetch, no new paid call shape')
  const rows = enrichmentsForLeads(db, 'u1', ['lead1']).lead1
  assert.deepEqual(rows.filter(r => r.kind === 'contact').map(r => r.value), ['Jane Buyer - VP Sales'])
  assert.equal(rows.filter(r => r.kind === 'contact_rejected' && r.label === 'contact_role_mismatch').length, 2, 'both wrong-person profiles rejected with the named code')
})

test('no reviewed buyer roles: one unfiltered query, no fallback burn', async () => {
  const { db, jobId, leads } = seed()
  const bodies: Record<string, unknown>[] = []
  await enrichLeadContacts(db, 'u1', jobId, leads, { fetchImpl: (async (url: RequestInfo | URL, init?: RequestInit) => {
    const u = String(url)
    if (u.includes('organizations/enrich')) return ok(ORG_RESP)
    bodies.push(JSON.parse(String(init?.body)))
    return ok({ people: [person('Jane Buyer', 'VP Sales')] })
  }) as never, master })
  assert.equal(bodies.length, 1)
  assert.ok(!('person_titles' in bodies[0]))
  assert.deepEqual(reviewedBuyerTitles(db, jobId), [])
})

test('assistant-to and former-employee candidates are rejected at the source with named reasons, never attached', async () => {
  const { db, jobId, leads } = seed({ who: ['VP Sales'], confirmed: ['VP Sales'] })
  await enrichLeadContacts(db, 'u1', jobId, leads, { fetchImpl: (async (url: RequestInfo | URL) => {
    const u = String(url)
    if (u.includes('organizations/enrich')) return ok(ORG_RESP)
    return ok({ people: [
      person('Aide Adams', 'Executive Assistant to the CEO'),
      person('Former Fred', 'VP Sales', 'Other Corp'),       // person whose own org contradicts the company
      person('Past Pam', 'Former VP of Sales'),
      { name: '', title: 'VP Sales', linkedin_url: null },     // nameless: never a person
      person('Jane Buyer', 'VP Sales'),
    ] })
  }) as never, master })
  const rows = enrichmentsForLeads(db, 'u1', ['lead1']).lead1
  assert.deepEqual(rows.filter(r => r.kind === 'contact').map(r => r.value), ['Jane Buyer - VP Sales'])
  const rejected = rows.filter(r => r.kind === 'contact_rejected')
  const codes = rejected.map(r => r.label).sort()
  assert.ok(codes.includes('contact_role_mismatch'), `assistant-to and past titles are role rejections: ${codes}`)
  assert.equal(rejected.filter(r => r.label === 'contact_role_mismatch').length, 2, 'assistant-to + former-title both named')
  assert.ok(rejected.some(r => /contradicts the reviewed buyer role/.test(r.value) && /Assistant to the CEO/.test(r.value)), 'the assistant rejection names what matched')
  assert.ok(!JSON.stringify(rows).includes('Former Fred'), 'the contradicting employer is not attached')
  assert.ok(!JSON.stringify(rows).includes('VP Sales,') && !rows.some(r => r.value.startsWith(' - ')), 'a nameless result never becomes a person')
})

test('bounded enrichment goes to the highest-priority leads first', async () => {
  const leads = Array.from({ length: 7 }, (_, i) => ({ id: `lead${i}`, company: `Co${i}`, score: (i % 7) * 10 }))
  const { db, jobId, leads: rows } = seed({ leads })
  const orgCalls: string[] = []
  await enrichLeadContacts(db, 'u1', jobId, rows, { fetchImpl: (async (url: RequestInfo | URL, init?: RequestInit) => {
    const u = String(url)
    if (u.includes('organizations/enrich')) { orgCalls.push(String(JSON.parse(String(init?.body)).domain)); return ok(ORG_RESP) }
    return ok({ people: [] })
  }) as never, master })
  assert.equal(orgCalls.length, 5, 'the per-scan cap is unchanged')
  const want = [...leads].sort((a, b) => b.score - a.score).slice(0, 5).map(l => `${l.company.toLowerCase()}.com`).sort()
  assert.deepEqual([...orgCalls].sort(), want, 'the five highest-scored leads got the bounded org calls')
})

test('a later reject supersedes an earlier confirm of the same title: it stops narrowing retrieval', async () => {
  const { db, jobId, leads } = seed({ who: ['VP Sales'], confirmed: ['VP Sales'] })
  decide(db, jobId, 'o1', 'VP Sales', 'reject') // newer decision, same normalized text
  assert.deepEqual(reviewedBuyerTitles(db, jobId), [], 'the rejected title is no longer a reviewed buyer role')
  const bodies: Record<string, unknown>[] = []
  await enrichLeadContacts(db, 'u1', jobId, leads, { fetchImpl: (async (url: RequestInfo | URL, init?: RequestInit) => {
    const u = String(url)
    if (u.includes('organizations/enrich')) return ok(ORG_RESP)
    bodies.push(JSON.parse(String(init?.body)))
    return ok({ people: [person('Jane Buyer', 'VP Sales')] })
  }) as never, master })
  assert.equal(bodies.length, 1)
  assert.ok(!('person_titles' in bodies[0]), 'with no reviewed titles left, retrieval is the plain unfiltered query')
  const rows = enrichmentsForLeads(db, 'u1', ['lead1']).lead1
  assert.deepEqual(rows.filter(r => r.kind === 'contact').map(r => r.value), ['Jane Buyer - VP Sales'], 'recall is preserved')
})

test('decisions never cross offer IDs: a title confirmed for another offer does not narrow this job', async () => {
  const { db, jobId, leads } = seed({ who: ['VP Sales'], confirmed: ['VP Sales'], confirmedOffer: 'o2' })
  assert.deepEqual(reviewedBuyerTitles(db, jobId), [], "the confirmed title belongs to a different offer's review")
  const bodies: Record<string, unknown>[] = []
  await enrichLeadContacts(db, 'u1', jobId, leads, { fetchImpl: (async (url: RequestInfo | URL, init?: RequestInit) => {
    const u = String(url)
    if (u.includes('organizations/enrich')) return ok(ORG_RESP)
    bodies.push(JSON.parse(String(init?.body)))
    return ok({ people: [person('Jane Buyer', 'VP Sales')] })
  }) as never, master })
  assert.equal(bodies.length, 1)
  assert.ok(!('person_titles' in bodies[0]), 'no cross-offer filter is sent to the provider')
})
