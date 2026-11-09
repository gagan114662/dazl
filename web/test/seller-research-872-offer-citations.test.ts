// #872: source-backed offers and disqualifiers (part of #750). Synthetic multiproduct site; stubbed pages and model
// output; no network, no key, no paid call. An extracted item is source-backed only when its citation is an EXACT
// already-fetched page URL with that page's own fetch time and a VERBATIM, claim-carrying, first-party quote:
//   - offer: the whole name as exact consecutive tokens (no prefix bleed), the name as SUBJECT of a positive
//     predicate, no negation/comparison/third-party subject/attribution, exactly one owning offer;
//   - disqualifier: an EXPLICIT exclusion claim bound to the same offer (never a pricing boundary or a positive
//     inclusion of the same segment).
// Anything less stays an unreviewed hypothesis with no citation (fail closed). The same strict binding is re-applied
// at the stored/client ingress (normalizeResearch): a forged 'sourced' row honestly downgrades.
import test from 'node:test'
import assert from 'node:assert/strict'
import { buildResearch, toStored, type FetchedPage, type SellerResearch } from '../lib/scan/seller-research.ts'
import { normalizeResearch } from '../lib/scan/icp.ts'

const T0 = 1_800_000_000
const HOME = 'https://multi.example/'
const BOOKING = 'https://multi.example/products/booking'
const PAYROLL = 'https://multi.example/products/payroll'
const PRICING = 'https://multi.example/pricing'
const page = (url: string, text: string, at: number): FetchedPage => ({ url, kind: 'product', title: '', text, fetched_at: at })
// A multiproduct site whose homepage omits the buyer segment (#750's outcome shape): the offer evidence
// lives on the product and pricing pages, each with its OWN fetch time.
const PAGES: FetchedPage[] = [
  page(HOME, 'Multi builds tools for modern teams and supports every customer.', T0),
  page(BOOKING, 'We offer Acme Booking. Acme Booking is our scheduling product for practice managers. Acme Booking is not available for clinics with over 50 staff. Acme Booking serves clinics with over 50 staff through partners.', T0 + 1),
  page(PAYROLL, 'We offer Acme Payroll. Acme Payroll is our payroll product for clinic owners without a finance team.', T0 + 2),
  page(PRICING, 'Acme Booking starts at $49 per location per month. Payroll is priced per employee for clinics with 10 to 50 staff.', T0 + 3),
]
// Round 8 (minimal atomic contract): ONLY an exact ONE-SENTENCE own-offer form sources - "We offer X.",
// "We sell X.", "Our product/offer is X.", "X is our [flagship] <product-type>." The ORIGINAL richer fixtures
// below are KEPT and now assert hypothesis: real coverage honestly lost (round-7 verdict), never rewritten away.
const ATOMIC_BOOKING = 'We offer Acme Booking.'
const ATOMIC_PAYROLL = 'We offer Acme Payroll.'
const BOOKING_QUOTE = 'Acme Booking is our scheduling product for practice managers.'
const PAYROLL_QUOTE = 'Acme Payroll is our payroll product for clinic owners without a finance team.'
const EXCLUSION_QUOTE = 'Acme Booking is not available for clinics with over 50 staff.'
const OFFERS = [
  { id: 'o1', name: 'Acme Booking', url: BOOKING, quote: ATOMIC_BOOKING, inferred: false },
  { id: 'o2', name: 'Acme Payroll', url: PAYROLL, quote: ATOMIC_PAYROLL, inferred: false },
]
const run = (offers: unknown[], items: unknown[] = [], pages = PAGES): SellerResearch => {
  const r = buildResearch({ offers, items }, pages, 'multi.example')
  if ('error' in r) throw new Error('fixture research failed to build')
  return r
}
const offerHyp = (r: SellerResearch, name: string) => {
  const o = r.offers.find(x => x.name === name)
  assert.ok(o, `offer ${name} present`)
  const h = r.hypotheses.find(x => x.offer === o.id && x.kind === 'offer')
  assert.ok(h, `offer hypothesis for ${name} present`)
  return h
}
const unsourced = (h: { status: string; url: string | null; quote: string | null; fetched_at: number | null }) => {
  assert.equal(h.status, 'hypothesis')
  assert.deepEqual([h.url, h.quote, h.fetched_at], [null, null, null])
}

test('each distinct own offer cites its own product/pricing page with the exact URL and that page\'s fetch time', () => {
  const r = run(OFFERS)
  const booking = offerHyp(r, 'Acme Booking')
  assert.deepEqual([booking.status, booking.url, booking.quote, booking.fetched_at], ['sourced', BOOKING, ATOMIC_BOOKING, T0 + 1])
  const payroll = offerHyp(r, 'Acme Payroll')
  assert.deepEqual([payroll.status, payroll.url, payroll.quote, payroll.fetched_at], ['sourced', PAYROLL, ATOMIC_PAYROLL, T0 + 2])
})

test('a disqualifier with an explicit exclusion claim bound to its own offer is sourced with URL and fetch time', () => {
  const r = run(OFFERS, [
    { offer: 'o1', kind: 'disqualifier', text: 'clinics with over 50 staff', url: BOOKING, quote: EXCLUSION_QUOTE, inferred: false },
  ])
  const o1 = r.offers.find(x => x.name === 'Acme Booking')!
  const d = r.hypotheses.find(h => h.offer === o1.id && h.kind === 'disqualifier')
  assert.ok(d, 'disqualifier present')
  assert.deepEqual([d.status, d.url, d.fetched_at], ['sourced', BOOKING, T0 + 1])
})

test('a pricing boundary mention never sources a disqualifier (range inference is not an exclusion)', () => {
  const r = run(OFFERS, [
    { offer: 'o1', kind: 'disqualifier', text: 'clinics with over 50 staff', url: PRICING, quote: 'priced per employee for clinics with 10 to 50 staff', inferred: false },
  ])
  const o1 = r.offers.find(x => x.name === 'Acme Booking')!
  unsourced(r.hypotheses.find(h => h.offer === o1.id && h.kind === 'disqualifier')!)
})

test('a positive inclusion of the same segment never sources a disqualifier', () => {
  const r = run(OFFERS, [
    { offer: 'o1', kind: 'disqualifier', text: 'clinics with over 50 staff', url: BOOKING, quote: 'Acme Booking serves clinics with over 50 staff through partners.', inferred: false },
  ])
  const o1 = r.offers.find(x => x.name === 'Acme Booking')!
  unsourced(r.hypotheses.find(h => h.offer === o1.id && h.kind === 'disqualifier')!)
})

test('an exclusion bound to the OTHER offer never sources this offer\'s disqualifier', () => {
  const q = 'Acme Payroll is not available for clinics with over 50 staff.'
  const r = run(OFFERS, [
    { offer: 'o1', kind: 'disqualifier', text: 'clinics with over 50 staff', url: PAYROLL, quote: q, inferred: false },
  ], [...PAGES.slice(0, 2), page(PAYROLL, `Acme Payroll runs payroll for clinic owners without a finance team. ${q}`, T0 + 2), PAGES[3]])
  const o1 = r.offers.find(x => x.name === 'Acme Booking')!
  unsourced(r.hypotheses.find(h => h.offer === o1.id && h.kind === 'disqualifier')!)
})

// The disqualifier binding is EXACT: the exclusion's object must equal the claim, comparator and number included.
const disq = (text: string, quote: string) => {
  const r = run([{ id: 'o1', name: 'Acme Payroll', url: PAYROLL, quote: PAYROLL_QUOTE }], [
    { offer: 'o1', kind: 'disqualifier', text, url: PAYROLL, quote, inferred: false },
  ], [page(PAYROLL, `${PAYROLL_QUOTE} ${quote}`, T0 + 2)])
  const o1 = r.offers.find(x => x.name === 'Acme Payroll')!
  return r.hypotheses.find(h => h.offer === o1.id && h.kind === 'disqualifier')!
}

test('an under-50 exclusion never backs an over-50 claim (comparator is part of the binding)', () => {
  unsourced(disq('clinics with over 50 staff', 'Acme Payroll is not available for clinics with under 50 staff.'))
})

test('an exclusion of a DIFFERENT segment plus a positive availability for the claimed one never sources', () => {
  unsourced(disq('Texas clinics', 'Acme Payroll is not available for dental clinics, but is available for Texas clinics.'))
})

test('a positive availability for the claimed segment plus an unrelated exclusion never sources', () => {
  unsourced(disq('dental clinics', 'Acme Payroll is available for dental clinics. Our consulting service is not suitable for retailers.'))
})

test('an explicit exclusion bound to the same offer and the exact claimed segment IS sourced (control)', () => {
  const h = disq('clinics with over 50 staff', 'Acme Payroll is not available for clinics with over 50 staff.')
  assert.deepEqual([h.status, h.url, h.fetched_at], ['sourced', PAYROLL, T0 + 2])
})

test('a disqualifier exclusion written as a QUESTION never sources', () => {
  unsourced(disq('clinics with over 50 staff', 'Acme Payroll is not available for clinics with over 50 staff?'))
})

test('an over-cap disqualifier quote is rejected, never sliced', () => {
  const q = 'Acme Payroll is not available for clinics with over 50 staff ' + 'under any current plan or pilot program '.repeat(8) + 'today.'
  assert.ok(q.length > 300, 'fixture exceeds the quote cap')
  unsourced(disq('clinics with over 50 staff', q))
})

test('a disqualifier whose quote does not carry the claim stays a hypothesis with no citation', () => {
  const r = run(OFFERS, [
    { offer: 'o1', kind: 'disqualifier', text: 'solo practitioners', url: BOOKING, quote: BOOKING_QUOTE, inferred: false },
  ])
  const o1 = r.offers.find(x => x.name === 'Acme Booking')!
  unsourced(r.hypotheses.find(h => h.offer === o1.id && h.kind === 'disqualifier')!)
})

// Below: every offer citation that is NOT an unambiguous first-party positive predicate fails closed.
const oneOffer = (quote: string, pageText: string, extra: Record<string, unknown> = {}) =>
  run([{ id: 'o1', name: 'Acme Payroll', url: PAYROLL, quote, ...extra }], [], [page(PAYROLL, pageText, T0 + 2)])

// The reviewer's semantic repro sets (2026-11-08, two adversarial rounds): each was FALSE-SOURCED by an earlier cut,
// all must stay hypotheses.
const REPRO: [string, string][] = [
  ['customers buying from another vendor', 'Our customers buy Acme Payroll from another vendor.'],
  ['a cannot-offer statement', 'We cannot offer Acme Payroll to any customers.'],
  ['a not-currently-planned statement', 'We do not currently plan to offer Acme Payroll.'],
  ['customers praising in their own words', 'Customers say Acme Payroll saved their clinic hours every week.'],
  ['a not-sold-here statement', 'Acme Payroll is not sold by our company.'],
  ['a nav-style information label', 'Acme Payroll information and resources for your business.'],
  ['a longer name with the offer as prefix (PayrollPlus)', 'Our offer is Acme PayrollPlus, which runs monthly payroll.'],
  ['sold exclusively by another vendor', 'Acme Payroll is a product sold exclusively by another vendor.'],
  ['a does-not-run statement', 'Acme Payroll does not run payroll for any customer.'],
  ['a not-our-product competitor statement', 'Acme Payroll is not our product and belongs to a competitor.'],
  ['a reviewer writing about the offer', 'A reviewer wrote that Acme Payroll runs payroll for clinics.'],
  ['a might-help-one-day statement', 'Acme Payroll might help clinics one day but is not available today.'],
  ['a no-longer-sold statement', 'Acme Payroll is no longer sold by anyone.'],
  // Round 3: bare availability/design is not ownership; reported speech and context are not the seller's claim;
  // hypothetical conditionals are not facts.
  ['available exclusively from another vendor', 'Acme Payroll is available exclusively from another vendor.'],
  ['designed and sold by our competitor', 'Acme Payroll is designed and sold by our competitor.'],
  ['a quoted testimonial with a trailing attribution', '"Acme Payroll runs payroll for clinics." says Harbor Dental.'],
  ['a testimonial announcement preceding the sentence', 'A customer testimonial follows. Acme Payroll runs payroll for clinics.'],
  ['available only hypothetically', 'Acme Payroll is available if we ever build it.'],
  ['a conditional offer claim', 'Acme Payroll would run payroll if we ever launch it.'],
  // Round 4: external ownership is not first-party ownership; appositive/possessive embedding is not a claim.
  ["our competitor's product is not our offer", "Acme Payroll is our competitor's payroll product."],
  ['an appositive third-party frame', "Harbor Dental's favorite, Acme Payroll, runs payroll for clinics."],
  ['a possessive embedding', "Acme Payroll's payroll features save clinics time."],
]
for (const [label, q] of REPRO) {
  test(`repro: ${label} never sources the offer`, () => {
    unsourced(offerHyp(oneOffer(q, q), 'Acme Payroll'))
  })
}

test('a not-offered negation never sources the offer', () => {
  const q = "We don't offer Acme Payroll anymore."
  unsourced(offerHyp(oneOffer(q, `${q} Contact us for details about Acme Booking.`), 'Acme Payroll'))
})

test('a not-available statement never sources the offer', () => {
  unsourced(offerHyp(oneOffer(EXCLUSION_QUOTE, EXCLUSION_QUOTE), 'Acme Payroll'))
})

test('a competitor comparison never sources the offer', () => {
  const q = 'Unlike Acme Payroll, Acme Booking has simple pricing for every clinic.'
  unsourced(offerHyp(oneOffer(q, q), 'Acme Payroll'))
})

test('a navigation label never sources the offer', () => {
  const q = 'Home Products Pricing Acme Payroll Contact'
  unsourced(offerHyp(oneOffer(q, q), 'Acme Payroll'))
})

test("a customer's attributed testimonial never sources the seller's offer", () => {
  const q = 'Acme Payroll saved our clinic hours every week. - Harbor Dental'
  unsourced(offerHyp(oneOffer(q, q), 'Acme Payroll'))
})

test('a bare headline with no own-offered predicate stays a hypothesis', () => {
  unsourced(offerHyp(oneOffer('Acme Payroll', 'Acme Payroll'), 'Acme Payroll'))
})

test('an over-cap quote is REJECTED, never sliced (a slice can cut off the negation)', () => {
  const q = 'Acme Payroll runs payroll for clinics ' + 'using integrated scheduling and accounting '.repeat(9) + 'but we do not offer it.'
  assert.ok(q.length > 300, 'fixture exceeds the quote cap')
  unsourced(offerHyp(oneOffer(q, q), 'Acme Payroll'))
})

test('a quote that is a fragment of a QUESTIONED page sentence never sources (span + context binding)', () => {
  unsourced(offerHyp(oneOffer('Acme Payroll runs payroll for clinics', 'Acme Payroll runs payroll for clinics? No, that is a third-party claim we reject.'), 'Acme Payroll'))
})

test('a quote must equal the complete authored page sentence, not a fragment of a longer one', () => {
  unsourced(offerHyp(oneOffer('Acme Payroll runs payroll for clinics', 'Acme Payroll runs payroll for clinics using integrated scheduling and accounting.'), 'Acme Payroll'))
})

// Round 4: the model cannot select the context away - the RAW authored span and its neighbors decide.
// (These use the ATOMIC quote so context binding, not the round-8 grammar, is the deciding mechanism.)
test('a claim preceded by a testimonial announcement never sources (context laundering)', () => {
  unsourced(offerHyp(oneOffer(ATOMIC_PAYROLL, `A customer testimonial follows. ${ATOMIC_PAYROLL}`), 'Acme Payroll'))
})

test('a claim preceded by an explicit denial frame never sources', () => {
  unsourced(offerHyp(oneOffer(ATOMIC_PAYROLL, `The following claim is false and we do not offer this product. ${ATOMIC_PAYROLL}`), 'Acme Payroll'))
})

test('a claim followed by a third-party disclaimer never sources', () => {
  unsourced(offerHyp(oneOffer(ATOMIC_PAYROLL, `${ATOMIC_PAYROLL} This is a third-party assertion, not our offer.`), 'Acme Payroll'))
})

test('a claim the model unquoted from a testimonial never sources (raw span keeps the quotation marks)', () => {
  unsourced(offerHyp(oneOffer(ATOMIC_PAYROLL, `"${ATOMIC_PAYROLL}" says Harbor Dental.`), 'Acme Payroll'))
})

test('the same sentence repeated with one framed occurrence never sources (the model cannot pick the clean twin)', () => {
  unsourced(offerHyp(oneOffer(ATOMIC_PAYROLL, `"${ATOMIC_PAYROLL}" says Harbor Dental. ${ATOMIC_PAYROLL}`), 'Acme Payroll'))
})

test('the same sentence repeated in two clean contexts still sources (control)', () => {
  const h = offerHyp(oneOffer(ATOMIC_PAYROLL, `${ATOMIC_PAYROLL} ${ATOMIC_PAYROLL}`), 'Acme Payroll')
  assert.deepEqual([h.status, h.url, h.fetched_at], ['sourced', PAYROLL, T0 + 2])
})

// Round 8: the original richer positives are KEPT as unsupported cases - adjectives, beneficiaries, prices and
// extra sentences all fall outside the minimal atomic contract and stay visible hypotheses.
test("the original 'we offer X to clinics of every size' fixture is no longer an accepted form (round 8)", () => {
  unsourced(offerHyp(oneOffer('We offer Acme Payroll to clinics of every size.', 'We offer Acme Payroll to clinics of every size.'), 'Acme Payroll'))
})

test("the original 'X is our payroll product' adjective form is no longer accepted (round 8)", () => {
  unsourced(offerHyp(oneOffer('Acme Payroll is our payroll product.', 'Acme Payroll is our payroll product.'), 'Acme Payroll'))
})

test('the original beneficiary and price forms are no longer accepted (round 8 honest losses)', () => {
  unsourced(offerHyp(oneOffer('We offer Acme Payroll for clinics.', 'We offer Acme Payroll for clinics.'), 'Acme Payroll'))
  unsourced(offerHyp(oneOffer('We offer Acme Payroll at $49 per location.', 'We offer Acme Payroll at $49 per location.'), 'Acme Payroll'))
})

test('the original PAYROLL_QUOTE and BOOKING_QUOTE strings stay hypotheses (round 8: coverage preserved as unsupported)', () => {
  unsourced(offerHyp(oneOffer(PAYROLL_QUOTE, PAYROLL_QUOTE), 'Acme Payroll'))
  unsourced(offerHyp(run([{ id: 'o1', name: 'Acme Booking', url: BOOKING, quote: BOOKING_QUOTE }], [], [page(BOOKING, BOOKING_QUOTE, T0 + 1)]), 'Acme Booking'))
})

// Round 8 positive controls: the canonical ATOMIC own-offering sentences - one complete declarative sentence,
// zero adjectives, zero tails, sentence-final name punctuation stripped at the boundary only.
test('the canonical atomic own-offering sentences source (positive controls)', () => {
  for (const q of ['We offer Acme Payroll.', 'We sell Acme Payroll.', 'Our product is Acme Payroll.', 'Our offer is Acme Payroll.', 'Acme Payroll is our product.', 'Acme Payroll is our flagship platform.']) {
    const h = offerHyp(oneOffer(q, q), 'Acme Payroll')
    assert.deepEqual([h.status, h.url, h.fetched_at], ['sourced', PAYROLL, T0 + 2], q)
  }
})

test('the model quote may omit the final period; the AUTHORED page sentence must carry it', () => {
  const h = offerHyp(oneOffer('We offer Acme Payroll', 'We offer Acme Payroll.'), 'Acme Payroll')
  assert.deepEqual([h.status, h.url, h.fetched_at], ['sourced', PAYROLL, T0 + 2])
  unsourced(offerHyp(oneOffer('We offer Acme Payroll', 'We offer Acme Payroll'), 'Acme Payroll'))
})

// Round 9: RAW exact identity. No stemming, no hyphen/period laundering; internal name punctuation is real
// identity; exactly one terminal period is the boundary; any '?'/'!' or unconsumed punctuation rejects.
const namedOffer = (name: string, quote: string) =>
  offerHyp(run([{ id: 'o1', name, url: PAYROLL, quote }], [], [page(PAYROLL, quote, T0 + 2)]), name)

test('offer identity is EXACT: no stemming, no hyphen laundering (round 9)', () => {
  unsourced(namedOffer('Acme Payroll', 'We offer Acme Payrolls.'))
  unsourced(namedOffer('Acme Payroll', 'We offer Acme Pay-Roll.'))
  unsourced(namedOffer('Acme Pay Roll', 'We offer Acme Pay-Roll.'))
  unsourced(namedOffer('Acme-Payroll', 'We offer Acme Payroll.'))
  unsourced(namedOffer('Acme Devices', 'We offer Acme Device.'))
})

test('internal name punctuation is real identity and survives (round 9)', () => {
  const h = namedOffer('Acme.Payroll', 'We offer Acme.Payroll.')
  assert.deepEqual([h.status, h.url, h.fetched_at], ['sourced', PAYROLL, T0 + 2])
  unsourced(namedOffer('Acme+Payroll', 'We offer AcmePayroll.'))
})

// Round 10: the PAGE<->model binding is RAW (case/whitespace only) - the model cannot invent a punctuation
// identity the authored page does not carry, and the authored terminal run must be exactly '.'.
test('the page binding is raw: the model cannot invent hyphen identity the page does not carry (round 10)', () => {
  unsourced(offerHyp(run([{ id: 'o1', name: 'Acme-Payroll', url: PAYROLL, quote: 'We offer Acme-Payroll.' }], [], [page(PAYROLL, 'We offer Acme Payroll.', T0 + 2)]), 'Acme-Payroll'))
  unsourced(offerHyp(oneOffer(ATOMIC_PAYROLL, 'We offer Acme-Payroll.'), 'Acme Payroll'))
})

test("the authored terminal run must be exactly '.': '...', '?.', '!.' never source (round 10)", () => {
  unsourced(offerHyp(oneOffer(ATOMIC_PAYROLL, 'We offer Acme Payroll...'), 'Acme Payroll'))
  unsourced(offerHyp(oneOffer(ATOMIC_PAYROLL, 'We offer Acme Payroll?.'), 'Acme Payroll'))
  unsourced(offerHyp(oneOffer(ATOMIC_PAYROLL, 'We offer Acme Payroll!.'), 'Acme Payroll'))
})

test("a disqualifier against a '?.', '!.' page never sources; the plain '.' page does (round 10)", () => {
  const q = 'Acme Payroll is not available for clinics with over 50 staff'
  const dq = (pageText: string) => {
    const r = run([{ id: 'o1', name: 'Acme Payroll', url: PAYROLL, quote: ATOMIC_PAYROLL }], [
      { offer: 'o1', kind: 'disqualifier', text: 'clinics with over 50 staff', url: PAYROLL, quote: q, inferred: false },
    ], [page(PAYROLL, `${ATOMIC_PAYROLL} ${pageText}`, T0 + 2)])
    const o1 = r.offers.find(x => x.name === 'Acme Payroll')!
    return r.hypotheses.find(h => h.offer === o1.id && h.kind === 'disqualifier')!
  }
  unsourced(dq(q + '?.'))
  unsourced(dq(q + '!.'))
  const ok = dq(q + '.')
  assert.deepEqual([ok.status, ok.url, ok.fetched_at], ['sourced', PAYROLL, T0 + 2])
})

test("any '?', '!' or unconsumed punctuation rejects - a trailing period never erases sentence intent (round 9)", () => {
  unsourced(namedOffer('Acme Payroll', 'We offer Acme Payroll?.'))
  unsourced(namedOffer('Acme Payroll', 'We offer Acme Payroll!.'))
  unsourced(namedOffer('Acme Payroll', 'We offer Acme Payroll?'))
  unsourced(namedOffer('Acme Payroll', 'We offer Acme Payroll!'))
  unsourced(namedOffer('Acme Payroll', 'We offer Acme Payroll..'))
  unsourced(namedOffer('Acme Payroll', 'We offer Acme Payroll;'))
  unsourced(namedOffer('Acme Payroll', 'We offer Acme Payroll:'))
  unsourced(namedOffer('Acme Payroll', 'We offer Acme Payroll. We sell Acme Payroll.'))
})

test('a bare capability sentence is NOT ownership (an integrations directory reads the same)', () => {
  unsourced(offerHyp(oneOffer('Acme Payroll runs payroll for clinics.', 'Acme Payroll runs payroll for clinics.'), 'Acme Payroll'))
})

test('a bare capability sentence under an integrations heading never sources', () => {
  unsourced(offerHyp(oneOffer('Acme Payroll runs payroll for clinics.', 'Tools we integrate with are listed below. Acme Payroll runs payroll for clinics.'), 'Acme Payroll'))
})

test("'we support X' is not ownership (support describes someone else's product)", () => {
  unsourced(offerHyp(oneOffer('We support Acme Payroll.', 'We support Acme Payroll. It is owned and sold by Harbor Software.'), 'Acme Payroll'))
})

test('a future offering is unknown, not a current claim', () => {
  unsourced(offerHyp(oneOffer('We offer Acme Payroll next year.', 'We offer Acme Payroll next year.'), 'Acme Payroll'))
})

test('an or-alternative offering is ambiguous, not a claim', () => {
  unsourced(offerHyp(oneOffer('We offer Acme Payroll or another system depending on availability.', 'We offer Acme Payroll or another system depending on availability.'), 'Acme Payroll'))
})

test('an unmarked review context frames the claim (preceding and closing sentences)', () => {
  unsourced(offerHyp(oneOffer('We offer Acme Payroll.', 'A review from Harbor Dental. We offer Acme Payroll. End of customer review.'), 'Acme Payroll'))
})

// Round 6: typed offering-object identity + current assertion. The complement's head noun must DENOTE the
// offering (not a relationship to someone else's product), the name must BE the offered object (not a
// modifier of a different object), and no continuation outside the typed frames may follow the core claim.
test("'X is our preferred integration' describes someone else's product, not ours", () => {
  unsourced(offerHyp(oneOffer('Acme Payroll is our preferred integration.', 'Acme Payroll is our preferred integration.'), 'Acme Payroll'))
})

test("'X is our main reference' is a comparison relationship, not ownership", () => {
  unsourced(offerHyp(oneOffer('Acme Payroll is our main reference for comparisons.', 'Acme Payroll is our main reference for comparisons.'), 'Acme Payroll'))
})

test('a contrast clause after the assertion voids currency ("runs payroll but was discontinued in 2024")', () => {
  unsourced(offerHyp(oneOffer('Our flagship Acme Payroll runs payroll but was discontinued in 2024.', 'Our flagship Acme Payroll runs payroll but was discontinued in 2024.'), 'Acme Payroll'))
})

test('a dated offering is not a current claim ("we offer X in 2028")', () => {
  unsourced(offerHyp(oneOffer('We offer Acme Payroll in 2028.', 'We offer Acme Payroll in 2028.'), 'Acme Payroll'))
})

test('an offering after an event is not a current claim ("we offer X after launch")', () => {
  unsourced(offerHyp(oneOffer('We offer Acme Payroll after launch.', 'We offer Acme Payroll after launch.'), 'Acme Payroll'))
})

test('the offering object must BE the name, not a noun it modifies ("we offer X consulting services")', () => {
  unsourced(offerHyp(oneOffer('We offer Acme Payroll consulting services.', 'We offer Acme Payroll consulting services.'), 'Acme Payroll'))
  unsourced(offerHyp(oneOffer('We offer Acme Payroll migration training.', 'We offer Acme Payroll migration training.'), 'Acme Payroll'))
})

test('the original composed price/recipient sentence is no longer accepted (round 8)', () => {
  unsourced(offerHyp(oneOffer('We offer Acme Payroll to clinics starting at $49 per location.', 'We offer Acme Payroll to clinics starting at $49 per location.'), 'Acme Payroll'))
})

test('the original 174-char OWN-offering string stays a hypothesis at build AND ingress (round 8: not disguised as covered)', () => {
  const q = 'Acme Payroll is our payroll product for busy clinics with multiple locations across several states that process monthly payroll for their staff through one integrated scheduling system.'
  assert.ok(q.length > 140 && q.length <= 300, 'fixture sits between the old and shared caps')
  unsourced(offerHyp(oneOffer(q, q), 'Acme Payroll'))
  const r = stored(q)
  assert.ok(r, 'research kept')
  assert.deepEqual([r.hyps[0].s, r.hyps[0].u, r.hyps[0].q, r.hyps[0].at], ['hypothesis', null, null, null])
})

test('a valid 174-char quote survives the whole construction -> storage -> ingress round trip (ONE quote contract)', () => {
  // Round 8: the round-trip positive uses a NON-OFFER claim kind (quoteSupports path, unaffected by the atomic
  // offer grammar) - it does NOT pretend the original 174-char offer coverage is preserved.
  const q = 'We serve dental practices across the whole region with dedicated onboarding, weekly review calls and a named success manager for every single location from small clinics to the largest multi-site groups.'
  assert.ok(q.length > 140 && q.length <= 300, 'fixture sits between the old and shared caps')
  const r = run(
    [{ id: 'o1', name: 'Acme Payroll', url: PAYROLL, quote: ATOMIC_PAYROLL, inferred: false }],
    [{ offer: 'o1', kind: 'industry', text: 'dental practices', url: PAYROLL, quote: q, inferred: false }],
    [page(PAYROLL, `${ATOMIC_PAYROLL} ${q}`, T0 + 2)],
  )
  const ind = r.hypotheses.find(h => h.kind === 'industry')!
  assert.deepEqual([ind.status, ind.url, ind.fetched_at], ['sourced', PAYROLL, T0 + 2])
  const n = normalizeResearch(toStored(r))
  assert.ok(n, 'research kept')
  const ni = n.hyps.find(h => h.k === 'industry')!
  assert.deepEqual([ni.s, ni.q], ['sourced', q])
})

test('an offer citing a URL that was never fetched stays a hypothesis', () => {
  const r = run([{ id: 'o1', name: 'Acme Payroll', url: 'https://multi.example/never-fetched', quote: ATOMIC_PAYROLL }])
  unsourced(offerHyp(r, 'Acme Payroll'))
})

test('an offer with no quote stays a hypothesis', () => {
  const r = run([{ id: 'o1', name: 'Acme Payroll', url: PAYROLL }])
  unsourced(offerHyp(r, 'Acme Payroll'))
})

test('an offer the model itself marked inferred stays a hypothesis', () => {
  const r = run([{ id: 'o1', name: 'Acme Payroll', url: PAYROLL, quote: ATOMIC_PAYROLL, inferred: true }])
  unsourced(offerHyp(r, 'Acme Payroll'))
})

test('a quote naming only a different offer never sources this one', () => {
  // o2 cites the BOOKING page quote, which names Acme Booking and never names Acme Payroll.
  const r = run([
    { id: 'o1', name: 'Acme Booking', url: BOOKING, quote: ATOMIC_BOOKING },
    { id: 'o2', name: 'Acme Payroll', url: BOOKING, quote: ATOMIC_BOOKING },
  ])
  assert.equal(offerHyp(r, 'Acme Booking').status, 'sourced')
  unsourced(offerHyp(r, 'Acme Payroll'))
})

test('a quote naming two offers sources neither (ownership is ambiguous)', () => {
  const q = 'Acme Booking and Acme Payroll both include free onboarding for every customer.'
  const r = run([
    { id: 'o1', name: 'Acme Booking', url: PRICING, quote: q },
    { id: 'o2', name: 'Acme Payroll', url: PRICING, quote: q },
  ], [], [page(PRICING, q, T0 + 3)])
  unsourced(offerHyp(r, 'Acme Booking'))
  unsourced(offerHyp(r, 'Acme Payroll'))
})

// The same strict binding is re-applied when a stored or client-sent block arrives (normalizeResearch).
const stored = (q: string) => normalizeResearch({ v: 1, site: 'multi.example', offers: [{ i: 'acme-payroll', n: 'Acme Payroll' }], hyps: [{ i: 'acme-payroll:offer', o: 'acme-payroll', k: 'offer', t: 'Acme Payroll', s: 'sourced', u: PAYROLL, q, at: T0 + 2 }], q: null, ans: null })

test('ingress: a genuinely source-backed offer survives the re-check unchanged', () => {
  const r = stored(ATOMIC_PAYROLL)
  assert.ok(r, 'research kept')
  assert.deepEqual([r.hyps[0].s, r.hyps[0].u, r.hyps[0].at], ['sourced', PAYROLL, T0 + 2])
})

test('ingress: the original own-offering sentence honestly downgrades (round 8)', () => {
  const r = stored(PAYROLL_QUOTE)
  assert.ok(r, 'research kept')
  assert.deepEqual([r.hyps[0].s, r.hyps[0].u, r.hyps[0].q, r.hyps[0].at], ['hypothesis', null, null, null])
})

test('ingress: a forged sourced offer with a cannot-offer quote honestly downgrades', () => {
  const r = stored('We cannot offer Acme Payroll to any customers.')
  assert.ok(r, 'research kept')
  assert.deepEqual([r.hyps[0].s, r.hyps[0].u, r.hyps[0].q, r.hyps[0].at], ['hypothesis', null, null, null])
})

test('ingress: a forged sourced offer quoting another offer\'s claim honestly downgrades', () => {
  const r = stored('Acme Booking runs payroll for clinics.')
  assert.ok(r, 'research kept')
  assert.deepEqual([r.hyps[0].s, r.hyps[0].u], ['hypothesis', null])
})

test('ingress: a sourced row whose text is not the canonical offer name honestly downgrades', () => {
  const r = normalizeResearch({ v: 1, site: 'multi.example', offers: [{ i: 'acme-payroll', n: 'Acme Payroll' }], hyps: [{ i: 'acme-payroll:offer', o: 'acme-payroll', k: 'offer', t: 'Other Payroll', s: 'sourced', u: PAYROLL, q: 'Other Payroll runs payroll for clinics.', at: T0 + 2 }], q: null, ans: null })
  assert.ok(r, 'research kept')
  assert.deepEqual([r.hyps[0].s, r.hyps[0].u, r.hyps[0].q, r.hyps[0].at], ['hypothesis', null, null, null])
})

test('ingress: an over-cap stored quote is rejected, never sliced, and honestly downgrades', () => {
  const q = 'Acme Payroll runs payroll for clinics' + ' with integrated scheduling'.repeat(10)
  assert.ok(q.length > 300, 'fixture exceeds the stored quote cap')
  const r = stored(q)
  assert.ok(r, 'research kept')
  assert.deepEqual([r.hyps[0].s, r.hyps[0].u, r.hyps[0].q, r.hyps[0].at], ['hypothesis', null, null, null])
})

test('ingress: a stored quote that is a question honestly downgrades', () => {
  const r = stored('Acme Payroll runs payroll for clinics?')
  assert.ok(r, 'research kept')
  assert.deepEqual([r.hyps[0].s, r.hyps[0].u], ['hypothesis', null])
})

test('ingress: a forged sourced disqualifier without an explicit bound exclusion honestly downgrades', () => {
  const r = normalizeResearch({ v: 1, site: 'multi.example', offers: [{ i: 'acme-booking', n: 'Acme Booking' }], hyps: [{ i: 'acme-booking:disqualifier:1', o: 'acme-booking', k: 'disqualifier', t: 'clinics with over 50 staff', s: 'sourced', u: PRICING, q: 'priced per employee for clinics with 10 to 50 staff', at: T0 + 3 }], q: null, ans: null })
  assert.ok(r, 'research kept')
  assert.deepEqual([r.hyps[0].s, r.hyps[0].u], ['hypothesis', null])
})
