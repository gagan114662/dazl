// A contact / company record found by enrichment attaches to a lead only when it AGREES with the lead on the company domain or on the
// place (city level for New York City / London, reusing placeAgreement). The same-name Pico Rivera, CA practice must not attach to a New
// York lead. Stubbed Apollo / PDL responses and invented companies; no network, no credits, no keys beyond test fixtures.
import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { randomBytes } from 'node:crypto'
import { enrichLeadContacts } from '../lib/enrich/index.ts'
import { contactAgreement, formatPlace, leadPlaceLabel, firstPlaceLabel, regradeFromKeptContacts, recordContactRejection } from '../lib/scan/contact-agreement.ts'
import { migrateScan, createJob } from '../lib/scan/store.ts'
import { migrateConnectors, saveCredential, recentAudit, enrichmentsForLeads } from '../lib/connectors/store.ts'

const master = randomBytes(32)
const ok = (b: unknown) => new Response(JSON.stringify(b), { status: 200 })
const NYC_ICP = JSON.stringify({ summary: 'NYC dental', where: ['New York City'], who: ['Practice manager'], signals: [] })

function seed(opts: { domain: string | null; icp?: string | null }) {
  const db = new Database(':memory:'); migrateScan(db); migrateConnectors(db)
  const jobId = createJob(db, 'u1', { business_name: 'B', industry: 'I', location: 'L' })
  db.prepare("UPDATE scan_jobs SET status = 'running', icp = ? WHERE id = ?").run(opts.icp === undefined ? NYC_ICP : opts.icp, jobId)
  db.prepare("INSERT INTO leads (id, scan_job_id, name, company, company_domain, signal, source_url, fit, intent, action, why) VALUES ('lead1', ?, '', 'Smile Avenue Dental', ?, 'opened a new practice', 'https://x.example/1', 4, 3, 4, 'New dental practice in Sunnyside.')").run(jobId, opts.domain)
  return { db, jobId, lead: { id: 'lead1', company: 'Smile Avenue Dental', company_domain: opts.domain } }
}
const apollo = (org: Record<string, unknown> | null, people: Record<string, unknown>[] = [{ name: 'Sophia Rozov', title: 'Practice Manager', linkedin_url: 'https://linkedin.com/in/sr' }]) => (async (url: RequestInfo | URL) => {
  const u = String(url)
  if (u.includes('organizations/enrich')) return ok(org ? { organization: org } : {})
  if (u.includes('mixed_people')) return ok({ people })
  return new Response('no', { status: 404 })
}) as never
const rows = (db: Database.Database) => (enrichmentsForLeads(db, 'u1', ['lead1']).lead1 ?? []).filter(e => e.kind !== 'contact_rejected').map(e => `${e.kind}:${e.value}`)   // what was ATTACHED (refusal reasons are separate rows)
const audits = (db: Database.Database) => (recentAudit(db, 'u1', 20) as { status: string; lookup: string }[]).map(a => a.status)

test('contactAgreement: domain agrees / disagrees; place agrees / mismatches / unconfirmed; no geography makes no place demand', () => {
  const W = ['New York City']
  assert.deepEqual(contactAgreement({ company_domain: 'acme.com', where: W }, { domain: 'https://www.acme.com/about' }), { ok: true, via: 'domain' })
  assert.deepEqual(contactAgreement({ company_domain: 'acme.com', where: W }, { domain: 'acme.io' }), { ok: false, reason: 'contact rejected: domain mismatch acme.io vs acme.com' })
  assert.deepEqual(contactAgreement({ where: W }, { place: 'New York, NY' }), { ok: true, via: 'location' })
  assert.deepEqual(contactAgreement({ where: W }, { place: 'Pico Rivera, CA' }), { ok: false, reason: 'contact rejected: location mismatch Pico Rivera, CA vs New York, NY' })
  assert.deepEqual(contactAgreement({ where: W }, { place: 'Rome, NY' }), { ok: false, reason: 'contact rejected: location mismatch Rome, NY vs New York, NY' })
  assert.equal(contactAgreement({ where: W }, { place: 'United States' }).ok, false)
  assert.equal(contactAgreement({ where: W }, {}).ok, false, 'no domain and no place: nothing confirms the company')
  assert.equal(contactAgreement({ where: [] }, {}).ok, true, 'a request with no place makes no place demand')
  assert.equal(contactAgreement({ company_domain: 'acme.com', where: W }, { keyedOnLeadDomain: true }).ok, true, 'the lookup was made by the lead’s own domain')
  assert.equal(formatPlace('Pico Rivera', 'California', 'United States'), 'Pico Rivera, CA'); assert.equal(formatPlace('Brooklyn', 'New York', null), 'Brooklyn, NY')
  assert.equal(leadPlaceLabel(['New York City']), 'New York, NY'); assert.equal(leadPlaceLabel(['London UK']), 'London, UK')
  assert.equal(firstPlaceLabel('Smile Avenue Dental Group - Dentist in Pico Rivera, CA 90660'), 'Pico Rivera, CA')
})

test('Apollo: the same-name practice in Pico Rivera, CA is NOT attached to the New York lead; the reason is recorded', async () => {
  const { db, jobId, lead } = seed({ domain: null })
  saveCredential(db, 'u1', 'enrich:apollo', 'test-apollo-key-1234', master)
  await enrichLeadContacts(db, 'u1', jobId, [lead], { fetchImpl: apollo({ name: 'Smile Avenue Dental Group', estimated_num_employees: 12, industry: 'Dental', website_url: 'https://smileavenuedental.com', city: 'Pico Rivera', state: 'California', country: 'United States' }), master })
  assert.deepEqual(rows(db), [], 'no firmographic and no contact')
  assert.ok(audits(db).includes('contact rejected: location mismatch Pico Rivera, CA vs New York, NY'), JSON.stringify(audits(db)))
})

test('Apollo control: the same-name practice in New York, NY still attaches (firmographic + contact)', async () => {
  const { db, jobId, lead } = seed({ domain: null })
  saveCredential(db, 'u1', 'enrich:apollo', 'test-apollo-key-1234', master)
  await enrichLeadContacts(db, 'u1', jobId, [lead], { fetchImpl: apollo({ name: 'Smile Avenue Dental', estimated_num_employees: 12, industry: 'Dental', website_url: 'https://smileavenuedental.com', city: 'New York', state: 'New York', country: 'United States' }), master })
  assert.deepEqual(rows(db).map(r => r.split(':')[0]).sort(), ['contact', 'firmographic'])
  assert.ok(audits(db).includes('ok'))
})

test('Apollo: a company with no place and no site, and a different domain than the lead’s, are not attached; the lead’s own domain settles it', async () => {
  const noInfo = seed({ domain: null })
  saveCredential(noInfo.db, 'u1', 'enrich:apollo', 'test-apollo-key-1234', master)
  await enrichLeadContacts(noInfo.db, 'u1', noInfo.jobId, [noInfo.lead], { fetchImpl: apollo({ name: 'Smile Avenue Dental', estimated_num_employees: 12 }), master })
  assert.deepEqual(rows(noInfo.db), [])
  const wrongDomain = seed({ domain: 'smileavenuedental.com' })
  saveCredential(wrongDomain.db, 'u1', 'enrich:apollo', 'test-apollo-key-1234', master)
  await enrichLeadContacts(wrongDomain.db, 'u1', wrongDomain.jobId, [wrongDomain.lead], { fetchImpl: apollo({ name: 'Smile Avenue Dental', estimated_num_employees: 12, website_url: 'https://smileavenue-dental.io' }), master })
  assert.deepEqual(rows(wrongDomain.db), []); assert.ok(audits(wrongDomain.db).some(a => a.startsWith('contact rejected: domain mismatch')))
  const sameDomain = seed({ domain: 'smileavenuedental.com' })
  saveCredential(sameDomain.db, 'u1', 'enrich:apollo', 'test-apollo-key-1234', master)
  await enrichLeadContacts(sameDomain.db, 'u1', sameDomain.jobId, [sameDomain.lead], { fetchImpl: apollo({ name: 'Smile Avenue Dental', estimated_num_employees: 12, website_url: 'https://www.smileavenuedental.com' }), master })
  assert.ok(rows(sameDomain.db).length >= 2)
  const keyedOnly = seed({ domain: 'smileavenuedental.com' })   // the org record carries no website: the lookup itself was keyed on the lead’s domain
  saveCredential(keyedOnly.db, 'u1', 'enrich:apollo', 'test-apollo-key-1234', master)
  await enrichLeadContacts(keyedOnly.db, 'u1', keyedOnly.jobId, [keyedOnly.lead], { fetchImpl: apollo({ name: 'Smile Avenue Dental', estimated_num_employees: 12 }), master })
  assert.ok(rows(keyedOnly.db).length >= 2)
})

test('PDL (matches on company NAME only): only the person whose company is in New York attaches; the Pico Rivera one is refused with a reason', async () => {
  const { db, jobId, lead } = seed({ domain: null })
  saveCredential(db, 'u1', 'enrich:pdl', 'test-pdl-key-5678', master)
  const fetchImpl = (async () => ok({ data: [
    { full_name: 'Carlos Vega', job_title: 'Office Manager', linkedin_url: 'https://linkedin.com/in/cv', job_company_location_locality: 'pico rivera', job_company_location_region: 'california', job_company_location_country: 'united states' },
    { full_name: 'Maya Chen', job_title: 'Practice Manager', linkedin_url: 'https://linkedin.com/in/mc', job_company_location_locality: 'new york', job_company_location_region: 'new york', job_company_location_country: 'united states' },
    { full_name: 'No Place', job_title: 'Dentist', linkedin_url: null },
  ] })) as never
  await enrichLeadContacts(db, 'u1', jobId, [lead], { fetchImpl, master })
  assert.deepEqual(rows(db), ['contact:Maya Chen - Practice Manager'])
  assert.ok(audits(db).includes('contact rejected: location mismatch pico rivera, CA vs New York, NY') || audits(db).some(a => /^contact rejected: location mismatch .*Pico Rivera.*vs New York, NY$/i.test(a)), JSON.stringify(audits(db)))
  assert.ok(audits(db).some(a => /no domain or location/.test(a)), 'a person with neither a place nor a domain is not attached')
})

test('no geography on the scan: PDL / Apollo behave as before (a record with a matching domain or nothing contradicting it attaches)', async () => {
  const { db, jobId, lead } = seed({ domain: 'acme.com', icp: null })
  saveCredential(db, 'u1', 'enrich:pdl', 'test-pdl-key-5678', master)
  await enrichLeadContacts(db, 'u1', jobId, [lead], { fetchImpl: (async () => ok({ data: [{ full_name: 'Jane Doe', job_title: 'VP Sales' }] })) as never, master })
  assert.deepEqual(rows(db), ['contact:Jane Doe - VP Sales'])
})

const leadRow = (db: Database.Database) => db.prepare("SELECT fit, intent, action, why FROM leads WHERE id = 'lead1'").get() as { fit: number; intent: number; action: number; why: string }

test('Pico Rivera / NYC regression: the refusal is recorded on the lead as a reason and the lead is regraded from the evidence actually kept', async () => {
  const { db, jobId, lead } = seed({ domain: null })
  saveCredential(db, 'u1', 'enrich:apollo', 'test-apollo-key-1234', master)
  await enrichLeadContacts(db, 'u1', jobId, [lead], { fetchImpl: apollo({ name: 'Smile Avenue Dental Group', estimated_num_employees: 12, industry: 'Dental', website_url: 'https://smileavenuedental.com', city: 'Pico Rivera', state: 'California', country: 'United States' }), master })
  const e = enrichmentsForLeads(db, 'u1', ['lead1']).lead1
  assert.deepEqual(e.map(x => [x.kind, x.value]), [['contact_rejected', 'contact rejected: location mismatch Pico Rivera, CA vs New York, NY']], 'only the reason is stored: no firmographic, no contact')
  assert.equal(leadRow(db).action, 4, 'not regraded yet')
  assert.equal(regradeFromKeptContacts(db, 'u1', jobId), 1)
  const l = leadRow(db); assert.equal(l.action, 2, 'reachability unconfirmed: action capped'); assert.equal(l.fit, 4); assert.equal(l.intent, 3)
  assert.match(l.why, /^Contact unconfirmed: location mismatch Pico Rivera, CA vs New York, NY\. New dental practice in Sunnyside\./)
  assert.equal(regradeFromKeptContacts(db, 'u1', jobId), 0, 'idempotent'); assert.equal(leadRow(db).why.match(/Contact unconfirmed/g)!.length, 1)
})

test('regrade control: the New York practice keeps its action grade; a refused record beside a kept contact changes nothing; the grade never goes up', async () => {
  const ny = seed({ domain: null }); saveCredential(ny.db, 'u1', 'enrich:apollo', 'test-apollo-key-1234', master)
  await enrichLeadContacts(ny.db, 'u1', ny.jobId, [ny.lead], { fetchImpl: apollo({ name: 'Smile Avenue Dental', estimated_num_employees: 12, website_url: 'https://smileavenuedental.com', city: 'New York', state: 'New York' }), master })
  assert.equal(regradeFromKeptContacts(ny.db, 'u1', ny.jobId), 0); assert.equal(leadRow(ny.db).action, 4)
  const mixed = seed({ domain: null })
  recordContactRejection(mixed.db, 'u1', 'lead1', { connector: 'enrich:pdl', reason: 'contact rejected: location mismatch Pico Rivera, CA vs New York, NY', sourceUrl: 'https://x.example/' })
  mixed.db.prepare("INSERT INTO lead_enrichments (id, lead_id, tenant_id, connector, kind, value, label, confidence, source_url, source_date, retrieved_at) VALUES ('E1', 'lead1', 'u1', 'enrich:pdl', 'contact', 'Maya Chen - Practice Manager', 'PDL', 70, 'https://x.example/', '2026-10-28', 1)").run()
  assert.equal(regradeFromKeptContacts(mixed.db, 'u1', mixed.jobId), 0, 'a contact that agreed was kept'); assert.equal(leadRow(mixed.db).action, 4)
  const low = seed({ domain: null }); low.db.prepare("UPDATE leads SET action = 1 WHERE id = 'lead1'").run()
  recordContactRejection(low.db, 'u1', 'lead1', { connector: 'sitecrawl', reason: 'contact rejected: location mismatch Rome, NY vs New York, NY', sourceUrl: 'https://x.example/' })
  assert.equal(regradeFromKeptContacts(low.db, 'u1', low.jobId), 0); assert.equal(leadRow(low.db).action, 1, 'never raised')
  const other = seed({ domain: null }); recordContactRejection(other.db, 'u1', 'lead1', { connector: 'sitecrawl', reason: 'contact rejected: location mismatch Rome, NY vs New York, NY', sourceUrl: 'https://x.example/' })
  assert.equal(regradeFromKeptContacts(other.db, 'other-tenant', other.jobId), 0, 'tenant-scoped'); assert.equal(leadRow(other.db).action, 4)
})

test('PDL: a person’s own NYC residence is NOT the company’s location: no employer location and no domain match = not attached (employer location only)', async () => {
  const { db, jobId, lead } = seed({ domain: null })
  saveCredential(db, 'u1', 'enrich:pdl', 'test-pdl-key-5678', master)
  const fetchImpl = (async () => ok({ data: [
    // works for a same-name company with NO employer location, but LIVES in New York
    { full_name: 'Carlos Vega', job_title: 'Office Manager', linkedin_url: 'https://linkedin.com/in/cv', location_locality: 'new york', location_region: 'new york', location_country: 'united states' },
    // employer is in Pico Rivera although the person lives in New York
    { full_name: 'Dana Ortiz', job_title: 'Dentist', location_locality: 'new york', location_region: 'new york', job_company_location_locality: 'pico rivera', job_company_location_region: 'california', job_company_location_country: 'united states' },
    // control: the EMPLOYER is in New York
    { full_name: 'Maya Chen', job_title: 'Practice Manager', job_company_location_locality: 'new york', job_company_location_region: 'new york', job_company_location_country: 'united states' },
  ] })) as never
  await enrichLeadContacts(db, 'u1', jobId, [lead], { fetchImpl, master })
  assert.deepEqual(rows(db), ['contact:Maya Chen - Practice Manager'], 'only the person whose EMPLOYER is in New York')
  const a = audits(db)
  assert.ok(a.some(x => /no domain or location/.test(x)), JSON.stringify(a)); assert.ok(a.some(x => /location mismatch Pico Rivera, CA vs New York, NY/.test(x)), JSON.stringify(a))
  assert.equal(await pdlPlaceOf({ full_name: 'x', location_locality: 'new york', location_region: 'new york' }), null, 'residence alone yields no place')
})
// the mapper's own view, exercised through the real pdlPeopleSearch
async function pdlPlaceOf(rec: Record<string, unknown>) {
  const { pdlPeopleSearch } = await import('../lib/enrich/pdl.ts')
  const people = await pdlPeopleSearch('k', 'Acme', (async () => ok({ data: [rec] })) as never)
  return people[0]?.place ?? null
}

test('Apollo: a returned person whose ORGANIZATION contradicts the requested company (other name or other domain) is not attached; matching or unstated organizations are', async () => {
  const lead = (domain: string | null) => seed({ domain })
  const people = [
    { name: 'Eve Other', title: 'CEO', linkedin_url: 'https://linkedin.com/in/eo', organization: { name: 'Acme Robotics', primary_domain: 'acmerobotics.com' } },
    { name: 'Dom Wrong', title: 'Manager', linkedin_url: 'https://linkedin.com/in/dw', organization: { name: 'Smile Avenue Dental', primary_domain: 'smileavenue-dental.io' } },
    { name: 'Sophia Rozov', title: 'Practice Manager', linkedin_url: 'https://linkedin.com/in/sr', organization: { name: 'Smile Avenue Dental Group', primary_domain: 'smileavenuedental.com' } },
    { name: 'No Org', title: 'Dentist', linkedin_url: 'https://linkedin.com/in/no' },
  ]
  const s = lead('smileavenuedental.com'); saveCredential(s.db, 'u1', 'enrich:apollo', 'test-apollo-key-1234', master)
  await enrichLeadContacts(s.db, 'u1', s.jobId, [s.lead], { fetchImpl: apollo({ name: 'Smile Avenue Dental', estimated_num_employees: 12, website_url: 'https://smileavenuedental.com' }, people), master })
  assert.deepEqual(rows(s.db).filter(r => r.startsWith('contact:')).sort(), ['contact:Sophia Rozov - Practice Manager'])   // #383: 'No Org - Dentist' is no longer attached - a Dentist is not the reviewed 'Practice manager' buyer role
  const a = audits(s.db)
  assert.ok(a.some(x => /^contact rejected: organization mismatch Acme Robotics vs Smile Avenue Dental$|^contact rejected: organization mismatch acmerobotics\.com vs smileavenuedental\.com$/.test(x)), JSON.stringify(a))
  assert.ok(a.some(x => /organization mismatch smileavenue-dental\.io vs smileavenuedental\.com/.test(x)), JSON.stringify(a))
  assert.ok(!rows(s.db).some(r => /Eve Other|Dom Wrong/.test(r)))
  // a refused person is recorded as a reason on the lead, never as a contact
  assert.ok((enrichmentsForLeads(s.db, 'u1', ['lead1']).lead1 ?? []).some(e => e.kind === 'contact_rejected' && /organization mismatch/.test(e.value)))
})
