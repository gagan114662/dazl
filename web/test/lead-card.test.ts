import { test } from 'node:test'
import assert from 'node:assert/strict'
import { approveState, leadCardSummary } from '../lib/scan/lead-card.ts'
import type { CardLead } from '../lib/scan/opportunity.ts'

const base: CardLead = {
  id: 'a'.repeat(24), company: 'Bright Dental', signal: 'Bright Dental opened a second office in Dublin, OH', source_url: 'https://www.news.example/bright',
  evidence_excerpt: 'Bright Dental opened a second office', event_date: '2026-10-01', date_status: 'unverified', review_reason: null,
  fit: 4, intent: 3, why: 'Two-location practice that matches your dental owner profile. It also hired staff.', icp_match: null,
  company_domain: 'brightdental.example', contact: 'hello@brightdental.example', confidence: 80, human_confirmed_at: null,
  enrichments: [],
}

test('the card shows company, contact, one line of why, source host and the claimed date', () => {
  const s = leadCardSummary(base)
  assert.equal(s.company, 'Bright Dental')
  assert.equal(s.contact, 'hello@brightdental.example')
  assert.equal(s.why, 'Two-location practice that matches your dental owner profile.')
  assert.equal(s.sourceHost, 'news.example')
  assert.equal(s.date, 'claimed event date 2026-10-01')
  assert.deepEqual(s.approve, { ok: true })
})

test('without a rationale the why line is the saved signal claim; unknowns stay unknown', () => {
  const s = leadCardSummary({ ...base, why: null, contact: null, event_date: null })
  assert.equal(s.why, base.signal)
  assert.equal(s.contact, null)
  assert.equal(s.date, 'event date unknown')
})

test('Approve is offered only when every existing draft condition holds', () => {
  const blocked = (l: Partial<CardLead>) => { const a = approveState({ ...base, ...l }); return a.ok ? null : a.reason }
  assert.match(blocked({ quarantined_at: 1 })!, /Rejected/)
  assert.match(blocked({ review_reason: 'quote_unconfirmed' })!, /could not confirm/)
  assert.match(blocked({ window_held: true })!, /time window/)
  assert.match(blocked({ confidence: null, human_confirmed_at: null })!, /Not verified/)
  assert.match(blocked({ fit: 0, intent: null })!, /not a fit/)
  assert.match(blocked({ contact: null })!, /No published email/)
  assert.match(blocked({ contact: 'privacy@brightdental.example' })!, /No published email/)
  assert.match(blocked({ currentness_held: true })!, /timing is unknown/)
  assert.equal(blocked({ confidence: null, human_confirmed_at: 1700000000 }), null, 'a lead you confirmed can be approved')
})

// Instinct #231: the compact card must never present an unconfirmed contact as the company's established contact.
type Row = NonNullable<CardLead['enrichments']>[number]
const dom = (site: string, token: string, url = 'https://news.example/bright'): Row => ({ connector: 'sitecrawl', kind: 'domain', value: `${site}|${token}`, label: `domain-basis-v1:${token}`, source_url: url })
const dana: Row = { connector: 'sitecrawl', kind: 'person', value: 'Dana Smith, Practice owner', label: 'x', source_url: 'https://name-guessed.example/team' }
const crawled = (e: string): Row => ({ connector: 'sitecrawl', kind: 'email', value: e, label: null, source_url: 'https://name-guessed.example/contact' })
const status = (over: Partial<CardLead>) => leadCardSummary({ ...base, ...over }, 'Practice owner').contactStatus

test("Instinct's repro: name-guessed website, crawled address and a listed person read as unconfirmed beside the contact", () => {
  const s = leadCardSummary({ ...base, contact: 'hello@name-guessed.example', company_domain: null, enrichments: [dom('name-guessed.example', 'name_probe', 'https://name-guessed.example/'), crawled('hello@name-guessed.example'), dana] }, 'Practice owner')
  assert.match(s.contact!, /Dana Smith, Practice owner/)
  assert.equal(s.contactStatus!.confirmed, false)
  assert.match(s.contactStatus!.text, /^Unconfirmed - name match only: name-guessed\.example: found by name search, not linked from the source\./)
  assert.match(s.contactStatus!.text, /Role as listed; current role not verified\./)
  assert.equal(s.approve.ok, false, 'drafting stays blocked')
})

test('conflicting websites: unconfirmed, names the competing sites', () => {
  const st = status({ contact: 'hello@a-dental.example', enrichments: [dom('a-dental.example', 'name_probe'), dom('b-dental.example', 'evidence_link_domain_label'), crawled('hello@a-dental.example')] })!
  assert.equal(st.confirmed, false)
  assert.match(st.text, /several websites recorded \(a-dental\.example, b-dental\.example\); which one is theirs is not settled/)
})

test('people with past or assistant titles are not shown as the buyer', () => {
  const former: Row = { ...dana, value: 'Pat Lee, Former practice owner' }
  const s = leadCardSummary({ ...base, enrichments: [dom('brightdental.example', 'evidence_own_domain', base.source_url), former] }, 'Practice owner')
  assert.doesNotMatch(s.contact!, /Pat Lee/)
  assert.match(s.contactStatus!.text, /Listed people have past, negated or assistant titles; no current buyer named\./)
})

test('a restricted-purpose inbox is labelled, never treated as a sales contact', () => {
  const st = status({ contact: 'privacy@brightdental.example' })!
  assert.equal(st.confirmed, false)
  assert.match(st.text, /Restricted inbox \(privacy\): not a sales contact\./)
})

test('quarantined: never reads as an established contact', () => {
  assert.deepEqual(status({ quarantined_at: 1 }), { confirmed: false, text: 'Quarantined or rejected: do not contact.' })
})

test('address printed on the cited page reads as confirmed, with its basis', () => {
  assert.deepEqual(status({}), { confirmed: true, text: 'Confirmed: address printed on the cited page.' })
  assert.equal(status({ contact: null }), null)
})
