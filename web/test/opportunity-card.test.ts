import { test } from 'node:test'
import assert from 'node:assert/strict'
import { opportunityCard, type CardLead } from '../lib/scan/opportunity.ts'

// Owner direction #204: why this business, why now (dated source), who (with identity), angle, facts / assumptions /
// missing, one next action. Built only from stored data; an opening is never presented as proof of buyer intent, an
// unverified identity is never a fact, and the next action never runs ahead of the outreach gates (Instinct, #207).
const NOW = new Date('2026-10-26T12:00:00Z')
type Row = NonNullable<CardLead['enrichments']>[number]
const dom = (site: string, token: string, url = 'https://news.example/bright'): Row => ({ connector: 'sitecrawl', kind: 'domain', value: `${site}|${token}`, label: `domain-basis-v1:${token}`, source_url: url })
const person: Row = { connector: 'sitecrawl', kind: 'person', value: 'Dana Lee, Practice Owner', label: 'x', source_url: 'https://brightteeth.example/team' }
const hygienist: Row = { connector: 'sitecrawl', kind: 'person', value: 'Ben Ortiz, Hygienist', label: 'x', source_url: 'https://brightteeth.example/team' }
const email: Row = { connector: 'sitecrawl', kind: 'email', value: 'hello@brightteeth.example', label: null, source_url: 'https://brightteeth.example/contact' }
const base: CardLead = {
  id: 'a'.repeat(24),
  company: 'Bright Teeth Studio', signal: 'Opened a second Brooklyn location', source_url: 'https://brightteeth.example/news',
  evidence_excerpt: 'Bright Teeth Studio opened its second Brooklyn location', event_date: '2026-10-10', date_status: 'verified',
  review_reason: null, fit: 5, intent: 0, why: 'Expanding practice; a second site needs front-desk staff now.', confidence: 90, human_confirmed_at: 1,
  icp_match: JSON.stringify({ role: 'match', industry: 'match', size: 'unknown', location: 'match', note: '' }),
  company_domain: 'brightteeth.example', contact: null, currentness_held: false, window_held: false,
  enrichments: [dom('brightteeth.example', 'evidence_own_domain', 'https://brightteeth.example/news'), person, hygienist, email],
}
const card = (over: Partial<CardLead>, roles = 'Practice owner') => opportunityCard({ ...base, ...over }, roles, NOW)

test('real evidence_own_domain: identity is a fact; draft is about the offer, the event only as context', () => {
  const c = card({})
  assert.equal(c.whyThisBusiness, 'Fits your profile (5/5): matches buyer role, industry, location.')
  assert.equal(c.whyNow.dateNote, 'dated 2026-10-10 (16 days ago), date confirmed on the page')
  assert.deepEqual(c.who, { name: 'Dana Lee', title: 'Practice Owner', link: 'https://brightteeth.example/team', identity: 'brightteeth.example: the cited page is on this site' })
  assert.ok(c.facts.includes('Company site brightteeth.example: the cited page is on this site.'))
  assert.ok(c.facts.includes('The quoted text was found on the cited page when the scan ran.'))
  assert.ok(c.assumptions.includes('No live buying trigger was confirmed.'))
  assert.deepEqual(c.missing, ['company size (not shown in the evidence)'])
  assert.equal(c.next, 'Draft a first message to Dana Lee introducing your offer; mention the event only as context.')
})

test('linked-but-unverified ownership is an assumption, never a fact, and must be confirmed first', () => {
  const c = card({ enrichments: [dom('brightteeth.example', 'evidence_link_domain_label'), person, email] })
  assert.ok(!c.facts.some(f => f.includes('brightteeth.example')))
  assert.ok(c.assumptions.some(a => a.includes('not proof the site is theirs')))
  assert.equal(c.next, 'Confirm brightteeth.example is their site before reaching out.')
})

test('unknown token and name probe never read as matched or linked', () => {
  const unk = card({ enrichments: [{ ...dom('brightteeth.example', 'something_new'), label: 'domain-basis-v1:something_new' }, person, email] })
  assert.ok(unk.assumptions.some(a => a.includes('how this site was chosen was not recorded')))
  assert.ok(!unk.facts.some(f => f.includes('brightteeth')))
  const probe = card({ enrichments: [dom('brightteeth.example', 'name_probe'), person, email] })
  assert.ok(probe.assumptions.some(a => a.includes('found by name search')))
  assert.match(probe.next, /^Confirm brightteeth\.example/)
})

test('weakest basis governs: a strong row does not outrank a weak one for the same site', () => {
  const c = card({ enrichments: [dom('brightteeth.example', 'evidence_own_domain'), dom('brightteeth.example', 'name_probe', 'https://brightteeth.example/'), person, email] })
  assert.ok(!c.facts.some(f => f.includes('brightteeth')))
  assert.match(c.next, /^Confirm/)
})

test('conflicting websites: not settled, no draft', () => {
  const c = card({ enrichments: [dom('brightteeth.example', 'evidence_own_domain'), dom('bright-teeth.example', 'evidence_link_domain_label'), person, email] })
  assert.equal(c.who!.identity.startsWith('several websites recorded'), true)
  assert.equal(c.next, 'Settle which website is theirs before reaching out.')
})

test('no domain provenance is a missing condition, not implicit verification', () => {
  const c = card({ enrichments: [person, email] })
  assert.ok(c.missing.includes('the company\'s own website'))
  assert.equal(c.next, 'Identify the company\'s own website before reaching out.')
  const cited = card({ enrichments: [person], contact: 'dana@brightteeth.example' })
  assert.equal(cited.who!.identity, 'address printed on the cited page')
  assert.match(cited.next, /^Draft a first message/)
})

test('a source-reviewed quote is the user\'s review, not a machine-checked fact', () => {
  const c = card({ confidence: null, human_confirmed_at: 5 })
  assert.ok(!c.facts.some(f => f.includes('quoted text')))
  assert.ok(c.assumptions.includes('You reviewed the quote yourself; dazl did not confirm it on the page.'))
})

test('hard window and currentness holds win over every recommendation', () => {
  assert.equal(card({ window_held: true }).next, 'None: outside the time window you asked for, or undated. Research only.')
  assert.equal(card({ window_held: true, event_date: null }).next, 'None: outside the time window you asked for, or undated. Research only.')
  assert.equal(card({ currentness_held: true }).next, 'Review the source to confirm the timing before any outreach.')
  assert.equal(card({ review_reason: 'quote_unconfirmed' }).next, 'Check the source yourself before using this lead.')
  assert.equal(card({ quarantined_at: 1, window_held: true }).next, 'None: quarantined.')
})

test('channel follows the contact evidence: phone only is not an email draft; a press inbox is not a sales contact', () => {
  const phoneOnly = card({ enrichments: [dom('brightteeth.example', 'evidence_own_domain'), person, { connector: 'sitecrawl', kind: 'phone', value: '+1 718 555 0100', label: null, source_url: 'https://brightteeth.example/contact' }] })
  assert.equal(phoneOnly.next, 'Call using the published number; there is no usable email to draft to.')
  assert.ok(!phoneOnly.missing.includes('an email or phone'))
  const press = card({ enrichments: [dom('brightteeth.example', 'evidence_own_domain'), person, { ...email, value: 'press@brightteeth.example' }] })
  assert.equal(press.next, 'Find a way to reach Dana Lee.')
  assert.ok(press.missing.includes('an email or phone'))
})

test('nobody found and ungraded/undated are said plainly', () => {
  const c = card({ enrichments: [], fit: null, icp_match: null, event_date: null, date_status: null }, '')
  assert.equal(c.who, null)
  assert.equal(c.whyThisBusiness, 'Not graded against your profile yet.')
  assert.equal(c.whyNow.dateNote, 'event date unknown')
  assert.ok(c.missing.includes('event date') && c.missing.includes('a named person to approach') && c.missing.includes('buyer role (not shown in the evidence)'))
  assert.equal(c.next, 'Find the decision-maker before reaching out.')
})
