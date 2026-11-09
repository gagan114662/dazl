// #872: source-backed offers and disqualifiers (part of #750). Synthetic multiproduct site; stubbed pages and model
// output; no network, no key, no paid call. An extracted item is source-backed only when its citation is an EXACT
// already-fetched page URL with that page's own fetch time and a VERBATIM, claim-carrying, first-party quote.
// Anything less stays an unreviewed hypothesis with no citation (fail closed):
//   not-offered negation, competitor comparison, navigation label, attributed testimonial, bare headline,
//   unfetched URL, absent quote, model-marked inference, a quote naming another offer, or one naming several.
import test from 'node:test'
import assert from 'node:assert/strict'
import { buildResearch, type FetchedPage, type SellerResearch } from '../lib/scan/seller-research.ts'

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
  page(BOOKING, 'Acme Booking lets practice managers fill their appointment book and send reminders.', T0 + 1),
  page(PAYROLL, 'Acme Payroll runs payroll for clinic owners without a finance team.', T0 + 2),
  page(PRICING, 'Acme Booking starts at $49 per location per month. Payroll is priced per employee for clinics with 10 to 50 staff.', T0 + 3),
]
const BOOKING_QUOTE = 'Acme Booking lets practice managers fill their appointment book and send reminders.'
const PAYROLL_QUOTE = 'Acme Payroll runs payroll for clinic owners without a finance team.'
const OFFERS = [
  { id: 'o1', name: 'Acme Booking', url: BOOKING, quote: BOOKING_QUOTE, inferred: false },
  { id: 'o2', name: 'Acme Payroll', url: PAYROLL, quote: PAYROLL_QUOTE, inferred: false },
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
  assert.deepEqual([booking.status, booking.url, booking.quote, booking.fetched_at], ['sourced', BOOKING, BOOKING_QUOTE, T0 + 1])
  const payroll = offerHyp(r, 'Acme Payroll')
  assert.deepEqual([payroll.status, payroll.url, payroll.quote, payroll.fetched_at], ['sourced', PAYROLL, PAYROLL_QUOTE, T0 + 2])
})

test('a disqualifier with a verbatim claim-carrying quote is sourced with the page URL and fetch time', () => {
  const r = run(OFFERS, [
    { offer: 'o1', kind: 'disqualifier', text: 'clinics with over 50 staff', url: PRICING, quote: 'priced per employee for clinics with 10 to 50 staff', inferred: false },
  ])
  const o1 = r.offers.find(x => x.name === 'Acme Booking')!
  const d = r.hypotheses.find(h => h.offer === o1.id && h.kind === 'disqualifier')
  assert.ok(d, 'disqualifier present')
  assert.deepEqual([d.status, d.url, d.fetched_at], ['sourced', PRICING, T0 + 3])
})

test('a disqualifier whose quote does not carry the claim stays a hypothesis with no citation', () => {
  const r = run(OFFERS, [
    { offer: 'o1', kind: 'disqualifier', text: 'solo practitioners', url: BOOKING, quote: BOOKING_QUOTE, inferred: false },
  ])
  const o1 = r.offers.find(x => x.name === 'Acme Booking')!
  const d = r.hypotheses.find(h => h.offer === o1.id && h.kind === 'disqualifier')
  assert.ok(d, 'disqualifier present')
  unsourced(d)
})

// Below: every offer citation that is NOT an unambiguous first-party positive predicate fails closed.
const oneOffer = (quote: string, pageText: string, extra: Record<string, unknown> = {}) =>
  run([{ id: 'o1', name: 'Acme Payroll', url: PAYROLL, quote, ...extra }], [], [page(PAYROLL, pageText, T0 + 2)])

test('a not-offered negation never sources the offer', () => {
  const q = "We don't offer Acme Payroll anymore."
  unsourced(offerHyp(oneOffer(q, `${q} Contact us for details about Acme Booking.`), 'Acme Payroll'))
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

test('an offer citing a URL that was never fetched stays a hypothesis', () => {
  const r = run([{ id: 'o1', name: 'Acme Payroll', url: 'https://multi.example/never-fetched', quote: PAYROLL_QUOTE }])
  unsourced(offerHyp(r, 'Acme Payroll'))
})

test('an offer with no quote stays a hypothesis', () => {
  const r = run([{ id: 'o1', name: 'Acme Payroll', url: PAYROLL }])
  unsourced(offerHyp(r, 'Acme Payroll'))
})

test('an offer the model itself marked inferred stays a hypothesis', () => {
  const r = run([{ id: 'o1', name: 'Acme Payroll', url: PAYROLL, quote: PAYROLL_QUOTE, inferred: true }])
  unsourced(offerHyp(r, 'Acme Payroll'))
})

test('a quote naming only a different offer never sources this one', () => {
  // o2 cites the BOOKING page quote, which names Acme Booking and never names Acme Payroll.
  const r = run([
    { id: 'o1', name: 'Acme Booking', url: BOOKING, quote: BOOKING_QUOTE },
    { id: 'o2', name: 'Acme Payroll', url: BOOKING, quote: BOOKING_QUOTE },
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
