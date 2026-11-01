// Regression probes for PR #501 / issue #379 (seller research), from the independent reviewer's probe file with the
// marked pre-fix assertions INVERTED to the correct behavior. Run from web/ with the standard harness:
//   SITECRAWL_ENABLED=0 NEWS_SEARCH_ENABLED=0 node --experimental-strip-types --import ./test/helpers/net-fence.ts --test test/seller-research-379-review-probes.test.ts
import test from 'node:test'
import assert from 'node:assert/strict'
import { applyReviewedDraft, buildResearch, fromStored, toStored, type SellerResearch, type FetchedPage } from '../lib/scan/seller-research.ts'
import type { Icp } from '../lib/scan/icp.ts'

const TXT = 'Harbor Dental, a four-chair dental practice, cut no-shows with Acme Booking. Elm Street Physio runs Acme Booking for its 22 staff.'
const PAGES: FetchedPage[] = [{ url: 'https://acme.example/customers', kind: 'customers', title: 'Customers', text: TXT, fetched_at: 1800000000 }]
const OUT = { offers: [{ id: 'o1', name: 'Booking' }, { id: 'o2', name: 'Payroll' }], items: [
  { offer: 'o1', kind: 'industry', text: 'dental practices', url: PAGES[0].url, quote: 'Harbor Dental, a four-chair dental practice', inferred: false },
  { offer: 'o1', kind: 'industry', text: 'physiotherapy clinics', url: PAGES[0].url, quote: 'Elm Street Physio runs Acme Booking', inferred: false },
  { offer: 'o1', kind: 'persona', text: 'VP of Sales at mid-market SaaS companies', url: PAGES[0].url, quote: 'not on the page', inferred: true },
] }
const research = (): SellerResearch => { const r = buildResearch(OUT, PAGES, 'acme.example'); if ('error' in r) throw new Error('setup'); return r }
const draft = (r: SellerResearch): Icp => ({ summary: 's', who: ['sales'], industries: ['dental'], sizes: [], where: [], signals: [], exclude: [], research: toStored(r) })

test('F1: a SOURCED statement absent from the reviewed draft keeps its status (absence is not rejection)', () => {
  const eff = applyReviewedDraft(draft(research()), 'Booking')
  const phys = eff.research!.hyps.find(h => h.t === 'physiotherapy clinics')!
  assert.equal(phys.s, 'sourced', 'page-verified fact must not be labeled rejected when the user never saw it')
  assert.deepEqual(eff.industries, ['dental'], 'the effective profile is the draft verbatim - nothing is auto-merged')
})

test('F2: a sourced statement the user never reviewed stays sourced across a recrawl', () => {
  const eff = applyReviewedDraft(draft(research()), 'Booking')
  const re = buildResearch(OUT, [{ ...PAGES[0], fetched_at: 1800000100 }], 'acme.example', fromStored(eff.research!))
  assert.ok(!('error' in re)); if ('error' in re) return
  const phys = re.hypotheses.find(h => h.text === 'physiotherapy clinics')!
  assert.equal(phys.status, 'sourced', 'a fact the page still verifies keeps its truthful status')
})

test('F3: "Who buys this?" is never auto-answered; it is re-asked until the person types an answer', () => {
  const r1 = buildResearch({ offers: [{ id: 'o1', name: 'Booking' }], items: [] }, PAGES, 'acme.example')
  assert.ok(!('error' in r1)); if ('error' in r1) return
  assert.equal(r1.question, 'Who buys this?')
  const eff = applyReviewedDraft(draft(r1), 'Booking')
  assert.equal(eff.research!.ans, null, 'an offer id is not an answer to a WHO question')
  const re = buildResearch({ offers: [{ id: 'o1', name: 'Booking' }], items: [] }, PAGES, 'acme.example', fromStored(eff.research!))
  assert.ok(!('error' in re)); if ('error' in re) return
  assert.equal(re.question, 'Who buys this?', 'the unanswered question is asked again')
})

test('F4: exact matching only - a substring ("sales") never confirms an unsupported inferred hypothesis', () => {
  const eff = applyReviewedDraft(draft(research()), 'Booking') // user typed who: ['sales']
  const hyp = eff.research!.hyps.find(h => h.t === 'VP of Sales at mid-market SaaS companies')!
  assert.equal(hyp.s, 'hypothesis', 'no fuzzy/substring confirmation of a person decision')
  assert.deepEqual(eff.who, ['sales'], 'the draft is verbatim')
})

test('F5: prior research from a DIFFERENT site never carries answers or corrections', () => {
  const a = buildResearch({ offers: [{ id: 'o1', name: 'Consulting' }, { id: 'o2', name: 'Other' }], items: [] }, PAGES, 'site-a.example')
  assert.ok(!('error' in a)); if ('error' in a) return
  assert.equal(a.question, 'Which of your offers is this play for?')
  const effA = applyReviewedDraft(draft(a), 'Consulting')
  assert.deepEqual(effA.research!.ans, { q: 'Which of your offers is this play for?', o: 'consulting' }, 'same-site: choosing the offer answers the offer-selection question')
  const reB = buildResearch({ offers: [{ id: 'x1', name: 'Consulting' }, { id: 'x2', name: 'Other' }], items: [] }, [{ ...PAGES[0], url: 'https://site-b.example/' }], 'site-b.example', fromStored(effA.research!))
  assert.ok(!('error' in reB)); if ('error' in reB) return
  assert.equal(reB.question, 'Which of your offers is this play for?', "site A's answer must not suppress site B's question")
  assert.equal(reB.answered, null, 'no answer carried across sites')
})

test('F6: a constraint the user DELETES from the draft stays deleted (current draft wins over stale reviewed status)', () => {
  const R = buildResearch({ offers: [{ id: 'o1', name: 'Booking' }], items: [
    { offer: 'o1', kind: 'persona', text: 'practice managers', url: 'https://acme.example/products/booking', quote: 'lets practice managers fill their appointment book', inferred: false } ] },
    [{ url: 'https://acme.example/products/booking', kind: 'product', title: 'Booking', text: 'Acme Booking lets practice managers fill their appointment book and send reminders to clients.', fetched_at: 1800000000 }], 'acme.example')
  assert.ok(!('error' in R)); if ('error' in R) return
  // Play 1: draft contains the persona -> confirmed (reviewed), persisted.
  const d1: Icp = { summary: 's', who: ['practice managers'], industries: [], sizes: [], where: [], signals: [], exclude: [], research: toStored(R) }
  const eff1 = applyReviewedDraft(d1, 'Booking')
  assert.equal(eff1.research!.hyps.find(h => h.k === 'persona')!.s, 'reviewed', 'setup: play 1 confirmed it')
  // The user then edits the draft and REMOVES 'practice managers' before creating play 2.
  const eff2 = applyReviewedDraft({ ...d1, who: [], research: eff1.research }, 'Booking')
  assert.deepEqual(eff2.who, [], 'the draft wins: a deleted constraint is not re-injected')
  assert.equal(eff2.research!.hyps.find(h => h.k === 'persona')!.s, 'rejected', 'the deletion is recorded as an explicit rejection')
  // ... and the explicit rejection survives a recrawl that re-reads the same statement.
  const re = buildResearch({ offers: [{ id: 'o1', name: 'Booking' }], items: [
    { offer: 'o1', kind: 'persona', text: 'practice managers', url: 'https://acme.example/products/booking', quote: 'lets practice managers fill their appointment book', inferred: false } ] },
    [{ url: 'https://acme.example/products/booking', kind: 'product', title: 'Booking', text: 'Acme Booking lets practice managers fill their appointment book and send reminders to clients.', fetched_at: 1800000200 }], 'acme.example', fromStored(eff2.research!))
  assert.ok(!('error' in re)); if ('error' in re) return
  assert.equal(re.hypotheses.find(h => h.kind === 'persona')!.status, 'rejected', 'explicit rejection persists across recrawls')
})

test('F6b: ambiguous offer identity binds nothing (SEO audit vs SEO audit Pro; same-name offers)', () => {
  const pages: FetchedPage[] = [{ url: 'https://seo.example/', kind: 'home', title: 'SEO', text: 'SEO audit and SEO audit Pro for agencies, with reports clients understand.', fetched_at: 1800000000 }]
  const out = { offers: [{ id: 'o1', name: 'SEO audit' }, { id: 'o2', name: 'SEO audit Pro' }], items: [] }
  const r = buildResearch(out, pages, 'seo.example')
  assert.ok(!('error' in r)); if ('error' in r) return
  // A play named loosely ('SEO') matches neither exactly: untouched.
  const loose = applyReviewedDraft({ summary: 's', who: [], industries: [], sizes: [], where: [], signals: [], exclude: [], research: toStored(r) }, 'SEO')
  assert.equal(loose.research!.ans, null, 'no exact match - no binding, no answer')
  // An exact play name binds exactly that offer, never the near one.
  const exact = applyReviewedDraft({ summary: 's', who: [], industries: [], sizes: [], where: [], signals: [], exclude: [], research: toStored(r) }, 'SEO audit Pro')
  assert.deepEqual(exact.research!.ans, { q: 'Which of your offers is this play for?', o: 'seo-audit-pro' }, 'exact identity binds exactly')
  const exact2 = applyReviewedDraft({ summary: 's', who: [], industries: [], sizes: [], where: [], signals: [], exclude: [], research: toStored(r) }, 'SEO audit')
  assert.deepEqual(exact2.research!.ans, { q: 'Which of your offers is this play for?', o: 'seo-audit' }, 'the plain offer binds the plain id, not the Pro')
})
