// Consumption-seam regressions for #379, adopted from the independent reviewer probes (PR #501): a reviewed
// correction reaches retrieval queries + the grader; finding prompts carry the canonical FLAT profile only (the
// research block is review provenance, never model targeting input); a dismissal is never resurrected by stale
// field text (explicit rejection precedence, and the rejected text leaves the effective fields).
// Run from web/: SITECRAWL_ENABLED=0 NEWS_SEARCH_ENABLED=0 node --experimental-strip-types --import ./test/helpers/net-fence.ts --test test/seller-research-379-consumption-seams.test.ts
import test from 'node:test'
import assert from 'node:assert/strict'
import { applyReviewedDraft, buildResearch, toStored, type SellerResearch, type FetchedPage } from '../lib/scan/seller-research.ts'
import { icpTextFor } from '../lib/scan/score.ts'
import { buildIcpPrompt } from '../lib/scan/runner.ts'
import { buildSourcePrompt } from '../lib/sources/index.ts'
import { queryPrompt } from '../lib/search/tinyfish.ts'
import type { Icp } from '../lib/scan/icp.ts'

const PAGES: FetchedPage[] = [{ url: 'https://acme.example/customers', kind: 'customers', title: 'C', text: 'Harbor Dental, a four-chair dental practice, cut no-shows. Elm Street Physio runs it too.', fetched_at: 1800000000 }]
const OUT = { offers: [{ id: 'o1', name: 'Booking' }], items: [
  { offer: 'o1', kind: 'persona', text: 'practice managers', url: PAGES[0].url, quote: 'Harbor Dental, a four-chair dental practice', inferred: false },
  { offer: 'o1', kind: 'industry', text: 'physiotherapy clinics', url: PAGES[0].url, quote: 'Elm Street Physio runs it too', inferred: false },
] }
const R = buildResearch(OUT, PAGES, 'acme.example'); if ('error' in R) throw new Error('setup')
const stored = toStored(R as SellerResearch)

test('SEAM 1: an explicit Add (visible field edit) reaches the grader text and the query-planning prompt', () => {
  const icp: Icp = { summary: 'Dental practices that need booking software.', who: ['practice managers'], industries: [], sizes: [], where: ['London'], signals: ['hiring front desk'], exclude: [], research: stored }
  const eff = applyReviewedDraft(icp, 'Booking')
  assert.equal(eff.research!.hyps.find(h => h.t === 'practice managers')!.s, 'reviewed')
  const graderText = icpTextFor(eff, '')
  assert.match(graderText, /practice managers/, 'grader (scoreLeads via icpTextFor) consumes the added buyer')
  assert.match(graderText, /hiring front desk/, 'grader consumes the signals')
  const qp = queryPrompt('find dental practices hiring', eff, 5)
  assert.match(qp, /practice managers/, 'retrieval query planning consumes the added buyer')
})

test('SEAM 2: a dismissed (rejected) statement absent from fields does NOT reach the grader', () => {
  const rejected = { ...stored, hyps: stored.hyps.map(h => h.t === 'physiotherapy clinics' ? { ...h, s: 'rejected' as const } : h) }
  const icp: Icp = { summary: 's', who: [], industries: [], sizes: [], where: [], signals: [], exclude: [], research: rejected }
  const eff = applyReviewedDraft(icp, 'Booking')
  assert.ok(!/physiotherapy/.test(icpTextFor(eff, '')), 'rejected statement never reaches scoreLeads (flat fields only)')
})

test('SEAM 2b: the lead-FINDING prompts carry the canonical flat profile - no research block, rejected or not', () => {
  const rejected = { ...stored, hyps: stored.hyps.map(h => h.t === 'physiotherapy clinics' ? { ...h, s: 'rejected' as const } : h) }
  const icp: Icp = { summary: 's', who: ['field buyer'], industries: [], sizes: [], where: [], signals: [], exclude: [], research: rejected }
  for (const [name, prompt] of [['buildIcpPrompt', buildIcpPrompt('find buyers', icp)], ['buildSourcePrompt', buildSourcePrompt('find buyers', icp, [])], ['queryPrompt', queryPrompt('find buyers', icp, 5)]] as const) {
    assert.ok(!/physiotherapy/.test(prompt), `${name} must not carry rejected research text`)
    assert.ok(!/practice managers/.test(prompt), `${name} must not carry UNAPPROVED sourced research text either`)
    assert.ok(!/"hyps"|"research"/.test(prompt), `${name} serializes no research block at all`)
    assert.match(prompt, /field buyer/, `${name} still carries the canonical flat profile`)
  }
})

test('SEAM 3: Dismiss-after-Add must stick — the dismissed statement must not stay confirmed and targeted', () => {
  // Play 1: user Added 'practice managers' (field text + reviewed). Play 2: user Dismisses the statement.
  // The UI dismiss flips only the hyp status; the stale field text then exact-RECONFIRMS it server-side.
  const dismissed = { ...stored, hyps: stored.hyps.map(h => h.t === 'practice managers' ? { ...h, s: 'rejected' as const } : h) }
  const icp: Icp = { summary: 's', who: ['practice managers'], industries: [], sizes: [], where: [], signals: [], exclude: [], research: dismissed }
  const eff = applyReviewedDraft(icp, 'Booking')
  assert.equal(eff.research!.hyps.find(h => h.t === 'practice managers')!.s, 'rejected', 'FAILS TODAY: the stale field text resurrects the dismissal to reviewed')
  assert.ok(!/practice managers/.test(icpTextFor(eff, '')), 'a dismissed statement must not reach the grader')
})
