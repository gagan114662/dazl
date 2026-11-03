import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { migrateScan, createJob } from '../lib/scan/store.ts'
import { migrateConnectors } from '../lib/connectors/store.ts'
import { parseRelatedPersons, storeFilingOfficers, confirmFilingIdentity, filingIssuerPlace, unitsIn, CANDIDATE_KIND, CONNECTOR } from '../lib/people/sec-officers.ts'
import { contactsFromEnrichments, recommendedPerson } from '../lib/people/rank.ts'
import { opportunityCard, type CardLead } from '../lib/scan/opportunity.ts'

// TEST-ONLY fixture shaped like a Form D primary_doc.xml; no network.
const rp = (f: string, l: string, rels: string[], clar = '') => `<relatedPersonInfo><relatedPersonName><firstName>${f}</firstName><lastName>${l}</lastName></relatedPersonName><relatedPersonAddress><street1>1 Main St</street1></relatedPersonAddress><relatedPersonRelationshipList>${rels.map(r => `<relationship>${r}</relationship>`).join('')}</relatedPersonRelationshipList>${clar ? `<relationshipClarification>${clar}</relationshipClarification>` : ''}</relatedPersonInfo>`
const issuer = (n: string, city = 'New York', state = 'NY') => `<primaryIssuer><entityName>${n}</entityName>${city ? `<issuerAddress><street1>100 Atlantic Avenue</street1><city>${city}</city><stateOrCountry>${state}</stateOrCountry></issuerAddress>` : ''}</primaryIssuer>`
const XML = `<edgarSubmission>${issuer('Acme, Inc.')}<relatedPersonsList>${rp('JANE', 'DOE', ['Executive Officer', 'Director'], 'CEO')}${rp('Raj', 'Patel', ['Director'])}${rp('', 'Big Fund LP', ['Promoter'])}${rp('Jane', 'Doe', ['Director'])}${rp('Sam', 'Lee', ['Promoter'])}</relatedPersonsList></edgarSubmission>`
const URL = 'https://www.sec.gov/Archives/edgar/data/123456/000123456726000001/primary_doc.xml'

test('parse: people only, clarified title first, no entities, deduped, no address kept', () => {
  const p = parseRelatedPersons(XML)
  assert.deepEqual(p.map(x => x.name), ['Jane Doe', 'Raj Patel', 'Sam Lee'])
  assert.equal(p[0].role, 'CEO (Executive Officer)')
  assert.ok(!JSON.stringify(p).includes('Main St'))
})

const KNOWN = 'Acme opened its second office at 100 Atlantic Avenue, New York'
function setup(evidence = KNOWN, confirmed = true) {
  const db = new Database(':memory:'); migrateScan(db); migrateConnectors(db)
  const job = createJob(db, 'A', { business_name: 'S', industry: 'x', location: 'y' })
  db.prepare("UPDATE scan_jobs SET status = 'running', icp = ? WHERE id = ?").run(JSON.stringify({ summary: 's', where: ['New York City'], who: [], signals: [] }), job)
  db.prepare('INSERT INTO leads (id,scan_job_id,company,contact,signal,source_url,evidence_excerpt,confidence,score) VALUES (?,?,?,?,?,?,?,?,?)').run('L1', job, 'Acme', null, 's', 'https://n.example.test/a', evidence, 90, 80)
  if (confirmed) confirmFilingIdentity(db, 'A', 'L1', '123456')      // the identity review confirmed this filer (CIK) as the lead's company
  return db
}
const filing = { url: URL, date: '2026-09-01', entity: 'Acme Inc' }

test('stores labelled person rows that the right-people ranker reads; ICP role ranks the CEO first', async () => {
  const db = setup()
  const urls: string[] = []
  const n = await storeFilingOfficers(db, 'A', 'L1', filing, { fetchImpl: (async (u: string) => { urls.push(u); return new Response(XML) }) as typeof fetch })
  assert.equal(n, 3); assert.deepEqual(urls, [URL])
  const rows = db.prepare("SELECT kind,value,label,source_url,connector FROM lead_enrichments WHERE lead_id = ? AND kind = 'person'").all('L1') as { kind: string; value: string; label: string; source_url: string; connector: string }[]
  assert.ok(rows.every(r => r.connector === CONNECTOR && r.kind === 'person' && r.source_url === URL && /not verified as current/.test(r.label)))
  const ranked = contactsFromEnrichments(rows, 'CEO; Executive Officer')
  assert.equal(ranked.length, 3, 'the history stays visible'); assert.ok(ranked.every(r => r.historical && r.tier === 'none' && r.score === 0), 'but is never ranked for action')
  assert.equal(ranked.find(r => r.name === 'Jane Doe')!.matched.length, 0)
  assert.equal(ranked[0].linkedin, null); assert.equal(ranked[0].source, URL)
})

test('refuses non-sec.gov / non-filing URLs, kill switch, http failure, and junk bodies without throwing', async () => {
  const db = setup(); let calls = 0
  const f = (async () => { calls++; return new Response(XML) }) as typeof fetch
  assert.equal(await storeFilingOfficers(db, 'A', 'L1', { ...filing, url: 'https://evil.example.test/a/000123456726000001/primary_doc.xml' }, { fetchImpl: f }), 0)
  assert.equal(await storeFilingOfficers(db, 'A', 'L1', { ...filing, url: 'http://www.sec.gov/Archives/edgar/data/1/000123456726000001/p.xml' }, { fetchImpl: f }), 0)
  assert.equal(await storeFilingOfficers(db, 'A', 'L1', filing, { fetchImpl: f, env: { SEC_OFFICERS: '0' } }), 0)
  assert.equal(calls, 0)
  assert.equal(await storeFilingOfficers(db, 'A', 'L1', filing, { fetchImpl: (async () => new Response('no', { status: 500 })) as typeof fetch }), 0)
  assert.equal(await storeFilingOfficers(db, 'A', 'L1', filing, { fetchImpl: (async () => new Response('{"hits":1}')) as typeof fetch }), 0)
  assert.equal(await storeFilingOfficers(db, 'A', 'L1', filing, { fetchImpl: (async () => { throw new Error('x') }) as typeof fetch }), 0)
})

test('issuer binding: contradicting, missing or fund-like issuer stores nothing; matching issuer stores', async () => {
  const body = (iss: string) => XML.replace(issuer('Acme, Inc.'), iss)
  const run = async (xml: string) => { const db = setup(); const n = await storeFilingOfficers(db, 'A', 'L1', filing, { fetchImpl: (async () => new Response(xml)) as typeof fetch }); return { n, rows: (db.prepare("SELECT count(*) n FROM lead_enrichments WHERE kind <> 'sec_filing_confirmed'").get() as { n: number }).n } }
  for (const iss of [issuer('Entirely Different Invented LLC'), '', '<primaryIssuer></primaryIssuer>', issuer('Acme Growth Fund II, LP')]) assert.deepEqual(await run(body(iss)), { n: 0, rows: 0 })
  assert.deepEqual(await run(body(issuer('ACME INC'))), { n: 3, rows: 3 })
})

// ---- two different companies with the same name: a name match alone is not identity ----
const withGeo = (icp: { where: string[] } | null, evidence?: string, confirmed = true) => { const db = setup(evidence, confirmed); db.prepare('UPDATE scan_jobs SET icp = ?').run(icp ? JSON.stringify({ summary: 's', who: [], signals: [], ...icp }) : null); return db }
const store = async (db: Database.Database, xml: string) => storeFilingOfficers(db, 'A', 'L1', filing, { fetchImpl: (async () => new Response(xml)) as typeof fetch })
const body = (iss: string) => XML.replace(issuer('Acme, Inc.'), iss)

test('same-name regression: "Acme Inc" in Austin TX does not attach to the New York "Acme"; the New York "Acme Inc" does', async () => {
  const austin = withGeo({ where: ['New York City'] }); assert.equal(await store(austin, body(issuer('Acme, Inc.', 'Austin', 'TX'))), 0)
  assert.equal((austin.prepare("SELECT COUNT(*) n FROM lead_enrichments WHERE kind <> 'sec_filing_confirmed'").get() as { n: number }).n, 0)
  const ny = withGeo({ where: ['New York City'] }); assert.equal(await store(ny, body(issuer('Acme, Inc.', 'New York', 'NY'))), 3)
  const brooklyn = withGeo({ where: ['New York City'] }); assert.equal(await store(brooklyn, body(issuer('Acme, Inc.', 'Brooklyn', 'NY'))), 3, 'a borough is the same city for the scan')
})

test('no stated issuer address, or no geography on the scan, means nothing to agree on: nothing is stored (a name alone never passes)', async () => {
  const NOADDR = 'Acme opened a dental office this month'      // the lead's evidence names no street and no place
  assert.equal(await store(withGeo({ where: ['New York City'] }, NOADDR), body(issuer('Acme, Inc.', '', ''))), 0)
  assert.equal(await store(withGeo({ where: [] }, NOADDR), body(issuer('Acme, Inc.'))), 0)
  assert.equal(await store(withGeo(null, NOADDR), body(issuer('Acme, Inc.'))), 0)
})

test('a lead that is not this tenant\'s stores nothing; a London scan refuses a New York issuer of the same name', async () => {
  const db = setup(); assert.equal(await storeFilingOfficers(db, 'B', 'L1', filing, { fetchImpl: (async () => new Response(XML)) as typeof fetch }), 0)
  assert.equal(await store(withGeo({ where: ['London, UK'] }), body(issuer('Acme, Inc.', 'New York', 'NY'))), 0)
})

// ---- same name AND same city is still not identity (review of a1450fe6) ----
const rows = (db: Database.Database, kind: string) => (db.prepare('SELECT value, label, source_url FROM lead_enrichments WHERE lead_id = ? AND kind = ?').all('L1', kind) as { value: string; label: string; source_url: string }[])
const NO_STREET = 'Acme opened a dental office in New York this month'
const nyc = (evidence: string) => withGeo({ where: ['New York City'] }, evidence, false)      // NOT confirmed by an identity review

test('same-city namesake with no confirmed binding: nothing is attached; the people are QUARANTINED for identity review and never count as people or contacts', async () => {
  const db = nyc(NO_STREET)
  assert.equal(await store(db, body(issuer('Acme, Inc.', 'New York', 'NY'))), 0)
  assert.equal(rows(db, 'person').length, 0)
  const q = rows(db, CANDIDATE_KIND); assert.equal(q.length, 3); assert.ok(q.every(r => /quarantined: same name and city only; not confirmed as this company - needs identity review/.test(r.label)))
  assert.equal(contactsFromEnrichments(db.prepare('SELECT kind,value,label,source_url,connector FROM lead_enrichments WHERE lead_id = ?').all('L1') as never, 'CEO; Executive Officer').length, 0, 'the ranker never sees a quarantined candidate')
})

test('a KNOWN different street address is a known different company: nothing is attached and nothing is even quarantined', async () => {
  const db = nyc('Acme Dental at 55 Court Street, New York opened a second room')           // the filing says 100 Atlantic Avenue
  assert.equal(await store(db, body(issuer('Acme, Inc.', 'New York', 'NY'))), 0)
  assert.equal(rows(db, 'person').length + rows(db, CANDIDATE_KIND).length, 0)
})

test('a conflicting place stays out entirely (other city, other country), even with an identical name', async () => {
  for (const [city, state] of [['Austin', 'TX'], ['Toronto', 'A6']]) { const db = nyc(NO_STREET); assert.equal(await store(db, body(issuer('Acme, Inc.', city, state))), 0); assert.equal(rows(db, CANDIDATE_KIND).length + rows(db, 'person').length, 0, city) }
})

test('the SAME street address is corroboration only: the people are quarantined, not attached, until an identity review confirms the filer', async () => {
  const db = nyc('Acme Dental opened at 100 Atlantic Avenue, New York this month')
  assert.equal(await store(db, body(issuer('Acme, Inc.', 'New York', 'NY'))), 0); assert.equal(rows(db, 'person').length, 0)
  const q = rows(db, CANDIDATE_KIND); assert.equal(q.length, 3); assert.ok(q.every(r => /street and unit match|unit not stated/.test(r.label) && /not confirmed as this company/.test(r.label)))
})

// ---- same building, different unit (review of cc8aced) ----
const withUnit = (unit: string, city = 'New York', state = 'NY') => `<primaryIssuer><entityName>Acme, Inc.</entityName><issuerAddress><street1>100 Atlantic Avenue</street1><street2>${unit}</street2><city>${city}</city><stateOrCountry>${state}</stateOrCountry></issuerAddress></primaryIssuer>`
const bodyU = (unit: string) => XML.replace(issuer('Acme, Inc.'), withUnit(unit))

test('same building, DIFFERENT unit (filing Suite 100 vs the lead at Suite 900, a different known dental domain): nothing is attached; the people are quarantined and unranked', async () => {
  const db = nyc('Acme Dental, Suite 900, 100 Atlantic Avenue, New York, opened its second office')
  db.prepare("UPDATE leads SET company_domain = 'acmedental.example'").run()
  assert.equal(await store(db, bodyU('Suite 100')), 0)
  assert.equal(rows(db, 'person').length, 0, 'not attached')
  const q = rows(db, CANDIDATE_KIND); assert.equal(q.length, 3); assert.ok(q.every(r => /same building, different unit \(filing 100 vs lead 900\)/.test(r.label)), q[0].label)
  assert.equal(contactsFromEnrichments(db.prepare('SELECT kind,value,label,source_url,connector FROM lead_enrichments WHERE lead_id = ?').all('L1') as never, 'CEO; Executive Officer').length, 0, 'unranked')
})

test('the unit is parsed from SEC street2 and from street1; "Ste.", "#" and "Floor" forms compare; a shared building with no unit on either side is flagged, never bound', async () => {
  assert.equal(filingIssuerPlace(withUnit('Suite 100')).unit, '100'); assert.equal(filingIssuerPlace(withUnit('Ste. 4B')).unit, '4b'); assert.equal(filingIssuerPlace(withUnit('#12')).unit, '12'); assert.equal(filingIssuerPlace(withUnit('3rd Floor')).unit, 'floor 3')
  assert.deepEqual(unitsIn('Acme at 100 Atlantic Avenue, Suite 900 and Unit 4B'), ['900', '4b'])
  const db = nyc('Acme Dental opened at 100 Atlantic Avenue, New York'); assert.equal(await store(db, body(issuer('Acme, Inc.', 'New York', 'NY'))), 0)
  assert.ok(rows(db, CANDIDATE_KIND).every(r => /unit not stated on both sides \(shared-building ambiguity\)/.test(r.label)))
  const same = nyc('Acme Dental, Suite 100, 100 Atlantic Avenue, New York'); assert.equal(await store(same, bodyU('Ste. 100')), 0); assert.ok(rows(same, CANDIDATE_KIND).every(r => /street and unit match \(corroboration only\)/.test(r.label)), 'even a full street + unit match is corroboration, not identity')
})

test('genuinely CIK/domain-bound: a reviewer binds the filer by the CIK and the lead\'s CONFIRMED domain, and only then are the people attached (a wrong or unconfirmed domain records nothing)', async () => {
  const db = nyc('Acme Dental, Suite 900, 100 Atlantic Avenue, New York')
  db.prepare("UPDATE leads SET company_domain = 'acmedental.example'").run()
  assert.equal(await store(db, bodyU('Suite 100')), 0); assert.equal(rows(db, CANDIDATE_KIND).length, 3)
  assert.equal(confirmFilingIdentity(db, 'A', 'L1', '123456', { domain: 'other.example' }), 0, 'a domain that is not the lead\'s'); assert.equal(confirmFilingIdentity(db, 'A', 'L1', '123456', { domain: 'acmedental.example' }), 0, 'the lead\'s domain is not confirmed yet')
  assert.equal(rows(db, 'sec_filing_confirmed').length, 0, 'nothing recorded by a refused confirmation'); assert.equal(rows(db, 'person').length, 0)
  db.prepare("INSERT INTO lead_enrichments (id, tenant_id, lead_id, connector, kind, value, label, source_url, source_date, retrieved_at) VALUES ('d1', 'A', 'L1', 'user', 'domain_review', 'acmedental.example', 'confirmed', 'https://acmedental.example', '2026-10-20', 0)").run()
  assert.equal(confirmFilingIdentity(db, 'A', 'L1', '123456', { domain: 'acmedental.example' }), 3)
  assert.equal(rows(db, 'person').length, 3); assert.equal(rows(db, CANDIDATE_KIND).length, 0); assert.ok(rows(db, 'sec_filing_confirmed')[0].label.includes('confirmed domain'))
})

test('identity review: confirming the filer (CIK) promotes ITS quarantined people, only for the reviewing tenant, and never another filer\'s', async () => {
  const db = nyc(NO_STREET); await store(db, body(issuer('Acme, Inc.', 'New York', 'NY')))
  assert.equal(confirmFilingIdentity(db, 'B', 'L1', '123456'), 0, 'another tenant cannot confirm'); assert.equal(confirmFilingIdentity(db, 'A', 'L1', '999999'), 0, 'a different filer\'s CIK promotes nothing'); assert.equal(confirmFilingIdentity(db, 'A', 'L1', 'abc'), 0)
  assert.equal(rows(db, 'person').length, 0)
  assert.equal(confirmFilingIdentity(db, 'A', 'L1', '123456'), 3); assert.equal(rows(db, 'person').length, 3); assert.equal(rows(db, CANDIDATE_KIND).length, 0)
  assert.ok(rows(db, 'person').every(r => /identity confirmed by review/.test(r.label)))
  // later runs for the confirmed filer attach directly; another filer (same name) stays quarantined
  const again = nyc(NO_STREET); confirmFilingIdentity(again, 'A', 'L1', '123456'); assert.equal(await store(again, body(issuer('Acme, Inc.', 'New York', 'NY'))), 3)
  const other = await storeFilingOfficers(again, 'A', 'L1', { ...filing, url: 'https://www.sec.gov/Archives/edgar/data/777777/000777777726000001/primary_doc.xml' }, { fetchImpl: (async () => new Response(body(issuer('Acme, Inc.', 'New York', 'NY')))) as typeof fetch })
  assert.equal(other, 0); assert.equal(rows(again, CANDIDATE_KIND).length, 3)
})

test('SEC-only historical officer + a generic hello@ company email: NOT "Who: Jane Doe, CEO", no "Draft a first message to Jane Doe", no approval path; the history stays visible and unranked', () => {
  const lead: CardLead = {
    id: 'a'.repeat(24), company: 'Acme Dental', signal: 'Opened a second location', source_url: 'https://acme-dental.example/news', evidence_excerpt: 'Acme Dental opened a second location',
    event_date: '2026-10-10', date_status: 'verified', review_reason: null, fit: 5, intent: 0, why: 'Expanding.', confidence: 90, human_confirmed_at: 1,
    icp_match: JSON.stringify({ role: 'match', industry: 'match', size: 'unknown', location: 'match', note: '' }), company_domain: 'acme-dental.example', contact: null, currentness_held: false, window_held: false,
    enrichments: [
      { connector: 'sitecrawl', kind: 'domain', value: 'acme-dental.example|evidence_own_domain', label: 'domain-basis-v1:evidence_own_domain', source_url: 'https://acme-dental.example/news' },
      { connector: CONNECTOR, kind: 'person', value: 'Jane Doe, Chief Executive Officer', label: 'named in SEC Form D filed 2021-03-01 (as of filing, not verified as current; identity confirmed by review)', source_url: URL },
      { connector: 'sitecrawl', kind: 'email', value: 'hello@acme-dental.example', label: null, source_url: 'https://acme-dental.example/contact' },
    ],
  }
  const c = opportunityCard(lead, 'CEO; Chief Executive Officer', new Date('2026-10-26T12:00:00Z'))
  assert.equal(c.who, null, 'the historical officer is not the recommended person')
  assert.doesNotMatch(c.next, /Jane Doe/); assert.doesNotMatch(c.next, /^Draft/); assert.match(c.next, /Find the decision-maker/)
  assert.ok(c.missing.some(m => /SEC filing: historical, not current/.test(m)))
  assert.ok(c.assumptions.some(a => /Jane Doe/.test(a) && /not a current role and not a contact/.test(a)), 'the history stays visible, as history')
  assert.equal(recommendedPerson([{ name: 'Jane Doe', title: 'Chief Executive Officer', linkedin: null, connector: CONNECTOR, historical: true }], 'CEO'), null)
  // with independent current evidence (a company-site listing) the SITE person is recommended, never the filing's
  const withSite = opportunityCard({ ...lead, enrichments: [...lead.enrichments!, { connector: 'sitecrawl', kind: 'person', value: 'Dana Lee, CEO', label: 'x', source_url: 'https://acme-dental.example/team' }] }, 'CEO', new Date('2026-10-26T12:00:00Z'))
  assert.equal(withSite.who?.name, 'Dana Lee')
})
