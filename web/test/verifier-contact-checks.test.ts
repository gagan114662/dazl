// Independent evidence verifier, person and contact-route checks (#781, part of #395). Every company, person and
// address below is SYNTHETIC and every source is a hand-built fixture: decide() is exercised directly with bounded,
// injected Snapshot[] fixtures, never a real fetch, never a model judge, never a paid call. Scope: a claimed person is
// verified as CURRENT (named, with the claimed title, tied to the company, no former-role marker on the source) and
// a claimed contact route is verified as printed on its own cited source, on the company's own domain, and not a
// generic hiring/recruiting inbox.
import test from 'node:test'
import assert from 'node:assert/strict'
import { blindClaim, type LeadClaim } from '../lib/verifier/claim.ts'
import { decide, isRecruitingMailbox, overall, type Snapshot } from '../lib/verifier/checks.ts'
import { linkedDomains, metadataDays, htmlToText } from '../lib/verifier/text.ts'

const AS_OF = '2026-11-06T12:00:00.000Z'
const WINDOW_DAYS = 90

const page = (body: string, head = '') => `<html><head><title>Synthetic</title>${head}</head><body>${body}</body></html>`
const snap = (url: string, html: string, opts: Partial<Snapshot> = {}): Snapshot => ({
  url, outcome: 'ok', final_url: url, text: htmlToText(html), truncated: false,
  meta_days: metadataDays(html), linked_domains: [...linkedDomains(html)], ...opts,
})

const OWN = 'https://harborledger.example/news/london-office'
const PEOPLE_PAGE = 'https://harborledger.example/about/leadership'
const BASE: LeadClaim = {
  company: 'Harbor Ledger Analytics', domain: 'harborledger.example',
  place: { city: 'London', country: 'United Kingdom' },
  event: { date: '2026-10-20', source_url: OWN, corroborating_urls: [] },
  person: null, contact: null,
}
const EVENT_SOURCE = snap(OWN, page('<p>Harbor Ledger Analytics opened its new London, United Kingdom office on October 20, 2026.</p>'))

const run = (claim: LeadClaim, sources: Snapshot[]) => decide({ claim, problems: [], sources, asOf: AS_OF, windowDays: WINDOW_DAYS })
const statusOf = (checks: ReturnType<typeof run>, check: string) => checks.filter(c => c.check === check).map(c => c.status)

test('current employer/title: named, title in the same passage, tied to the company -> person_current passes', () => {
  const claim: LeadClaim = { ...BASE, person: { name: 'Priya Raman', title: 'Chief Revenue Officer', source_url: PEOPLE_PAGE } }
  const html = page('<p>Priya Raman, Chief Revenue Officer at Harbor Ledger Analytics, leads the commercial team.</p>')
  const checks = run(claim, [EVENT_SOURCE, snap(PEOPLE_PAGE, html)])
  assert.deepEqual(statusOf(checks, 'person_current'), ['pass'])
})

test('former employee: a "formerly"/"until"/"ex-" marker next to the name fails, never passes', () => {
  const claim: LeadClaim = { ...BASE, person: { name: 'Priya Raman', title: 'Chief Revenue Officer', source_url: PEOPLE_PAGE } }
  for (const sentence of [
    'Priya Raman was formerly Chief Revenue Officer at Harbor Ledger Analytics.',
    'Priya Raman served as Chief Revenue Officer at Harbor Ledger Analytics until 2024.',
    'Ex-Harbor Ledger Analytics Chief Revenue Officer Priya Raman now advises startups.',
  ]) {
    const checks = run(claim, [EVENT_SOURCE, snap(PEOPLE_PAGE, page(`<p>${sentence}</p>`))])
    assert.deepEqual(statusOf(checks, 'person_current'), ['fail'], sentence)
    assert.match(checks.find(c => c.check === 'person_current')!.reason, /past role/)
    assert.notEqual(overall(checks).action, 'accept', sentence)
  }
})

test('title not next to the name: unknown, not a pass - the claim is unverified, not disproven', () => {
  const claim: LeadClaim = { ...BASE, person: { name: 'Priya Raman', title: 'Chief Revenue Officer', source_url: PEOPLE_PAGE } }
  const filler = 'Harbor Ledger Analytics continues to expand across several European markets this year. '.repeat(4)
  const html = page(`<p>Priya Raman joined the London team.</p><p>${filler}</p><p>Our Chief Revenue Officer role was created last year as part of this growth.</p>`)
  assert.deepEqual(statusOf(run(claim, [EVENT_SOURCE, snap(PEOPLE_PAGE, html)]), 'person_current'), ['unknown'])
})

test('name not on the source at all: fails (the readable page simply never mentions them)', () => {
  const claim: LeadClaim = { ...BASE, person: { name: 'Priya Raman', title: 'Chief Revenue Officer', source_url: PEOPLE_PAGE } }
  const html = page('<p>Harbor Ledger Analytics named a new Chief Revenue Officer this quarter.</p>')
  const checks = run(claim, [EVENT_SOURCE, snap(PEOPLE_PAGE, html)])
  assert.deepEqual(statusOf(checks, 'person_current'), ['fail'])
  assert.match(checks.find(c => c.check === 'person_current')!.reason, /is not named on/)
})

test('generic recruiting inbox is rejected as a buyer contact route, even when it is printed on a cited source at the right domain', () => {
  for (const mailbox of ['careers', 'jobs', 'talent.acquisition', 'hr', 'apply', 'recruiting+london']) {
    const email = `${mailbox}@harborledger.example`
    const claim: LeadClaim = { ...BASE, contact: { email, source_url: PEOPLE_PAGE } }
    const html = page(`<p>Reach our team at ${email}.</p>`)
    const checks = run(claim, [EVENT_SOURCE, snap(PEOPLE_PAGE, html)])
    assert.deepEqual(statusOf(checks, 'contact_not_recruiting'), ['fail'], mailbox)
    assert.notEqual(overall(checks).action, 'accept', mailbox)
  }
  // a named person's mailbox that merely contains a recruiting-looking substring is not a hiring inbox
  assert.equal(isRecruitingMailbox('hrishi@harborledger.example'), false)
  assert.equal(isRecruitingMailbox('jobsworth@harborledger.example'), false)
})

test('contact route on a different domain than the company: fails, never passes', () => {
  const claim: LeadClaim = { ...BASE, contact: { email: 'priya.raman@mailhost.example', source_url: PEOPLE_PAGE } }
  const html = page('<p>Reach Priya Raman at priya.raman@mailhost.example.</p>')
  const checks = run(claim, [EVENT_SOURCE, snap(PEOPLE_PAGE, html)])
  assert.deepEqual(statusOf(checks, 'contact_domain'), ['fail'])
  assert.notEqual(overall(checks).action, 'accept')
})

test('contact route not printed on its own cited source: fails, never passes', () => {
  const claim: LeadClaim = { ...BASE, contact: { email: 'priya.raman@harborledger.example', source_url: PEOPLE_PAGE } }
  const html = page('<p>Priya Raman leads the London office.</p>')
  const checks = run(claim, [EVENT_SOURCE, snap(PEOPLE_PAGE, html)])
  assert.deepEqual(statusOf(checks, 'contact_on_source'), ['fail'])
  assert.notEqual(overall(checks).action, 'accept')
})

test('genuine contact control: a named buyer-route address, on the company domain, printed on its cited source -> all three contact checks pass, accepted end to end with the event', () => {
  const claim: LeadClaim = {
    ...BASE,
    person: { name: 'Priya Raman', title: 'Chief Revenue Officer', source_url: PEOPLE_PAGE },
    contact: { email: 'priya.raman@harborledger.example', source_url: PEOPLE_PAGE },
  }
  const html = page('<p>Priya Raman, Chief Revenue Officer at Harbor Ledger Analytics. Reach her at priya.raman@harborledger.example.</p>')
  const checks = run(claim, [EVENT_SOURCE, snap(PEOPLE_PAGE, html)])
  for (const check of ['person_current', 'contact_not_recruiting', 'contact_domain', 'contact_on_source']) {
    assert.deepEqual(statusOf(checks, check), ['pass'], check)
  }
  assert.deepEqual(overall(checks), { verdict: 'pass', action: 'accept' })
})

test('unreadable contact source: the contact checks that need it are unknown, never fail - a verifier defect cannot sink a lead', () => {
  const claim: LeadClaim = { ...BASE, person: { name: 'Priya Raman', title: 'Chief Revenue Officer', source_url: PEOPLE_PAGE }, contact: { email: 'priya.raman@harborledger.example', source_url: PEOPLE_PAGE } }
  const checks = run(claim, [EVENT_SOURCE, snap(PEOPLE_PAGE, '', { outcome: 'error', text: '' })])
  assert.deepEqual(statusOf(checks, 'person_current'), ['unknown'])
  assert.deepEqual(statusOf(checks, 'contact_on_source'), ['unknown'])
  // domain and recruiting-inbox checks are decided from the email address itself, not the source, so they still run
  assert.deepEqual(statusOf(checks, 'contact_domain'), ['pass'])
  assert.deepEqual(statusOf(checks, 'contact_not_recruiting'), ['pass'])
  assert.notEqual(overall(checks).action, 'accept')
})

test('blindClaim takes person/contact only through the allowlisted fields and nothing else', () => {
  const { claim, dropped } = blindClaim({
    ...BASE,
    person: { name: 'Priya Raman', title: 'Chief Revenue Officer', source_url: PEOPLE_PAGE, confidence: 0.9 },
    contact: { email: 'priya.raman@harborledger.example', source_url: PEOPLE_PAGE, verified_by_producer: true },
  })
  assert.deepEqual(claim.person, { name: 'Priya Raman', title: 'Chief Revenue Officer', source_url: PEOPLE_PAGE })
  assert.deepEqual(claim.contact, { email: 'priya.raman@harborledger.example', source_url: PEOPLE_PAGE })
  assert.ok(dropped.includes('person.confidence'))
  assert.ok(dropped.includes('contact.verified_by_producer'))
})

// Regression cases for the independent review of this PR: each of these previously made a false pass or a false
// fail possible.

test('an unrelated company mention far from the name does not bind the title to the claimed company', () => {
  const claim: LeadClaim = { ...BASE, person: { name: 'Priya Raman', title: 'Chief Revenue Officer', source_url: PEOPLE_PAGE } }
  const filler = 'This masthead profiles leaders across several unrelated firms in the sector. '.repeat(4)
  const html = page(`<p>Priya Raman, Chief Revenue Officer at RivalCo, spoke at a conference.</p><p>${filler}</p><p>Harbor Ledger Analytics was also mentioned in passing.</p>`)
  assert.deepEqual(statusOf(run(claim, [EVENT_SOURCE, snap(PEOPLE_PAGE, html)]), 'person_current'), ['unknown'])
})

test('a bare "was <title>" copula states a historical role and fails, even with no "formerly"/"until"/"ex-" marker', () => {
  const claim: LeadClaim = { ...BASE, person: { name: 'Priya Raman', title: 'Chief Revenue Officer', source_url: PEOPLE_PAGE } }
  const html = page('<p>In 2019, Priya Raman was Chief Revenue Officer at Harbor Ledger Analytics.</p>')
  const checks = run(claim, [EVENT_SOURCE, snap(PEOPLE_PAGE, html)])
  assert.deepEqual(statusOf(checks, 'person_current'), ['fail'])
  assert.notEqual(overall(checks).action, 'accept')
  // "was named/appointed/promoted/elected/hired/made <title>" is a current-appointment announcement, not historical
  const appointed = page('<p>Priya Raman was named Chief Revenue Officer at Harbor Ledger Analytics this quarter.</p>')
  assert.deepEqual(statusOf(run(claim, [EVENT_SOURCE, snap(PEOPLE_PAGE, appointed)]), 'person_current'), ['pass'])
})

test('a different (longer, or suffixed) address does not satisfy contact_on_source - only the exact printed address does', () => {
  const claim: LeadClaim = { ...BASE, contact: { email: 'ann@harborledger.example', source_url: PEOPLE_PAGE } }
  for (const html of [
    page('<p>Reach us at joann@harborledger.example.</p>'),
    page('<p>Reach us at ann@harborledger.example.evil.</p>'),
  ]) {
    assert.deepEqual(statusOf(run(claim, [EVENT_SOURCE, snap(PEOPLE_PAGE, html)]), 'contact_on_source'), ['fail'], html)
  }
})

test('former-role wording about a DIFFERENT employer, in its own clause, does not reject an explicit current claim at the claimed company', () => {
  const claim: LeadClaim = { ...BASE, person: { name: 'Priya Raman', title: 'Chief Revenue Officer', source_url: PEOPLE_PAGE } }
  const html = page('<p>Priya Raman, formerly VP at OldCo, is now Chief Revenue Officer at Harbor Ledger Analytics.</p>')
  assert.deepEqual(statusOf(run(claim, [EVENT_SOURCE, snap(PEOPLE_PAGE, html)]), 'person_current'), ['pass'])
})

test('a title substring inside an unrelated word does not count as the claimed title', () => {
  const claim: LeadClaim = { ...BASE, person: { name: 'Priya Raman', title: 'COO', source_url: PEOPLE_PAGE } }
  const html = page('<p>Priya Raman coordinates sales efforts at Harbor Ledger Analytics.</p>')
  assert.deepEqual(statusOf(run(claim, [EVENT_SOURCE, snap(PEOPLE_PAGE, html)]), 'person_current'), ['unknown'])
})

test('qualified recruiting aliases (careers-emea@, jobs-uk@, recruitment-team@) are still rejected as hiring inboxes', () => {
  for (const mailbox of ['careers-emea', 'jobs-uk', 'recruitment-team']) {
    assert.equal(isRecruitingMailbox(`${mailbox}@harborledger.example`), true, mailbox)
  }
  // look-alikes still allowed: a delimiter must actually follow the recruiting base word
  assert.equal(isRecruitingMailbox('hrishi@harborledger.example'), false)
  assert.equal(isRecruitingMailbox('jobsworth@harborledger.example'), false)
})

test('a malformed address with trailing punctuation is rejected by blindClaim, never reaches the checks', () => {
  const { claim, problems } = blindClaim({ ...BASE, contact: { email: 'buyer@acme.com.', source_url: PEOPLE_PAGE } })
  assert.equal(claim.contact, null)
  assert.ok(problems.includes('contact is malformed'))
})
