import { test } from 'node:test'
import assert from 'node:assert/strict'
import { heldReason, journey, playDataFor, previewSplit, NO_OWN_BUYER, type JourneyJob, type PreviewLead } from '../lib/journey.ts'
import { readFileSync } from 'node:fs'
import { ownSiteBuyerRows } from './helpers/own-site-buyer.ts'

const lead = (o: Partial<PreviewLead> = {}): PreviewLead => ({
  id: 'l1', company: 'Bright Dental', signal: 'Opened a second office', source_url: 'https://news.example/a', evidence_excerpt: 'Bright Dental opened a second office',
  event_date: '2026-10-01', date_status: 'unverified', day_verified: true, review_reason: null, fit: 4, intent: 4, why: 'fits', icp_match: null,
  company_domain: 'brightdental.example', contact: 'hello@brightdental.example', quarantined_at: null, confidence: 90, human_confirmed_at: null,
  currentness_held: false, window_held: false, enrichments: ownSiteBuyerRows('brightdental.example'), ...o,   // #1037: names its buyer on its own site
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
    ['no verified date', { event_date: null, date_status: 'undated', day_verified: false }],
    ['no verified date', { day_verified: false }],   // a dated lead whose day no cited source proves
    ['no verified date', { day_verified: undefined, date_status: 'verified' }],   // the retired verdict (pre 2026-10-23 rows, no proof) never counts, #1176
    ['not a fit', { fit: 0, intent: null }],
    [NO_OWN_BUYER, { enrichments: [] }],   // #1037: nobody named on the company's own site
    [NO_OWN_BUYER, { enrichments: ownSiteBuyerRows('brightdental.example', { at: Math.floor(Date.now() / 1000) - 200 * 86_400 }) }],   // read on the site over 180 days ago: not current
    [NO_OWN_BUYER, { enrichments: ownSiteBuyerRows('brightdental.example').filter(r => r.kind === 'person') }],   // the site is not confirmed as the company's (no domain rows)
    [NO_OWN_BUYER, { enrichments: ownSiteBuyerRows('brightdental.example').map(r => r.kind === 'person' ? { ...r, label: 'listed with this title on this company page' } : r) }],   // listed, but the page links no LinkedIn
    [NO_OWN_BUYER, { enrichments: [...ownSiteBuyerRows('brightdental.example').filter(r => r.kind !== 'person'), { connector: 'search:people', kind: 'person', value: 'Dana Reyes, Head of Sales', label: 'public search result', source_url: 'https://www.linkedin.com/in/dana-reyes-example', confidence: null, source_date: '2026-11-20', retrieved_at: Math.floor(Date.now() / 1000) }] }],   // found by search, not on the company's site
    [NO_OWN_BUYER, { enrichments: [...ownSiteBuyerRows('brightdental.example').filter(r => r.kind !== 'person'), ...ownSiteBuyerRows('elsewhere.example').filter(r => r.kind === 'person')] }],   // a person read on ANOTHER site
    [NO_OWN_BUYER, { enrichments: ownSiteBuyerRows('brightdental.example').filter(r => r.kind !== 'domain_check').map(r => r.kind === 'domain' ? { ...r, value: 'brightdental.example|name_probe', label: 'domain-basis-v1:name_probe' } : r) }],   // the site was only GUESSED by name: its page cannot name the buyer
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
  const j = journey({ profile, jobs: [job()], leads: [lead({ review_reason: 'quote_unconfirmed' }), lead({ id: 'l2', review_reason: 'blocked_by_site' })], drafts: null })
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

test('#1037 a ready lead\'s card names the buyer its own site names, never a better-titled search or provider person', async () => {
  const { opportunityCard } = await import('../lib/scan/opportunity.ts')
  const at = Math.floor(Date.now() / 1000), day = new Date().toISOString().slice(0, 10)
  const others = [
    { connector: 'search:people', kind: 'person', value: 'Vic Park, VP Sales', label: 'public search result', source_url: 'https://www.linkedin.com/in/vic-park-example', confidence: null, source_date: day, retrieved_at: at },
    { connector: 'enrich:pdl', kind: 'contact', value: 'Pat Moe - VP Sales', label: 'People Data Labs, record dated ' + day, source_url: 'https://www.linkedin.com/in/pat-moe-example', confidence: null, source_date: day, retrieved_at: at },
  ]
  const l = lead({ enrichments: [...ownSiteBuyerRows('brightdental.example', { title: 'Sales Manager' }), ...others] })
  assert.equal(heldReason(l), null)
  const card = opportunityCard(l, 'VP Sales; Sales Manager')
  assert.deepEqual([card.who?.name, card.who?.title, card.who?.link], ['Dana Reyes', 'Sales Manager', 'https://www.linkedin.com/in/dana-reyes-example'])
})

test('#1037 a lead held only for its buyer is research "the rest of the lead is not confirmed yet", worded on Home', async () => {
  const { researchCause, heldState } = await import('../lib/lead-state.ts')
  const { holdWords } = await import('../lib/outreach/hold-words.ts')
  const l = lead({ enrichments: [] })
  assert.equal(heldReason(l), NO_OWN_BUYER)
  assert.equal(researchCause(l), 'need')
  assert.deepEqual(heldState(l), { state: 'research', cause: 'need' })
  assert.equal(holdWords(NO_OWN_BUYER, 1), "no buyer named on the company's own site")
})

// #1720: the Home Play card's title, link and leads all come from one play. Two one-off plays with different requests: the
// card shows the newest one, and its link is that same job, never the other play's.
test('#1720 two one-off plays: the card title (query) and its job id are the same play', () => {
  const OLD = 'a'.repeat(24), NEW = 'b'.repeat(24)
  const jobs = [job({ id: OLD, query: 'Marketing agencies hiring SDRs', created_at: 100 }), job({ id: NEW, query: 'Textile mills expanding', created_at: 200 })]
  const j = journey({ profile: { sells: 'Outbound tools' }, jobs, leads: null, drafts: null, watches: [] })
  assert.equal(j.play?.id, NEW)
  assert.equal(j.play?.query, 'Textile mills expanding')
  assert.match(j.action?.href ?? '', new RegExp(NEW))
  assert.doesNotMatch(j.action?.href ?? '', new RegExp(OLD))
})
test('#1720 data read for one play is never shown for another play (stale answers included)', () => {
  const A = 'a'.repeat(24), B = 'b'.repeat(24)
  const readA = { id: A, leads: [lead({ id: 'la' })], drafts: { drafts: 2, approved: 1 }, sent: 3 }
  const readB = { id: B, leads: [lead({ id: 'lb' })], drafts: null, sent: 0 }
  assert.equal(playDataFor(A, readA), readA, 'the play the data was read for')
  assert.equal(playDataFor(B, readA), null, 'the card moved to B: A\'s leads, drafts and sent count are not shown')
  assert.equal(playDataFor(A, readB), null, 'and the reverse')
  assert.equal(playDataFor(null, readA), null, 'no play on the card: nothing shown')
  assert.equal(playDataFor(A, null), null)
  // a late answer for A lands after the card moved to B: it is stored as A's, so B still shows none of it
  let stored: typeof readA | typeof readB | null = readB
  stored = readA
  assert.equal(playDataFor(B, stored), null)
  // and the journey for B built from that gate holds no leads (never A's leads under B's title)
  const jobs = [job({ id: A, query: 'Marketing agencies hiring SDRs', created_at: 100 }), job({ id: B, query: 'Textile mills expanding', created_at: 200 })]
  const shown = playDataFor(B, stored)
  const j = journey({ profile: { sells: 'Outbound tools' }, jobs, leads: shown?.leads ?? null, drafts: shown?.drafts ?? null, watches: [] })
  assert.equal(j.play?.id, B)
  assert.equal(j.stage, 'unknown', 'leads for B not read yet: unknown, not A\'s result')
})
test('#1720 Home reads every play\'s data through the id gate and drops answers that arrive for a play no longer shown', () => {
  const src = readFileSync(new URL('../app/app/journey.tsx', import.meta.url), 'utf8')
  assert.match(src, /playDataFor\(playId, playData\)/)
  assert.match(src, /return \(\) => \{ stale = true \}/)
  assert.doesNotMatch(src, /useState<PreviewLead\[\] \| null>/, 'no untagged leads state that outlives a change of play')
})
