// #383 ACCEPTANCE HARNESS - one executable fixture per acceptance criterion of the issue
// ("Filter decision-maker enrichment by buyer role before truncating results"). Offline fixtures
// only: no provider is called. Criteria text from the issue; each test names the criterion it pins.
//   1. A fixture company whose relevant buyer is beyond the first five unfiltered employees returns
//      the buyer (the role filter reaches retrieval BEFORE the page cap).
//   2. A former employee and an assistant-to-the-buyer are rejected, never attached.
//   3. No person is inferred from a generic inbox (mailbox-shaped names never attach; a lead whose
//      only contact is a generic inbox gets EMPTY best-person fields, never an invented person).
//   4. "Show named verified-current versus search-result-only contacts separately". The 180/90-day windows are
//      builder-chosen (no owner message on record; see lib/people/currency.ts): verified current = a first-party
//      company page read within 180 days, or a
//      provider record (Apollo/PDL) confirmed/updated within 90 days; everything else is search-result-only. The
//      LinkedIn-session basis waits for #192's follow-up and is not counted. The leads page shows two sections.
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
import { contactCurrency, isoDay, providerContactLabel, splitByCurrency, FIRST_PARTY_DAYS, PROVIDER_DAYS } from '../lib/people/currency.ts'
import { readFileSync } from 'node:fs'

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
    return ok({ people: [person('Aide Adams', 'Executive Assistant to the CEO'), person('Asa Assist', 'Assistant to the VP Sales'), person('Former Fred', 'VP Sales', 'Other Corp'), person('Past Pam', 'Former VP of Sales'), person('Jane Buyer', 'VP Sales')] })
  }) as never, master })
  const rows = enrichmentsForLeads(db, 'u1', ['lead1']).lead1
  assert.deepEqual(rows.filter(r => r.kind === 'contact').map(r => r.value), ['Jane Buyer - VP Sales'])
  const rejected = rows.filter(r => r.kind === 'contact_rejected')
  assert.equal(rejected.filter(r => r.label === 'contact_role_mismatch').length, 3, 'assistant-to (incl. assistant to the buyer role itself) and past-title all named as role rejections')
  assert.ok(!rows.some(r => r.kind === 'contact' && /Asa Assist|Aide Adams|Past Pam/.test(r.value)), 'no assistant or past-title candidate is attached')
  assert.ok(!JSON.stringify(rows).includes('Former Fred'), 'the former employee is never attached')
})

test('criterion 3a: a mailbox-shaped provider result is not a person (Apollo and PDL boundaries)', async () => {
  const apollo = await apolloPeopleSearch('k', { domain: 'acme.com', name: 'Acme' }, (async (_u: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body))
    if (body.q_organization_domains) return ok({ people: [person('info@acme.com', 'VP Sales'), person('Info', 'VP Sales'), person('Sales Team', 'VP Sales'), person('Contact Us', 'VP Sales'), person('Customer Support', 'VP Sales'), person('Customer Success', 'VP Sales'), person('Careers', 'VP Sales'), person('Hiring Manager', 'VP Sales'), person('Marketing', 'VP Sales'), person('Sales Rep', 'VP Sales'), person('Hr', 'VP Sales'), person('Dev', 'VP Sales'), person('Customer Service', 'VP Sales'), person('Help Desk', 'VP Sales'), person('Human Resources', 'VP Sales'), person('Recruiting', 'VP Sales'), person('Recruitment', 'VP Sales'), person('Talent Acquisition', 'VP Sales'), person('Billing', 'VP Sales'), person('Accounts Payable', 'VP Sales'), person('Reception', 'VP Sales'), person('Sales Dept', 'VP Sales'), person('Info Desk', 'VP Sales'), person('No Reply', 'VP Sales'), person('Business Development', 'VP Sales'), person('Front Office', 'VP Sales'), person('Finance Department', 'VP Sales'), person('Operations', 'VP Sales'), person('Procurement', 'VP Sales'), person('Legal Team', 'VP Sales'), person('IT Support', 'VP Sales'), person('Technical Support', 'VP Sales'), person('Account Management', 'VP Sales'), person('Dispatch', 'VP Sales'), person('Do Not Reply', 'VP Sales'), person('Accounting', 'VP Sales'), person('Payroll', 'VP Sales'), person('Customer Care', 'VP Sales'), person('Receptionist', 'VP Sales'), person('Order Desk', 'VP Sales'), person('Store Manager', 'VP Sales'), person('Production', 'VP Sales'), person('Purchasing', 'VP Sales'), person('Logistics', 'VP Sales'), person('Shipping', 'VP Sales'), person('Warehouse', 'VP Sales'), person('Claims', 'VP Sales'), person('Quotes', 'VP Sales'), person('Webmaster', 'VP Sales'), person('Helpdesk', 'VP Sales'), person('Customer Experience', 'VP Sales'), person('Client Services', 'VP Sales'), person('Administration', 'VP Sales'), person('Orders', 'VP Sales'), person('Team Lead', 'VP Sales'), person('Sales & Marketing', 'VP Sales'), person('Lead Generation Team', 'VP Sales'), person('Inside Sales', 'VP Sales'), person('Sales Representative', 'VP Sales'), person('Head of Sales', 'VP Sales'), person('Chief Executive Officer', 'VP Sales'), person('CEO Office', 'VP Sales'), person('Jane Buyer', 'VP Sales'), person('Ana Sales', 'VP Sales'), person('Dev Patel', 'VP Sales'), person('Us Khan', 'VP Sales'), person('Mary Hiring', 'VP Sales'), person('Sam Support', 'VP Sales'), person('John Billing', 'VP Sales'), person('Bessie Head', 'VP Sales'), person('Chief Joseph', 'VP Sales'), person('Rep Smith', 'VP Sales'), person('Will Service', 'VP Sales'), person('Joy Manager', 'VP Sales'), person('Frank Billing', 'VP Sales'), person('Faith Account', 'VP Sales'), person('Mark Hiring', 'VP Sales')] })
    return ok({ people: [] })
  }) as never, 25, { titles: ['VP Sales'] })
  assert.deepEqual(apollo.map(p => p.name), ['Jane Buyer', 'Ana Sales', 'Dev Patel', 'Us Khan', 'Mary Hiring', 'Sam Support', 'John Billing', 'Bessie Head', 'Chief Joseph', 'Rep Smith', 'Will Service', 'Joy Manager', 'Frank Billing', 'Faith Account', 'Mark Hiring'], 'a generic inbox, department label, team label or role/title label never becomes an Apollo person; a real name containing a role, department, title or filler word is kept')
  const pdlRow = (full_name: string) => ({ full_name, job_title: 'VP Sales', job_company_name: 'acme', job_company_website: 'acme.com' })
  const pdl = await pdlPeopleSearch('k', 'Acme', (async () => ok({ data: [pdlRow('sales@acme.com'), pdlRow('support'), pdlRow('sales.support'), pdlRow('Contact Us'), pdlRow('Customer Support'), pdlRow('Customer Success'), pdlRow('Careers'), pdlRow('Hiring Manager'), pdlRow('Marketing'), pdlRow('Sales Rep'), pdlRow('Hr'), pdlRow('Dev'), pdlRow('Customer Service'), pdlRow('Help Desk'), pdlRow('Human Resources'), pdlRow('Recruiting'), pdlRow('Recruitment'), pdlRow('Talent Acquisition'), pdlRow('Billing'), pdlRow('Accounts Payable'), pdlRow('Reception'), pdlRow('Sales Dept'), pdlRow('Info Desk'), pdlRow('No Reply'), pdlRow('Business Development'), pdlRow('Front Office'), pdlRow('Finance Department'), pdlRow('Operations'), pdlRow('Procurement'), pdlRow('Legal Team'), pdlRow('IT Support'), pdlRow('Technical Support'), pdlRow('Account Management'), pdlRow('Dispatch'), pdlRow('Do Not Reply'), pdlRow('Accounting'), pdlRow('Payroll'), pdlRow('Customer Care'), pdlRow('Receptionist'), pdlRow('Order Desk'), pdlRow('Store Manager'), pdlRow('Production'), pdlRow('Purchasing'), pdlRow('Logistics'), pdlRow('Shipping'), pdlRow('Warehouse'), pdlRow('Claims'), pdlRow('Quotes'), pdlRow('Webmaster'), pdlRow('Helpdesk'), pdlRow('Customer Experience'), pdlRow('Client Services'), pdlRow('Administration'), pdlRow('Orders'), pdlRow('Team Lead'), pdlRow('Sales & Marketing'), pdlRow('Lead Generation Team'), pdlRow('Inside Sales'), pdlRow('Sales Representative'), pdlRow('Head of Sales'), pdlRow('Chief Executive Officer'), pdlRow('CEO Office'), pdlRow('Jane Buyer'), pdlRow('Dev Patel'), pdlRow('Us Khan'), pdlRow('Mary Hiring'), pdlRow('Sam Support'), pdlRow('John Billing'), pdlRow('Bessie Head'), pdlRow('Chief Joseph'), pdlRow('Rep Smith'), pdlRow('Will Service'), pdlRow('Joy Manager'), pdlRow('Frank Billing'), pdlRow('Faith Account'), pdlRow('Mark Hiring')] })) as never, 25)
  assert.deepEqual(pdl.map(p => p.name), ['Jane Buyer', 'Dev Patel', 'Us Khan', 'Mary Hiring', 'Sam Support', 'John Billing', 'Bessie Head', 'Chief Joseph', 'Rep Smith', 'Will Service', 'Joy Manager', 'Frank Billing', 'Faith Account', 'Mark Hiring'], 'a generic inbox, department label, team label or role/title label never becomes a PDL person; a real name containing a role, department, title or filler word is kept')
})

test('criterion 3b: a lead whose only contact is a generic inbox gets EMPTY best-person fields, not an invented person', async () => {
  const { db, jobId } = seed()
  addEnrichment(db, 'u1', 'lead1', { connector: 'enrich:apollo', kind: 'email', value: 'info@acme.com', label: 'Apollo', confidence: 70, source_url: 'https://x.com/1', source_date: '2026-11-02', retrieved_at: 1 })
  const best = await bestPeople(sqliteDb(db), 'u1', [{ lead_id: 'lead1', job_id: jobId }])
  assert.deepEqual(best.get('lead1'), { best_person: '', best_person_title: '', best_person_link: '', best_person_found_via: '' }, 'nothing is invented from a generic inbox')
})

const DAY = 86_400_000
const dayAgo = (n: number, now = Date.now()) => new Date(now - n * DAY).toISOString().slice(0, 10)

test('criterion 4a: a provider record dated within 90 days is verified current; older or undated stays search-result-only (through the real enrichment path)', async () => {
  const { db, jobId, leads } = seed({ confirmed: ['VP Sales'] })
  const now = Date.now()
  await enrichLeadContacts(db, 'u1', jobId, leads, { fetchImpl: (async (url: RequestInfo | URL) => {
    if (String(url).includes('organizations/enrich')) return ok(ORG_RESP)
    return ok({ people: [
      { ...person('Jane Buyer', 'VP Sales'), last_refreshed_at: new Date(now - 30 * DAY).toISOString() },
      { ...person('Olga Old', 'VP Sales'), updated_at: dayAgo(120, now) },
      { ...person('Uma Undated', 'VP Sales') },
    ] })
  }) as never, master })
  const rows = enrichmentsForLeads(db, 'u1', ['lead1']).lead1
  assert.equal(rows.find(r => r.value.startsWith('Jane'))?.label, `Apollo, record dated ${dayAgo(30, now)}`, 'the record date is stored with the contact')
  assert.equal(rows.find(r => r.value.startsWith('Uma'))?.label, 'Apollo', 'an undated record stores no date')
  const ranked = contactsFromEnrichments(rows, 'VP Sales', now)
  const by = (n: string) => ranked.find(r => r.name === n)!
  assert.deepEqual(by('Jane Buyer').verified, { currency: 'verified_current', basis: 'provider_record', dated: dayAgo(30, now) })
  assert.equal(by('Olga Old').currency, 'search_only', '120 days is outside the 90-day provider window')
  assert.equal(by('Uma Undated').currency, 'search_only', 'an undated provider row is search-result-only')
  // PDL: job_last_verified / job_last_changed are the record's own dates
  const pdl = await pdlPeopleSearch('k', 'Acme', (async () => ok({ data: [
    { full_name: 'Pia Fresh', job_title: 'VP Sales', job_company_website: 'acme.com', job_last_verified: dayAgo(10, now) },
    { full_name: 'Pat Changed', job_title: 'VP Sales', job_company_website: 'acme.com', job_last_changed: dayAgo(200, now), job_last_verified: dayAgo(95, now) },
    { full_name: 'Pam Month', job_title: 'VP Sales', job_company_website: 'acme.com', job_last_verified: '2026-10' },
  ] })) as never, 25)
  assert.deepEqual(pdl.map(p => p.recordDay), [dayAgo(10, now), dayAgo(95, now), '2026-10-01'], 'the latest valid date; a month-only date is its first day (older, never newer)')
  const pdlRow = (name: string, day: string | null) => ({ kind: 'contact', value: `${name} - VP Sales`, label: providerContactLabel('enrich:pdl', day), source_url: '', connector: 'enrich:pdl' })
  const p = contactsFromEnrichments([pdlRow('Pia Fresh', pdl[0].recordDay ?? null), pdlRow('Pat Changed', pdl[1].recordDay ?? null)], 'VP Sales', now)
  assert.deepEqual(p.map(x => [x.name, x.currency]), [['Pia Fresh', 'verified_current'], ['Pat Changed', 'search_only']])
})

test('criterion 4b: a first-party company page read within 180 days is verified current; public search, SEC filings and the LinkedIn session are not counted', () => {
  const now = Date.UTC(2026, 10, 4)
  const sec = (d: number) => Math.floor((now - d * DAY) / 1000)
  const rows = [
    { kind: 'person', value: 'Cara Crawl, VP Sales', label: 'listed with this title on this company page, not verified as current staff', source_url: 'https://acme.com/team', connector: 'sitecrawl', retrieved_at: sec(10) },
    { kind: 'person', value: 'Stale Stan, VP Sales', label: 'listed with this title on this company page, not verified as current staff', source_url: 'https://acme.com/team', connector: 'sitecrawl', retrieved_at: sec(181) },
    { kind: 'person', value: 'Sam Search, VP Sales', label: 'public search result (profile title), not verified as current staff', source_url: 'https://linkedin.com/in/sam', connector: 'search:people', retrieved_at: sec(1) },
    { kind: 'person', value: 'Fil Filing, VP Sales', label: 'named in SEC Form D', source_url: 'https://sec.gov/x', connector: 'signals:sec-form-d', retrieved_at: sec(1) },
    { kind: 'person', value: 'Lin Session, VP Sales', label: 'LinkedIn', source_url: 'https://linkedin.com/in/lin', connector: 'adv:linkedin', retrieved_at: sec(1) },
  ]
  const ranked = contactsFromEnrichments(rows, 'VP Sales', now)
  const cur = Object.fromEntries(ranked.map(r => [r.name, r.verified]))
  assert.deepEqual(cur['Cara Crawl'], { currency: 'verified_current', basis: 'first_party_page', dated: '2026-10-25' })
  for (const n of ['Stale Stan', 'Sam Search', 'Fil Filing', 'Lin Session']) assert.equal(cur[n]?.currency, 'search_only', `${n} is search-result-only`)
  assert.equal(FIRST_PARTY_DAYS, 180); assert.equal(PROVIDER_DAYS, 90)
})

test('criterion 4c: malformed, forged, future or contradicted evidence fails closed to search-result-only', async () => {
  const now = Date.now()
  const bad: unknown[] = [12345, 1730000000, [dayAgo(1)], { date: dayAgo(1) }, null, true, '', '2026', '2026-13-45', '2026-02-30', '2026-10T10:00', 'yesterday', 'x'.repeat(100_000), `${dayAgo(1)}\ud800`, `${dayAgo(1)}\u0000`, '1989-12-31', `${dayAgo(1)} DROP TABLE`]
  for (const v of bad) assert.equal(isoDay(v), null, `isoDay(${JSON.stringify(v)?.slice(0, 40)})`)
  const apollo = await apolloPeopleSearch('k', { domain: 'acme.com', name: 'Acme' }, (async () => ok({ people: bad.map((v, i) => ({ ...person(`Bad Case${String.fromCharCode(65 + i)}`, 'VP Sales'), last_refreshed_at: v, updated_at: v })) })) as never, 50)
  assert.ok(apollo.length === bad.length && apollo.every(p => p.recordDay === null), 'no malformed provider date becomes a record date')
  assert.ok(apollo.every(p => providerContactLabel('enrich:apollo', p.recordDay ?? null) === 'Apollo'))
  const fresh = dayAgo(1, now)
  const C = (connector: string, label: string | null, kind = 'contact', retrieved_at?: unknown) => contactCurrency({ kind, connector, label, retrieved_at }, true, now).currency
  assert.equal(C('enrich:apollo', `Apollo, record dated ${fresh}`), 'verified_current', 'control: the genuine label verifies')
  assert.equal(C('search:people', `Apollo, record dated ${fresh}`, 'person'), 'search_only', 'a provider-style label on another connector is ignored')
  assert.equal(C('enrich:pdl', `Apollo, record dated ${fresh}`), 'search_only', 'a label naming the other provider is ignored')
  assert.equal(C('enrich:apollo', `Apollo, record dated ${fresh} (edited)`), 'search_only', 'trailing text is not a date')
  assert.equal(C('enrich:apollo', `Apollo, record dated ${dayAgo(-2, now)}`), 'search_only', 'a future record date')
  assert.equal(C('enrich:apollo', 'Apollo, record dated 2026-02-30'), 'search_only', 'an impossible date')
  assert.equal(C('enrich:apollo', null), 'search_only')
  for (const t of ['123abc', Number.NaN, -5, 1.5, 1e15, Math.floor((now + 2 * DAY) / 1000), null, [1], { s: 1 }]) assert.equal(C('sitecrawl', 'x', 'person', t), 'search_only', `retrieved_at ${String(t)}`)
  assert.equal(C('sitecrawl', 'x', 'person', String(Math.floor(now / 1000) - 60)), 'verified_current', 'control: a numeric string from the PG driver is read as seconds')
  assert.equal(contactCurrency({ kind: 'contact', connector: 'enrich:apollo', label: `Apollo, record dated ${fresh}` }, true, Number.NaN).currency, 'search_only', 'no clock, no verification')
  // the role must be held: a contradicted or missing title is never verified, however fresh
  const rows = [
    { kind: 'contact', value: 'Fred Former - Former VP Sales', label: `Apollo, record dated ${fresh}`, source_url: '', connector: 'enrich:apollo' },
    { kind: 'contact', value: 'Asa Aide - Assistant to the VP Sales', label: `Apollo, record dated ${fresh}`, source_url: '', connector: 'enrich:apollo' },
    { kind: 'contact', value: 'Nina Notitle', label: `Apollo, record dated ${fresh}`, source_url: '', connector: 'enrich:apollo' },
  ]
  assert.deepEqual(contactsFromEnrichments(rows, 'VP Sales', now).map(r => r.currency), ['search_only', 'search_only', 'search_only'])
})

test('criterion 4d: the leads page shows "Verified current" and "Search result only" separately, each ordered by title match; the export names the evidence', async () => {
  const now = Date.now()
  const fresh = dayAgo(5, now)
  const rows = [
    { kind: 'contact', value: 'Wes Weak - Sales Lead', label: 'Apollo', source_url: '', connector: 'enrich:apollo' },
    { kind: 'contact', value: 'Vera Verified - Head of Ops', label: `Apollo, record dated ${fresh}`, source_url: '', connector: 'enrich:apollo' },
    { kind: 'contact', value: 'Sue Strong - VP Sales', label: 'Apollo', source_url: '', connector: 'enrich:apollo' },
    { kind: 'contact', value: 'Val Vp - VP Sales', label: `Apollo, record dated ${fresh}`, source_url: '', connector: 'enrich:apollo' },
  ]
  const { verified, searchOnly } = splitByCurrency(contactsFromEnrichments(rows, 'VP Sales; Head of Ops', now))
  assert.deepEqual(verified.map(p => p.name), ['Vera Verified', 'Val Vp'], 'verified current, equal title match keeps stored order')
  assert.deepEqual(searchOnly.map(p => p.name), ['Sue Strong', 'Wes Weak'], 'search-result-only, strongest title match first')
  for (const sec of [verified, searchOnly]) for (let i = 1; i < sec.length; i++) assert.ok(sec[i - 1].score >= sec[i].score, 'ordered by title match within the section')
  const page = readFileSync(new URL('../app/app/leads/leads-client.tsx', import.meta.url), 'utf8')
  assert.ok(page.includes('splitByCurrency(people)') && page.includes('>Verified current<') && page.includes('>Search result only<'), 'the Right people block renders the two sections from splitByCurrency')
  // export: Best Person found-via names the verified evidence; a search-only best person keeps its plain source
  const { db, jobId } = seed()
  addEnrichment(db, 'u1', 'lead1', { connector: 'enrich:apollo', kind: 'contact', value: 'Val Vp - VP Sales', label: providerContactLabel('enrich:apollo', fresh), confidence: 70, source_url: 'https://linkedin.com/in/valvp', source_date: fresh, retrieved_at: Math.floor(now / 1000) })
  const best = await bestPeople(sqliteDb(db), 'u1', [{ lead_id: 'lead1', job_id: jobId }])
  assert.equal(best.get('lead1')?.best_person_found_via, `${PEOPLE_SOURCE['enrich:apollo']}; verified current: Apollo record dated ${fresh}`)
})
