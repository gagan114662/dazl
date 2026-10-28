// A contact / company record found by enrichment attaches to a lead only when it AGREES with the lead on the company domain or on the
// place (city level for New York City / London, reusing placeAgreement). The same-name Pico Rivera, CA practice must not attach to a New
// York lead. Stubbed Apollo / PDL responses and invented companies; no network, no credits, no keys beyond test fixtures.
import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { randomBytes } from 'node:crypto'
import { enrichLeadContacts } from '../lib/enrich/index.ts'
import { contactAgreement, formatPlace, leadPlaceLabel, firstPlaceLabel } from '../lib/scan/contact-agreement.ts'
import { migrateScan, createJob } from '../lib/scan/store.ts'
import { migrateConnectors, saveCredential, recentAudit, enrichmentsForLeads } from '../lib/connectors/store.ts'

const master = randomBytes(32)
const ok = (b: unknown) => new Response(JSON.stringify(b), { status: 200 })
const NYC_ICP = JSON.stringify({ summary: 'NYC dental', where: ['New York City'], who: ['Practice manager'], signals: [] })

function seed(opts: { domain: string | null; icp?: string | null }) {
  const db = new Database(':memory:'); migrateScan(db); migrateConnectors(db)
  const jobId = createJob(db, 'u1', { business_name: 'B', industry: 'I', location: 'L' })
  db.prepare("UPDATE scan_jobs SET status = 'running', icp = ? WHERE id = ?").run(opts.icp === undefined ? NYC_ICP : opts.icp, jobId)
  db.prepare("INSERT INTO leads (id, scan_job_id, name, company, company_domain, signal, source_url) VALUES ('lead1', ?, '', 'Smile Avenue Dental', ?, 'opened a new practice', 'https://x.example/1')").run(jobId, opts.domain)
  return { db, jobId, lead: { id: 'lead1', company: 'Smile Avenue Dental', company_domain: opts.domain } }
}
const apollo = (org: Record<string, unknown> | null, people: Record<string, unknown>[] = [{ name: 'Sophia Rozov', title: 'Practice Manager', linkedin_url: 'https://linkedin.com/in/sr' }]) => (async (url: RequestInfo | URL) => {
  const u = String(url)
  if (u.includes('organizations/enrich')) return ok(org ? { organization: org } : {})
  if (u.includes('mixed_people')) return ok({ people })
  return new Response('no', { status: 404 })
}) as never
const rows = (db: Database.Database) => (enrichmentsForLeads(db, 'u1', ['lead1']).lead1 ?? []).map(e => `${e.kind}:${e.value}`)
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
