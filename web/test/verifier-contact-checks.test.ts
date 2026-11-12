// Independent evidence verifier, person and contact-route checks (#781, part of #395). Every company, person and
// address below is SYNTHETIC and every source is a hand-built fixture: decide() is exercised directly with bounded,
// injected Snapshot[] fixtures, never a real fetch, never a model judge, never a paid call. Scope: a claimed person is
// verified as CURRENT (named, with the claimed title, tied to the company, no former-role marker on the source) and
// a claimed contact route is verified as printed on its own cited source, on the company's own domain, and not a
// generic hiring/recruiting inbox.
import test from 'node:test'
import assert from 'node:assert/strict'
import { blindClaim, type LeadClaim } from '../lib/verifier/claim.ts'
import { CHECK_VERSIONS, decide, isRecruitingMailbox, overall, type Snapshot } from '../lib/verifier/checks.ts'
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
  quotes: [], person: null, contact: null,
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

// #781 audit 9379b162 (2026-11-06 19:31Z): cross-employer proximity false pass. The role is explicitly attached to a
// rival employer; an unrelated mention of the claimed company within the same 250-character passage must not supply
// the employer relation.
test('explicit rival employer with the target named nearby, after or before: person_current never passes', () => {
  const claim: LeadClaim = { ...BASE, person: { name: 'Pat Example', title: 'Sales Director', source_url: PEOPLE_PAGE } }
  for (const text of [
    // the audited reproduction, verbatim shape
    'Harbor Ledger Analytics opened a Toronto, Canada office on October 8, 2026. Pat Example is Sales Director at Rival Corp. Harbor Ledger Analytics sponsored the conference.',
    // target mentioned only before
    'Harbor Ledger Analytics sponsored the conference. Pat Example is Sales Director at Rival Corp.',
    // target in the SAME sentence, role still attached to the rival
    'Harbor Ledger Analytics sponsored the panel where Pat Example, Sales Director at Rival Corp, spoke.',
    // possessive rival before the title
    'Rival Corp\'s Sales Director Pat Example spoke on a panel sponsored by Harbor Ledger Analytics.',
  ]) {
    const checks = run(claim, [EVENT_SOURCE, snap(PEOPLE_PAGE, page(`<p>${text}</p>`))])
    const pc = checks.find(c => c.check === 'person_current')!
    assert.notEqual(pc.status, 'pass', text)
    assert.notEqual(overall(checks).action, 'accept', text)
  }
  const named = run(claim, [EVENT_SOURCE, snap(PEOPLE_PAGE, page('<p>Harbor Ledger Analytics sponsored the panel where Pat Example, Sales Director at Rival Corp, spoke.</p>'))]).find(c => c.check === 'person_current')!
  assert.match(named.reason, /role at rival corp, not at "Harbor Ledger Analytics"/, 'the hold names the attached employer')
})

test('controls: a valid current appointment, a possessive target and "formerly at OldCo, now at Target" still pass', () => {
  const claim: LeadClaim = { ...BASE, person: { name: 'Pat Example', title: 'Sales Director', source_url: PEOPLE_PAGE } }
  for (const text of [
    'Harbor Ledger Analytics named Pat Example Sales Director this quarter.',
    'Pat Example, Sales Director at Harbor Ledger Analytics, leads the London team.',
    'Harbor Ledger Analytics\' Sales Director Pat Example spoke on the panel.',
    'Pat Example, formerly at Rival Corp, is now Sales Director at Harbor Ledger Analytics.',
    'Pat Example was named Sales Director at Harbor Ledger Analytics in October.',
  ]) assert.deepEqual(statusOf(run(claim, [EVENT_SOURCE, snap(PEOPLE_PAGE, page(`<p>${text}</p>`))]), 'person_current'), ['pass'], text)
})

test('the check version moved with the relationship rule', () => {
  assert.equal(CHECK_VERSIONS.person_current, 3)
})

// #781 follow-up (same audit class as 9379b162): the role must be tied POSITIVELY to the name and to the claimed
// company. Before this change every sentence below passed person_current on main, because only "<title> at <X>" and
// "<X>'s <title>" were read as an attached employer and anything else in the same sentence counted as the target's.
const PAT: LeadClaim = { ...BASE, person: { name: 'Pat Example', title: 'Sales Director', source_url: PEOPLE_PAGE } }
const pcOf = (claim: LeadClaim, text: string) => {
  const checks = run(claim, [EVENT_SOURCE, snap(PEOPLE_PAGE, page(`<p>${text}</p>`))])
  return { pc: checks.find(c => c.check === 'person_current')!, action: overall(checks).action }
}

test('#781: rival employer in any explicit shape (apposition, adjective, of/for/with, works at/joined ... as) never passes for the target', () => {
  for (const text of [
    'Pat Example (Sales Director, Rival Corp) thanked Harbor Ledger Analytics for hosting.',
    'Pat Example, Sales Director, Rival Corp, thanked Harbor Ledger Analytics for hosting.',
    'Rival Corp Sales Director Pat Example thanked Harbor Ledger Analytics for hosting.',
    'Pat Example, Rival Corp Sales Director, thanked Harbor Ledger Analytics for hosting.',
    'Pat Example, Sales Director of Rival Corp, thanked Harbor Ledger Analytics for hosting.',
    'Pat Example, Sales Director for Rival Corp, thanked Harbor Ledger Analytics for hosting.',
    'Pat Example, Sales Director with Rival Corp, thanked Harbor Ledger Analytics for hosting.',
    'Pat Example works at Rival Corp as Sales Director and praised Harbor Ledger Analytics.',
    'Pat Example joined Rival Corp as Sales Director after leaving Harbor Ledger Analytics.',
    'Pat Example is Sales Director at Rival Corp, a partner of Harbor Ledger Analytics.',
    'Pat Example is Rival Corp\u2019s Sales Director and met Harbor Ledger Analytics.',
    'Rival Corp named Pat Example Sales Director, Harbor Ledger Analytics said.',
    'Pat Example, Sales Director at Harbor Ledger Analytics\' London partner Rival Corp, spoke.',
  ]) {
    const { pc, action } = pcOf(PAT, text)
    assert.equal(pc.status, 'unknown', text)
    assert.notEqual(action, 'accept', text)
  }
})

test('someone else\'s title at the target, with the claimed person merely in the same sentence, never passes', () => {
  for (const text of [
    'Jane Doe, Sales Director at Harbor Ledger Analytics, introduced Pat Example.',
    'Pat Example met Jane Doe, Sales Director at Harbor Ledger Analytics.',
    'Pat Example thanked Harbor Ledger Analytics\' Sales Director for the invitation.',
  ]) {
    const { pc, action } = pcOf(PAT, text)
    assert.equal(pc.status, 'unknown', text)
    assert.match(pc.reason, /never states that Pat Example is "Harbor Ledger Analytics"'s Sales Director/, text)
    assert.notEqual(action, 'accept', text)
  }
})

test('#781: explicit current-role shapes at the target still pass', () => {
  for (const text of [
    'Pat Example, Sales Director, Harbor Ledger Analytics, spoke on the panel.',
    'Pat Example (Sales Director, Harbor Ledger Analytics) spoke on the panel.',
    'Pat Example - Sales Director, Harbor Ledger Analytics',
    'Pat Example, Harbor Ledger Analytics Sales Director, spoke on the panel.',
    'Pat Example is Sales Director of Harbor Ledger Analytics.',
    'Pat Example is the Sales Director at Harbor Ledger Analytics.',
    'Pat Example is Harbor Ledger Analytics\' Sales Director.',
    'Harbor Ledger Analytics hired Pat Example as Sales Director.',
    'Harbor Ledger Analytics has appointed Pat Example as its new Sales Director.',
    'Harbor Ledger Analytics promoted Pat Example to Sales Director in October.',
    'Pat Example joined Harbor Ledger Analytics as Sales Director in May.',
    'Meet Pat Example, Sales Director at Harbor Ledger Analytics.',
  ]) assert.equal(pcOf(PAT, text).pc.status, 'pass', text)
})

test('#781: former-role wording still fails once the role is positively bound', () => {
  for (const text of [
    'Pat Example, previously Sales Director at Harbor Ledger Analytics, now advises startups.',
    'Pat Example, Sales Director at Harbor Ledger Analytics until 2025, now runs Rival Corp.',
    'Pat Example, formerly Sales Director at Harbor Ledger Analytics, is now CEO at Rival Corp.',
  ]) {
    const { pc, action } = pcOf(PAT, text)
    assert.equal(pc.status, 'fail', text)
    assert.equal(action, 'skip', text)
  }
})

test('#781: adversarial inputs: regex metacharacters in names, huge sentences and repeated names stay fail-closed and fast', () => {
  const odd: LeadClaim = { ...BASE, company: 'Smith & Sons (UK) Ltd.', person: { name: 'Pat O\'Neil+', title: 'Head (Sales)', source_url: PEOPLE_PAGE } }
  const oddEvent = snap(OWN, page('<p>Smith & Sons (UK) Ltd. opened its new London, United Kingdom office on October 20, 2026.</p>'))
  const check = (text: string) => run(odd, [oddEvent, snap(PEOPLE_PAGE, page(`<p>${text}</p>`))]).find(c => c.check === 'person_current')!.status
  assert.equal(check('Pat O\'Neil+, Head (Sales) at Smith & Sons (UK) Ltd., leads the team.'), 'pass')
  assert.equal(check('Pat O\'Neil+, Head (Sales) at Rival Corp, met Smith & Sons (UK) Ltd. staff.'), 'unknown')
  // one enormous sentence with hundreds of name/title/company occurrences and no binding shape: bounded time, unknown
  const blob = 'Pat Example met Harbor Ledger Analytics and a Sales Director from Rival Corp '.repeat(800)
  const t0 = Date.now()
  const { pc } = pcOf(PAT, blob)
  assert.equal(pc.status, 'unknown')
  assert.ok(Date.now() - t0 < 5000, `took ${Date.now() - t0}ms`)
})
