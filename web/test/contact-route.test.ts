// #384: published-contact provenance, deliverability and person-route match are three separate facts.
import { seedOffers } from './helpers/seed-offer.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import Database from 'better-sqlite3'
import { migrateScan, createJob } from '../lib/scan/store.ts'
import { migrateOutreach } from '../lib/outreach/store.ts'
import { migrateConnectors, addEnrichment } from '../lib/connectors/store.ts'
import { createDraft } from '../lib/outreach/service.ts'
import { contactRoute, deliverabilityBlocked, emailDomainInvalid, type RouteLead, type RouteRow } from '../lib/outreach/contact-route.ts'
import { approveState, leadCardSummary } from '../lib/scan/lead-card.ts'
import { contactIdentity, type CardLead } from '../lib/scan/opportunity.ts'
import { domainReviewFor, REVIEW_PREFIX } from '../lib/outreach/domain-review.ts'

const NOW_MS = Date.UTC(2026, 10, 2)
const SEC = (y: number, m: number, d: number) => Date.UTC(y, m - 1, d) / 1000
const lead = (o: Partial<RouteLead> = {}): RouteLead => ({ contact: 'hello@brightdental.example', source_url: 'https://news.example/a', evidence_excerpt: 'Bright Dental opened a second office', enrichments: [], ...o })
const check = (value: string, at = SEC(2026, 10, 1)): RouteRow => ({ connector: 'checker', kind: 'deliverability', value, retrieved_at: at })
const founder = { name: 'Dana Lee', title: 'Founder', roleRelevant: true }

test('a generic recruiting or support inbox never becomes the founder\'s address', () => {
  for (const contact of ['jobs@brightdental.example', 'careers@brightdental.example', 'support@brightdental.example']) {
    const r = contactRoute(lead({ contact }), founder, NOW_MS)
    assert.equal(r.personRoute.state, 'restricted_inbox', contact)
    assert.equal(r.emailReadiness, 'blocked', contact)
    assert.match(r.personRoute.text, /not Dana Lee's address/)
  }
  const shared = contactRoute(lead({ contact: 'info@brightdental.example' }), founder, NOW_MS)
  assert.equal(shared.personRoute.state, 'shared_inbox')
  assert.match(shared.personRoute.text, /not Dana Lee \(Founder\)'s own address/)
  const named = contactRoute(lead({ contact: 'dana.lee@brightdental.example' }), founder, NOW_MS)
  assert.equal(named.personRoute.state, 'person_named_address')
  assert.match(named.personRoute.text, /current role not verified/)
  assert.equal(contactRoute(lead({ contact: 'xq7@brightdental.example' }), founder, NOW_MS).personRoute.state, 'owner_unknown')
})

test('an address read years ago keeps its age and an unknown first-published date; it is never refreshed silently', () => {
  const r = contactRoute(lead({ contact: null, enrichments: [{ connector: 'sitecrawl', kind: 'email', value: 'hello@brightdental.example', label: 'contact page', source_url: 'https://brightdental.example/contact', retrieved_at: SEC(2023, 3, 1) }] }), null, NOW_MS)
  assert.equal(r.provenance.state, 'unrecorded_site')
  assert.equal(r.provenance.stale, true)
  assert.ok(r.provenance.ageDays! > 1000)
  assert.match(r.provenance.text, /not recorded as the company's own website, last read 1 Mar 2023 \(\d+ days ago, may be out of date\); when it was first published is unknown/)
  assert.equal(r.deliverability.state, 'not_checked', 'being published is not a deliverability check')
  const cited = contactRoute(lead(), null, NOW_MS)
  assert.equal(cited.provenance.state, 'cited_page')
  assert.match(cited.provenance.text, /printed on the cited page \(news\.example\), read when the scan ran; when it was first published is unknown/)
})

test('a crawled page is never called the company website unless the site identity is recorded as theirs', () => {
  const emailRow = { connector: 'sitecrawl', kind: 'email', value: 'contact@kyro.ai', label: 'contact page', source_url: 'https://kyro.ai/contact', retrieved_at: SEC(2026, 10, 24) }
  const dom = (token: string) => ({ connector: 'sitecrawl', kind: 'domain', value: `kyro.ai|${token}`, label: `domain-basis-v1:${token}`, source_url: 'https://kyro.ai/' })

  // Kyro repro: an email row and NO domain row. The identity line says the own website was not identified;
  // the provenance line must not call the same page "the company website".
  const noDom = contactRoute(lead({ id: 'l-kyro', contact: null, enrichments: [emailRow] }), null, NOW_MS)
  assert.equal(noDom.provenance.state, 'unrecorded_site')
  assert.doesNotMatch(noDom.provenance.text, /company website/)
  assert.match(noDom.provenance.text, /printed on a page at kyro\.ai, not recorded as the company's own website/)
  const cardLead: CardLead = { id: 'l-kyro', company: 'Kyro AI', signal: 'hiring', source_url: 'https://weworkremotely.com/x', evidence_excerpt: null, event_date: null, date_status: null, review_reason: null, fit: null, intent: null, why: null, icp_match: null, company_domain: null, contact: null, enrichments: [emailRow] }
  assert.equal(contactIdentity(cardLead).state, 'none')
  assert.match(contactIdentity(cardLead).text, /own website was not identified/)

  // A recorded website whose basis does not prove ownership: named, never called the company's own.
  const weak = contactRoute(lead({ id: 'l-weak', contact: null, enrichments: [emailRow, dom('name_probe')] }), null, NOW_MS)
  assert.equal(weak.provenance.state, 'unconfirmed_site')
  assert.doesNotMatch(weak.provenance.text, /the company website/)
  assert.match(weak.provenance.text, /printed on a page at kyro\.ai, a website not confirmed as the company's own/)

  // The cited page on the company's own domain: the company website, as before.
  const own = contactRoute(lead({ id: 'l-own', contact: null, enrichments: [emailRow, dom('evidence_own_domain')] }), null, NOW_MS)
  assert.equal(own.provenance.state, 'company_site')
  assert.match(own.provenance.text, /printed on the company website \(kyro\.ai\)/)

  // A weaker basis the user confirmed themselves: the company website, as before.
  const reviewRows = [emailRow, dom('name_probe')]
  const decision = domainReviewFor({ id: 'l-user', contact: null }, reviewRows)
  assert.equal(decision.state, 'required')
  const confirmed = contactRoute(lead({ id: 'l-user', contact: null, enrichments: [...reviewRows, { connector: 'user', kind: 'domain_review', value: 'kyro.ai', label: REVIEW_PREFIX + decision.binding }] }), null, NOW_MS)
  assert.equal(confirmed.provenance.state, 'company_site')

  // The lead's own contact stays the cited page, whatever the crawl recorded.
  const cited = contactRoute(lead({ id: 'l-cited', contact: 'dana@news.example', enrichments: [emailRow] }), null, NOW_MS)
  assert.equal(cited.provenance.state, 'cited_page')
})

test('an invalid domain fails; a recorded failed check fails; catch-all and mail-server-found stay uncertain', () => {
  assert.equal(emailDomainInvalid('a@shop.internal'), true)
  assert.equal(emailDomainInvalid('a@shop.invalid'), false, 'the repo-wide synthetic fixture TLD, like .example and .test')
  assert.equal(emailDomainInvalid('a@localhost'), true)
  assert.equal(emailDomainInvalid('a@10.0.0.1'), true)
  assert.equal(emailDomainInvalid('a@brightdental.example'), false)
  const bad = contactRoute(lead({ contact: 'hello@brightdental.internal' }), null, NOW_MS)
  assert.equal(bad.deliverability.state, 'domain_invalid')
  assert.equal(bad.emailReadiness, 'blocked')
  assert.equal(contactRoute(lead({ enrichments: [check('@brightdental.example|no_mx')] }), null, NOW_MS).deliverability.state, 'domain_invalid')
  assert.equal(contactRoute(lead({ enrichments: [check('hello@brightdental.example|rejected')] }), null, NOW_MS).emailReadiness, 'blocked')
  const ca = contactRoute(lead({ enrichments: [check('@brightdental.example|catch_all')] }), null, NOW_MS)
  assert.equal(ca.deliverability.state, 'catch_all')
  assert.equal(ca.emailReadiness, 'uncertain', 'catch-all is never treated as a confirmed mailbox')
  assert.match(ca.deliverability.text, /uncertain.*catch-all/)
  assert.equal(contactRoute(lead({ enrichments: [check('@brightdental.example|mx_found')] }), null, NOW_MS).emailReadiness, 'uncertain')
  // A domain-level row can never accept one mailbox; an unknown verdict is ignored.
  assert.equal(contactRoute(lead({ enrichments: [check('@brightdental.example|accepted')] }), null, NOW_MS).deliverability.state, 'not_checked')
  assert.equal(contactRoute(lead({ enrichments: [check('hello@brightdental.example|verified')] }), null, NOW_MS).deliverability.state, 'not_checked')
  const ok = contactRoute(lead({ enrichments: [check('hello@brightdental.example|accepted')] }), founder, NOW_MS)
  assert.equal(ok.emailReadiness, 'checked')
  assert.match(ok.deliverability.text, /not proof it reaches the right person/)
  assert.equal(ok.personRoute.state, 'shared_inbox', 'an accepted mailbox does not make it the person\'s route')
  // The newest recorded check wins.
  assert.equal(contactRoute(lead({ enrichments: [check('hello@brightdental.example|rejected', SEC(2026, 1, 1)), check('hello@brightdental.example|accepted', SEC(2026, 9, 1))] }), null, NOW_MS).deliverability.state, 'mailbox_accepted')
  assert.equal(deliverabilityBlocked('hello@brightdental.example', [check('@brightdental.example|catch_all')]), false)
  assert.equal(deliverabilityBlocked('hello@brightdental.example', [check('hello@brightdental.example|rejected')]), true)
})

test('email readiness is separate from phone-only reachability', () => {
  const r = contactRoute(lead({ contact: '(614) 555-0142' }), founder, NOW_MS)
  assert.equal(r.channel, 'phone_only')
  assert.equal(r.email, null)
  assert.equal(r.emailReadiness, 'none')
  assert.equal(r.personRoute.state, 'phone_only')
  assert.match(r.deliverability.text, /a phone number is not email readiness/)
  assert.match(r.personRoute.text, /not confirmed as Dana Lee \(Founder\)'s line/)
  assert.equal(contactRoute(lead({ contact: null }), null, NOW_MS).channel, 'none')
})

const card: CardLead = {
  id: 'a'.repeat(24), company: 'Bright Dental', signal: 'Bright Dental opened a second office', source_url: 'https://www.news.example/bright',
  evidence_excerpt: 'Bright Dental opened a second office', event_date: '2026-10-01', date_status: 'unverified', review_reason: null,
  fit: 4, intent: 3, why: 'Fits.', icp_match: null, company_domain: 'brightdental.example', contact: 'hello@brightdental.example', confidence: 80,
  human_confirmed_at: null, enrichments: [],
}

test('the lead card carries the three facts separately and Approve refuses an undeliverable address', () => {
  const s = leadCardSummary(card)
  assert.ok(s.route)
  assert.equal(s.route!.provenance.state, 'cited_page')
  assert.equal(s.route!.deliverability.state, 'not_checked')
  assert.equal(s.route!.personRoute.state, 'shared_inbox')
  assert.equal(leadCardSummary({ ...card, contact: null }).route, null)
  assert.deepEqual(approveState(card), { ok: true })
  const rejected = approveState({ ...card, enrichments: [{ connector: 'checker', kind: 'deliverability', value: 'hello@brightdental.example|rejected', label: null, source_url: '', retrieved_at: SEC(2026, 10, 1) }] as CardLead['enrichments'] })
  assert.equal(rejected.ok, false)
  assert.match((rejected as { reason: string }).reason, /cannot receive mail/)
  assert.equal(approveState({ ...card, contact: 'hello@brightdental.internal' }).ok, false)
})

test('createDraft refuses an undeliverable address; catch-all still drafts', () => {
  const db = new Database(':memory:')
  migrateScan(db); migrateOutreach(db); seedOffers(db); migrateConnectors(db)
  const add = (contact: string) => {
    const job = createJob(db, 'A', { business_name: 'Acme', industry: 'roofing', location: 'Toronto' })
    const id = randomBytes(12).toString('hex')
    db.prepare("UPDATE scan_jobs SET status = 'running' WHERE id = ?").run(job)
    db.prepare("INSERT INTO leads (id, scan_job_id, company, contact, signal, source_url, evidence_excerpt, confidence, human_confirmed_at, human_confirmed_from) VALUES (?, ?, 'Northside Builders', ?, 'Hiring five roofers', 'https://news.example/a', 'Northside Builders is hiring five roofers', 85, 1800000000, 'test_review')").run(id, job, contact)
    return id
  }
  const rec = (id: string, value: string) => addEnrichment(db, 'A', id, { connector: 'checker', kind: 'deliverability', value, label: null, confidence: null, source_url: 'https://checker.example/run', source_date: '2026-10-01', retrieved_at: SEC(2026, 10, 1) })
  assert.throws(() => createDraft(db, 'A', add('info@northside.internal'), 'Acme'), /undeliverable/)
  const rejected = add('info@northside.example'); rec(rejected, 'info@northside.example|rejected')
  assert.throws(() => createDraft(db, 'A', rejected, 'Acme'), /undeliverable/)
  const catchAll = add('sales@northside.example'); rec(catchAll, '@northside.example|catch_all')
  assert.doesNotThrow(() => createDraft(db, 'A', catchAll, 'Acme'))
})
