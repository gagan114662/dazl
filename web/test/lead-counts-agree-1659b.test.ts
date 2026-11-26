// Quest's live check on production (2026-11-24, after #1659): four places where two numbers or labels for the same leads disagreed.
//  1. Leads page of an older-engine search: chips "1 needs your review, 4 research only" above ONE list headed "Needs your review" with all 5.
//  2. Home: "Latest leads (15 new)" (lead rows) beside "Not ready yet (12 of 13 companies checked)" + 1 ready (companies).
//  3. The same play: "8 new leads so far" on Plays (every run) beside a bare "4 new" in the repeating-searches box (its last run).
//  4. A lead card's "new" badge glued to the company name: the text read "<Company>new".
// Flags and counts only; no real company, person or URL.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { lastRunNewLabel, reviewListSplit } from '../lib/scan/leads-view.ts'
import { currentQual } from '../lib/run-status.ts'
import { reviewCanNameBuyer } from '../lib/people/buyer-reach.ts'
import { reviewAction } from '../lib/scan/review-action.ts'
import { latestLeadsCount } from '../lib/outreach/hold-words.ts'
import { newLabel } from '../lib/play-new-view.ts'
import type { PreviewLead } from '../lib/journey.ts'
import { ownSiteBuyerRows } from './helpers/own-site-buyer.ts'

const leadsPage = readFileSync(new URL('../app/app/leads/leads-client.tsx', import.meta.url), 'utf8')
const homePanel = readFileSync(new URL('../app/app/home-results.tsx', import.meta.url), 'utf8')

// The production search's shape: 6 saved older-engine leads, one source-checked and five carrying these review reasons. Only one of the
// five can still be made usable by a person's check: the others have no buyer a review can name, are held by the time window, or by a
// required check that has not passed.
const lead = (id: string, o: Partial<PreviewLead> = {}): PreviewLead => ({
  id, company: `Co ${id}`, signal: 'hiring', source_url: 'https://jobs.example/a', evidence_excerpt: null, event_date: '2026-11-12', date_status: 'unverified',
  review_reason: null, fit: 4, intent: 4, why: 'fits', icp_match: null, company_domain: `co-${id}.example`, contact: null, quarantined_at: null, confidence: null,
  human_confirmed_at: null, currentness_held: false, window_held: false, gate_held: false, enrichments: ownSiteBuyerRows(`co-${id}.example`), ...o,
})
const scan: PreviewLead[] = [
  lead('a', { evidence_excerpt: 'Co a is hiring', confidence: 80 }),
  lead('b', { review_reason: 'no_sales_hiring_evidence', enrichments: [] }),
  lead('c', { review_reason: 'needs_javascript', event_date: null, window_held: true }),
  lead('d', { review_reason: 'quote_unconfirmed', event_date: '2026-05-04', window_held: true }),
  lead('e', { review_reason: 'blocked_by_site' }),
  lead('f', { review_reason: 'blocked_by_site', gate_held: true }),
]

test('finding 1: the list under the Leads cards is split by the same verdict as the count line above it', () => {
  const split = reviewListSplit(scan)
  assert.deepEqual(split.review.map(l => l.id), ['e'], 'only the lead a check can still make usable is listed under Needs your review')
  assert.deepEqual(split.research.map(l => l.id), ['b', 'c', 'd', 'f'], 'the rest are listed under Research only')
  // the count line's rule (lib/run-status.ts currentQual, with the hold fields the Campaigns readers give it) says the same two numbers
  const q = currentQual(scan.map(l => ({ evidence_excerpt: l.evidence_excerpt, confidence: l.confidence ?? null, human_confirmed_at: null, review_reason: l.review_reason, quarantined_at: null,
    window_held: l.window_held, gate_held: l.gate_held, buyer_unreachable: !reviewCanNameBuyer({ id: l.id, contact: l.contact }, l.enrichments ?? []) })))
  assert.equal(split.review.length, q.needsReview)
  assert.equal(split.research.length, q.research)
  assert.equal(q.needsReview, 1); assert.equal(q.research, 4)
  // what the page asked before: "does any row have a confirm action". It knows nothing of the buyer rule, so it put all five under one review heading.
  assert.ok(scan.filter(l => l.review_reason && reviewAction(l).label !== 'Keep as research').length > split.review.length)
})

test('finding 1: a rejected lead with a reason and a lead without one are never review items', () => {
  const split = reviewListSplit([lead('r', { review_reason: 'blocked_by_site', quarantined_at: 1 }), lead('n')])
  assert.deepEqual(split.review, [])
  assert.deepEqual(split.research.map(l => l.id), ['r'])
})

test('finding 1: the Leads page renders the two lists from that split, each under its own heading', () => {
  assert.match(leadsPage, /const reviewSplit = reviewListSplit\(leads\)/)
  assert.match(leadsPage, /const unconfirmedTiming = leads\.filter\(l => l\.timing === 'unconfirmed' && !l\.review_reason && !l\.quarantined_at && l\.human_confirmed_at == null\)/)
  assert.match(leadsPage, /const researchLeads = \[\.\.\.reviewSplit\.research, \.\.\.unconfirmedTiming\]/)
  assert.match(leadsPage, /\[\['review', reviewSplit\.review\], \['research', researchLeads\]\] as const\)\.map\(\(\[part, rows\]\) => rows\.length > 0 && \(/)
  assert.doesNotMatch(leadsPage, /leads\.filter\(l => l\.review_reason\)\.map/, 'no single list of every lead with a reason')
  assert.doesNotMatch(leadsPage, /reviewAction\(l\)\.label !== 'Keep as research'\) \?/, 'the heading is not chosen by a second rule')
})

test('finding 2: the count beside Latest leads on Home is the companies the ready read judged, so ready + not ready add up to it', () => {
  // production: 15 lead rows in the window, 13 companies judged (1 ready + 12 not ready)
  assert.equal(latestLeadsCount(15, { judged: 13, capped: false }), '(13 new companies)')
  assert.equal(latestLeadsCount(1, { judged: 1, capped: false }), '(1 new company)')
  assert.equal(latestLeadsCount(15, null), '', 'no number while the ready read loads')
  // without a complete ready read the rows are counted, and named as rows that can repeat a company - never a bare "N new"
  for (const r of ['failed', { judged: 5, capped: true }] as const) {
    assert.equal(latestLeadsCount(15, r), '(15 found, counting a company once for each search that found it)')
    assert.doesNotMatch(latestLeadsCount(15, r), /\d+ new/)
  }
  assert.match(homePanel, /data-testid="new-leads">\{latestLeadsCount\(t\.leads, ready\)\}<\/span>/)
  assert.doesNotMatch(homePanel, /\(\{t\.leads\} new\)/)
})

test('finding 3: the repeating-searches box says its count is the last run, beside the Plays pill that counts every run', () => {
  assert.equal(lastRunNewLabel(4), 'last run: 4 new')
  assert.equal(lastRunNewLabel(0), 'last run: nothing new')
  assert.equal(newLabel(8, false), '8 new leads so far', 'the Plays pill (every finished run) is unchanged')
  assert.match(leadsPage, /data-testid="watch-new">\{lastRunNewLabel\(w\.new_leads\)\}<\/a>/)
  assert.doesNotMatch(leadsPage, /\{w\.new_leads\} new</, 'never a bare "N new" with no run named')
})

test('finding 4: a badge after a company name is separated from it by a space in the text', () => {
  // the decision card: new, Rejected and Approved badges each follow the name with a text space
  const title = leadsPage.slice(leadsPage.indexOf('<div className="font-semibold text-base leading-tight">'))
  const line = title.slice(0, title.indexOf('\n'))
  assert.equal(line.match(/&& <>\{' '\}<span className="ml-1"><Pill /g)?.length, 3)
  assert.doesNotMatch(line, /&& <span className="ml-2"><Pill /, 'no badge glued to the name')
  // the older row layout's badge too
  assert.equal(leadsPage.match(/\{!!l\.watch_new && <>\{' '\}<span /g)?.length, 2)
  assert.doesNotMatch(leadsPage, /\{!!l\.watch_new && <span /)
})

test('finding 5: a repeating search\'s name is in the page\'s ink colour, not the near-white of the old dark theme', () => {
  assert.match(leadsPage, /<span className="text-\[#111\] min-w-0 flex-1 truncate" title=\{w\.query\} data-testid="watch-query">\{w\.query\}<\/span>/)
})
