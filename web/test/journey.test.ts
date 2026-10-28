import { test } from 'node:test'
import assert from 'node:assert/strict'
import { heldReason, journey, previewSplit, type JourneyJob, type PreviewLead } from '../lib/journey.ts'

const lead = (o: Partial<PreviewLead> = {}): PreviewLead => ({
  id: 'l1', company: 'Bright Dental', signal: 'Opened a second office', source_url: 'https://news.example/a', evidence_excerpt: 'Bright Dental opened a second office',
  event_date: '2026-10-01', date_status: 'verified', review_reason: null, fit: 4, intent: 4, why: 'fits', icp_match: null,
  company_domain: 'brightdental.example', contact: 'hello@brightdental.example', quarantined_at: null, confidence: 90, human_confirmed_at: null,
  currentness_held: false, window_held: false, enrichments: [], ...o,
})
const job = (o: Partial<JourneyJob> = {}): JourneyJob => ({ id: 'a'.repeat(24), status: 'done', error: null, query: 'Dental owners in Ohio', csv_domain: null, created_at: 100, candidates: 3, verified: 1, needs_review: 1, dropped: 1, lead_count: 2, test_only: false, ...o })
const profile = { sells: 'Booking software', website: 'brightsmile.example' }

test('a verified, dated, in-window lead is an opportunity; its contact status is reported, not required', () => {
  const s = previewSplit([lead(), lead({ id: 'l2', contact: null })])
  assert.deepEqual(s.opportunities.map(l => [l.id, l.contactReady]), [['l1', true], ['l2', false]])
  assert.equal(s.held.length, 0)
})

test('wrong-company, undated, out-of-window, unverified, rejected and in-review leads never enter the preview', () => {
  const bad: [string, Partial<PreviewLead>][] = [
    ['needs your review', { review_reason: 'identity_mismatch' }],
    ['rejected', { quarantined_at: 1 }],
    ['source not verified', { evidence_excerpt: null, confidence: null }],
    ['outside your time window or undated', { window_held: true }],
    ['event timing unknown', { currentness_held: true }],
    ['no verified date', { event_date: null, date_status: 'undated' }],
    ['no verified date', { date_status: 'unverified' }],
    ['not a fit', { fit: 0, intent: null }],
  ]
  for (const [why, o] of bad) assert.equal(heldReason(lead(o)), why, why)
  const s = previewSplit(bad.map(([, o], i) => lead({ ...o, id: `b${i}` })))
  assert.equal(s.opportunities.length, 0)
  assert.equal(s.held.length, bad.length)
})

test('next action follows real state', () => {
  assert.equal(journey({ profile: null, jobs: [], leads: null, drafts: null }).stage, 'unknown')
  assert.equal(journey({ profile: {}, jobs: [], leads: null, drafts: null }).stage, 'no_profile')
  const none = journey({ profile, jobs: [], leads: null, drafts: null })
  assert.deepEqual([none.stage, none.action?.href], ['no_play', '/app/leads'])
  // Test fixtures and CSV imports are not plays.
  assert.equal(journey({ profile, jobs: [job({ test_only: true }), job({ csv_domain: 'x.com', query: null })], leads: null, drafts: null }).stage, 'no_play')
  const run = journey({ profile, jobs: [job({ created_at: 50 }), job({ id: 'c'.repeat(24), status: 'running', created_at: 10 })], leads: null, drafts: null })
  assert.deepEqual([run.stage, run.action?.href], ['running', `/app/leads?job_id=${'c'.repeat(24)}`], 'a running play wins over a newer finished one')
  assert.equal(journey({ profile, jobs: [job({ status: 'failed', error: 'key_rejected' })], leads: null, drafts: null }).stage, 'failed')
  const zero = journey({ profile, jobs: [job({ status: 'failed', error: 'no_candidates', candidates: 0, lead_count: 0 })], leads: null, drafts: null })
  assert.deepEqual([zero.stage, zero.line], ['zero', 'This play found 0 companies.'])
})

test('a lead list that did not load is unknown, never a zero', () => {
  const j = journey({ profile, jobs: [job()], leads: null, drafts: null })
  assert.equal(j.stage, 'unknown'); assert.doesNotMatch(j.line, /\b0\b/)
})

test('all held: zero opportunities, the held leads are counted separately', () => {
  const j = journey({ profile, jobs: [job()], leads: [lead({ review_reason: 'x' }), lead({ id: 'l2', window_held: true })], drafts: null })
  assert.equal(j.stage, 'all_held'); assert.equal(j.split?.opportunities.length, 0)
  assert.equal(j.line, '0 opportunities. 2 leads need review.')
})

test('useful: drafts come from the same campaign only; unknown drafts fall back to reviewing opportunities', () => {
  const id = 'a'.repeat(24)
  const withDrafts = journey({ profile, jobs: [job()], leads: [lead(), lead({ id: 'h', quarantined_at: 1 })], drafts: { drafts: 2, approved: 1 } })
  assert.deepEqual([withDrafts.stage, withDrafts.action?.label, withDrafts.action?.href], ['useful', 'Review 2 drafts', `/app/outreach?job_id=${id}`])
  assert.equal(withDrafts.line, '1 opportunity in this play.', 'the held lead does not inflate the count')
  const unknown = journey({ profile, jobs: [job()], leads: [lead()], drafts: null })
  assert.deepEqual([unknown.action?.label, unknown.action?.href], ['Review 1 opportunity', `/app/leads?job_id=${id}`])
})

test('profile edit: untouched constraints go back exactly; comma-bearing entries survive; only the edited field changes', async () => {
  const { editedBuyer, showList, LIST_FIELDS } = await import('../lib/journey.ts')
  const orig = { summary: 'B2B SaaS, 10-50 staff', who: ['Founder, CEO', 'Head of Sales'], industries: ['SaaS'], where: ['London, UK'], sizes: ['10-50 employees'], signals: ['Raised seed, last 90 days', 'Hiring sales'], exclude: ['Agencies, recruiters'] }
  const form = { summary: orig.summary, ...Object.fromEntries(LIST_FIELDS.map(k => [k, showList(orig[k])])) } as Parameters<typeof editedBuyer>[1]
  assert.deepEqual(editedBuyer(orig, form), orig, 'nothing edited: identical, "London, UK" is one entry')
  assert.deepEqual(editedBuyer(orig, { ...form, where: 'London, UK; Manchester, UK' }), { ...orig, where: ['London, UK', 'Manchester, UK'] }, 'an edited list splits on ";" only')
  const unchangedOthers = editedBuyer(orig, { ...form, industries: 'SaaS; Fintech' })
  for (const k of ['who', 'where', 'sizes', 'signals', 'exclude'] as const) assert.equal(unchangedOthers[k], orig[k], `${k} is the stored array itself`)
})
