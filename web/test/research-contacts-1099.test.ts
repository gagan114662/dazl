// Refs #1099: the research engine's contacts without a paid vendor (lib/research/contacts.ts). Company research found addresses printed on the
// company's own pages; they used to be dropped (the lead was saved with contact: null). Now each is saved on the lead with its page, and the
// named person without an address of their own gets ONE pattern guess from the workspace's confirmed formats, only for a domain with a mail
// server, stored apart as "guessed, unverified" (never counted as an email). Invented companies; MX lookup injected; no network.
import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { migrateAllSqlite } from '../lib/db/sqlite-migrations.ts'
import { createJob } from '../lib/scan/store.ts'
import { enrichmentsForLeads } from '../lib/connectors/store.ts'
import { saveResearchContacts } from '../lib/research/contacts.ts'
import type { VerifiedLead } from '../lib/research/types.ts'

const SITE = 'https://kestreldental.example'
const SRC = 'https://news.example/kestrel-second-office'
const ON = { EMAIL_GUESS_ENABLED: '1' }

function seed() {
  const db = new Database(':memory:'); migrateAllSqlite(db)
  const jobId = createJob(db, 'u1', { business_name: 'B', industry: 'I', location: 'L' })
  db.prepare("UPDATE scan_jobs SET status = 'running' WHERE id = ?").run(jobId)
  db.prepare("INSERT INTO leads (id, scan_job_id, name, company, company_domain, signal, source_url, fit, intent, action, why) VALUES ('lead1', ?, 'Jane Doe', 'Kestrel Dental', 'kestreldental.example', 'opened a second office', ?, 4, 3, 4, 'x')").run(jobId, SRC)
  return { db, jobId }
}
function lead(emails: { email: string; url: string }[], personOk = true): VerifiedLead {
  return {
    event: { company: 'Kestrel Dental', website: SITE, pageIsCompanySite: false, triggerId: 't1', whatHappened: 'opened a second office', whyNow: 'x', quote: 'q', eventDate: null, dateQuote: null, locationQuote: null, people: [], sourceUrl: SRC, indexDate: null, foundBy: 'q' },
    company: { site: SITE, sources: [], person: { name: 'Jane Doe', title: 'Owner', sourceId: 's1', quote: 'Jane Doe, owner of Kestrel Dental', profileUrl: null, from: 'research' }, location: null, whatTheyDo: null, emails },
    verification: { personOk } as VerifiedLead['verification'],
  }
}
const emailRows = (db: Database.Database) => (enrichmentsForLeads(db, 'u1', ['lead1']).lead1 ?? []).filter(e => e.kind === 'email').map(e => [e.value, e.label, e.source_url])
const guesses = (db: Database.Database) => db.prepare("SELECT address, tier FROM email_candidates WHERE lead_id = 'lead1' AND tier = 'guessed'").all() as { address: string; tier: string }[]

test('published addresses are saved on the lead with the page they were printed on; another domain is not', async () => {
  const { db, jobId } = seed()
  const r = await saveResearchContacts(db, jobId, [lead([
    { email: 'jane.doe@kestreldental.example', url: `${SITE}/team` },
    { email: 'info@kestreldental.example', url: `${SITE}/contact` },
    { email: 'press@agency.example', url: `${SITE}/press` },
  ])], { mx: async () => { throw new Error('no MX lookup needed: Jane has her own address') }, env: ON })
  assert.deepEqual(emailRows(db), [
    ['jane.doe@kestreldental.example', 'published: Jane Doe, printed on the company website', `${SITE}/team`],
    ['info@kestreldental.example', 'published: printed on the company website', `${SITE}/contact`],
  ])
  assert.equal(r.published, 2); assert.equal(r.guessed, 0)
  assert.deepEqual(guesses(db), [], 'her own address is published: no guess')
})

test('the named person with no address of their own: one unverified guess from the confirmed format, only when the domain takes mail', async () => {
  const learn = (db: Database.Database) => db.prepare("INSERT INTO email_candidates (tenant_id, lead_id, person, address, format, tier, source_url, country_basis) VALUES ('u1', 'other-lead', 'John Smith', 'john.smith@kestreldental.example', 'first.last', 'published', ?, 'US')").run(`${SITE}/team`)
  // no mail server: no guess
  const a = seed(); learn(a.db)
  const ra = await saveResearchContacts(a.db, a.jobId, [lead([{ email: 'info@kestreldental.example', url: `${SITE}/contact` }])], { mx: async () => false, env: ON })
  assert.equal(ra.no_mx, 1); assert.deepEqual(guesses(a.db), [])
  // a mail server: the guess, stored apart and never an 'email' row
  const b = seed(); learn(b.db)
  const rb = await saveResearchContacts(b.db, b.jobId, [lead([{ email: 'info@kestreldental.example', url: `${SITE}/contact` }])], { mx: async d => d === 'kestreldental.example', env: ON })
  assert.equal(rb.guessed, 1)
  assert.deepEqual(guesses(b.db), [{ address: 'jane.doe@kestreldental.example', tier: 'guessed' }])
  assert.ok(!emailRows(b.db).some(([v]) => v === 'jane.doe@kestreldental.example'), 'a guess is never saved as an email on the lead')
  // no confirmed format in the workspace: nothing is invented
  const c = seed()
  const rc = await saveResearchContacts(c.db, c.jobId, [lead([])], { mx: async () => true, env: ON })
  assert.equal(rc.guessed, 0); assert.deepEqual(guesses(c.db), [])
})

test('a person the verifier did not confirm gets no guess', async () => {
  const { db, jobId } = seed()
  db.prepare("INSERT INTO email_candidates (tenant_id, lead_id, person, address, format, tier, source_url, country_basis) VALUES ('u1', 'other-lead', 'John Smith', 'john.smith@kestreldental.example', 'first.last', 'published', ?, 'US')").run(`${SITE}/team`)
  const r = await saveResearchContacts(db, jobId, [lead([], false)], { mx: async () => true, env: ON })
  assert.equal(r.guessed, 0); assert.deepEqual(guesses(db), [])
})
