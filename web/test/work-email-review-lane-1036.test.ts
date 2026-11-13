// #1036 live check (Hermes 2026-11-13 18:43Z): on staging the real lead "Benesch" (a law firm, settled site, "Chief Marketing
// Officer" read from its own site) sat under "Needs your review" because the scan found no event date, and there the Leads page
// showed no Find work email until "Keep as research" was clicked. Shape below: that lead's stored rows (person renamed).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { reviewLaneWorkEmailTargets } from '../lib/people/work-email-review-lane.ts'

const NOW = Date.parse('2026-11-13T18:40:00Z')
const row = (kind: string, value: string, over: Record<string, unknown> = {}) => ({ connector: 'sitecrawl', kind, value, label: null as string | null, source_url: 'https://www.beneschlaw.example/contact-us/', source_date: '2026-11-13', retrieved_at: Math.floor(NOW / 1000), confidence: null, ...over })
const settled = row('domain', 'beneschlaw.example|evidence_own_domain', { label: 'domain-basis-v1:evidence_own_domain', source_url: 'https://www.beneschlaw.example/' })
const lead = (over: Record<string, unknown> = {}) => ({ id: 'f3b9dfbc66e5b02de37efb68', contact: null, company: 'Benesch', quarantined_at: null, source_kind: 'query', human_confirmed_from: null, review_reason: 'outside_window_undated',
  enrichments: [settled, row('person', 'Jordan Hammond, Chief Marketing Officer')], ...over })
const WHO = 'Chief Marketing Officer; Managing Partner'

test('#1036 a lead still under "Needs your review" offers Find work email for its buyer (no "Keep as research" first)', () => {
  assert.deepEqual(reviewLaneWorkEmailTargets(lead(), WHO, NOW), [{ key: 'Jordan Hammond|Chief Marketing Officer', name: 'Jordan Hammond', title: 'Chief Marketing Officer' }])
  for (const reason of ['outside_window_undated', 'quote_unconfirmed', 'event_timing_unconfirmed', 'source_review_required'])
    assert.equal(reviewLaneWorkEmailTargets(lead({ review_reason: reason }), WHO, NOW).length, 1, reason)
})

test('#1036 review lane: no block for a rejected lead, a non-company row, an unsettled site, a fixture row or a person outside the buyer roles', () => {
  assert.deepEqual(reviewLaneWorkEmailTargets(lead({ quarantined_at: 1 }), WHO, NOW), [])
  for (const reason of ['author_post', 'counterparty_signal']) assert.deepEqual(reviewLaneWorkEmailTargets(lead({ review_reason: reason }), WHO, NOW), [], reason)
  assert.deepEqual(reviewLaneWorkEmailTargets(lead({ source_kind: 'test' }), WHO, NOW), [])
  const guessed = row('domain', 'beneschlaw.example|name_probe', { label: 'domain-basis-v1:name_probe' })
  assert.deepEqual(reviewLaneWorkEmailTargets(lead({ enrichments: [guessed, row('person', 'Jordan Hammond, Chief Marketing Officer')] }), WHO, NOW), [], 'website only guessed from the name')
  assert.deepEqual(reviewLaneWorkEmailTargets(lead({ enrichments: [row('person', 'Jordan Hammond, Chief Marketing Officer')] }), WHO, NOW), [], 'no website recorded')
  assert.deepEqual(reviewLaneWorkEmailTargets(lead({ enrichments: [settled, row('person', 'Brent Richards, General Manager')] }), 'Chief Marketing Officer', NOW), [], 'not a buyer role of this play')
  assert.deepEqual(reviewLaneWorkEmailTargets(lead({ enrichments: [settled] }), WHO, NOW), [])
})

test('#1036 the Leads page renders that block on every "Needs your review" row, with the same component as a decided lead', () => {
  const src = readFileSync(new URL('../app/app/leads/leads-client.tsx', import.meta.url), 'utf8')
  const lane = src.slice(src.indexOf('{leads.filter(l => l.review_reason).map(l => ('), src.indexOf('data-testid="review-actions"'))
  assert.match(lane, /reviewLaneWorkEmailTargets\(l, icp && icp\.icp\.who\.length > 0 \? icp\.icp\.who\.join\('; '\) : ''\)/)
  assert.match(lane, /data-testid="review-work-email"><WorkEmail leadId=\{l\.id\} targets=\{t\} \/>/)
})
