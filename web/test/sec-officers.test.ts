import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { migrateScan, createJob } from '../lib/scan/store.ts'
import { migrateConnectors } from '../lib/connectors/store.ts'
import { parseRelatedPersons, storeFilingOfficers, confirmFilingIdentity, CANDIDATE_KIND, CONNECTOR } from '../lib/people/sec-officers.ts'
import { contactsFromEnrichments } from '../lib/people/rank.ts'

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
function setup(evidence = KNOWN) {
  const db = new Database(':memory:'); migrateScan(db); migrateConnectors(db)
  const job = createJob(db, 'A', { business_name: 'S', industry: 'x', location: 'y' })
  db.prepare("UPDATE scan_jobs SET status = 'running', icp = ? WHERE id = ?").run(JSON.stringify({ summary: 's', where: ['New York City'], who: [], signals: [] }), job)
  db.prepare('INSERT INTO leads (id,scan_job_id,company,contact,signal,source_url,evidence_excerpt,confidence,score) VALUES (?,?,?,?,?,?,?,?,?)').run('L1', job, 'Acme', null, 's', 'https://n.example.test/a', evidence, 90, 80)
  return db
}
const filing = { url: URL, date: '2026-09-01', entity: 'Acme Inc' }

test('stores labelled person rows that the right-people ranker reads; ICP role ranks the CEO first', async () => {
  const db = setup()
  const urls: string[] = []
  const n = await storeFilingOfficers(db, 'A', 'L1', filing, { fetchImpl: (async (u: string) => { urls.push(u); return new Response(XML) }) as typeof fetch })
  assert.equal(n, 3); assert.deepEqual(urls, [URL])
  const rows = db.prepare('SELECT kind,value,label,source_url,connector FROM lead_enrichments WHERE lead_id = ?').all('L1') as { kind: string; value: string; label: string; source_url: string; connector: string }[]
  assert.ok(rows.every(r => r.connector === CONNECTOR && r.kind === 'person' && r.source_url === URL && /not verified as current/.test(r.label)))
  const ranked = contactsFromEnrichments(rows, 'CEO; Executive Officer')
  assert.equal(ranked[0].name, 'Jane Doe'); assert.equal(ranked[0].tier, 'strong')
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
  const run = async (xml: string) => { const db = setup(); const n = await storeFilingOfficers(db, 'A', 'L1', filing, { fetchImpl: (async () => new Response(xml)) as typeof fetch }); return { n, rows: (db.prepare('SELECT count(*) n FROM lead_enrichments').get() as { n: number }).n } }
  for (const iss of [issuer('Entirely Different Invented LLC'), '', '<primaryIssuer></primaryIssuer>', issuer('Acme Growth Fund II, LP')]) assert.deepEqual(await run(body(iss)), { n: 0, rows: 0 })
  assert.deepEqual(await run(body(issuer('ACME INC'))), { n: 3, rows: 3 })
})

// ---- two different companies with the same name: a name match alone is not identity ----
const withGeo = (icp: { where: string[] } | null, evidence?: string) => { const db = setup(evidence); db.prepare('UPDATE scan_jobs SET icp = ?').run(icp ? JSON.stringify({ summary: 's', who: [], signals: [], ...icp }) : null); return db }
const store = async (db: Database.Database, xml: string) => storeFilingOfficers(db, 'A', 'L1', filing, { fetchImpl: (async () => new Response(xml)) as typeof fetch })
const body = (iss: string) => XML.replace(issuer('Acme, Inc.'), iss)

test('same-name regression: "Acme Inc" in Austin TX does not attach to the New York "Acme"; the New York "Acme Inc" does', async () => {
  const austin = withGeo({ where: ['New York City'] }); assert.equal(await store(austin, body(issuer('Acme, Inc.', 'Austin', 'TX'))), 0)
  assert.equal((austin.prepare('SELECT COUNT(*) n FROM lead_enrichments').get() as { n: number }).n, 0)
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
const nyc = (evidence: string) => withGeo({ where: ['New York City'] }, evidence)

test('same-city namesake with no confirmed binding: nothing is attached; the people are QUARANTINED for identity review and never count as people or contacts', async () => {
  const db = nyc(NO_STREET)
  assert.equal(await store(db, body(issuer('Acme, Inc.', 'New York', 'NY'))), 0)
  assert.equal(rows(db, 'person').length, 0)
  const q = rows(db, CANDIDATE_KIND); assert.equal(q.length, 3); assert.ok(q.every(r => /quarantined: same name, not confirmed as this company - needs identity review/.test(r.label)))
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

test('the SAME street address binds the filer to the lead: people are attached', async () => {
  const db = nyc('Acme Dental opened at 100 Atlantic Avenue, New York this month')
  assert.equal(await store(db, body(issuer('Acme, Inc.', 'New York', 'NY'))), 3); assert.equal(rows(db, 'person').length, 3); assert.equal(rows(db, CANDIDATE_KIND).length, 0)
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
