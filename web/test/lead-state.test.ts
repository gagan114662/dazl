import { test } from 'node:test'
import assert from 'node:assert/strict'
import { heldState, researchCause } from '../lib/lead-state.ts'
import { journey, previewSplit, type JourneyJob, type PreviewLead } from '../lib/journey.ts'
import { widenActions } from '../lib/play-card.ts'

// Synthetic leads shaped like the two reported failures: an undated customer-mention and a blocked, undated page.
// No real company, run id or URL.
const lead = (o: Partial<PreviewLead> = {}): PreviewLead => ({
  id: 'l1', company: 'Example Dental', signal: 'Opened a second office', source_url: 'https://news.example/a', evidence_excerpt: 'Example Dental opened a second office',
  event_date: null, date_status: 'undated', review_reason: null, fit: 4, intent: 4, why: 'fits', icp_match: null,
  company_domain: 'exampledental.example', contact: null, quarantined_at: null, confidence: 90, human_confirmed_at: null,
  currentness_held: false, window_held: false, enrichments: [], ...o,
})
const nyc = [lead({ id: 'a', review_reason: 'counterparty_signal', window_held: true }), lead({ id: 'b', review_reason: 'outside_window_undated', window_held: true })]
const london = [lead({ id: 'c', review_reason: 'counterparty_signal' }), lead({ id: 'd', review_reason: 'blocked_by_site', window_held: true })]
const job: JourneyJob = { id: 'a'.repeat(24), status: 'done', error: null, query: 'Dental owners in NYC opening a second office, past 90 days', csv_domain: null, created_at: 100, candidates: 2, verified: 0, needs_review: 2, dropped: 0, lead_count: 2, test_only: false }
const profile = { sells: 'Booking software' }

test('undated or customer-mention leads are research only, never actionable review', () => {
  for (const l of [...nyc, ...london]) assert.equal(heldState(l)?.state, 'research', l.id)
  assert.equal(researchCause(nyc[1]), 'undated')
  assert.equal(researchCause(london[1]), 'undated', 'a blocked page with no usable date is undated research')
  assert.equal(researchCause(london[0]), 'customer')
})

test('only a hold a source check can settle, on a lead whose date stands, is actionable review', () => {
  const dated = { event_date: '2026-10-01', date_status: 'verified' }
  for (const r of ['quote_unconfirmed', 'blocked_by_site', 'needs_javascript', 'login_required']) assert.equal(heldState(lead({ ...dated, review_reason: r }))?.state, 'review', r)
  for (const r of ['counterparty_signal', 'job_closed', 'location_mismatch', 'self_description', 'event_timing_unconfirmed', 'something_new']) assert.equal(heldState(lead({ ...dated, review_reason: r }))?.state, 'research', r)
  assert.equal(heldState(lead({ ...dated, review_reason: 'quote_unconfirmed', window_held: true }))?.state, 'research', 'older than the window: research')
  assert.equal(heldState(lead({ quarantined_at: 1 }))?.state, 'rejected')
  assert.equal(heldState(lead({ ...dated })), null, 'a ready lead is not held')
})

test('NYC and London shaped runs: zero actionable review, a research-only stage, no review CTA', () => {
  for (const leads of [nyc, london]) {
    const j = journey({ profile, jobs: [job], leads, drafts: null })
    assert.equal(j.stage, 'research_only'); assert.equal(j.split?.review.length, 0); assert.equal(j.split?.research.length, 2)
    assert.equal(j.split?.opportunities.length, 0)
    assert.doesNotMatch(j.action?.label ?? '', /review/i); assert.doesNotMatch(j.line, /need review|are ready|is ready/)
    assert.match(j.line, /research-only/); assert.match(j.line, /cannot make them ready/)
  }
})

test('a mixed run keeps review and research separate', () => {
  const s = previewSplit([lead({ id: 'q', event_date: '2026-10-01', date_status: 'verified', review_reason: 'quote_unconfirmed' }), ...nyc])
  assert.equal(s.review.length, 1); assert.equal(s.research.length, 2); assert.equal(s.held.length, 3)
  assert.equal(journey({ profile, jobs: [job], leads: [s.review[0]], drafts: null }).stage, 'all_held')
})

test('recovery never offers date widening for a missing date, and always offers a path that can change the result', () => {
  const icp = { window_days: 90, where: ['NYC'], signals: ['opening a second office'] }
  const undated = widenActions(job.query, icp, ['undated', 'customer']).map(a => a.testid)
  assert.ok(!undated.includes('widen-window'), 'no window widening for undated/customer leads')
  assert.ok(undated.includes('recover-dated') && undated.includes('widen-signal') && undated.includes('recover-source'))
  assert.ok(widenActions(job.query, icp, ['older']).map(a => a.testid).includes('widen-window'), 'a dated lead that was only too old can widen')
  assert.ok(widenActions(job.query, icp).map(a => a.testid).includes('widen-window'), 'no causes: the generic list is unchanged')
})
