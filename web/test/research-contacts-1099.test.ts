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
import { saveResearchContacts, isTheirs } from '../lib/research/contacts.ts'
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

test('an address is the named person\'s only when its local part is one of their name formats as a whole (council review)', () => {
  for (const [email, person] of [['jane.doe@x.example', 'Jane Doe'], ['jdoe@x.example', 'Jane Doe'], ['j.doe@x.example', 'Jane Doe'], ['janedoe@x.example', 'Jane Doe'], ['doe.jane@x.example', 'Jane Doe']])
    assert.equal(isTheirs(email, person), true, email)
  for (const [email, person] of [['hello@x.example', 'Hannah Lo'], ['fleet@x.example', 'Fred Lee'], ['sales@x.example', 'Sara Le'], ['william@x.example', 'Wei Li'], ['marketing@x.example', 'Mia Ma'], ['jane@x.example', 'Jane Doe'], ['doe@x.example', 'Jane Doe'], ['smithson@x.example', 'Sam Smith']])
    assert.equal(isTheirs(email, person), false, email)
})

test('guesses off (the default): no DNS lookup and no guess; one MX lookup per domain when on; the parent domain counts as the site\'s', async () => {
  const learn = (db: Database.Database) => db.prepare("INSERT INTO email_candidates (tenant_id, lead_id, person, address, format, tier, source_url, country_basis) VALUES ('u1', 'other-lead', 'John Smith', 'john.smith@kestreldental.example', 'first.last', 'published', ?, 'US')").run(`${SITE}/team`)
  const a = seed(); learn(a.db); let asked = 0
  const ra = await saveResearchContacts(a.db, a.jobId, [lead([])], { mx: async () => { asked++; return true }, env: {} })
  assert.equal(asked, 0); assert.equal(ra.guessed, 0); assert.deepEqual(guesses(a.db), [])
  // two leads on the same site: one lookup
  const b = seed(); learn(b.db)
  b.db.prepare("INSERT INTO leads (id, scan_job_id, name, company, company_domain, signal, source_url, fit, intent, action, why) VALUES ('lead2', ?, 'Jane Doe', 'Kestrel Dental', 'kestreldental.example', 'hired', ?, 4, 3, 4, 'x')").run(b.jobId, SRC + '-2')
  const second = { ...lead([]), event: { ...lead([]).event, sourceUrl: SRC + '-2' } }
  let n = 0
  await saveResearchContacts(b.db, b.jobId, [lead([]), second], { mx: async () => { n++; return true }, env: ON })
  assert.equal(n, 1)
  // a site on a hosting platform's subdomain never takes the platform's address (council round 2)
  const c = seed()
  const sub = { ...lead([{ email: 'hello@webflow.example', url: 'https://kestrel.webflow.example/contact' }, { email: 'info@kestrel.webflow.example', url: 'https://kestrel.webflow.example/contact' }]) }
  sub.company = { ...sub.company, site: 'https://kestrel.webflow.example' }
  await saveResearchContacts(c.db, c.jobId, [sub], { mx: async () => true, env: {} })
  assert.deepEqual(emailRows(c.db).map(r => r[0]), ['info@kestrel.webflow.example'])
  // the MX budget spent: no lookup, no guess, counted apart from "takes no mail"
  const d = seed(); learn(d.db); let calls = 0
  const rd = await saveResearchContacts(d.db, d.jobId, [lead([])], { mx: async () => { calls++; return true }, mxBudgetMs: -1, env: ON })
  assert.deepEqual([calls, rd.mx_skipped, rd.no_mx, rd.guessed], [0, 1, 0, 0])
})
