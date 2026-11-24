// Owner decision 2026-11-24 (#1250 contact gate; DECISIONS 2026-10-26): a lead of the discovery lane that names a person and has a
// website but no address of that person's own gets a guessed address, kept ONLY when a mailbox check says the mailbox exists, and only
// for a company whose own homepage states a US address. These tests call the real step (lib/people/email-pattern.ts guessDiscoverEmails)
// and the real lane (lib/scan/runner.ts) on an in-memory database, with a stub verifier and a stub homepage read: invented companies,
// no network, no key, no check made anywhere.
import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { randomBytes } from 'node:crypto'
import { migrateAllSqlite } from '../lib/db/sqlite-migrations.ts'
import { sqliteDb } from '../lib/db/client.ts'
import { addEnrichment } from '../lib/connectors/store.ts'
import { guessDiscoverEmails, usOnlyEvidence, type MailboxVerifier, type VerifyAnswer } from '../lib/people/email-pattern.ts'
import { canadianProvinceMentions, countryMentions } from '../lib/scan/countries.ts'
import { nonUsCityMentions } from '../lib/scan/place-agreement.ts'
import { VerifierError } from '../lib/people/zerobounce.ts'
import { discoverContact, discoverSources, discoverState, GUESSED_VERIFIED_LABEL, GUESSED_VERIFIED_SHORT } from '../lib/discover/card.ts'
import { discoverJobCounts, discoverStatesFromRows, discoverStoredSql, type DiscoverLeadRow, type DiscoverStoredRow } from '../lib/discover/state-db.ts'
import { discoverExportFields } from '../lib/discover/export.ts'
import { leadCardSummary } from '../lib/scan/lead-card.ts'
import { createDraft, OutreachError } from '../lib/outreach/service.ts'
import { saveKey } from '../lib/llm/key-store.ts'
import { createQueryJob, listLeads } from '../lib/scan/store.ts'
import { claimKeyedJob, runJob } from '../lib/scan/runner.ts'
import type { DiscoverResult, DiscoveredLead } from '../lib/discover/agent.ts'

// the paid switch falls back to the process's own setting when a call's env does not name it: these tests decide it themselves
delete process.env.DAZL_PAID_VENDORS

const ON = { EMAIL_GUESS_ENABLED: '1', DAZL_PAID_VENDORS: 'zerobounce', EMAIL_VERIFY_DAILY_CAP: '20' }
const SITE = 'northwind-dental.example'
const HOME = `https://${SITE}/`
const US_HOME = 'Northwind Dental. Visit us at 500 Congress Ave, Austin, TX 78701. Call for an appointment.'
const RECENT = new Date(Date.now() - 20 * 86_400_000).toISOString().slice(0, 10)
const WHERE = ['Dental clinics in Austin opening a new location']

type Outcome = VerifyAnswer['outcome']
// A verifier that answers from a table (anything not listed: no such mailbox) and records every address it was asked about.
function stubVerifier(answers: Record<string, Outcome | Error>, asked: string[]): MailboxVerifier {
  return { name: 'stub-verifier', async verify(address: string) { asked.push(address); const a = answers[address] ?? 'undeliverable'; if (a instanceof Error) throw a; return { outcome: a } } }
}
// dazl's own read of a homepage, from a table; an address not in it cannot be read
function stubHome(pages: Record<string, string>, read: string[] = []) {
  return async (url: string) => { read.push(url); return pages[url] ?? null }
}
function setup() {
  const db = new Database(':memory:')
  migrateAllSqlite(db)
  db.prepare("INSERT INTO scan_jobs (id, user_id, business_name, industry, location, status, query, seller) VALUES ('j1', 'T', 'b', 'i', 'l', 'running', 'Dental clinics in Austin opening a new location', 'Clinic fit-out contractor')").run()   // 'running': the store only takes a lead while its search runs
  return db
}
let seq = 0
function addLead(db: Database.Database, o: { person?: string | null; domain?: string | null; company?: string; email?: { value: string; source_url: string } | null; review?: boolean; job?: string } = {}): string {
  const id = `lead${String(++seq).padStart(4, '0')}`
  const person = o.person === undefined ? 'Dana Ruiz, Practice Owner' : o.person
  db.prepare(`INSERT INTO leads (id, scan_job_id, name, company, signal, source_url, score, evidence_excerpt, event_date, date_status, confidence, fit, intent, why, source_kind, company_domain, review_reason)
    VALUES (?, ?, ?, ?, 'Opening a second clinic', ?, 85, 'will open its second clinic', ?, 'verified', 85, 4, 4, 'expanding', 'discover', ?, ?)`)
    .run(id, o.job ?? 'j1', person ? person.split(', ')[0] : '', o.company ?? 'Northwind Dental', `https://news.example/${id}`, RECENT, o.domain === undefined ? SITE : o.domain, o.review ? 'source_review_required' : null)
  const now = Math.floor(Date.now() / 1000)
  if (person) addEnrichment(db, 'T', id, { connector: 'discover', kind: 'person', value: person, label: 'named on a public page', confidence: null, source_url: `https://${SITE}/team`, source_date: RECENT, retrieved_at: now })
  if (o.email) addEnrichment(db, 'T', id, { connector: 'discover', kind: 'email', value: o.email.value, label: 'published on a public page', confidence: null, source_url: o.email.source_url, source_date: RECENT, retrieved_at: now })
  return id
}
const emailRows = (db: Database.Database, leadId: string) => db.prepare("SELECT value, label, source_url, confidence FROM lead_enrichments WHERE tenant_id = 'T' AND lead_id = ? AND connector = 'discover' AND kind = 'email' ORDER BY value").all(leadId) as { value: string; label: string | null; source_url: string; confidence: number | null }[]
const stored = (db: Database.Database, leadId: string) => db.prepare("SELECT kind, connector, value, source_url, label FROM lead_enrichments WHERE tenant_id = 'T' AND lead_id = ? AND connector = 'discover' ORDER BY retrieved_at, id").all(leadId) as { kind: string; connector: string; value: string; source_url: string | null; label: string | null }[]
const usage = (db: Database.Database) => (db.prepare('SELECT COALESCE(SUM(n), 0) AS n FROM email_verify_usage').get() as { n: number }).n
const ledger = (db: Database.Database, leadId: string) => db.prepare('SELECT address, verification, verifier, tier, country_basis, source_url FROM email_candidates WHERE lead_id = ? ORDER BY checked_at, address').all(leadId) as { address: string; verification: string; verifier: string | null; tier: string; country_basis: string | null; source_url: string | null }[]
// the lead's one state, as the Leads header, Home and Campaigns read it: the stored rows through the shared query
function stateOf(db: Database.Database, leadId: string) {
  const rows = db.prepare("SELECT l.id, l.scan_job_id, l.review_reason, l.quarantined_at, l.name, l.company_domain, l.event_date, l.fit, l.intent, l.source_kind FROM leads l WHERE l.id = ?").all(leadId) as DiscoverLeadRow[]
  const kept = db.prepare(discoverStoredSql(1)).all('T', 'T', rows[0].scan_job_id) as DiscoverStoredRow[]
  return discoverStatesFromRows(rows, kept).get(rows[0].scan_job_id)?.get(leadId)
}

test('a US lead with a named person, a website and no email: the first format has no mailbox, the second does - two checks, one guessed row, ready by email', async () => {
  const db = setup(), asked: string[] = [], read: string[] = []
  const id = addLead(db)
  assert.equal(stateOf(db, id), 'no_contact', 'before: a named person nobody can reach')
  const run = await guessDiscoverEmails(db, 'T', 'j1', { env: ON, where: WHERE, readHome: stubHome({ [HOME]: US_HOME }, read), verifier: stubVerifier({ [`danaruiz@${SITE}`]: 'deliverable' }, asked) })
  assert.deepEqual(asked, [`dana.ruiz@${SITE}`, `danaruiz@${SITE}`], 'one address at a time, in the format order, stopping at the first mailbox that exists')
  assert.deepEqual(read, [HOME], 'the company\'s own homepage is read once, by dazl itself')
  assert.deepEqual(run, { leads: 1, checked: 2, verified: 1, skipped: null })
  assert.deepEqual(emailRows(db, id), [{ value: `danaruiz@${SITE}`, label: GUESSED_VERIFIED_LABEL, source_url: HOME, confidence: null }], 'exactly one row, labelled as what it is')
  assert.doesNotMatch(GUESSED_VERIFIED_LABEL, /published/)
  assert.equal(usage(db), 2, 'both checks are in the monthly ledger')
  assert.deepEqual(ledger(db, id).map(r => [r.address, r.verification, r.verifier, r.tier, r.source_url]), [[`dana.ruiz@${SITE}`, 'undeliverable', 'stub-verifier', 'guessed', HOME], [`danaruiz@${SITE}`, 'verified', 'stub-verifier', 'guessed', HOME]])
  assert.match(ledger(db, id)[0].country_basis ?? '', /Austin, TX 78701/, 'the US address read on the homepage is kept as the basis')
  // every reader says "guessed", none says "published"
  const lead = { source_kind: 'discover', name: 'Dana Ruiz', source_url: `https://news.example/${id}`, enrichments: stored(db, id) }
  assert.deepEqual(discoverContact(lead)?.email, { address: `danaruiz@${SITE}`, source: HOME, provenance: 'guessed_verified' })
  const source = discoverSources(lead).find(s => s.field === 'email')
  assert.equal(source?.url, HOME)
  assert.match(source?.label ?? '', /guessed, mailbox checked/)
  assert.match(source?.label ?? '', /not a page that prints the email/)
  assert.equal(stateOf(db, id), 'ready_email', 'contact-ready by email, exactly as a published address is')
  const card = leadCardSummary({ id, company: 'Northwind Dental', name: 'Dana Ruiz', signal: 'Opening a second clinic', source_url: `https://news.example/${id}`, evidence_excerpt: 'will open its second clinic', event_date: RECENT, date_status: 'verified', review_reason: null, fit: 4, intent: 4, why: 'expanding', icp_match: null, company_domain: SITE, contact: null, confidence: 85, source_kind: 'discover', enrichments: stored(db, id) } as never)
  assert.equal(card.contact, `Dana Ruiz, Practice Owner - danaruiz@${SITE} (${GUESSED_VERIFIED_SHORT})`, 'the card says guessed, mailbox checked')
  assert.doesNotMatch(card.contact ?? '', /published/)
  assert.deepEqual(card.approve, { ok: true })
  // the spreadsheet's Contact cell carries the same words
  const sheet = await discoverExportFields(sqliteDb(db), 'T', [{ lead_id: id, source_kind: 'discover', name: 'Dana Ruiz', contact: null }])
  assert.equal(sheet.get(id)?.contact, `danaruiz@${SITE} (${GUESSED_VERIFIED_SHORT})`)
  // the search's counts
  assert.deepEqual([(await discoverJobCounts(sqliteDb(db), 'T', 'j1'))?.ready_email, (await discoverJobCounts(sqliteDb(db), 'T', 'j1'))?.no_contact], [1, 0])
  // a second run asks nothing: the lead has its address
  const again = await guessDiscoverEmails(db, 'T', 'j1', { env: ON, where: WHERE, readHome: stubHome({ [HOME]: US_HOME }), verifier: stubVerifier({}, asked) })
  assert.equal(asked.length, 2); assert.equal(again.checked, 0)
})

test('a person can approve the guessed address, and the draft never says a page published it', async () => {
  process.env.DAZL_MASTER_KEY = randomBytes(32).toString('base64')
  const db = setup()
  const id = addLead(db)
  const other = addLead(db, { company: 'Elsewhere Dental' })
  const printed = addLead(db, { company: 'Printed Dental', email: { value: 'dana.ruiz@other-mail.example', source_url: `https://${SITE}/contact` } })
  db.prepare("UPDATE scan_jobs SET status = 'done' WHERE id = 'j1'").run()   // the search has finished
  const code = (fn: () => unknown) => { try { fn(); return 'created' } catch (e) { if (e instanceof OutreachError) return e.code; throw e } }
  assert.equal(code(() => createDraft(db, 'T', id, 'Fit-out Co', { manual: true })), 'no_email_contact', 'before the check: nothing to draft to')
  await guessDiscoverEmails(db, 'T', 'j1', { env: ON, where: WHERE, leadIds: [id], readHome: stubHome({ [HOME]: US_HOME }), verifier: stubVerifier({ [`dana.ruiz@${SITE}`]: 'deliverable' }, []) })
  assert.equal(code(() => createDraft(db, 'T', id, 'Fit-out Co', { manual: true })), 'created')
  const draft = db.prepare("SELECT to_email, body FROM outreach_messages WHERE tenant_id = 'T' AND lead_id = ?").get(id) as { to_email: string; body: string }
  assert.equal(draft.to_email, `dana.ruiz@${SITE}`)
  assert.doesNotMatch(draft.body, /published/i, 'no page prints the address, so the message does not say one does')
  assert.ok(!draft.body.includes(HOME), 'the homepage is not cited as where the address came from')
  assert.ok(draft.body.includes(`https://news.example/${id}`), 'it cites the page the signal was read on')
  // the same row at another company's domain is nobody's contact: only its own domain can place a guessed address (the homepage is not a page that prints it)
  addEnrichment(db, 'T', other, { connector: 'discover', kind: 'email', value: 'dana.ruiz@other-mail.example', label: GUESSED_VERIFIED_LABEL, confidence: null, source_url: HOME, source_date: RECENT, retrieved_at: 1 })
  assert.equal(code(() => createDraft(db, 'T', other, 'Fit-out Co', { manual: true })), 'domain_unconfirmed')
  assert.equal(stateOf(db, other), 'no_contact')
  // ...while a PUBLISHED address at another domain, printed on the company's own site, still counts as before
  assert.equal(stateOf(db, printed), 'ready_email')
  assert.equal(discoverContact({ source_kind: 'discover', name: 'Dana Ruiz', enrichments: stored(db, printed) })?.email?.provenance, 'published')
})

test('not in the United States, or country unknown: nothing is checked and nothing is stored', async () => {
  const cases: [string, Record<string, string>, string[]][] = [
    ['a Canadian address on the homepage', { [HOME]: 'Northwind Dental, 100 King St W, Toronto, ON M5X 1A9' }, WHERE],
    ['a Canadian address beside a US one', { [HOME]: `${US_HOME} Also at 100 King St W, Toronto, ON M5X 1A9` }, WHERE],
    ['no address on the homepage', { [HOME]: 'Northwind Dental. Family dentistry since 1998. Book online.' }, WHERE],
    ['a homepage dazl could not read', {}, WHERE],
    // review of #1691: a US office beside offices elsewhere, and addresses elsewhere that only look like "City, ST 12345"
    ['a US office beside a London and a Berlin one', { [HOME]: 'Northwind Dental. Offices: New York, NY 10001 · London EC1A 1BB · Berlin' }, WHERE],
    ['an Italian address that reads like Michigan', { [HOME]: 'Studio Northwind, Via Roma 1, Milano, MI 20121' }, WHERE],
    ['an Italian address that reads like Pennsylvania', { [HOME]: 'Studio Northwind, Via Roma 1, Palermo, PA 90133' }, WHERE],
    ['a German address that reads like Delaware', { [HOME]: 'Northwind Zahnmedizin, Unter den Linden 1, Berlin, DE 10115' }, WHERE],
    ['a US address beside a phone number outside the US', { [HOME]: `${US_HOME} London desk: +44 20 7946 0000` }, WHERE],
    ['a US address beside another country\'s name', { [HOME]: `${US_HOME} We also see patients in Toronto, Canada` }, WHERE],
    ['the request names Germany', { [HOME]: US_HOME }, ['Dental clinics in Germany']],
    // second review of #1691: another country, province or city named anywhere on the page, not only where an address writes it
    ['a US office beside offices named by city only', { [HOME]: 'Northwind Dental. Offices: Austin, TX 78701 · London · Berlin' }, WHERE],
    ['a US address beside a Canadian town and province code, no postal code', { [HOME]: `${US_HOME} Also in Toronto, ON` }, WHERE],
    ['a US address beside a small Canadian town and province code', { [HOME]: `${US_HOME} Second clinic: Guelph, ON` }, WHERE],
    ['a country named in the middle of a sentence', { [HOME]: 'Northwind Dental. We have offices in Germany and Austin. 500 Congress Ave, Austin, TX 78701' }, WHERE],
    ['a country followed by more text', { [HOME]: `${US_HOME} We also see patients in Toronto, Canada. Book today.` }, WHERE],
    ['a country that is also a US town\'s name, not at the end of the page', { [HOME]: 'Northwind Dental. Austin, TX 78701 · Mumbai, India · Contact us' }, WHERE],
    ['a phone number outside the US with a one-digit dialling code', { [HOME]: `${US_HOME} Second desk: +7 495 555 01 00` }, WHERE],
    // third review of #1691: a Canadian address as Canada Post writes it (no comma before the province), and written province abbreviations
    ['a US address beside a Canadian address with no comma before the province', { [HOME]: `${US_HOME} Canadian office: 55 Wyndham St N, Guelph ON N1H 1A1` }, WHERE],
    ['a US address beside a second Canadian address with no comma', { [HOME]: `${US_HOME} Second clinic: 12 Bernard Ave, Kelowna BC V1Y 6N2` }, WHERE],
    ['a US address beside a town and a dotted province abbreviation', { [HOME]: `${US_HOME} Also in Kelowna, B.C.` }, WHERE],
    ['a US address beside a town and a long province abbreviation', { [HOME]: `${US_HOME} Also in Waterloo, Ont.` }, WHERE],
  ]
  for (const [what, pages, where] of cases) {
    const db = setup(), asked: string[] = []
    const id = addLead(db)
    const run = await guessDiscoverEmails(db, 'T', 'j1', { env: ON, where, readHome: stubHome(pages), verifier: stubVerifier({ [`dana.ruiz@${SITE}`]: 'deliverable' }, asked) })
    assert.deepEqual(asked, [], what)
    assert.equal(run.checked, 0, what)
    assert.deepEqual(emailRows(db, id), [], what)
    assert.equal(usage(db), 0, what)
    assert.equal(stateOf(db, id), 'no_contact', what)
  }
  // a homepage read that throws is "could not read", never an error and never US
  const db = setup(), asked: string[] = []
  addLead(db)
  const run = await guessDiscoverEmails(db, 'T', 'j1', { env: ON, where: WHERE, readHome: async () => { throw new Error('socket hang up') }, verifier: stubVerifier({}, asked) })
  assert.deepEqual([asked.length, run.checked, run.leads], [0, 0, 0])
})

test('the step\'s reading of a homepage: a US address whose ZIP code is that state\'s, and no sign of any other country', () => {
  for (const us of [US_HOME, 'Harbour Smiles, 12 Dock St, Portland, ME 04101', 'Acme Labs, 1 Market St, Wilmington, DE 19801', 'Offices: New York, NY 10001 and Austin, TX 78701', 'Call +1 512 555 0100. 500 Congress Ave, Austin, TX 78701-1234'])
    assert.equal(usOnlyEvidence(us, WHERE).us, true, us)
  const no: [string, RegExp][] = [
    ['Offices: New York, NY 10001 · London EC1A 1BB · Berlin', /UK postcode/],
    ['Via Roma 1, Milano, MI 20121', /ZIP code/], ['Via Roma 1, Palermo, PA 90133', /ZIP code/], ['Unter den Linden 1, Berlin, DE 10115', /ZIP code/],
    [`${US_HOME} London desk: +44 20 7946 0000`, /phone number outside the US/],
    [`${US_HOME} We also see patients in Toronto, Canada`, /names CA/],
    ['100 King St W, Toronto, ON M5X 1A9', /Canadian/], ['Family dentistry since 1998', /no US address/],
  ]
  for (const [text, why] of no) { const r = usOnlyEvidence(text, WHERE); assert.equal(r.us, false, text); assert.match(r.us ? '' : r.reason, why, text) }
  assert.equal(usOnlyEvidence(US_HOME, ['Dental clinics in Germany']).us, false)
  assert.equal(usOnlyEvidence(undefined, WHERE).us, false)
})

test('the step\'s reading of a homepage: another country, a Canadian province or a city outside the US named anywhere on it means not US', () => {
  const no: [string, RegExp][] = [
    // offices named by city only, beside a US address
    ['Offices: Austin, TX 78701 · London · Berlin', /names London/],
    [`${US_HOME} Studios in MONTRÉAL and são paulo`, /names MONTRÉAL/],
    [`${US_HOME} Our Calgary team answers the phone`, /names Calgary/],
    // Canada shares +1 and these carry no postal code
    [`${US_HOME} Also in Toronto, ON`, /Canadian province: ON/],
    [`${US_HOME} Second clinic: Guelph, ON`, /Canadian province: ON/],
    [`${US_HOME} Serving all of Ontario and Quebec`, /Canadian province: Ontario/],
    [`${US_HOME} Flights to the Yukon`, /Canadian province: Yukon/],
    // Canada Post's own format has no comma between town and province: the postal code alone refuses, wherever it stands
    [`${US_HOME} Canadian office: 55 Wyndham St N, Guelph ON N1H 1A1`, /Canadian postal code/],
    [`${US_HOME} Markham ON L3R 0B8`, /Canadian postal code/],
    [`${US_HOME} Second clinic: 12 Bernard Ave, Kelowna BC V1Y 6N2`, /Canadian postal code/],
    [`${US_HOME} Regina SK S4P-3Y2`, /Canadian postal code/],
    [`${US_HOME} Postal code H7N 4Z9 for parcels`, /Canadian postal code/],
    // ...and so does the province code with half a postal code, or none, after a town with no comma
    [`${US_HOME} Laval QC H7N`, /Canadian province: QC/],
    [`${US_HOME} Clinics in Regina SK. Book online`, /Canadian province: SK/],
    [`${US_HOME} Second clinic in Markham ON`, /Canadian province: ON/],
    // written abbreviations
    [`${US_HOME} Also in Kelowna, B.C.`, /Canadian province: B\.C\./],
    [`${US_HOME} Also in Waterloo, Ont.`, /Canadian province: Ont\./],
    [`${US_HOME} Labs in Laval, Que. and Red Deer, Alta. and Regina Sask.`, /Canadian province: Que\./],
    [`${US_HOME} Charlottetown, P.E.I. and Halifax N.S.`, /Canadian province: P\.E\.I\./],
    // a country anywhere in the text, not only where an address writes it
    ['We have offices in Germany and Austin. 500 Congress Ave, Austin, TX 78701', /names DE/],
    [`${US_HOME} We also see patients in Toronto, Canada. Book today.`, /names CA/],
    ['Austin, TX 78701 · Mumbai, India · Contact us', /names IN/],
    [`${US_HOME} Our team in Poland builds the product.`, /names PL/],
    [`${US_HOME} Lab partners in the Côte d'Ivoire office help us`, /names CI$/],
    [`${US_HOME} Offices across the U.K. and beyond`, /names GB$/],
    [`${US_HOME} Clinics in Northern Ireland opening soon`, /names GB$/],
    // a phone number outside the US, however it is punctuated
    [`${US_HOME} Call +44 20 7946 0000`, /phone number outside the US/],
    [`${US_HOME} Second desk: +7 495 555 01 00`, /phone number outside the US/],
    [`${US_HOME} Tel +49-30-5550-1000`, /phone number outside the US/],
    [`${US_HOME} Tel +44 (0)20 7946 0000`, /phone number outside the US/],
    // a US town that shares a name is let through only as its own full address: a second, bare mention still refuses
    ['Harbour Smiles, 2 Brattle St, Cambridge, MA 02139 · Cambridge · London', /names Cambridge/],
    ['Offices: London Vienna, VA 22180', /names London/],
    ['Harbour Smiles, 4 Cumberland St, Lebanon, PA 17042. Our lab is in Lebanon', /names LB/],
    ['Harbour Smiles, 9 Euclid Ave, Ontario, CA 91761. Now in Ontario too', /Canadian province: Ontario/],
    // the ZIP code after the shared name must be that state's
    ['Harbour Smiles, 12 Dock St, Portland, ME 04101. Also at Vienna, VA 90210', /names Vienna/],
  ]
  for (const [text, why] of no) { const r = usOnlyEvidence(text, WHERE); assert.equal(r.us, false, text); assert.match(r.us ? '' : r.reason, why, text) }
  const yes = [
    // "+" before a number that is not a phone number
    `${US_HOME} +30% revenue growth`, `${US_HOME} +25 years of experience`, `${US_HOME} 500+ 5 star reviews`, `${US_HOME} Rated 4.9 by 1,200+ patients`,
    // US towns named after places elsewhere, written as full US addresses
    'Harbour Smiles, 1 Maple Ave, Vienna, VA 22180', 'Harbour Smiles, 2 Brattle St, Cambridge, MA 02139', 'Harbour Smiles, 4 Cumberland St, Lebanon, PA 17042',
    'Harbour Smiles, 9 Euclid Ave, Ontario, CA 91761', 'Harbour Smiles, 3 Central Ave, Albuquerque, NM 87102, New Mexico',
    // words that only look like a country: lower-case "turkey", "china" and "chile", a unit, a US state's name
    `${US_HOME} We serve turkey on fine china with green chile. 16 GB of photos. Second office in Georgia.`,
    // not a Canadian postal code or province: a part number, a ZIP+4, "on" and "man" as words, a province code that no town precedes
    `${US_HOME} Part A1B2C34 in stock. Mail to Austin, TX 78701-1234. Sign on today, man. We are ON it and open at 9 AM.`,
  ]
  for (const text of yes) { const r = usOnlyEvidence(text, WHERE); assert.equal(r.us, true, `${text} -> ${r.us ? '' : r.reason}`) }
  // the scans themselves: where in the text, which country, and whether the name is also a US town's
  assert.deepEqual(countryMentions('Offices in Germany and Lebanon, PA 17042').map(m => [m.code, m.at, m.ambiguous]), [['DE', 11, false], ['LB', 23, true]])
  assert.deepEqual(countryMentions('New Mexico, Papua New Guinea, new jersey, turkey').map(m => m.code), ['PG'])
  assert.deepEqual(canadianProvinceMentions('Guelph, ON and british columbia; go on, in ON mode').map(m => [m.place, m.code]), [['ON', true], ['british columbia', false]])
  assert.deepEqual(canadianProvinceMentions('Laval QC H7N, Kelowna B.C. and Waterloo, Ont. then Regina SK').map(m => [m.place, m.code]), [['QC', true], ['B.C.', true], ['Ont.', true], ['SK', true]])
  assert.deepEqual(canadianProvinceMentions('Go ON with it. We are ON it, man. Since 400 B.C. and on. Call ON 5 May'), [], 'a province code or abbreviation needs a town before it and an address end after it')
  assert.deepEqual(nonUsCityMentions('From new delhi to Derby, by way of bath and a derby hat').map(m => m.place), ['new delhi', 'Derby'])
  assert.deepEqual(nonUsCityMentions('Dallas, Chicago and New York'), [], 'US cities are not read')
})

test('a catch-all domain is never verified: one check, no row, and no second format', async () => {
  const db = setup(), asked: string[] = []
  const id = addLead(db)
  const run = await guessDiscoverEmails(db, 'T', 'j1', { env: ON, where: WHERE, readHome: stubHome({ [HOME]: US_HOME }), verifier: stubVerifier({ [`dana.ruiz@${SITE}`]: 'catch_all', [`danaruiz@${SITE}`]: 'deliverable' }, asked) })
  assert.deepEqual(asked, [`dana.ruiz@${SITE}`])
  assert.deepEqual([run.checked, run.verified], [1, 0])
  assert.deepEqual(emailRows(db, id), [])
  assert.deepEqual(ledger(db, id).map(r => r.verification), ['catch_all'])
  assert.equal(stateOf(db, id), 'no_contact')
  // an unknown or refused answer ends the lead the same way: only "no such mailbox" moves on to the next format
  for (const outcome of ['unknown', 'refused'] as const) {
    const d = setup(), a: string[] = []
    const l = addLead(d)
    await guessDiscoverEmails(d, 'T', 'j1', { env: ON, where: WHERE, readHome: stubHome({ [HOME]: US_HOME }), verifier: stubVerifier({ [`dana.ruiz@${SITE}`]: outcome, [`danaruiz@${SITE}`]: 'deliverable' }, a) })
    assert.deepEqual(a, [`dana.ruiz@${SITE}`], outcome)
    assert.deepEqual(emailRows(d, l), [], outcome)
  }
})

test('at most three checks for one lead, and the next lead is still checked', async () => {
  const db = setup(), asked: string[] = []
  const a = addLead(db)
  const b = addLead(db, { company: 'Harbour Smiles', person: 'Lee Okafor, Owner', domain: 'harbour-smiles.example' })
  const run = await guessDiscoverEmails(db, 'T', 'j1', { env: ON, where: WHERE, verifier: stubVerifier({ 'lee.okafor@harbour-smiles.example': 'deliverable' }, asked),
    readHome: stubHome({ [HOME]: US_HOME, 'https://harbour-smiles.example/': 'Harbour Smiles, 12 Dock St, Portland, ME 04101' }) })
  assert.deepEqual(asked, [`dana.ruiz@${SITE}`, `danaruiz@${SITE}`, `druiz@${SITE}`, 'lee.okafor@harbour-smiles.example'], 'three formats and no more for the first lead')
  assert.deepEqual(run, { leads: 2, checked: 4, verified: 1, skipped: null })
  assert.deepEqual(emailRows(db, a), [])
  assert.deepEqual(emailRows(db, b).map(r => r.value), ['lee.okafor@harbour-smiles.example'])
  assert.equal(usage(db), 4)
})

test('a verifier that cannot check at all (bad key, no credits, rate limit) stops the whole step: no further check for any lead', async () => {
  const db = setup(), asked: string[] = []
  const a = addLead(db)
  const b = addLead(db, { company: 'Harbour Smiles', person: 'Lee Okafor, Owner', domain: 'harbour-smiles.example' })
  const run = await guessDiscoverEmails(db, 'T', 'j1', { env: ON, where: WHERE, verifier: stubVerifier({ [`dana.ruiz@${SITE}`]: new VerifierError('stop', 'ZeroBounce: your account ran out of credits'), 'lee.okafor@harbour-smiles.example': 'deliverable' }, asked),
    readHome: stubHome({ [HOME]: US_HOME, 'https://harbour-smiles.example/': 'Harbour Smiles, 12 Dock St, Portland, ME 04101' }) })
  assert.deepEqual(asked, [`dana.ruiz@${SITE}`])
  assert.match(run.stopped ?? '', /ran out of credits/)
  assert.deepEqual([emailRows(db, a), emailRows(db, b)], [[], []])
  assert.deepEqual(ledger(db, a).map(r => r.verification), ['uncertain'], 'the failed check is never verified')
  // a call that merely fails (a 5xx) is not verified either, and ends that lead only
  const d = setup(), asked2: string[] = []
  const l = addLead(d)
  await guessDiscoverEmails(d, 'T', 'j1', { env: ON, where: WHERE, readHome: stubHome({ [HOME]: US_HOME }), verifier: stubVerifier({ [`dana.ruiz@${SITE}`]: new VerifierError('failed', 'ZeroBounce returned 503'), [`danaruiz@${SITE}`]: 'deliverable' }, asked2) })
  assert.deepEqual(asked2, [`dana.ruiz@${SITE}`])
  assert.deepEqual(emailRows(d, l), [])
})

test('the caps: the workspace\'s daily cap and the monthly cap are both reserved before any check', async () => {
  // daily cap 1: one check, then the step stops for every lead
  const db = setup(), asked: string[] = []
  addLead(db)
  addLead(db, { company: 'Harbour Smiles', person: 'Lee Okafor, Owner', domain: 'harbour-smiles.example' })
  const pages = { [HOME]: US_HOME, 'https://harbour-smiles.example/': 'Harbour Smiles, 12 Dock St, Portland, ME 04101' }
  const run = await guessDiscoverEmails(db, 'T', 'j1', { env: { ...ON, EMAIL_VERIFY_DAILY_CAP: '1' }, where: WHERE, readHome: stubHome(pages), verifier: stubVerifier({}, asked) })
  assert.deepEqual(asked, [`dana.ruiz@${SITE}`])
  assert.equal(run.capped, true); assert.equal(run.checked, 1); assert.equal(usage(db), 1)
  // the daily cap already reached: no check at all
  const later = await guessDiscoverEmails(db, 'T', 'j1', { env: { ...ON, EMAIL_VERIFY_DAILY_CAP: '1' }, where: WHERE, readHome: stubHome(pages), verifier: stubVerifier({}, asked) })
  assert.equal(asked.length, 1); assert.equal(later.checked, 0); assert.equal(later.capped, true)
  // the monthly cap: two checks across the whole database, then none
  const m = setup(), askedM: string[] = []
  addLead(m)
  const month = await guessDiscoverEmails(m, 'T', 'j1', { env: { ...ON, EMAIL_VERIFY_MONTHLY_CAP: '2' }, where: WHERE, readHome: stubHome(pages), verifier: stubVerifier({}, askedM) })
  assert.equal(askedM.length, 2); assert.equal(month.capped, true); assert.equal(usage(m), 2)
  // no daily cap set (the default is 0), or a monthly cap of 0: nothing runs
  for (const env of [{ EMAIL_GUESS_ENABLED: '1', DAZL_PAID_VENDORS: 'zerobounce' }, { ...ON, EMAIL_VERIFY_MONTHLY_CAP: '0' }, { ...ON, EMAIL_VERIFY_MONTHLY_CAP: 'lots' }]) {
    const d = setup(), a: string[] = []
    addLead(d)
    const r = await guessDiscoverEmails(d, 'T', 'j1', { env, where: WHERE, readHome: stubHome(pages), verifier: stubVerifier({}, a) })
    assert.equal(a.length, 0, JSON.stringify(env)); assert.match(r.skipped ?? '', /CAP is 0/)
  }
})

test('the switches fail closed: EMAIL_GUESS_ENABLED unset, zerobounce not named as a paid vendor, or no verifier - nothing is read and nothing is checked', async () => {
  const cases: [string, Record<string, string>, RegExp][] = [
    ['EMAIL_GUESS_ENABLED unset', { DAZL_PAID_VENDORS: 'zerobounce', EMAIL_VERIFY_DAILY_CAP: '20' }, /EMAIL_GUESS_ENABLED is off/],
    ['EMAIL_GUESS_ENABLED=0', { ...ON, EMAIL_GUESS_ENABLED: '0' }, /EMAIL_GUESS_ENABLED is off/],
    ['zerobounce not named', { EMAIL_GUESS_ENABLED: '1', EMAIL_VERIFY_DAILY_CAP: '20' }, /ZeroBounce not called/],
    ['another vendor named', { ...ON, DAZL_PAID_VENDORS: 'apollo,pdl' }, /ZeroBounce not called/],
  ]
  for (const [what, env, why] of cases) {
    const db = setup(), asked: string[] = [], read: string[] = []
    const id = addLead(db)
    const run = await guessDiscoverEmails(db, 'T', 'j1', { env, where: WHERE, readHome: stubHome({ [HOME]: US_HOME }, read), verifier: stubVerifier({ [`dana.ruiz@${SITE}`]: 'deliverable' }, asked) })
    assert.deepEqual([asked, read], [[], []], what)
    assert.match(run.skipped ?? '', why, what)
    assert.deepEqual(emailRows(db, id), [], what)
  }
  // every switch on but no verifier configured (no key): nothing runs, and no key is needed to say so
  const db = setup(), read: string[] = []
  addLead(db)
  assert.equal((await guessDiscoverEmails(db, 'T', 'j1', { env: ON, where: WHERE, readHome: stubHome({ [HOME]: US_HOME }, read), verifier: null })).skipped, 'no verifier configured')
  assert.equal((await guessDiscoverEmails(db, 'T', 'j1', { env: ON, where: WHERE, readHome: stubHome({ [HOME]: US_HOME }, read) })).skipped, 'no verifier configured', 'no ZEROBOUNCE_API_KEY in the settings: no verifier')
  assert.deepEqual(read, [])
})

test('leads that are never guessed for: an address of their own already, a first name only, no website, a shared inbox only, rejected, another workspace', async () => {
  const db = setup(), asked: string[] = [], read: string[] = []
  const published = addLead(db, { email: { value: `dana@${SITE}`, source_url: `https://${SITE}/contact` } })
  addLead(db, { company: 'First Name Dental', person: 'Dana, Owner' })
  addLead(db, { company: 'Nobody Dental', person: null })
  addLead(db, { company: 'No Site Dental', domain: null })
  addLead(db, { company: 'Bad Site Dental', domain: 'not a host name' })
  const rejected = addLead(db, { company: 'Rejected Dental' })
  db.prepare('UPDATE leads SET quarantined_at = 1 WHERE id = ?').run(rejected)
  // another workspace's search, same company: never read for this workspace
  db.prepare("INSERT INTO scan_jobs (id, user_id, business_name, industry, location, status, query, seller) VALUES ('j9', 'OTHER', 'b', 'i', 'l', 'running', 'q', 's')").run()
  addLead(db, { company: 'Other Tenant Dental', job: 'j9' })
  const run = await guessDiscoverEmails(db, 'T', 'j1', { env: ON, where: WHERE, readHome: stubHome({ [HOME]: US_HOME }, read), verifier: stubVerifier({ [`dana.ruiz@${SITE}`]: 'deliverable' }, asked) })
  assert.deepEqual(asked, [])
  assert.deepEqual(read, [], 'not even the homepage is read for a lead that cannot be guessed for')
  assert.deepEqual(run, { leads: 0, checked: 0, verified: 0, skipped: null })
  assert.deepEqual(emailRows(db, published).map(r => [r.value, r.label]), [[`dana@${SITE}`, 'published on a public page']], 'the published address stands alone')
  assert.equal(usage(db), 0)
  // a lead with only a shared inbox published still has no address of the person's own: it IS guessed for, and never at a shared local part
  const shared = addLead(db, { company: 'Shared Inbox Dental', email: { value: `info@${SITE}`, source_url: `https://${SITE}/contact` } })
  await guessDiscoverEmails(db, 'T', 'j1', { env: ON, where: WHERE, leadIds: [shared], readHome: stubHome({ [HOME]: US_HOME }), verifier: stubVerifier({ [`dana.ruiz@${SITE}`]: 'deliverable' }, asked) })
  assert.deepEqual(asked, [`dana.ruiz@${SITE}`])
  assert.equal(discoverContact({ source_kind: 'discover', name: 'Dana Ruiz', enrichments: stored(db, shared) })?.email?.provenance, 'guessed_verified')
  // a person whose name builds a shared-inbox local part ("Sal Es" -> s.es / sales): that address is never asked about
  const d = setup(), a: string[] = []
  addLead(d, { company: 'Desk Dental', person: 'Sal Es, Owner' })
  await guessDiscoverEmails(d, 'T', 'j1', { env: ON, where: WHERE, readHome: stubHome({ [HOME]: US_HOME }), verifier: stubVerifier({}, a) })
  assert.ok(a.length > 0 && a.length <= 3)
  assert.ok(!a.includes(`sales@${SITE}`), 'sales@ is a shared inbox, whoever is named Sal Es')
  // an address on the workspace's do-not-contact list is never sent to the verifier
  const s = setup(), sa: string[] = []
  addLead(s)
  s.prepare("INSERT INTO suppressions (tenant_id, email, reason) VALUES ('T', ?, 'manual')").run(`Dana.Ruiz@${SITE}`)
  await guessDiscoverEmails(s, 'T', 'j1', { env: ON, where: WHERE, readHome: stubHome({ [HOME]: US_HOME }), verifier: stubVerifier({}, sa) })
  assert.deepEqual(sa, [`danaruiz@${SITE}`, `druiz@${SITE}`], 'the listed address is skipped, whatever its letter case')
})

test('a search that is no longer this attempt\'s, or the step\'s deadline: no further check', async () => {
  const db = setup(), asked: string[] = []
  addLead(db)
  const gone = await guessDiscoverEmails(db, 'T', 'j1', { env: ON, where: WHERE, alive: () => false, readHome: stubHome({ [HOME]: US_HOME }), verifier: stubVerifier({}, asked) })
  assert.deepEqual([asked.length, gone.aborted], [0, true])
  // taken over after the first check: the second format is not asked about
  let alive = true
  const run = await guessDiscoverEmails(db, 'T', 'j1', { env: ON, where: WHERE, alive: () => alive, readHome: stubHome({ [HOME]: US_HOME }),
    verifier: { name: 'stub-verifier', async verify(address: string) { asked.push(address); alive = false; return { outcome: 'undeliverable' } } } })
  assert.deepEqual(asked, [`dana.ruiz@${SITE}`]); assert.equal(run.aborted, true)
  const ctrl = new AbortController(); ctrl.abort()
  const d = setup(), a: string[] = []
  addLead(d)
  assert.equal((await guessDiscoverEmails(d, 'T', 'j1', { env: ON, where: WHERE, signal: ctrl.signal, readHome: stubHome({ [HOME]: US_HOME }), verifier: stubVerifier({}, a) })).aborted, true)
  assert.equal(a.length, 0)
})

// ---- the real lane: the step runs after the search has finished, for the leads it stored ----
const found = (o: Partial<DiscoveredLead>): DiscoveredLead => ({ company: 'Northwind Dental', domain: SITE, signal: 'Opening a second clinic', signal_date: '2026-10-14', evidence_url: 'https://news.example/northwind', evidence_quote: 'Northwind Dental will open its second clinic', person: 'Dana Ruiz', title: 'Practice Owner', person_source_url: `https://${SITE}/team`, linkedin_url: null, email: null, email_source_url: null, confidence: 'high', why: 'expanding', ...o })
const canned: DiscoverResult = {
  leads: [
    found({}),
    // its proof address answers 404 when dazl asks: the page is gone
    found({ company: 'Ghost Dental', domain: 'ghost-dental.example', evidence_url: 'https://nowhere.example/ghost', evidence_quote: 'Ghost Dental will open a clinic', person: 'Lee Okafor', title: 'Owner', person_source_url: 'https://ghost-dental.example/team' }),
  ],
  seen: [{ url: 'https://news.example/northwind', title: 'Northwind Dental', page_age: null, text: 'On 14 October 2026 Northwind Dental will open its second clinic downtown.' }],
  usage: { input_tokens: 1000, output_tokens: 500, cache_read_tokens: 0, cache_write_tokens: 0, searches: 3, requests: 1, usd: 0.044 }, stop: 'end_turn', model: 'claude-opus-5-5', note: null,
}
async function laneRun(emailGuess: NonNullable<Parameters<typeof runJob>[2]>['emailGuess']) {
  const master = randomBytes(32)
  process.env.DAZL_MASTER_KEY = master.toString('base64')
  const db = new Database(':memory:')
  migrateAllSqlite(db)
  saveKey(db, 'T', 'anthropic', 'sk-ant-test', master)
  const id = createQueryJob(db, 'T', { query: 'Dental clinics in Austin opening a new location', seller: 'Clinic fit-out contractor' })
  const job = claimKeyedJob(db, id)
  assert.ok(job)
  let passes = 0
  // dazl's own reads: the ghost lead's proof address answers "not found"; every other request is refused, as in discover-lane.test.ts
  const web = (async (u: RequestInfo | URL) => String(u instanceof Request ? u.url : u).startsWith('https://nowhere.example/') ? new Response('Not found', { status: 404 }) : new Response('no', { status: 403 })) as unknown as typeof fetch
  const result = await runJob(db, job!, { master, fetchImpl: web, discover: true, enrichImpl: null, emailGuess,
    discoverImpl: async () => (++passes === 1 ? canned : { ...canned, leads: [], seen: [] }) })
  const j = db.prepare('SELECT status, error, candidates, verified, needs_review FROM scan_jobs WHERE id = ?').get(id) as { status: string; error: string | null; candidates: number; verified: number; needs_review: number }
  const spend = db.prepare('SELECT kind, status, actual_usd FROM scan_spend_calls WHERE scan_job_id = ? ORDER BY kind').all(id) as { kind: string; status: string; actual_usd: number | null }[]
  const leads = listLeads(db, 'T', id, 50, false) as unknown as { id: string; company: string }[]
  return { db, id, result, scan: [result, j.status, j.error, j.candidates, j.verified, j.needs_review, JSON.stringify(spend)], leads }
}
const HOMES = { [HOME]: US_HOME, 'https://ghost-dental.example/': 'Ghost Dental, 9 Elm St, Dallas, TX 75201' }

test('the lane: after the search finishes, the shown US lead gets its checked address; the lead whose proof page is gone is never guessed for', async () => {
  const asked: string[] = [], read: string[] = []
  const r = await laneRun({ env: ON, readHome: stubHome(HOMES, read), verifier: stubVerifier({ [`dana.ruiz@${SITE}`]: 'undeliverable', [`danaruiz@${SITE}`]: 'deliverable', 'lee.okafor@ghost-dental.example': 'deliverable' }, asked) })
  assert.equal(r.result, 'done')
  assert.deepEqual(r.leads.map(l => l.company), ['Northwind Dental'], 'the lead whose proof page is gone is dropped by the search itself (#1687)')
  assert.deepEqual(asked, [`dana.ruiz@${SITE}`, `danaruiz@${SITE}`], 'only the lead whose proof page is still there')
  assert.deepEqual(read, [HOME], 'the dropped lead\'s homepage is not even read')
  const nw = r.leads.find(l => l.company === 'Northwind Dental')!
  assert.deepEqual(emailRows(r.db, nw.id).map(e => [e.value, e.label, e.source_url]), [[`danaruiz@${SITE}`, GUESSED_VERIFIED_LABEL, HOME]])
  assert.deepEqual(r.db.prepare("SELECT value FROM lead_enrichments WHERE kind = 'email' AND value LIKE '%ghost-dental.example'").all(), [], 'no address anywhere for the dropped lead')
  assert.equal(usage(r.db), 2)
  assert.equal(discoverState({ ...(r.db.prepare('SELECT name, company_domain, review_reason, event_date, fit, intent, quarantined_at, source_kind FROM leads WHERE id = ?').get(nw.id) as Record<string, unknown>), gate_held: false, enrichments: stored(r.db, nw.id) } as never), 'ready_email')
  const note = r.db.prepare("SELECT status, results FROM connector_audit WHERE tenant_id = 'T' AND connector = 'email_guess'").get() as { status: string; results: number }
  assert.deepEqual([note.status, note.results], ['checked 2 for 1 US lead', 1], 'what the step did is recorded, as counts only')
})

test('the lane: the search\'s own result (status, counts, spend) is the same with the step off, on, or throwing', async () => {
  const off = await laneRun({ env: {}, readHome: stubHome(HOMES), verifier: stubVerifier({}, []) })
  const asked: string[] = []
  const on = await laneRun({ env: ON, readHome: stubHome(HOMES), verifier: stubVerifier({ [`dana.ruiz@${SITE}`]: 'deliverable' }, asked) })
  // a verifier that blows up outside any check (not a provider answer): the step fails, the search does not
  const broken: MailboxVerifier = { get name(): string { throw new Error('verifier misconfigured') }, async verify() { throw new Error('unreachable') } }
  const threw = await laneRun({ env: ON, readHome: stubHome(HOMES), verifier: broken })
  assert.equal(asked.length, 1)
  assert.deepEqual(off.scan.slice(0, 6), ['done', 'done', null, 2, 1, 0], 'two found, one shown; the one whose proof page is gone is dropped, not listed for review (#1687)')
  assert.deepEqual(on.scan, off.scan)
  assert.deepEqual(threw.scan, off.scan, 'a step that throws changes nothing about the finished search')
  assert.equal(threw.leads.length, 1)
  const notes = (db: Database.Database) => (db.prepare("SELECT status FROM connector_audit WHERE tenant_id = 'T' AND connector = 'email_guess'").all() as { status: string }[]).map(r => r.status)
  assert.deepEqual(notes(threw.db), ['email_guess_failed'], 'the failure is recorded')
  assert.deepEqual(notes(off.db), [], 'switched off: nothing was done and nothing is recorded')
  assert.equal(usage(off.db), 0); assert.equal(usage(threw.db), 0)
})
