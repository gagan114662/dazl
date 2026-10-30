// A contact / company record found by NAME attaches only when it agrees with the lead on at least one of: domain, city/state, or street address taken from the lead's OWN
// evidence. When they conflict it is not attached: it stays unresolved with the reason recorded. Two same-name businesses in different cities: the NYC lead gets the New York
// one and never the Pico Rivera, CA one. Stubbed Apollo / PDL responses, invented companies: no network, no credits.
import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { randomBytes } from 'node:crypto'
import { enrichLeadContacts } from '../lib/enrich/index.ts'
import { contactAgreement, streetKeys, addressAgreement, contactRejectionCode, firstPlaceLabel } from '../lib/scan/contact-agreement.ts'
import { migrateScan, createJob } from '../lib/scan/store.ts'
import { migrateConnectors, saveCredential, enrichmentsForLeads } from '../lib/connectors/store.ts'

const master = randomBytes(32)
const ok = (b: unknown) => new Response(JSON.stringify(b), { status: 200 })
const NYC_ICP = JSON.stringify({ summary: 'NYC dental', where: ['New York City'], who: ['Practice manager'], signals: [] })
const EVIDENCE = 'Smile Avenue Dental is opening a second practice at 57 W 57th St, New York'

function seed(o: { evidence?: string; domain?: string | null; where?: string } = {}) {
  const db = new Database(':memory:'); migrateScan(db); migrateConnectors(db)
  const jobId = createJob(db, 'u1', { business_name: 'B', industry: 'I', location: 'L' })
  db.prepare("UPDATE scan_jobs SET status = 'running', icp = ? WHERE id = ?").run(o.where ?? NYC_ICP, jobId)
  db.prepare("INSERT INTO leads (id, scan_job_id, name, company, company_domain, signal, source_url, evidence_excerpt, fit, intent, action, why) VALUES ('lead1', ?, '', 'Smile Avenue Dental', ?, 'opened a new practice', 'https://x.example/1', ?, 4, 3, 4, 'New practice.')").run(jobId, o.domain ?? null, o.evidence ?? EVIDENCE)
  saveCredential(db, 'u1', 'enrich:apollo', 'test-apollo-key-1234', master)
  return { db, jobId, lead: { id: 'lead1', company: 'Smile Avenue Dental', company_domain: o.domain ?? null } }
}
const apollo = (org: Record<string, unknown>) => (async (url: RequestInfo | URL) => {
  const u = String(url)
  if (u.includes('organizations/enrich')) return ok({ organization: org })
  if (u.includes('mixed_people')) return ok({ people: [{ name: 'Sophia Rozov', title: 'Practice Manager', linkedin_url: 'https://linkedin.com/in/sr' }] })
  return new Response('no', { status: 404 })
}) as never
const attached = (db: Database.Database) => (enrichmentsForLeads(db, 'u1', ['lead1']).lead1 ?? []).filter(e => e.kind !== 'contact_rejected').map(e => e.kind)
const refusals = (db: Database.Database) => (enrichmentsForLeads(db, 'u1', ['lead1']).lead1 ?? []).filter(e => e.kind === 'contact_rejected').map(e => [e.label, e.value])
const PICO = { name: 'Smile Avenue Dental Group', estimated_num_employees: 12, industry: 'Dental', website_url: 'https://smileavenue-pr.com', city: 'Pico Rivera', state: 'California', street_address: '8500 Whittier Blvd' }
const NY = { name: 'Smile Avenue Dental', estimated_num_employees: 9, industry: 'Dental', website_url: 'https://smileavenuedental.com', city: 'New York', state: 'New York', street_address: '57 West 57th Street' }

test('street addresses compare by number + street + suffix, whatever the spelling', () => {
  assert.deepEqual(streetKeys('57 W 57th St, New York, NY 10019'), ['57 w 57th st']); assert.deepEqual(streetKeys('57 West 57th Street'), ['57 w 57th st'])
  assert.deepEqual(streetKeys('8500 Whittier Blvd, Pico Rivera, CA'), ['8500 whittier blvd']); assert.deepEqual(streetKeys('no address here'), [])
  assert.equal(addressAgreement('57 West 57th Street', EVIDENCE), 'agrees'); assert.equal(addressAgreement('8500 Whittier Blvd', EVIDENCE), 'conflict')
  assert.equal(addressAgreement(null, EVIDENCE), 'unknown'); assert.equal(addressAgreement('57 W 57th St', 'no address in the quote'), 'unknown')
  assert.equal(contactRejectionCode('contact rejected: address mismatch 8500 whittier blvd vs 57 w 57th st'), 'contact_address_mismatch')
})

test('contactAgreement: address agrees / conflicts; a matching domain beats an address conflict; unknown address falls back to place', () => {
  const W = ['New York City']
  assert.deepEqual(contactAgreement({ where: W, evidence: EVIDENCE }, { address: '57 West 57th Street' }), { ok: true, via: 'address' }, 'the same street address, no city needed')
  const bad = contactAgreement({ where: W, evidence: EVIDENCE }, { address: '8500 Whittier Blvd', place: 'Pico Rivera, CA' })
  assert.equal(bad.ok, false); assert.match((bad as { reason: string }).reason, /^contact rejected: address mismatch 8500 whittier blvd vs 57 w 57th st/)
  assert.equal(contactAgreement({ where: W, evidence: EVIDENCE }, { address: '9 Main St', place: 'New York, NY' }).ok, false, 'same city, different street address: not the same practice')
  // A domain that is ESTABLISHED (the cited page's own host, or user-confirmed) stands over a conflicting address; a guessed or legacy domain only agrees with itself and does not.
  assert.deepEqual(contactAgreement({ company_domain: 'smileavenue.com', where: W, evidence: EVIDENCE, domainEstablished: true }, { domain: 'www.smileavenue.com', address: '8500 Whittier Blvd' }), { ok: true, via: 'domain' }, 'an established domain agrees')
  assert.equal(contactAgreement({ company_domain: 'smileavenue.com', where: W, evidence: EVIDENCE }, { domain: 'www.smileavenue.com', address: '8500 Whittier Blvd' }).ok, false, 'a guessed domain does not beat an explicit address conflict')
  assert.deepEqual(contactAgreement({ where: W, evidence: 'no street in the quote' }, { address: '8500 Whittier Blvd', place: 'New York, NY' }), { ok: true, via: 'location' }, 'no address basis on the lead: the place decides, as before')
})

test('TWO SAME-NAME BUSINESSES: the Pico Rivera, CA one is NOT attached to the NYC lead (address + city + domain all conflict) and is recorded as unresolved; the New York one IS attached', async () => {
  const wrong = seed()
  await enrichLeadContacts(wrong.db, 'u1', wrong.jobId, [wrong.lead], { fetchImpl: apollo(PICO), master })
  assert.deepEqual(attached(wrong.db), [], 'no firmographic and no contact from the Pico Rivera practice')
  assert.deepEqual(refusals(wrong.db).map(r => r[0]), ['contact_address_mismatch'], JSON.stringify(refusals(wrong.db)))
  assert.match(String(refusals(wrong.db)[0][1]), /address mismatch 8500 whittier blvd vs 57 w 57th st/)
  const right = seed()
  await enrichLeadContacts(right.db, 'u1', right.jobId, [right.lead], { fetchImpl: apollo(NY), master })
  assert.deepEqual(attached(right.db).sort(), ['contact', 'firmographic'], 'the New York practice at the lead’s own address attaches')
  assert.deepEqual(refusals(right.db), [])
})

test('same city, different street address is unresolved too; an address-less record falls back to the city', async () => {
  const other = seed(); await enrichLeadContacts(other.db, 'u1', other.jobId, [other.lead], { fetchImpl: apollo({ ...NY, street_address: '9 Main St' }), master })
  assert.deepEqual(attached(other.db), []); assert.deepEqual(refusals(other.db).map(r => r[0]), ['contact_address_mismatch'])
  const noAddr = seed(); await enrichLeadContacts(noAddr.db, 'u1', noAddr.jobId, [noAddr.lead], { fetchImpl: apollo({ ...NY, street_address: undefined }), master })
  assert.deepEqual(attached(noAddr.db).sort(), ['contact', 'firmographic'], 'New York, NY agrees on the city when the record has no street address')
})

// ---- the crawler's own address check (sitecrawl): a homepage that lists street addresses, none of them the lead's, is another business with the same name ----
test('CRAWLER: two same-name sites - the Pico Rivera, CA homepage (other street address) is refused with a contact_address_mismatch record and attaches nothing; the New York homepage at the lead’s own address attaches its contact', async () => {
  const { crawlJob } = await import('../lib/connectors/sitecrawl.ts')
  const db = new Database(':memory:'); migrateConnectors(db)
  db.exec('CREATE TABLE leads (id TEXT, scan_job_id TEXT, company TEXT, source_url TEXT, review_reason TEXT, confidence INTEGER, score INTEGER, company_domain TEXT, signal TEXT, evidence_excerpt TEXT)')
  const ex = 'Smile Avenue Dental is opening a second practice at 57 W 57th St, New York'
  db.prepare("INSERT INTO leads VALUES ('wrong','j1','Smile Avenue Dental','https://news.example/wrong',NULL,90,80,NULL,'opened a new practice',?),('right','j1','Smile Avenue Dental','https://news.example/right',NULL,90,70,NULL,'opened a new practice',?)").run(ex, ex)
  const html = (b: string) => `<html><body>${b}</body></html>`
  const pages: Record<string, string> = {
    'news.example/wrong': html('<a href="https://smileavenue-pr.com/">Smile Avenue Dental</a>'),
    'news.example/right': html('<a href="https://smileavenuedental.com/">Smile Avenue Dental</a>'),
    'smileavenue-pr.com/': html('<h1>Smile Avenue Dental</h1><p>Visit us at 8500 Whittier Blvd, Pico Rivera, CA 90660.</p><a href="/contact">Contact</a>'),
    'smileavenue-pr.com/contact': html('Email: hello@smileavenue-pr.com'),
    'smileavenuedental.com/': html('<h1>Smile Avenue Dental</h1><p>Visit us at 57 West 57th Street, New York, NY 10019.</p><a href="/contact">Contact</a>'),
    'smileavenuedental.com/contact': html('Email: hello@smileavenuedental.com'),
  }
  const get = async (url: string) => { const u = new URL(url); const b = pages[u.hostname + u.pathname]; return b !== undefined ? { status: 200, body: b, finalUrl: url } : u.pathname === '/robots.txt' ? { status: 200, body: '', finalUrl: url } : { status: 404, body: '', finalUrl: url } }
  await crawlJob(db, 't1', 'j1', { get, gapMs: 0, env: {}, now: Date.parse('2026-10-20T12:00:00Z') })
  const rows = (id: string) => db.prepare("SELECT kind, value, label FROM lead_enrichments WHERE lead_id = ? AND kind <> 'domain'").all(id) as { kind: string; value: string; label: string }[]
  assert.deepEqual(rows('wrong').map(r => [r.kind, r.label]), [['contact_rejected', 'contact_address_mismatch']], JSON.stringify(rows('wrong')))
  assert.match(rows('wrong')[0].value, /^contact rejected: address mismatch 8500 whittier blvd vs 57 w 57th st/)
  assert.deepEqual(rows('right').filter(r => r.kind !== 'domain_check').map(r => [r.kind, r.value]), [['email', 'hello@smileavenuedental.com']], 'the practice at the lead’s own address attaches')
  assert.equal((db.prepare("SELECT company_domain FROM leads WHERE id = 'wrong'").get() as { company_domain: string | null }).company_domain, null, 'the wrong site is never recorded as the lead’s domain')
  assert.equal((db.prepare("SELECT company_domain FROM leads WHERE id = 'right'").get() as { company_domain: string | null }).company_domain, 'smileavenuedental.com')
  assert.ok((db.prepare("SELECT status FROM connector_audit").all() as { status: string }[]).some(a => /address mismatch/.test(a.status)))
})

test('REGRESSION: a matching street number/name never bypasses a contradicting city/state — "57 W 57th St, New York" vs "57 W 57th St, Pico Rivera, CA", no matching domain', async () => {
  const W = ['New York City']
  for (const c of [{ address: '57 W 57th St', place: 'Pico Rivera, CA' }, { address: '57 W 57th St, Pico Rivera, CA 90660' }, { address: '57 West 57th Street', place: 'Pico Rivera, California' }]) {
    const r = contactAgreement({ where: W, evidence: EVIDENCE }, c)
    assert.equal(r.ok, false, JSON.stringify(c)); assert.match((r as { reason: string }).reason, /location mismatch Pico Rivera/)
    assert.equal(contactRejectionCode((r as { reason: string }).reason), 'contact_location_mismatch')
  }
  assert.deepEqual(contactAgreement({ where: W, evidence: EVIDENCE }, { address: '57 W 57th St, New York, NY 10019', place: 'New York, NY' }), { ok: true, via: 'address' }, 'same street AND the same city still attaches')
  assert.deepEqual(contactAgreement({ where: W, evidence: EVIDENCE }, { address: '57 W 57th St' }), { ok: true, via: 'address' }, 'same street, no city stated: nothing contradicts')
  // through the Apollo path: no domain on the lead, the org at the same street text in Pico Rivera
  const s = seed()
  await enrichLeadContacts(s.db, 'u1', s.jobId, [s.lead], { fetchImpl: apollo({ ...PICO, street_address: '57 W 57th St' }), master })
  assert.deepEqual(attached(s.db), [], 'nothing from the Pico Rivera record attaches')
  assert.deepEqual(refusals(s.db).map(r => r[0]), ['contact_location_mismatch'], JSON.stringify(refusals(s.db)))
})

test('REGRESSION (address-only, spelled-out state): "57 W 57th St, Pico Rivera, California" with no separate place field is refused for the NYC lead — every US state name and DC is parsed, not only two-letter codes', async () => {
  const W = ['New York City']
  for (const addr of ['57 W 57th St, Pico Rivera, California', '57 W 57th St, Pico Rivera, California 90660', '57 W 57th St, Pico Rivera, CA 90660', '57 West 57th Street, Austin, Texas', '57 W 57th St, Washington, District of Columbia', '57 W 57th St, Albany, New York',
    '57 w 57th st, pico rivera, california', '57 W 57TH ST, PICO RIVERA, CALIFORNIA', '57 w 57th st, pico rivera, ca 90660', '57 W 57TH ST, PICO RIVERA, CA', '57 west 57th street, austin, texas', '57 W 57TH ST, WASHINGTON, DISTRICT OF COLUMBIA']) {
    const r = contactAgreement({ where: W, evidence: EVIDENCE }, { address: addr })
    assert.equal(r.ok, false, addr); assert.equal(contactRejectionCode((r as { reason: string }).reason), 'contact_location_mismatch', addr)
  }
  assert.equal(firstPlaceLabel('8500 Whittier Blvd, Pico Rivera, California 90660'), 'Pico Rivera, California')
  assert.equal(firstPlaceLabel('1 Main St, Washington, District of Columbia'), 'Washington, District of Columbia')
  assert.equal(firstPlaceLabel('1 Main St, Jackson, Wyoming'), 'Jackson, Wyoming')
  assert.equal(firstPlaceLabel('57 w 57th st, pico rivera, california'), 'Pico Rivera, California'); assert.equal(firstPlaceLabel('57 W 57TH ST, PICO RIVERA, CALIFORNIA'), 'Pico Rivera, California')
  assert.equal(firstPlaceLabel('call us or visit in person, or by mail'), null, 'running text with "or" / "in" is not a state')
  // through Apollo: street text matches, the org record has no place field of its own
  const s = seed()
  await enrichLeadContacts(s.db, 'u1', s.jobId, [s.lead], { fetchImpl: apollo({ ...PICO, city: undefined, state: undefined, street_address: undefined, raw_address: '57 W 57th St, Pico Rivera, California' }), master })
  assert.deepEqual(attached(s.db), []); assert.deepEqual(refusals(s.db).map(r => r[0]), ['contact_location_mismatch'], JSON.stringify(refusals(s.db)))
})

test('REGRESSION (empty search location): the lead\'s OWN evidenced city/state is compared instead of skipping the check', () => {
  const NYC_EVIDENCE = 'Smile Avenue Dental is opening a second practice at 57 W 57th St, New York'
  for (const where of [[], ['']]) {
    const bad = contactAgreement({ where, evidence: NYC_EVIDENCE }, { address: '57 W 57th St, Pico Rivera, California' })
    assert.equal(bad.ok, false); assert.match((bad as { reason: string }).reason, /location mismatch Pico Rivera/)
    const badPlace = contactAgreement({ where, evidence: NYC_EVIDENCE }, { place: 'Pico Rivera, CA' })
    assert.equal(badPlace.ok, false, 'a record with only a place, no address, is compared too')
    assert.deepEqual(contactAgreement({ where, evidence: NYC_EVIDENCE }, { place: 'New York, NY' }), { ok: true, via: 'location' })
  }
  assert.equal(contactAgreement({ where: [], evidence: 'Smile Avenue Dental, Pico Rivera, CA is hiring' }, { place: 'New York, NY' }).ok, false, 'a Pico Rivera lead refuses the New York record')
  assert.deepEqual(contactAgreement({ where: [], evidence: 'no place stated anywhere' }, { place: 'Pico Rivera, CA' }), { ok: true, via: 'no_geography' }, 'no search place AND no evidenced place: nothing to compare')
})

test('REGRESSION (casing): the address-only record in lowercase and ALL CAPS is refused through the Apollo path exactly like the title-case one', async () => {
  for (const raw of ['57 w 57th st, pico rivera, california', '57 W 57TH ST, PICO RIVERA, CALIFORNIA']) {
    const s = seed()
    await enrichLeadContacts(s.db, 'u1', s.jobId, [s.lead], { fetchImpl: apollo({ ...PICO, city: undefined, state: undefined, street_address: undefined, raw_address: raw }), master })
    assert.deepEqual(attached(s.db), [], raw); assert.deepEqual(refusals(s.db).map(r => r[0]), ['contact_location_mismatch'], raw + JSON.stringify(refusals(s.db)))
  }
})

test('casing controls on the place field too: lowercase / ALL CAPS "pico rivera, california" is refused with or without a matching street, with or without a search location', () => {
  const E = 'Smile Avenue Dental is opening a second practice at 57 W 57th St, New York'
  for (const c of [{ place: 'pico rivera, california', address: '57 w 57th st' }, { place: 'PICO RIVERA, CA', address: '57 W 57TH ST' }, { place: 'pico rivera, ca' }, { place: 'PICO RIVERA, CALIFORNIA' }])
    for (const where of [['New York City'], []]) assert.equal(contactAgreement({ where, evidence: E }, c).ok, false, JSON.stringify([c, where]))
})

test('REGRESSION (structured address, no ZIP): a lowercase / ALL CAPS two-letter state code as the LAST segment is recognised without a ZIP; running text still needs one', async () => {
  const W = ['New York City']
  for (const addr of ['57 W 57th St, pico rivera, ca', '57 W 57TH ST, PICO RIVERA, CA', '57 w 57th st, pico rivera, ca', '57 W 57th St, pico rivera, ca 90660', '57 W 57th St, pico rivera, ca, usa']) {
    for (const where of [W, []]) { const r = contactAgreement({ where, evidence: EVIDENCE }, { address: addr }); assert.equal(r.ok, false, addr + JSON.stringify(where)); assert.match((r as { reason: string }).reason, /location mismatch Pico Rivera/i, addr) }
    assert.equal(firstPlaceLabel(addr, { structured: true })?.toLowerCase(), 'pico rivera, ca', addr)
  }
  assert.equal(firstPlaceLabel('we sell in pico rivera, ca and nearby'), null, 'running text without a ZIP is not read as a state')
  assert.equal(firstPlaceLabel('call us or visit in person, or'), null)
  assert.equal(firstPlaceLabel('visit us in pico rivera, ca 90660'), 'Pico Rivera, CA', 'running text WITH a ZIP still is')
  assert.deepEqual(contactAgreement({ where: W, evidence: EVIDENCE }, { address: '57 W 57th St, new york, ny' }), { ok: true, via: 'address' }, 'same street and same city still attaches')
  for (const raw of ['57 W 57th St, pico rivera, ca', '57 W 57TH ST, PICO RIVERA, CA']) {
    const s = seed()
    await enrichLeadContacts(s.db, 'u1', s.jobId, [s.lead], { fetchImpl: apollo({ ...PICO, city: undefined, state: undefined, street_address: undefined, raw_address: raw }), master })
    assert.deepEqual(attached(s.db), [], raw); assert.deepEqual(refusals(s.db).map(r => r[0]), ['contact_location_mismatch'], raw + JSON.stringify(refusals(s.db)))
  }
})

test('REGRESSION (Toronto): the same street in another country never attaches to the NYC lead - city AND region/country must agree; provinces, Canadian postal codes and "Canada" are read; same street + same city still attaches', async () => {
  const W = ['New York City']
  for (const addr of ['57 W 57th St, Toronto, ON', '57 W 57th St, Toronto, ON M5V 2T6', '57 W 57th St, Toronto, ON, Canada', '57 W 57th St, Toronto, Ontario, Canada', '57 W 57th St, toronto, on', '57 W 57TH ST, TORONTO, ON M5V 2T6, CANADA', '57 W 57th St, Toronto', '57 W 57th St, Vancouver, BC V6B 1A1', '57 W 57th St, Montreal, QC H3B 2Y5, Canada', '57 W 57th St, London, England']) {
    for (const where of [W, []]) { const r = contactAgreement({ where, evidence: EVIDENCE }, { address: addr }); assert.equal(r.ok, false, addr + JSON.stringify(where)); assert.match((r as { reason: string }).reason, /^contact rejected: location (?:mismatch|unconfirmed) /, addr) }
  }
  for (const place of ['Toronto, ON', 'Toronto, Ontario, Canada', 'toronto, on']) assert.equal(contactAgreement({ where: W, evidence: EVIDENCE }, { address: '57 W 57th St', place }).ok, false, `the place field too: ${place}`)
  // same street + same city (any honest spelling) attaches
  for (const addr of ['57 W 57th St, New York, NY 10019', '57 W 57th St, New York', '57 W 57th St, Manhattan, NY', '57 West 57th Street, New York, New York 10019', '57 W 57th St']) assert.equal(contactAgreement({ where: W, evidence: EVIDENCE }, { address: addr }).ok, true, addr)
  // a Toronto lead is the one place that street in Toronto agrees with
  assert.equal(contactAgreement({ where: ['Toronto, ON'], evidence: 'Maple Dental is opening at 57 W 57th St, Toronto' }, { address: '57 W 57th St, Toronto, ON M5V 2T6, Canada' }).ok, true, 'a Toronto lead accepts its own Toronto address')
  // through Apollo: org record = Toronto, Ontario on the same street text, no domain
  const s = seed()
  await enrichLeadContacts(s.db, 'u1', s.jobId, [s.lead], { fetchImpl: apollo({ ...PICO, name: 'Smile Avenue Dental', website_url: undefined, city: 'Toronto', state: 'Ontario', country: 'Canada', street_address: '57 W 57th St' }), master })
  assert.deepEqual(attached(s.db), [], 'nothing from the Toronto record attaches'); assert.equal(refusals(s.db).length, 1, JSON.stringify(refusals(s.db)))
})

test('REGRESSION (explicit country): a stated country that is not the lead\'s refuses even when street / city / region match - "New York, NY, Canada" for a New York lead, "London, France" for a London UK lead; genuine same-country positives stay', async () => {
  const NYC = ['New York City'], LON = ['London, UK']
  const LE = 'Brightloop is opening an office at 10 Old Street, London'
  const bad: [string[], string | null, { address?: string; place?: string }][] = [
    [NYC, EVIDENCE, { place: 'New York, NY, Canada' }], [NYC, EVIDENCE, { address: '57 W 57th St, New York, NY, Canada' }], [NYC, EVIDENCE, { address: '57 W 57th St, New York, NY 10019, Canada' }],
    [NYC, EVIDENCE, { place: 'New York, New York, United Kingdom' }], [NYC, EVIDENCE, { address: '57 W 57th St', place: 'New York, NY, Mexico' }], [NYC, EVIDENCE, { place: 'NEW YORK, NY, CANADA' }],
    [LON, LE, { place: 'London, France' }], [LON, LE, { address: '10 Old Street, London, France' }], [LON, LE, { address: '10 Old St, London EC1V 9AB, France' }], [LON, LE, { place: 'London, Germany' }], [LON, LE, { place: 'London, United States' }],
  ]
  for (const [where, evidence, c] of bad) { const r = contactAgreement({ where, evidence }, c); assert.equal(r.ok, false, JSON.stringify(c)); assert.match((r as { reason: string }).reason, /^contact rejected: location mismatch .*country [A-Z]{2} is not the lead's/, JSON.stringify(c)) }
  const good: [string[], string | null, { address?: string; place?: string }][] = [
    [NYC, EVIDENCE, { place: 'New York, NY, USA' }], [NYC, EVIDENCE, { place: 'New York, NY, United States' }], [NYC, EVIDENCE, { address: '57 W 57th St, New York, NY 10019, USA' }], [NYC, EVIDENCE, { address: '57 W 57th St, New York, NY' }],
    [LON, LE, { place: 'London, UK' }], [LON, LE, { place: 'London, England' }], [LON, LE, { address: '10 Old Street, London EC1V 9AB, United Kingdom' }], [LON, LE, { address: '10 Old Street, London' }],
  ]
  for (const [where, evidence, c] of good) assert.equal(contactAgreement({ where, evidence }, c).ok, true, JSON.stringify(c))
  // Apollo path, both leads: the org record states the wrong country
  const wrongNy = seed()
  await enrichLeadContacts(wrongNy.db, 'u1', wrongNy.jobId, [wrongNy.lead], { fetchImpl: apollo({ ...NY, country: 'Canada' }), master })
  assert.deepEqual(attached(wrongNy.db), [], 'New York, New York, Canada does not attach to the New York lead'); assert.deepEqual(refusals(wrongNy.db).map(r => r[0]), ['contact_location_mismatch'], JSON.stringify(refusals(wrongNy.db)))
  const wrongLon = seed({ where: JSON.stringify({ summary: 'London', where: ['London, UK'], who: ['Founder'], signals: [] }) })
  await enrichLeadContacts(wrongLon.db, 'u1', wrongLon.jobId, [wrongLon.lead], { fetchImpl: apollo({ ...NY, name: 'Smile Avenue Dental', city: 'London', state: undefined, country: 'France', street_address: undefined }), master })
  assert.deepEqual(attached(wrongLon.db), [], 'London, France does not attach to the London UK lead'); assert.deepEqual(refusals(wrongLon.db).map(r => r[0]), ['contact_location_mismatch'], JSON.stringify(refusals(wrongLon.db)))
  const rightNy = seed()
  await enrichLeadContacts(rightNy.db, 'u1', rightNy.jobId, [rightNy.lead], { fetchImpl: apollo({ ...NY, country: 'United States' }), master })
  assert.ok(attached(rightNy.db).length > 0, 'the genuine same-city, same-country record still attaches'); assert.equal(refusals(rightNy.db).length, 0, JSON.stringify(refusals(rightNy.db)))
})

test('COUNTRY TABLE: the complete ISO 3166 table resolves any explicit country; US states / DC, "New Jersey" / "New Mexico" and UK constituents are never misread', async () => {
  const { countriesIn, COUNTRY_COUNT, resolveSegment } = await import('../lib/scan/countries.ts')
  assert.ok(COUNTRY_COUNT >= 249, `all of ISO 3166-1: ${COUNTRY_COUNT}`)
  const code = (t: string) => countriesIn(t)
  for (const [t, c] of [['New York, NY, Zimbabwe', 'ZW'], ['57 W 57th St, New York, NY 10019, Brazil', 'BR'], ['Tokyo, Japan', 'JP'], ['London, Kenya', 'KE'], ['Harare, ZWE', 'ZW'], ['Seoul, Republic of Korea', 'KR'], ['Abidjan, Cote d\'Ivoire', 'CI'], ['Kyiv, Ukraine', 'UA'], ['Vilnius, Lithuania', 'LT'], ['Ulaanbaatar, Mongolia', 'MN'], ['Lima, Peru', 'PE'], ['Beirut, Lebanon', 'LB'], ['Tbilisi, Republic of Georgia', 'GE'], ['St Helier, Jersey', 'JE'], ['New York NY Zimbabwe', 'ZW'], ['Nairobi, kenya', 'KE'], ['MANILA, PHILIPPINES', 'PH']] as const) assert.deepEqual(code(t), [c], t)
  for (const t of ['Atlanta, Georgia', 'Atlanta, GA 30301', 'Newark, New Jersey', 'Santa Fe, New Mexico', 'Lebanon, PA', 'Mexico, MO', 'Peru, IN', 'Turkey, TX', 'Indiana, PA', 'Washington, DC', 'Washington, District of Columbia', 'Dover, Delaware', 'Phoenix, Arizona', 'Charleston, West Virginia', 'Jersey City, NJ', 'New York, NY 10019']) assert.deepEqual(code(t), [], `${t}: a US place is not a foreign country`)
  for (const t of ['New York, NY, USA', 'New York, NY, United States', 'New York, NY, U.S.A.', 'New York, NY, America']) assert.deepEqual(code(t), ['US'], t)
  for (const t of ['London, UK', 'London, England', 'London, Scotland', 'Cardiff, Wales', 'Belfast, Northern Ireland', 'London, United Kingdom', 'London, GBR', 'London, Great Britain']) assert.deepEqual(code(t), ['GB'], t)
  assert.equal(resolveSegment('Georgia'), null); assert.equal(resolveSegment('New Jersey'), null); assert.equal(resolveSegment('Jersey', true), 'JE'); assert.equal(resolveSegment('Jersey City'), null)
})
test('REGRESSION (complete country resolver): NYC street + Zimbabwe / Brazil / Japan and a London address + Kenya refuse; the USA / UK positives and US-state spellings attach', async () => {
  const NYC = ['New York City'], LON = ['London, UK'], LE = 'Brightloop is opening an office at 10 Old Street, London'
  for (const c of ['Zimbabwe', 'Brazil', 'Japan', 'Nigeria', 'Vietnam', 'New Zealand', 'Iceland', 'Peru', 'Zambia', 'ZWE', 'Republic of Korea'] as const) {
    for (const stated of [{ place: `New York, NY, ${c}` }, { address: `57 W 57th St, New York, NY 10019, ${c}` }, { address: `57 W 57th St, New York, ${c}` }, { address: `57 W 57TH ST, NEW YORK, NY, ${c.toUpperCase()}` }]) {
      const r = contactAgreement({ where: NYC, evidence: EVIDENCE }, stated); assert.equal(r.ok, false, JSON.stringify(stated)); assert.match((r as { reason: string }).reason, /^contact rejected: location mismatch .*country [A-Z]{2} is not the lead's/, JSON.stringify(stated))
    }
  }
  for (const stated of [{ place: 'London, Kenya' }, { address: '10 Old Street, London EC1V 9AB, Kenya' }, { place: 'London, Zimbabwe' }, { address: '10 Old Street, London, Australia' }]) {
    const r = contactAgreement({ where: LON, evidence: LE }, stated); assert.equal(r.ok, false, JSON.stringify(stated)); assert.match((r as { reason: string }).reason, /country [A-Z]{2} is not the lead's/)
  }
  for (const stated of [{ place: 'New York, NY, USA' }, { place: 'New York, NY, United States' }, { address: '57 W 57th St, New York, NY 10019, USA' }, { address: '57 W 57th St, New York, NY 10019' }, { address: '57 W 57th St' }, { address: '57 W 57th St, New York, New York' }]) assert.equal(contactAgreement({ where: NYC, evidence: EVIDENCE }, stated).ok, true, JSON.stringify(stated))
  for (const stated of [{ place: 'London, UK' }, { place: 'London, England' }, { place: 'London, United Kingdom' }, { address: '10 Old Street, London EC1V 9AB, United Kingdom' }, { address: '10 Old Street, London EC1V 9AB, GBR' }]) assert.equal(contactAgreement({ where: LON, evidence: LE }, stated).ok, true, JSON.stringify(stated))
  // US-state spellings are never a foreign country, for a lead in that state
  assert.equal(contactAgreement({ where: ['Atlanta, Georgia'], evidence: 'Peachtree Dental is opening at 100 Peachtree St, Atlanta' }, { address: '100 Peachtree St, Atlanta, GA 30303' }).ok, true)
  assert.equal(contactAgreement({ where: ['Atlanta, Georgia'], evidence: 'Peachtree Dental is opening at 100 Peachtree St, Atlanta' }, { address: '100 Peachtree St, Atlanta, Georgia' }).ok, true)
  assert.equal(contactAgreement({ where: ['Newark, New Jersey'], evidence: 'Garden Dental is opening at 5 Broad St, Newark' }, { place: 'Newark, New Jersey, USA' }).ok, true)
  // Apollo path: the org record names Zimbabwe (a country the old short list did not know)
  const s = seed()
  await enrichLeadContacts(s.db, 'u1', s.jobId, [s.lead], { fetchImpl: apollo({ ...NY, country: 'Zimbabwe' }), master })
  assert.deepEqual(attached(s.db), [], 'New York, New York, Zimbabwe does not attach'); assert.deepEqual(refusals(s.db).map(r => r[0]), ['contact_location_mismatch'], JSON.stringify(refusals(s.db)))
})
