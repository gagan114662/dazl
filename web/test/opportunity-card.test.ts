import { test } from 'node:test'
import assert from 'node:assert/strict'
import { opportunityCard, type CardLead } from '../lib/scan/opportunity.ts'

// Owner direction #204: why this business, why now (dated source), who (with identity), angle, facts / assumptions /
// missing, one next action. Built only from stored data; an opening is never presented as proof of buyer intent.
const NOW = new Date('2026-10-26T12:00:00Z')
const base: CardLead = {
  company: 'Bright Teeth Studio', signal: 'Opened a second Brooklyn location', source_url: 'https://news.example/bright',
  evidence_excerpt: 'Bright Teeth Studio opened its second Brooklyn location', event_date: '2026-10-10', date_status: 'verified',
  review_reason: null, fit: 5, intent: 0, why: 'Expanding practice; a second site needs front-desk staff now.',
  icp_match: JSON.stringify({ role: 'match', industry: 'match', size: 'unknown', location: 'match', note: '' }),
  company_domain: 'brightteeth.example', contact: null,
  enrichments: [
    { connector: 'sitecrawl', kind: 'domain', value: 'brightteeth.example|evidence_link_domain_label', label: 'x', source_url: 'https://news.example/bright' },
    { connector: 'sitecrawl', kind: 'person', value: 'Dana Lee, Practice Owner', label: 'x', source_url: 'https://brightteeth.example/team' },
    { connector: 'sitecrawl', kind: 'person', value: 'Ben Ortiz, Hygienist', label: 'x', source_url: 'https://brightteeth.example/team' },
    { connector: 'sitecrawl', kind: 'email', value: 'hello@brightteeth.example', label: 'x', source_url: 'https://brightteeth.example/contact' },
  ],
}

test('a strong lead: matched criteria, dated source, buyer-role person with a linked site, certainty split, draft next', () => {
  const c = opportunityCard(base, 'Practice owner', NOW)
  assert.equal(c.whyThisBusiness, 'Fits your profile (5/5): matches buyer role, industry, location.')
  assert.equal(c.whyNow.dateNote, 'dated 2026-10-10 (16 days ago), date confirmed on the page')
  assert.deepEqual(c.who, { name: 'Dana Lee', title: 'Practice Owner', link: 'https://brightteeth.example/team', identity: 'brightteeth.example: linked from the cited page' })
  assert.ok(c.facts.some(f => f.includes('quoted text is on the cited page')) && c.facts.some(f => f.includes('linked from the cited page')))
  assert.ok(c.assumptions.includes('The event is a reason to look closer, not proof they want to buy.'))
  assert.ok(c.assumptions.includes('No live buying trigger was confirmed.'))
  assert.deepEqual(c.missing, ['company size (not shown in the evidence)'])
  assert.equal(c.next, 'Draft a first message to Dana Lee about: Opened a second Brooklyn location')
})

test('a guessed site is an assumption, never a fact, and the next action is to confirm it', () => {
  const enr = base.enrichments!.map(e => e.kind === 'domain' ? { ...e, value: 'brightteeth.example|name_probe' } : e)
  const c = opportunityCard({ ...base, enrichments: enr }, 'Practice owner', NOW)
  assert.ok(!c.facts.some(f => f.includes('brightteeth.example')))
  assert.ok(c.assumptions.some(a => a.includes('found by name search')))
  assert.match(c.next, /^Confirm brightteeth\.example is their site/)
})

test('missing pieces are named and drive the next action', () => {
  const noPeople = opportunityCard({ ...base, enrichments: [] }, '', NOW)
  assert.equal(noPeople.who, null)
  assert.ok(noPeople.missing.includes('a named person to approach') && noPeople.missing.includes('an email or phone'))
  assert.equal(noPeople.next, 'Find the decision-maker before reaching out.')
  const unreachable = opportunityCard({ ...base, enrichments: base.enrichments!.filter(e => e.kind !== 'email') }, 'Practice owner', NOW)
  assert.equal(unreachable.next, 'Find a way to reach Dana Lee.')
})

test('review and quarantine override everything; ungraded and undated are said plainly', () => {
  assert.equal(opportunityCard({ ...base, review_reason: 'quote_unconfirmed' }, '', NOW).next, 'Check the source yourself before using this lead.')
  assert.equal(opportunityCard({ ...base, quarantined_at: 1 }, '', NOW).next, 'None: quarantined.')
  const bare = opportunityCard({ ...base, fit: null, icp_match: null, event_date: null, date_status: null }, '', NOW)
  assert.equal(bare.whyThisBusiness, 'Not graded against your profile yet.')
  assert.equal(bare.whyNow.dateNote, 'event date unknown')
  assert.ok(bare.missing.includes('event date') && bare.missing.includes('buyer role (not shown in the evidence)'))
})
