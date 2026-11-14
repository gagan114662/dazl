import { test } from 'node:test'
import assert from 'node:assert/strict'
import { heldState, researchCause } from '../lib/lead-state.ts'
import { journey, previewSplit, type JourneyJob, type PreviewLead } from '../lib/journey.ts'
import { widenActions } from '../lib/play-card.ts'
import { readFileSync } from 'node:fs'
import { reviewAction } from '../lib/scan/review-action.ts'
import { REVIEWABLE, RESEARCH_REASONS, uncheckableCause } from '../lib/lead-state.ts'

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

test('only a hold a source check can settle, outside any time-window hold, is actionable review', () => {
  const dated = { event_date: '2026-10-01', date_status: 'unverified', day_verified: true }
  for (const r of ['quote_unconfirmed', 'blocked_by_site', 'needs_javascript', 'login_required', 'self_description', 'event_timing_unconfirmed', 'no_event_evidence']) assert.equal(heldState(lead({ ...dated, review_reason: r }))?.state, 'review', r)
  for (const r of ['counterparty_signal', 'job_closed', 'location_mismatch', 'sales_hiring_check_failed', 'something_new']) assert.equal(heldState(lead({ ...dated, review_reason: r }))?.state, 'research', r)
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
  const s = previewSplit([lead({ id: 'q', event_date: '2026-10-01', date_status: 'unverified', day_verified: true, review_reason: 'quote_unconfirmed' }), ...nyc])
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

test('#352 recovery record: research leads say what the automatic recovery pass already tried, or why it did not run; no record says nothing and nothing becomes ready', async () => {
  const { recoveryNote, CAUSE_TEXT } = await import('../lib/lead-state.ts')
  const rec = (label: string, value: string) => ({ connector: 'scan:recovery', kind: 'recovery', value, label, source_url: 'https://news.example/a' })
  // The exact strings recordRecovery (lib/scan/blocked-fallback.ts) writes.
  const customer = lead({ id: 'r1', review_reason: 'counterparty_signal', enrichments: [rec('recovery:counterparty_signal', 'Recovery pass ran before this was held (counterparty_signal): searched other press for a source about the company itself for the same company; none verified.')] })
  const undated = lead({ id: 'r2', review_reason: 'outside_window_undated', window_held: true, enrichments: [rec('recovery:undated', 'Recovery pass ran before this was held (undated): searched other press for a dated source for the same company; none verified.')] })
  const notRun = lead({ id: 'r3', review_reason: 'blocked_by_site', window_held: true, enrichments: [rec('recovery:blocked_by_site', 'Recovery pass did not run (the run disabled the paid fallback).')] })
  assert.deepEqual(recoveryNote(customer), { ran: true, text: 'dazl already searched other press for a source about the company itself; none verified.' })
  assert.deepEqual(recoveryNote(undated), { ran: true, text: 'dazl already searched other press for a dated source; none verified.' })
  assert.deepEqual(recoveryNote(notRun), { ran: false, text: 'dazl did not search other sources for it: this run allowed no extra search.' })
  assert.equal(recoveryNote(lead({ enrichments: [rec('recovery:undated', 'Recovery pass did not run (something new).')] }))?.text, 'dazl did not search other sources for it: the search was not available for this run.')
  assert.equal(recoveryNote(lead({ enrichments: [{ connector: 'scan:fallback', kind: 'fallback', value: 'x', label: 'other_sources', source_url: 'https://n.example' }] })), null)
  assert.equal(recoveryNote(lead()), null)
  // The record is display only: the NYC/London-shaped runs with it stay research_only, with zero actionable review.
  for (const leads of [[customer, undated], [customer, notRun]]) {
    const j = journey({ profile, jobs: [job], leads, drafts: null })
    assert.equal(j.stage, 'research_only'); assert.equal(j.split?.review.length, 0); assert.equal(j.split?.opportunities.length, 0)
  }
  for (const c of ['undated', 'older', 'customer', 'place', 'closed', 'unsupported'] as const) assert.ok(CAUSE_TEXT[c] && !/ready|review/i.test(CAUSE_TEXT[c]), c)
})

// #352 review follow-up (2026-11-03): Home (heldState) and the Leads view (reviewAction) must agree for EVERY hold reason. Before this change a visible lead held for
// no_event_evidence / no_sales_hiring_evidence / source_review_required / self_description / trial_budget_reached / a date it can vouch for was "research - checking it
// cannot make it ready" on Home while its card offered a draftable confirm; and sales_hiring_check_failed was offered a draftable confirm the draft gate refuses.
const REVIEW_LABEL_KEYS = (() => {
  const src = readFileSync(new URL('../app/app/leads/leads-client.tsx', import.meta.url), 'utf8')
  const body = /const REVIEW: Record<string, string> = \{([^\n]*)\}\r?\n/.exec(src)?.[1] ?? ''
  return [...body.matchAll(/(?:^|,)\s*([a-z_]+):/g)].map(m => m[1])
})()

test('#352 inventory: every reason the Leads view labels is classified exactly once (reviewable or research), and nothing else is', () => {
  assert.ok(REVIEW_LABEL_KEYS.length >= 20, `parsed ${REVIEW_LABEL_KEYS.length} labels`)
  for (const r of REVIEW_LABEL_KEYS) assert.equal(Number(REVIEWABLE.has(r)) + Number(RESEARCH_REASONS.has(r)), 1, r)
  for (const r of [...REVIEWABLE, ...RESEARCH_REASONS]) assert.ok(REVIEW_LABEL_KEYS.includes(r), `${r} has a Leads label`)
})

test('#352 Home and the Leads view agree for every reason, dated or undated, with and without a time-window hold', () => {
  for (const r of REVIEW_LABEL_KEYS) for (const date of [{ event_date: '2026-10-01', date_status: 'unverified', day_verified: true }, { event_date: null, date_status: 'undated' }]) for (const window_held of [false, true]) {
    const l = lead({ ...date, review_reason: r, window_held })
    const home = heldState(l)?.state, keep = reviewAction(l, new Date('2026-11-03T12:00:00Z')).label === 'Keep as research'
    assert.equal(home === 'research', keep, `${r} ${date.event_date ?? 'undated'} window_held=${window_held}: home=${home} card=${keep ? 'keep' : 'confirm'}`)
  }
})

test('#352 the original gap: a visible no_event_evidence lead is actionable review on Home (not "cannot make it ready"); sales_hiring_check_failed is research on both', () => {
  const ne = lead({ id: 'n', review_reason: 'no_event_evidence', event_date: '2026-10-20', date_status: 'unverified', day_verified: true })
  const j = journey({ profile, jobs: [job], leads: [ne], drafts: null })
  assert.equal(j.stage, 'all_held'); assert.equal(j.split?.review.length, 1); assert.equal(j.split?.research.length, 0); assert.doesNotMatch(j.line, /cannot make/)
  assert.notEqual(reviewAction(ne).label, 'Keep as research')
  const gate = lead({ id: 'g', review_reason: 'sales_hiring_check_failed', event_date: '2026-10-20', date_status: 'unverified', day_verified: true })
  assert.equal(heldState(gate)?.state, 'research'); assert.equal(reviewAction(gate).label, 'Keep as research'); assert.match(reviewAction(gate).hint, /sales-hiring check could not run/)
  assert.equal(journey({ profile, jobs: [job], leads: [gate], drafts: null }).stage, 'research_only')
})

test('#352 malformed reasons fail closed to research on Home and never crash either surface', () => {
  for (const r of ['constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf', '', ' quote_unconfirmed', 'QUOTE_UNCONFIRMED', 'x'.repeat(100_000), '\u0000', '\ud800bad']) {
    const l = lead({ review_reason: r, event_date: '2026-10-01', date_status: 'unverified', day_verified: true })
    const h = heldState(l)
    if (r === '') { assert.equal(h, null, 'an empty reason is no review reason: the lead is not held by it'); continue }
    assert.equal(h?.state, 'research', JSON.stringify(r.slice(0, 20)))
    assert.equal(typeof researchCause(l), 'string', 'the cause is one of the named causes, never an Object.prototype member')
    assert.ok(['undated', 'older', 'customer', 'place', 'closed', 'unsupported'].includes(researchCause(l)), r.slice(0, 20))
    assert.equal(typeof reviewAction(l).label, 'string')
  }
  for (const bad of [null, undefined, 42, {}, [], true] as unknown[]) {
    const l = lead({ review_reason: bad as string, event_date: '2026-10-01', date_status: 'unverified', day_verified: true })
    assert.doesNotThrow(() => heldState(l)); assert.doesNotThrow(() => reviewAction(l))
    assert.notEqual(heldState(l)?.state, 'review', String(bad))
  }
})

test('#352 recovery note: a malformed or prototype-named record never renders a function or crashes', async () => {
  const { recoveryNote } = await import('../lib/lead-state.ts')
  const rec = (label: string | null, value: string) => ({ enrichments: [{ connector: 'scan:recovery', label, value }] })
  assert.equal(recoveryNote(rec('recovery:constructor', 'Recovery pass ran before this was held'))?.text, 'dazl already searched other press for another source; none verified.')
  assert.equal(recoveryNote(rec('recovery:x', 'Recovery pass did not run (constructor).'))?.text, 'dazl did not search other sources for it: the search was not available for this run.')
  assert.equal(recoveryNote(rec(null, 'Recovery pass did not run (toString).'))?.text, 'dazl did not search other sources for it: the search was not available for this run.')
})

test('#683 round 2: uncheckableCause covers a failed REQUIRED gate, not just the three original reasons', () => {
  for (const r of ['counterparty_signal', 'location_mismatch', 'job_closed', 'sales_hiring_check_failed']) assert.ok(uncheckableCause(r), r)
  assert.equal(uncheckableCause('sales_hiring_check_failed'), 'unsupported')
  assert.equal(uncheckableCause('quote_unconfirmed'), null) // a reviewable reason is not uncheckable
  assert.equal(uncheckableCause(null), null)
  assert.equal(uncheckableCause(undefined), null)
})
