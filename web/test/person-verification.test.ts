// #781: person and contact-route verification (lib/evals/person-verify.ts) judged by the #394 contract's contact.usable.
// Acceptance: former employees and generic recruiting inboxes never pass. Unknown is never pass.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { freezeContract, evaluateLead, SCORER, type Contract, type LeadEvidence } from '../lib/evals/contract.ts'
import { verifyPerson, contactEvidence, statedDays, type PersonPage } from '../lib/evals/person-verify.ts'

const contract: Contract = {
  schema: 'dazl.evaluation-contract/1', id: 'person-contact-781', version: 1, as_of: '2026-11-10', brief: { seller: 'Acme', offer: 'revops' },
  constraints: { places: [], industries: [], event_kinds: ['hiring'], window_days: 30, min_independent_sources: 2, require_consent: false },
}
const P = { name: 'Jane Doe', company: 'Northwind Labs', title: 'VP of Sales' }
const O = { as_of: '2026-11-10' }
const page = (text: string, url = 'https://news.example.com/p'): PersonPage => ({ url, text })
const CUR = page('Updated October 20, 2026. Jane Doe is the VP of Sales at Northwind Labs.')
const contactStatus = (email: string | null, person: Parameters<typeof contactEvidence>[2]) => {
  const e: LeadEvidence = { company: 'Northwind Labs', claimed_domain: 'northwind.io', contact: contactEvidence(email, null, person, P.name) }
  const r = evaluateLead(freezeContract(contract), e); const v = r.verdicts.find(x => x.field === 'contact.usable')!
  return { status: v.status, why: v.rationale }
}

test('a fresh page saying the person is at the company confirms a current employee, and the title when stated', () => {
  const r = verifyPerson(P, [CUR], O); assert.equal(r.person, 'current'); assert.equal(r.title_matches, 'pass'); assert.deepEqual(r.evidence, ['https://news.example.com/p'])
  assert.deepEqual(contactStatus('jane@northwind.io', r), { status: 'pass', why: 'the email is at the company\'s domain, carries the confirmed person\'s name, and that person is independently confirmed as a current employee' })
})

test('former employee: a fresh page saying they left makes them former, and the contact fails', () => {
  for (const text of [
    'Posted 2026-10-02. Jane Doe, formerly VP of Sales at Northwind Labs, joined Acme.',
    'Posted 2026-10-02. Jane Doe left Northwind Labs in September.',
    'Posted 2026-10-02. Jane Doe is a Northwind Labs alumna.',
    'Posted 2026-10-02. Jane Doe was VP of Sales at Northwind Labs until 2025.',
    'Posted 2026-10-02. Jane Doe has stepped down from Northwind Labs.',
  ]) { const r = verifyPerson(P, [page(text)], O); assert.equal(r.person, 'former', text); assert.equal(contactStatus('jane@northwind.io', r).status, 'fail') }
})

test('former beats current: one fresh page saying they left outweighs another saying they are there', () => {
  const r = verifyPerson(P, [CUR, page('Posted 2026-11-01. Jane Doe resigned from Northwind Labs.', 'https://other.example.org/x')], O)
  assert.equal(r.person, 'former'); assert.deepEqual(r.evidence, ['https://other.example.org/x'])
})

test('unknown is never pass: no pages, an undated page, a stale page, a future page, or a different company all leave the person unknown', () => {
  const cases: [string, PersonPage[]][] = [
    ['no pages', []],
    ['undated', [page('Jane Doe is the VP of Sales at Northwind Labs.')]],
    ['stale (over a year old)', [page('Posted 2024-03-01. Jane Doe is the VP of Sales at Northwind Labs.')]],
    ['after as_of', [page('Posted 2026-12-01. Jane Doe is the VP of Sales at Northwind Labs.')]],
    ['a same-name person at another company', [page('Posted 2026-10-20. Jane Doe is the VP of Sales at Contoso.')]],
    ['the company without the person', [page('Posted 2026-10-20. Northwind Labs is hiring a VP of Sales.')]],
    ['a sentence with no present-tense cue', [page('Posted 2026-10-20. Jane Doe, Northwind Labs.')]],
  ]
  for (const [name, pages] of cases) { const r = verifyPerson(P, pages, O); assert.equal(r.person, 'unknown', name); assert.equal(contactStatus('jane@northwind.io', r).status, 'unknown', name) }
})

test('the freshness window is the caller\'s: a page one day past it is stale, on it is fresh', () => {
  const pg = page('Posted 2026-10-11. Jane Doe is the VP of Sales at Northwind Labs.')
  assert.equal(verifyPerson(P, [pg], { as_of: '2026-11-10', max_age_days: 30 }).person, 'current')
  assert.equal(verifyPerson(P, [pg], { as_of: '2026-11-10', max_age_days: 29 }).person, 'unknown')
})

test('generic and hiring inboxes never pass, whatever the person check says', () => {
  const cur = verifyPerson(P, [CUR], O)
  for (const m of ['careers@northwind.io', 'jobs@northwind.io', 'hr@northwind.io', 'talent.acquisition@northwind.io', 'recruiting+sales@northwind.io', 'info@northwind.io', 'sales@northwind.io', 'support@northwind.io', 'hello@northwind.io', 'no-reply@northwind.io', 'noreply@northwind.io', 'customer.service@northwind.io', 'contact@northwind.io'])
    assert.equal(contactStatus(m, cur).status, 'fail', m)
  assert.equal(contactStatus('jane@northwind.io', cur).status, 'pass')
  assert.equal(contactStatus('jane.info@northwind.io', cur).status, 'pass', 'a name that merely contains a role word is a person')
})

test('the route must be at the company\'s domain, and an unconfirmed person stays unknown even at the right domain', () => {
  const cur = verifyPerson(P, [CUR], O), unk = verifyPerson(P, [], O)
  assert.equal(contactStatus('jane@gmail.com', cur).status, 'fail')
  assert.equal(contactStatus('jane@northwind.io', unk).status, 'unknown')
  assert.equal(contactStatus(null, cur).status, 'unknown')
})

test('a contact with no person check (older evidence) is judged by the route alone, as before', () => {
  const e: LeadEvidence = { company: 'Northwind Labs', claimed_domain: 'northwind.io', contact: { email: 'jane@northwind.io' } }
  assert.equal(evaluateLead(freezeContract(contract), e).verdicts.find(x => x.field === 'contact.usable')!.status, 'pass')
})

test('stated days: three forms, whole tokens, impossible days dropped', () => {
  assert.deepEqual(statedDays('2026-10-08 and October 9, 2026 and 10 Oct 2026').sort(), ['2026-10-08', '2026-10-09', '2026-10-10'])
  assert.deepEqual(statedDays('x2026-10-08x, 2026-02-30, Feb 30, 2026, 2026-13-01'), [])
})

test('reproducible: the same pages give the same result', () => {
  assert.equal(JSON.stringify(verifyPerson(P, [CUR], O)), JSON.stringify(verifyPerson(P, [CUR], O)))
})

// ---- review findings on #1030 (Greptile P1 x2, xhawk) ----

test('P1: a sentence that merely mentions the person and the company is not an employment statement', () => {
  for (const text of [
    'Posted 2026-10-20. Jane Doe is suing Northwind Labs.',
    'Posted 2026-10-20. Jane Doe is not employed by Northwind Labs.',
    'Posted 2026-10-20. Jane Doe is not at Northwind Labs.',
    'Posted 2026-10-20. Jane Doe has never worked for Northwind Labs.',
    'Posted 2026-10-20. Jane Doe is a critic of Northwind Labs.',
    'Posted 2026-10-20. Jane Doe is a customer of Northwind Labs.',
  ]) { const r = verifyPerson(P, [page(text)], O); assert.equal(r.person, 'unknown', text); assert.equal(contactStatus('jane@northwind.io', r).status, 'unknown', text) }
})

test('P1: "replaced X, who left the company" says nothing about the person; a former role at ANOTHER company is not a departure from this one', () => {
  assert.equal(verifyPerson(P, [page('Posted 2026-10-20. Jane Doe replaced John Smith, who left Northwind Labs.')], O).person, 'unknown')
  const r = verifyPerson(P, [page('Posted 2026-10-20. Jane Doe, former VP at Contoso, is VP of Sales at Northwind Labs.')], O)
  assert.equal(r.person, 'unknown', 'a departure cue in the same sentence blocks current: fail closed (review of #1030), it is never read as current')
  assert.equal(verifyPerson(P, [page('Posted 2026-10-20. Jane Doe, former VP at Contoso, now advises Fabrikam.')], O).person, 'unknown')
})

test('P1: a negated departure is not a departure: "no longer" with the company is former, "never left" is unknown', () => {
  assert.equal(verifyPerson(P, [page('Posted 2026-10-20. Jane Doe no longer works at Northwind Labs.')], O).person, 'former')
  assert.equal(verifyPerson(P, [page('Posted 2026-10-20. Jane Doe never left Northwind Labs.')], O).person, 'unknown')
})

test('P1: an unrelated date on the page does not make an old employment statement fresh', () => {
  const stale = page('Published 2020-01-01. Jane Doe is VP of Sales at Northwind Labs. Related news: Webinar, November 1, 2026.')
  assert.equal(verifyPerson(P, [stale], O).person, 'unknown')
  const undated = page('Jane Doe is VP of Sales at Northwind Labs. Webinar: 2026-11-01.')
  assert.equal(verifyPerson(P, [undated], O).person, 'unknown')
  assert.equal(verifyPerson(P, [page('Jane Doe is VP of Sales at Northwind Labs as of October 20, 2026.')], O).person, 'current', 'a date in the sentence itself is bound to it')
  assert.equal(verifyPerson(P, [page('Last updated 2026-10-20. Jane Doe is VP of Sales at Northwind Labs.')], O).person, 'current', 'the page\'s own labelled date is bound to it')
  assert.equal(verifyPerson(P, [page('Published 2020-01-01. Jane Doe left Northwind Labs. Updated 2026-10-20.')], O).person, 'former', 'a labelled update date counts')
})

test('xhawk: a former contact fails whether or not an email is on file', () => {
  const former = verifyPerson(P, [page('Posted 2026-10-02. Jane Doe left Northwind Labs.')], O)
  assert.equal(contactStatus(null, former).status, 'fail')
  const e: LeadEvidence = { company: 'Northwind Labs', claimed_domain: 'northwind.io', contact: { phone: '+1 416 555 0100', person: 'former' } }
  assert.equal(evaluateLead(freezeContract(contract), e).verdicts.find(x => x.field === 'contact.usable')!.status, 'fail')
})

test('xhawk: common and qualified generic role inboxes never pass, and a name that contains a role word does', () => {
  const cur = verifyPerson(P, [CUR], O)
  for (const m of ['reception@northwind.io', 'webmaster@northwind.io', 'sales-emea@northwind.io', 'support.us@northwind.io', 'customer.service.team@northwind.io', 'info2@northwind.io', 'postmaster@northwind.io', 'billing@northwind.io', 'legal@northwind.io', 'press+tips@northwind.io', 'donotreply@northwind.io', 'marketing.apac@northwind.io'])
    assert.equal(contactStatus(m, cur).status, 'fail', m)
  for (const m of ['jane@northwind.io', 'jane.info@northwind.io', 'info.doe@northwind.io', 'sales.jane@northwind.io', 'marketing-jane@northwind.io'])
    assert.equal(contactStatus(m, cur).status, 'pass', m)
})

test('xhawk: the changed contact verdicts carry a new scorer version, so persisted judgements can tell the algorithms apart', () => {
  assert.deepEqual(SCORER, { id: 'dazl.lead-contract', version: 3 })
  const e: LeadEvidence = { company: 'Northwind Labs', claimed_domain: 'northwind.io', contact: { email: 'jane@northwind.io' } }
  assert.deepEqual(evaluateLead(freezeContract(contract), e).scorer, { id: 'dazl.lead-contract', version: 3 })
})

// ---- Hermes-PC review of #1030 (head 40129cfc): seven leads that must not pass ----
const stat = (...texts: string[]) => verifyPerson(P, texts.map((x, i) => page(x, `https://s${i}.example.com/p`)), O).person

test('review 1: "is no longer at X" is a departure, not current', () => {
  for (const x of ['Posted 2026-11-01. Jane Doe is no longer at Northwind Labs.', 'Posted 2026-11-01. Jane Doe is no longer with Northwind Labs.', 'Posted 2026-11-01. Jane Doe no longer works for Northwind Labs.'])
    assert.equal(stat(x), 'former', x)
})

test('review 2: common departure phrasings are former, and a fresh current page does not outvote them', () => {
  for (const x of [
    'Posted 2026-11-01. Jane Doe, former VP of Sales of Northwind Labs, has joined Rival Inc.',
    'Posted 2026-11-01. Jane Doe, the ex-VP of Sales of Northwind Labs, now leads sales at Rival.',
    'Posted 2026-11-01. Jane Doe, who left Northwind Labs last month, now runs sales at Rival.',
    'Posted 2026-11-01. Jane Doe has departed from Northwind Labs.',
  ]) { assert.equal(stat(x), 'former', x); assert.equal(stat(CUR.text, x), 'former', 'with a fresh current page: ' + x) }
  assert.equal(stat('Posted 2026-11-01. Jane Doe replaced John Smith, who left Northwind Labs.'), 'unknown', 'a departure about somebody else says nothing about her')
})

test('review 3: present tense that is not employment is not current', () => {
  for (const x of ['Posted 2026-11-01. Jane Doe is speaking at Northwind Labs Summit next week.', 'Posted 2026-11-01. Jane Doe is an investor with Northwind Labs.', 'Posted 2026-11-01. Jane Doe is an advisor to Northwind Labs.', 'Posted 2026-11-01. Jane Doe is a customer of Northwind Labs.', 'Posted 2026-11-01. Jane Doe is attending the Northwind Labs conference.', 'Posted 2026-11-01. Jane Doe is the host at Northwind Labs Summit.', 'Posted 2026-11-01. Jane Doe is the VP of Sales at Northwind Labs and previously left Contoso.'])
    assert.equal(stat(x), 'unknown', x)
  assert.equal(stat('Posted 2026-11-01. Jane Doe is the VP of Sales at Northwind Labs.'), 'current')
})

test('review 4: only the page\'s OWN label dates the claim, never "updated" in the middle of a sentence', () => {
  assert.equal(stat('Jane Doe is the VP of Sales at Northwind Labs. We updated our cookie policy on 2026-11-01.'), 'unknown')
  assert.equal(stat('Jane Doe is the VP of Sales at Northwind Labs. The page was last updated by our team. Posted by Jane on 2026-11-01.'), 'unknown')
  assert.equal(stat('Jane Doe is the VP of Sales at Northwind Labs. We updated 2026-11-01 the pricing page.'), 'unknown', 'a verb "updated" followed by a date is not the page label')
  assert.equal(stat('Last updated 2026-11-01. Jane Doe is the VP of Sales at Northwind Labs.'), 'current', 'a page label that begins a sentence still counts')
  assert.equal(stat('Jane Doe is the VP of Sales at Northwind Labs. Updated: November 1, 2026.'), 'current')
})

test('review 5: an unrecognised person value is unknown at best, and a wrong-case FORMER is still former', () => {
  const ev = (person: unknown): LeadEvidence => ({ company: 'Northwind Labs', claimed_domain: 'northwind.io', contact: { email: 'jane@northwind.io', person: person as 'current', person_name: P.name } })
  const status = (person: unknown) => evaluateLead(freezeContract(contract), ev(person)).verdicts.find(v => v.field === 'contact.usable')!.status
  for (const v of ['maybe', 'yes', 'Current', 'true', 1, {}, '']) assert.equal(status(v), 'unknown', JSON.stringify(v))
  for (const v of ['FORMER', ' Former ']) assert.equal(status(v), 'fail', JSON.stringify(v))
  assert.equal(status('current'), 'pass')
})

test('review 6: the confirmed person must be tied to the address', () => {
  const cur = verifyPerson(P, [CUR], O); assert.equal(cur.person, 'current')
  const at = (email: string, name: string | null) => { const e: LeadEvidence = { company: 'Northwind Labs', claimed_domain: 'northwind.io', contact: contactEvidence(email, null, cur, name) }; return evaluateLead(freezeContract(contract), e).verdicts.find(v => v.field === 'contact.usable')! }
  assert.equal(at('bob@northwind.io', P.name).status, 'unknown'); assert.match(at('bob@northwind.io', P.name).rationale, /does not carry that person/)
  assert.equal(at('jane@northwind.io', P.name).status, 'pass'); assert.equal(at('jdoe@northwind.io', P.name).status, 'pass'); assert.equal(at('doe.j@northwind.io', P.name).status, 'pass')
  assert.equal(at('jane@northwind.io', null).status, 'unknown', 'a confirmation that does not say who it is about confirms no route')
})

test('review 7: malformed pages and arguments fail closed and never throw', () => {
  const run = (pages: unknown, p: unknown = P, o: unknown = O) => { let r: ReturnType<typeof verifyPerson> | undefined; assert.doesNotThrow(() => { r = verifyPerson(p as typeof P, pages as PersonPage[], o as typeof O) }); return r!.person }
  for (const [name, pages] of [['pages null', null], ['pages a string', 'x'], ['text null', [{ url: 'u', text: null }]], ['text a number', [{ url: 'u', text: 5 }]], ['url missing', [{ text: CUR.text }]], ['null entries', [null, undefined, 3]]] as [string, unknown][])
    assert.equal(run(pages), 'unknown', name)
  assert.equal(run([null, CUR]), 'current', 'a null entry among good pages is dropped, not fatal')
  assert.equal(run([CUR], null), 'unknown'); assert.equal(run([CUR], { name: 5, company: 'x' }), 'unknown'); assert.equal(run([CUR], P, { as_of: 'not-a-day' }), 'unknown'); assert.equal(run([CUR], P, null), 'unknown')
})
