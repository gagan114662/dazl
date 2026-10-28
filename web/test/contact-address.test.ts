// A contact / company record found by NAME attaches only when it agrees with the lead on at least one of: domain, city/state, or street address taken from the lead's OWN
// evidence. When they conflict it is not attached: it stays unresolved with the reason recorded. Two same-name businesses in different cities: the NYC lead gets the New York
// one and never the Pico Rivera, CA one. Stubbed Apollo / PDL responses, invented companies: no network, no credits.
import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { randomBytes } from 'node:crypto'
import { enrichLeadContacts } from '../lib/enrich/index.ts'
import { contactAgreement, streetKeys, addressAgreement, contactRejectionCode } from '../lib/scan/contact-agreement.ts'
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
  assert.deepEqual(contactAgreement({ company_domain: 'smileavenue.com', where: W, evidence: EVIDENCE }, { domain: 'www.smileavenue.com', address: '8500 Whittier Blvd' }), { ok: true, via: 'domain' }, 'the lead’s own domain agrees')
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
  assert.deepEqual(rows('right').map(r => [r.kind, r.value]), [['email', 'hello@smileavenuedental.com']], 'the practice at the lead’s own address attaches')
  assert.equal((db.prepare("SELECT company_domain FROM leads WHERE id = 'wrong'").get() as { company_domain: string | null }).company_domain, null, 'the wrong site is never recorded as the lead’s domain')
  assert.equal((db.prepare("SELECT company_domain FROM leads WHERE id = 'right'").get() as { company_domain: string | null }).company_domain, 'smileavenuedental.com')
  assert.ok((db.prepare("SELECT status FROM connector_audit").all() as { status: string }[]).some(a => /address mismatch/.test(a.status)))
})
