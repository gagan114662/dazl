// #781: person and contact-route verification (lib/evals/person-verify.ts) judged by the #394 contract's contact.usable.
// Acceptance: former employees and generic recruiting inboxes never pass. Unknown is never pass.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { freezeContract, evaluateLead, type Contract, type LeadEvidence } from '../lib/evals/contract.ts'
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
  const e: LeadEvidence = { company: 'Northwind Labs', claimed_domain: 'northwind.io', contact: contactEvidence(email, null, person) }
  const r = evaluateLead(freezeContract(contract), e); const v = r.verdicts.find(x => x.field === 'contact.usable')!
  return { status: v.status, why: v.rationale }
}

test('a fresh page saying the person is at the company confirms a current employee, and the title when stated', () => {
  const r = verifyPerson(P, [CUR], O); assert.equal(r.person, 'current'); assert.equal(r.title_matches, 'pass'); assert.deepEqual(r.evidence, ['https://news.example.com/p'])
  assert.deepEqual(contactStatus('jane@northwind.io', r), { status: 'pass', why: 'the email is at the company\'s domain and the contact is independently confirmed as a current employee' })
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
