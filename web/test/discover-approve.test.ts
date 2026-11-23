// Launch blockers from the staging check (#1571): a discovery lead's person shows on its row and card, and a person can approve it
// (a draft email to review; nothing is sent) when a public page prints an email for it. Autopilot keeps every older check.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import Database from 'better-sqlite3'
import { randomBytes } from 'node:crypto'
import { migrateAllSqlite } from '../lib/db/sqlite-migrations.ts'
import { addEnrichment } from '../lib/connectors/store.ts'
import { leadPerson } from '../lib/people/lead-person.ts'
import { leadCardSummary } from '../lib/scan/lead-card.ts'
import { contactSearchNote } from '../lib/outreach/published-email.ts'
import { createDraft, OutreachError } from '../lib/outreach/service.ts'

const person = { connector: 'discover', kind: 'person', value: 'Dana Ruiz, Practice Owner', label: 'named on a public page', source_url: 'https://northwind-dental.example/team' }
const email = { connector: 'discover', kind: 'email', value: 'dana@northwind-dental.example', label: 'published on a public page', source_url: 'https://northwind-dental.example/contact' }
const linkedin = { connector: 'discover', kind: 'linkedin', value: 'https://www.linkedin.com/in/dana-ruiz/', label: 'linked from a public page', source_url: 'https://northwind-dental.example/team' }
const lead = (enrichments: unknown[], o: Record<string, unknown> = {}) => ({ id: 'a'.repeat(24), company: 'Northwind Dental', name: 'Dana Ruiz', signal: 'Opening a second clinic', source_url: 'https://news.example/northwind', evidence_excerpt: 'Northwind Dental will open its second clinic', event_date: '2026-10-14', date_status: 'verified', review_reason: null, fit: 4, intent: 4, why: 'expanding', icp_match: null, company_domain: 'northwind-dental.example', contact: null, confidence: 85, source_kind: 'discover', enrichments, ...o })

test('the row names the person the run found, with their LinkedIn and the page that names them', () => {
  const p = leadPerson([person, linkedin, email], '')
  assert.deepEqual(p && [p.name, p.title, p.linkedin, p.source], ['Dana Ruiz', 'Practice Owner', 'https://www.linkedin.com/in/dana-ruiz/', 'https://northwind-dental.example/team'])
  assert.equal(leadPerson([{ ...person, value: 'Dana, Owner' }], ''), null, 'a bare first name is not a named person')
  assert.equal(leadPerson([{ ...person, connector: 'apollo' }], ''), null, 'only the discovery run\'s own rows take this path')
})

test('the card shows the person and the email, and Approve is on when a public page prints an email', () => {
  const c = leadCardSummary(lead([person, linkedin, email]) as never)
  assert.equal(c.contact, 'Dana Ruiz, Practice Owner - dana@northwind-dental.example')
  assert.deepEqual(c.approve, { ok: true })
  const noEmail = leadCardSummary(lead([person, linkedin]) as never)
  assert.equal(noEmail.contact, 'Dana Ruiz, Practice Owner')
  assert.deepEqual(noEmail.approve, { ok: false, reason: 'No email address is published for this lead. Reach them through their LinkedIn profile.' })
  assert.equal(leadCardSummary(lead([person, email], { review_reason: 'source_review_required' }) as never).approve.ok, false, 'an unconfirmed proof page is reviewed first')
  assert.equal(leadCardSummary(lead([person, email], { quarantined_at: 1 }) as never).approve.ok, false)
  // the safety rules stay: an undated signal, an address off the company's site, a support inbox, a failed required check
  const why = (e: unknown[], o: Record<string, unknown> = {}) => { const a = leadCardSummary(lead(e, o) as never).approve; return a.ok ? 'ok' : a.reason }
  assert.match(why([person, email], { event_date: null }), /no date/)
  assert.match(why([person, { ...email, value: 'dana@other-company.example', source_url: 'https://directory.example/northwind' }]), /only on another site/)
  // review of #1574: the company's own mailbox domain is not publication by the company. The SAME address, found only on a directory, is refused
  assert.match(why([person, { ...email, source_url: 'https://directory.example/northwind' }]), /only on another site/)
  assert.equal(why([person, { ...email, source_url: 'https://team.northwind-dental.example/people' }]), 'ok', 'a subdomain of the company site is its own site')
  assert.match(why([person, { ...email, source_url: 'https://northwind-dental.example.evil.example/contact' }]), /only on another site/)
  assert.equal(why([person, { ...email, value: 'dana@other-mail.example', source_url: 'https://www.northwind-dental.example/contact' }]), 'ok', 'an address printed on the company\'s own site')
  assert.match(why([person, { ...email, value: 'privacy@northwind-dental.example' }]), /not a sales contact/)
  assert.match(why([person, email], { gate_held: true }), /required check/)
  assert.match(why([person, email], { company_domain: null }), /only on another site/)
})

test('Approve creates a draft for the published address; autopilot and calibration still get every older check', () => {
  process.env.DAZL_MASTER_KEY = randomBytes(32).toString('base64')
  const db = new Database(':memory:')
  migrateAllSqlite(db)
  db.prepare("INSERT INTO scan_jobs (id, user_id, business_name, industry, location, status, query, seller) VALUES ('j1', 'T', 'b', 'i', 'l', 'running', 'Dental clinics opening a new location', 'Clinic fit-out contractor')").run()
  const id = 'b'.repeat(24)
  db.prepare("INSERT INTO leads (id, scan_job_id, name, company, signal, source_url, score, evidence_excerpt, event_date, date_status, confidence, fit, intent, why, source_kind, company_domain) VALUES (?, 'j1', 'Dana Ruiz', 'Northwind Dental', 'Opening a second clinic', 'https://news.example/northwind', 85, 'Northwind Dental will open its second clinic', '2026-10-14', 'verified', 85, 4, 4, 'expanding', 'discover', 'northwind-dental.example')").run(id)
  db.prepare("UPDATE scan_jobs SET status = 'done' WHERE id = 'j1'").run()
  const now = Math.floor(Date.now() / 1000)
  const code = (fn: () => unknown) => { try { fn(); return 'created' } catch (e) { if (e instanceof OutreachError) return e.code; throw e } }
  assert.equal(code(() => createDraft(db, 'T', id, 'Fit-out Co', { manual: true })), 'no_email_contact', 'no published email yet: nothing to draft to')
  addEnrichment(db, 'T', id, { ...person, confidence: null, source_date: '2026-11-22', retrieved_at: now })
  addEnrichment(db, 'T', id, { ...email, confidence: null, source_date: '2026-11-22', retrieved_at: now })
  assert.notEqual(code(() => createDraft(db, 'T', id, 'Fit-out Co')), 'created', 'without a person asking, the older checks decide')
  assert.equal(code(() => createDraft(db, 'T', id, 'Fit-out Co', { manual: true })), 'created')
  const draft = db.prepare("SELECT to_email, status FROM outreach_messages WHERE tenant_id = 'T' AND lead_id = ?").get(id) as { to_email: string; status: string }
  assert.equal(draft.to_email, 'dana@northwind-dental.example')
  assert.equal(code(() => createDraft(db, 'OTHER', id, 'x', { manual: true })), 'not_found', 'another workspace cannot draft to this lead')
  // the same rules at the server, whatever the page shows
  db.prepare("INSERT INTO scan_jobs (id, user_id, business_name, industry, location, status, query, seller) VALUES ('j2', 'T', 'b', 'i', 'l', 'running', 'Dental clinics opening a new location', 'Clinic fit-out contractor')").run()
  const cases = [{ date: null }, { domain: 'someone-else.example' }, { to: 'privacy@northwind-dental.example' }, { src: 'https://directory.example/northwind' }, { to: 'sam@northwind-dental.example', src: 'https://northwind-dental.example/team' }].map((o: { date?: string | null; domain?: string | null; to?: string; src?: string }) => {
    const lid = randomBytes(12).toString('hex')
    db.prepare("INSERT INTO leads (id, scan_job_id, name, company, signal, source_url, score, evidence_excerpt, event_date, date_status, confidence, fit, intent, why, source_kind, company_domain) VALUES (?, 'j2', 'Dana Ruiz', 'Northwind Dental', 'Opening a second clinic', ?, 85, 'Northwind Dental will open its second clinic', ?, 'verified', 85, 4, 4, 'expanding', 'discover', ?)").run(lid, `https://news.example/${lid}`, o.date === undefined ? '2026-10-14' : o.date, o.domain === undefined ? 'northwind-dental.example' : o.domain)
    return { lid, to: o.to ?? email.value, src: o.src ?? email.source_url }
  })
  db.prepare("UPDATE scan_jobs SET status = 'done' WHERE id = 'j2'").run()
  const [undated, offSite, privacy, directoryOnly, ownSite] = cases.map(c => { addEnrichment(db, 'T', c.lid, { ...email, value: c.to, source_url: c.src, confidence: null, source_date: '2026-11-22', retrieved_at: now }); return code(() => createDraft(db, 'T', c.lid, 'Fit-out Co', { manual: true })) })
  assert.deepEqual([undated, offSite, privacy], ['lead_currentness_unconfirmed', 'domain_unconfirmed', 'not_sales_contact'])
  // review of #1574: dana@<company domain> sourced only from a directory is refused and NO draft row exists; an address the company's own page prints is drafted
  const drafts = (lid: string) => (db.prepare("SELECT COUNT(*) AS n FROM outreach_messages WHERE tenant_id = 'T' AND lead_id = ?").get(lid) as { n: number }).n
  assert.deepEqual([directoryOnly, drafts(cases[3].lid)], ['domain_unconfirmed', 0])
  assert.deepEqual([ownSite, drafts(cases[4].lid)], ['created', 1])
})

test('the scheduler enrols a first search into a repeat only when the operator switch is on', () => {
  const src = readFileSync(new URL('../app/api/internal/tick/route.ts', import.meta.url), 'utf8')
  assert.ok(src.includes("if (process.env.DAZL_FIRST_PLAY_REPEAT === '1') try { firstPlayRepeats = (await repeatFirstPlays("))
})

test('Details does not say "no published contact" beside a published address (#1571)', () => {
  const base = { contact: null, source_url: 'https://news.example/northwind', evidence_excerpt: 'x', confidence: 85, company_domain: 'northwind-dental.example' }
  assert.equal(contactSearchNote({ ...base, enrichments: [email] } as never), null)
  assert.match(contactSearchNote({ ...base, enrichments: [person] } as never) ?? '', /No published contact stored/)
})

// #1250, owner decision 2026-11-23: a shared inbox (sales@, info@, reception@, founders@ ...) is not a contact. On production that day
// 12 leads carried 4 addresses and 3 were shared inboxes, each shown as the lead's contact and counted as one.
test('#1250: a shared inbox is never a discovery lead\'s contact; the person\'s own address is', () => {
  for (const local of ['info', 'sales', 'reception', 'founders', 'hello', 'contact', 'front-desk', 'Info']) {
    const shared = { ...email, value: `${local}@northwind-dental.example` }
    const c = leadCardSummary(lead([person, linkedin, shared]) as never)
    assert.equal(c.contact, 'Dana Ruiz, Practice Owner', `${local}@ is not shown as the contact`)
    assert.deepEqual(c.approve, { ok: false, reason: 'Only a shared inbox (such as info@ or sales@) is published for this lead, and that is not a contact. Reach them through their LinkedIn profile.' }, `${local}@ cannot be approved`)
    assert.deepEqual(leadCardSummary(lead([person, shared]) as never).approve, { ok: false, reason: 'Only a shared inbox (such as info@ or sales@) is published for this lead, and that is not a contact.' })
  }
  const both = leadCardSummary(lead([person, linkedin, { ...email, value: 'info@northwind-dental.example' }, email]) as never)
  assert.equal(both.contact, 'Dana Ruiz, Practice Owner - dana@northwind-dental.example', 'the person\'s own address is the contact, wherever the shared one is listed')
  assert.deepEqual(both.approve, { ok: true })
})

test('#1250 at the server and in the counts: a shared inbox is not drafted to and not counted; the person\'s own address is', async () => {
  const { listCampaigns } = await import('../lib/outreach/campaigns.ts')
  process.env.DAZL_MASTER_KEY = randomBytes(32).toString('base64')
  const db = new Database(':memory:')
  migrateAllSqlite(db)
  db.prepare("INSERT INTO scan_jobs (id, user_id, business_name, industry, location, status, query, seller) VALUES ('j1', 'T', 'b', 'i', 'l', 'running', 'Dental clinics opening a new location', 'Clinic fit-out contractor')").run()
  const mk = (id: string) => db.prepare("INSERT INTO leads (id, scan_job_id, name, company, signal, source_url, score, evidence_excerpt, event_date, date_status, confidence, fit, intent, why, source_kind, company_domain) VALUES (?, 'j1', 'Dana Ruiz', 'Northwind Dental', 'Opening a second clinic', ?, 85, 'Northwind Dental will open its second clinic', '2026-10-14', 'verified', 85, 4, 4, 'expanding', 'discover', 'northwind-dental.example')").run(id, `https://news.example/${id}`)
  const shared = 'c'.repeat(24), own = 'd'.repeat(24)
  mk(shared); mk(own)
  db.prepare("UPDATE scan_jobs SET status = 'done' WHERE id = 'j1'").run()
  const now = Math.floor(Date.now() / 1000)
  const add = (lead: string, value: string, at: number) => addEnrichment(db, 'T', lead, { ...email, value, confidence: null, source_date: '2026-11-22', retrieved_at: at })
  add(shared, 'info@northwind-dental.example', now)
  add(own, 'reception@northwind-dental.example', now)      // stored first
  add(own, 'dana@northwind-dental.example', now + 1)
  const code = (fn: () => unknown) => { try { fn(); return 'created' } catch (e) { if (e instanceof OutreachError) return e.code; throw e } }
  assert.equal(code(() => createDraft(db, 'T', shared, 'Fit-out Co', { manual: true })), 'no_email_contact', 'a shared inbox is nothing to draft to')
  assert.equal(code(() => createDraft(db, 'T', own, 'Fit-out Co', { manual: true })), 'created')
  assert.equal((db.prepare("SELECT to_email FROM outreach_messages WHERE tenant_id = 'T' AND lead_id = ?").get(own) as { to_email: string }).to_email, 'dana@northwind-dental.example', 'the person\'s own address, not the shared inbox stored before it')
  assert.equal(listCampaigns(db, 'T').find(c => c.id === 'j1')!.contact.withContact, 1, 'Campaigns counts the lead with a real address only')
})
