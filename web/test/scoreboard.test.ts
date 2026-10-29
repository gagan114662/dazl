import test from 'node:test'
import assert from 'node:assert/strict'
import { scoreLead, scoreSearch, scoreboardMarkdown, isReachable, RUBRIC_VERSION, type ScoredLeadInput } from '../lib/scan/scoreboard.ts'
import { approveState } from '../lib/scan/lead-card.ts'

const NOW = new Date('2026-10-26T12:00:00Z')
const person = { connector: 'sitecrawl', kind: 'person', value: 'Pat Lee, Founder', label: null, source_url: 'https://acme.example/team' }
// A lead that every gate passes. Synthetic: no real company, host or person.
const good: ScoredLeadInput = {
  id: 'l1', company: 'Acme Dental', name: 'Pat Lee', signal: 'Opened a second office', source_url: 'https://news.example/a', contact: 'pat@acme.example', review_reason: null,
  event_date: '2026-10-01', date_status: 'verified', evidence_excerpt: 'Acme Dental opened a second office', confidence: 90, company_domain: 'acme.example', quarantined_at: null,
  fit: 5, intent: 4, contacts: [], enrichments: [person],
}

test('a verified, current, well-fitting lead with a right person and a sales-usable email is qualified and eligible', () => {
  const c = scoreLead(good, NOW)
  assert.deepEqual([c.sourceChecked, c.fit, c.currentEvent, c.rightPerson, c.email, c.eligible, c.qualified], [true, true, true, true, true, true, true])
  assert.ok(RUBRIC_VERSION.startsWith('qualified-v2'))
})

test('each missing condition alone disqualifies', () => {
  const no = (o: Partial<ScoredLeadInput>) => scoreLead({ ...good, ...o }, NOW).qualified
  assert.equal(no({ review_reason: 'quote_unconfirmed' }), false)
  assert.equal(no({ event_date: '2026-06-01' }), false)          // 147 days old
  assert.equal(no({ event_date: null, date_status: 'undated' }), false)
  assert.equal(no({ fit: 3 }), false)
  assert.equal(no({ fit: null }), false)                         // ungraded is not a fit
  assert.equal(no({ contact: null }), false)
  assert.equal(no({ enrichments: [] }), false)                   // a name from the page is not a right person
})

test('cannot be inflated: wrong-company contact, unverified claimed date, quarantine, generic hiring inbox, missing person', () => {
  const cases: [string, Partial<ScoredLeadInput>][] = [
    ['wrong-company contact (unconfirmed website, other domain)', { company_domain: null, contact: 'pat@other-company.example' }],
    ['claimed, unverified date', { date_status: 'unverified' }],
    ['quarantined lead', { quarantined_at: 1 }],
    ['generic hiring inbox', { contact: 'careers@acme.example' }],
    ['missing right person', { enrichments: [{ ...person, value: 'Sam Roe, Dental Hygienist' }] }],
    ['no person at all, name only', { enrichments: [], name: 'Pat Lee' }],
  ]
  for (const [why, o] of cases) assert.equal(scoreLead({ ...good, ...o }, NOW, { who: 'Practice owner' }).qualified, false, why)
})

test("the request's own window is honored: a 45-day-old event is out at 30 days, in at 180", () => {
  const l = { ...good, event_date: '2026-09-11' }
  assert.equal(scoreLead(l, NOW, { windowDays: 30 }).qualified, false)
  assert.equal(scoreLead(l, NOW, { windowDays: 180 }).qualified, true)
  assert.equal(scoreLead({ ...l, event_date: '2026-03-01' }, NOW, { windowDays: 180 }).qualified, false, 'older than 180 days')
})

test('phone is reported apart from email; a phone-only lead is qualified but not eligible to draft', () => {
  const phoneOnly = { ...good, contact: null, enrichments: [person, { connector: 'sitecrawl', kind: 'phone', value: '+1 (614) 555-0199', label: null, source_url: 'https://acme.example/contact' }] }
  const c = scoreLead(phoneOnly, NOW)
  assert.deepEqual([c.email, c.phone, c.eligible, c.qualified], [false, true, false, true])
})

test('the right role comes from the request: a founder-level title always counts, another title only when asked for', () => {
  const office = { ...good, enrichments: [{ ...person, value: 'Dana Fox, Office Manager' }] }
  assert.equal(scoreLead(office, NOW, { who: 'Practice owner' }).rightPerson, false)
  assert.equal(scoreLead(office, NOW, { who: 'Office manager' }).rightPerson, true)
})

test('reconciles with the cards: every qualified email lead can be drafted, and no card the product holds is counted', () => {
  const set: ScoredLeadInput[] = [good, { ...good, id: 'l2', quarantined_at: 1 }, { ...good, id: 'l3', review_reason: 'quote_unconfirmed' }, { ...good, id: 'l4', contact: 'jobs@acme.example' }, { ...good, id: 'l5', event_date: null, date_status: 'undated' }]
  const s = scoreSearch(set, NOW)
  assert.equal(s.qualified, 1); assert.ok(s.qualified <= s.eligible + s.phone)
  for (const l of set) { const c = scoreLead(l, NOW); if (c.qualified && c.email) assert.equal(c.eligible, true, l.id) }
  for (const k of ['sourceChecked', 'fit', 'currentEvent', 'rightPerson'] as const) assert.ok(s.qualified <= s[k], k)
})

test('reachable means an email or phone, not any text', () => {
  assert.equal(isReachable('Jane Doe - VP Sales'), false)
  assert.equal(isReachable('https://linkedin.com/in/jane'), false)
  assert.equal(isReachable('+1 (614) 555-0199'), true)
  assert.equal(isReachable('info@acme.co.uk'), true)
})

test('markdown reports every stage separately, flags incomplete searches, shows unique companies and the pinned rubric', () => {
  const s = scoreSearch([good, { ...good, id: 'l2', fit: 2 }], NOW)
  const md = scoreboardMarkdown([
    { search: 'Ohio | payroll', status: 'done', error: null, complete: true, score: s },
    { search: 'b', status: 'INCOMPLETE', error: 'budget_stopped', complete: false, score: scoreSearch([], NOW) },
  ], { commit: 'c', date: 'd', model: 'm', rubric: `${RUBRIC_VERSION}/r123`, uniqueQualified: 1, budgetUsd: 3 })
  assert.ok(md.includes('**Qualified leads: 1**') && md.includes('Ohio / payroll'))
  assert.ok(md.includes('Source-checked | Fit | Current event | Right person | Email | Phone | Eligible to draft | Qualified'))
  assert.ok(md.includes('**1 of 2 searches INCOMPLETE**') && md.includes('**1 unique companies**') && md.includes('r123') && md.includes('total budget $3'))
  assert.ok(md.includes('does not yet prove buyer need'))
})
