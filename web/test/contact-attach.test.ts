// Before ANY contact or company record is attached to a lead it must agree with the lead on the company domain or on the city / state; on disagreement it is not
// attached, a `contact_*` marker is recorded on the lead with the reason, and the other sources are still looked at. A same-name business in another state is the
// case that failed live (a Pico Rivera, CA practice attached to a New York lead). Stubbed Apollo / PDL responses and invented companies: no network, no credits.
import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { randomBytes } from 'node:crypto'
import { enrichCommenters, migrateCommenterImport } from '../lib/scan/commenter-import.ts'
import { contactAgreement, contactRejectionCode, recordContactRejection } from '../lib/scan/contact-agreement.ts'
import { migrateScan, createJob } from '../lib/scan/store.ts'
import { migrateConnectors, saveCredential, enrichmentsForLeads } from '../lib/connectors/store.ts'

const master = randomBytes(32)
const ok = (b: unknown) => new Response(JSON.stringify(b), { status: 200 })

test('markers: every refusal carries a structured contact_* code beside its reason', () => {
  assert.equal(contactRejectionCode('contact rejected: location mismatch Pico Rivera, CA vs New York, NY'), 'contact_location_mismatch')
  assert.equal(contactRejectionCode('contact rejected: location unconfirmed United States vs New York, NY'), 'contact_location_unconfirmed')
  assert.equal(contactRejectionCode('contact rejected: domain mismatch acme.io vs acme.com'), 'contact_domain_mismatch')
  assert.equal(contactRejectionCode('contact rejected: organization mismatch other.com vs acme.com'), 'contact_domain_mismatch')
  assert.equal(contactRejectionCode('contact rejected: no domain or location to confirm the company'), 'contact_unconfirmed')
  const db = new Database(':memory:'); migrateScan(db); migrateConnectors(db)
  const job = createJob(db, 'u1', { business_name: 'B', industry: 'I', location: 'L' }); db.prepare("UPDATE scan_jobs SET status = 'running' WHERE id = ?").run(job)
  db.prepare("INSERT INTO leads (id, scan_job_id, name, company, signal, source_url) VALUES ('l1', ?, '', 'Smile Avenue Dental', 's', 'https://x.example/1')").run(job)
  recordContactRejection(db, 'u1', 'l1', { connector: 'sitecrawl', reason: 'contact rejected: location mismatch Pico Rivera, CA vs New York, NY', sourceUrl: 'https://smileavenue.example/' })
  const r = (enrichmentsForLeads(db, 'u1', ['l1']).l1 ?? [])[0]
  assert.deepEqual([r.kind, r.label, r.value], ['contact_rejected', 'contact_location_mismatch', 'contact rejected: location mismatch Pico Rivera, CA vs New York, NY'])
})

test('agreement: same-name business in another state rejected; the lead’s domain or the same city accepted', () => {
  const W = ['New York City']
  assert.equal(contactAgreement({ where: W }, { place: 'Pico Rivera, CA' }).ok, false)
  assert.equal(contactAgreement({ company_domain: 'smileavenue.com', where: W }, { domain: 'smileavenue-pr.com', place: 'New York, NY' }).ok, false, 'a different domain overrides a matching city')
  assert.equal(contactAgreement({ company_domain: 'smileavenue.com', where: W, domainEstablished: true }, { domain: 'www.smileavenue.com', place: 'Pico Rivera, CA' }).ok, true, 'the same ESTABLISHED domain')
  assert.equal(contactAgreement({ company_domain: 'smileavenue.com', where: W }, { domain: 'www.smileavenue.com', place: 'Pico Rivera, CA' }).ok, false, 'a guessed domain does not excuse an explicit other-state place')
  assert.equal(contactAgreement({ company_domain: 'smileavenue.com', where: W }, { domain: 'www.smileavenue.com', place: 'New York, NY' }).ok, true, 'the same domain and a consistent place')
  assert.equal(contactAgreement({ where: W }, { place: 'Brooklyn, NY' }).ok, true, 'the same city')
})

// ---- the commenter-import enrichment attached whatever Apollo / PDL returned for the company NAME ----
function importDb(domain: string | null) {
  const db = new Database(':memory:'); migrateScan(db); migrateConnectors(db); migrateCommenterImport(db)
  const job = createJob(db, 'A', { business_name: 'B', industry: 'I', location: 'L' })
  db.prepare("UPDATE scan_jobs SET status = 'running' WHERE id = ?").run(job)
  db.prepare("INSERT INTO leads (id, scan_job_id, name, company, company_domain, signal, source_url) VALUES ('l1', ?, 'Jane Doe - VP Sales', 'Smile Avenue Dental', ?, 'commented', 'https://www.linkedin.com/in/jane-doe')").run(job, domain)
  db.prepare("UPDATE scan_jobs SET status = 'done' WHERE id = ?").run(job)
  db.prepare("INSERT INTO commenter_batches (id, user_id, job_id, context, total) VALUES ('b1', 'A', ?, 'commented on my post', 1)").run(job)
  return db
}
const apollo = (org: Record<string, unknown> | null, people: Record<string, unknown>[]) => (async (url: RequestInfo | URL) => {
  const u = String(url)
  if (u.includes('organizations/enrich')) return ok(org ? { organization: org } : {})
  if (u.includes('mixed_people')) return ok({ people })
  return new Response('no', { status: 404 })
}) as never
const attached = (db: Database.Database) => (enrichmentsForLeads(db, 'A', ['l1']).l1 ?? []).filter(e => e.kind !== 'contact_rejected').map(e => `${e.kind}:${e.value}`)
const refused = (db: Database.Database) => (enrichmentsForLeads(db, 'A', ['l1']).l1 ?? []).filter(e => e.kind === 'contact_rejected').map(e => e.label)
const PICO = { name: 'Smile Avenue Dental Group', estimated_num_employees: 12, industry: 'Dental', website_url: 'https://smileavenue-pr.com', city: 'Pico Rivera', state: 'California' }
const P = [{ name: 'Sophia Rozov', title: 'Practice Manager', linkedin_url: 'https://linkedin.com/in/sr' }]

test('commenter import / Apollo: a same-name company on another domain attaches nothing and is marked; the lead’s own domain attaches', async () => {
  const wrong = importDb('smileavenue.com'); saveCredential(wrong, 'A', 'enrich:apollo', 'test-apollo-key-1234', master)
  await enrichCommenters(wrong, 'A', 'b1', { fetchImpl: apollo(PICO, [{ ...P[0], organization: { name: 'Smile Avenue Dental Group', website_url: 'https://smileavenue-pr.com' } }]), master })
  assert.deepEqual(attached(wrong), [], 'no firmographic and no contact from the same-name company'); assert.ok(refused(wrong).includes('contact_domain_mismatch'), JSON.stringify(refused(wrong)))
  const right = importDb('smileavenue.com'); saveCredential(right, 'A', 'enrich:apollo', 'test-apollo-key-1234', master)
  await enrichCommenters(right, 'A', 'b1', { fetchImpl: apollo({ ...PICO, website_url: 'https://www.smileavenue.com', city: 'New York', state: 'New York' }, P), master })
  assert.deepEqual(attached(right).map(x => x.split(':')[0]).sort(), ['contact', 'firmographic'])
  const none = importDb(null); saveCredential(none, 'A', 'enrich:apollo', 'test-apollo-key-1234', master)
  await enrichCommenters(none, 'A', 'b1', { fetchImpl: apollo(null, P), master })
  assert.deepEqual(attached(none), [], 'no domain at all: nothing confirms the company'); assert.ok(refused(none).includes('contact_unconfirmed'))
})

test('commenter import / PDL: only a person whose employer domain equals the lead’s attaches; other-domain and no-domain people are refused and marked', async () => {
  const pdl = (people: Record<string, unknown>[]) => (async () => ok({ data: people })) as never
  const person = (name: string, domain: string | null) => ({ full_name: name, job_title: 'Practice Manager', job_company_name: 'Smile Avenue Dental', job_company_website: domain, job_company_location_locality: 'pico rivera', job_company_location_region: 'california', linkedin_url: `https://www.linkedin.com/in/${name.toLowerCase().replace(/ /g, '-')}` })
  const db = importDb('smileavenue.com'); saveCredential(db, 'A', 'enrich:pdl', 'test-pdl-key-1234', master)
  await enrichCommenters(db, 'A', 'b1', { fetchImpl: pdl([person('Match Person', 'smileavenue.com'), person('Wrong Person', 'smileavenue-pr.com'), person('Blank Person', null)]), master })
  const got = attached(db); assert.equal(got.length, 1, JSON.stringify(got)); assert.match(got[0], /Match Person/)
  assert.deepEqual([...new Set(refused(db))].sort(), ['contact_domain_mismatch', 'contact_unconfirmed'].sort())
  const nodom = importDb(null); saveCredential(nodom, 'A', 'enrich:pdl', 'test-pdl-key-1234', master)
  await enrichCommenters(nodom, 'A', 'b1', { fetchImpl: pdl([person('Match Person', 'smileavenue.com')]), master })
  assert.deepEqual(attached(nodom), [], 'a lead with no domain and no geography cannot be confirmed by a name match')
})

// ---- the score follows the evidence kept ----
test('score recompute: a contact refused by the agreement checks stops contributing — the lead is regraded to what is actually reachable; a kept contact keeps its grade; idempotent', async () => {
  const grade = (db: Database.Database) => db.prepare("SELECT fit, intent, action, why FROM leads WHERE id = 'l1'").get() as { fit: number; intent: number; action: number; why: string }
  const withGrades = (domain: string | null) => { const db = importDb(domain); db.prepare("UPDATE leads SET fit = 4, intent = 3, action = 4, why = 'Dental group, reachable VP.' WHERE id = 'l1'").run(); return db }
  // Pico Rivera same-name company: every contact refused -> action capped at 2 with the reason, fit and intent untouched
  const wrong = withGrades('smileavenue.com'); saveCredential(wrong, 'A', 'enrich:apollo', 'test-apollo-key-1234', master)
  await enrichCommenters(wrong, 'A', 'b1', { fetchImpl: apollo(PICO, [{ ...P[0], organization: { name: 'Smile Avenue Dental Group', website_url: 'https://smileavenue-pr.com' } }]), master })
  let g = grade(wrong); assert.deepEqual([g.fit, g.intent, g.action], [4, 3, 2]); assert.match(g.why, /^Contact unconfirmed: domain mismatch smileavenue-pr\.com vs smileavenue\.com\. Dental group/)
  await enrichCommenters(wrong, 'A', 'b1', { fetchImpl: apollo(PICO, []), master }); assert.equal(grade(wrong).why.match(/Contact unconfirmed/g)!.length, 1, 'idempotent')
  // control: the lead's own domain keeps a contact -> grade unchanged
  const right = withGrades('smileavenue.com'); saveCredential(right, 'A', 'enrich:apollo', 'test-apollo-key-1234', master)
  await enrichCommenters(right, 'A', 'b1', { fetchImpl: apollo({ ...PICO, website_url: 'https://www.smileavenue.com', city: 'New York', state: 'New York' }, P), master })
  g = grade(right); assert.deepEqual([g.fit, g.intent, g.action], [4, 3, 4]); assert.doesNotMatch(g.why, /Contact unconfirmed/)
  // no domain: nothing confirms the company, nothing is kept -> capped
  const none = withGrades(null); saveCredential(none, 'A', 'enrich:apollo', 'test-apollo-key-1234', master)
  await enrichCommenters(none, 'A', 'b1', { fetchImpl: apollo(null, P), master })
  assert.equal(grade(none).action, 2)
})

// ---- Instinct review of 86e49bd: a name-only company match must never supply the lead's identity ----
test('a no-domain NYC lead + Apollo returns a plausible same-name company in Pico Rivera CA with a website and a person -> nothing attached, marked unconfirmed (fails on 86e49bd)', async () => {
  const db = importDb(null); db.prepare("UPDATE leads SET fit = 4, intent = 3, action = 4, why = 'NYC dental group.' WHERE id = 'l1'").run()
  saveCredential(db, 'A', 'enrich:apollo', 'test-apollo-key-1234', master)
  const searched: string[] = []
  const f = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const u = String(url)
    if (u.includes('organizations/enrich')) return ok({ organization: PICO })
    if (u.includes('mixed_people')) { searched.push(String(init?.body ?? '')); return ok({ people: [{ ...P[0], organization: { name: 'Smile Avenue Dental Group', website_url: 'https://smileavenue-pr.com' } }] }) }
    return new Response('no', { status: 404 })
  }) as never
  await enrichCommenters(db, 'A', 'b1', { fetchImpl: f, master })
  assert.deepEqual(attached(db), [], 'no contact and no firmographic from the same-name company'); assert.ok(refused(db).includes('contact_unconfirmed'), JSON.stringify(refused(db)))
  assert.deepEqual(searched, [], 'the same-name company’s website never keyed a people search')
  assert.equal((db.prepare("SELECT company_domain FROM leads WHERE id = 'l1'").get() as { company_domain: string | null }).company_domain, null, 'the lead’s identity was not set from the name match')
  const g = db.prepare("SELECT fit, intent, action, why FROM leads WHERE id = 'l1'").get() as { fit: number; intent: number; action: number; why: string }
  assert.deepEqual([g.fit, g.intent, g.action], [4, 3, 2]); assert.match(g.why, /^Contact unconfirmed: no domain to confirm the company\./)
})
