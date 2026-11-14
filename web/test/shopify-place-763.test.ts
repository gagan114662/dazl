// #763 (stacked on the Shopify source): two things real data showed.
//  1. products.json published_at does NOT mark a new product. On 12 real UK stores (2026-11-14) 10 had ALL of their listed products
//     "published" inside 90 days, with records created 300 to 800 days earlier (lucyandyak.com: newest "published" 2026-11-13, record
//     created 2025-12-17; missoma.com: published 2026-11-10, created 2024-09-02). A candidate now needs a product whose record was
//     CREATED and published inside the window.
//  2. A store's own stated place (meta.json: city, province, country) is passed to the verifier's place check. Real product pages of
//     three UK stores read "unconfirmed" (they name no place); one candidate in a matrix run was held location_mismatch because its
//     page named another place. The stated place answers the question only when it agrees with the request.
import test from 'node:test'
import assert from 'node:assert/strict'
import { placeOf, readStore, storeLead, type ShopifyStore } from '../lib/sources/shopify.ts'
import { verifyLeads } from '../lib/scan/runner.ts'
import type { HttpResult, SafeGet } from '../lib/sources/types.ts'

const NOW = new Date('2026-11-14T12:00:00Z')
const META = JSON.stringify({ id: 19799235, name: 'Lucy & Yak', city: 'Barnsley', province: 'England', country: 'GB', currency: 'GBP', domain: 'lucyandyak.com', myshopify_domain: 'lucy-yak.myshopify.com' })
const product = (title: string, handle: string, created_at: string, published_at: string) => ({ id: 1, title, handle, body_html: '<p>Comfy organic cotton boxer shorts in a bright kelly green, cut for an easy fit.</p>', created_at, published_at, updated_at: published_at, vendor: 'Lucy & Yak' })
const store = (...products: ReturnType<typeof product>[]): SafeGet => async (url): Promise<HttpResult | null> => ({ status: 200, body: new URL(url).pathname === '/meta.json' ? META : JSON.stringify({ products }) })
const O = { countries: ['GB'], windowDays: 90, now: NOW }

test('#763 a re-published old product is not a new product: the record must be created AND published inside the window', async () => {
  // the real shape: every listed product "published" yesterday, records a year old
  const relisted = store(product('IMPERFECT Kit - Viscose Boxer Shorts in Kelly Green', 'imperfect-kit-boxers', '2025-12-17T10:00:00+00:00', '2026-11-13T09:00:00+00:00'), product('Old Dungarees', 'old-dungarees', '2024-09-02T10:00:00+00:00', '2026-11-13T09:00:00+00:00'))
  assert.equal(await readStore('lucyandyak.com', relisted, O), null, 'a catalogue re-published this week is not a launch')
  // one genuinely new record among re-published ones: that product, not the newest "published" one
  const mixed = store(product('Old Dungarees', 'old-dungarees', '2024-09-02T10:00:00+00:00', '2026-11-13T09:00:00+00:00'), product('Emmerson - Card Holder Organic Cotton in Tulip', 'emmerson-card-holder-in-tulip', '2026-11-01T10:00:00+00:00', '2026-11-03T09:00:00+00:00'))
  const s = await readStore('lucyandyak.com', mixed, O)
  assert.deepEqual([s?.productTitle, s?.createdAt, s?.publishedAt], ['Emmerson - Card Holder Organic Cotton in Tulip', '2026-11-01', '2026-11-03'])
  // created inside the window but published before it cannot happen; created inside, published in the FUTURE (scheduled) is not live
  assert.equal(await readStore('lucyandyak.com', store(product('Scheduled', 'scheduled', '2026-11-10T10:00:00+00:00', '2026-12-01T09:00:00+00:00')), O), null)
  assert.match(storeLead(s!).signal, /added a new product listing "Emmerson - Card Holder Organic Cotton in Tulip" \(record created 2026-11-01, published 2026-11-03\)\.$/)
  assert.doesNotMatch(storeLead(s!).signal, /launched/, 'the signal says what the data says: a new listing, not a launch')
})

test('#763 the stated place names the country in full, as the place check reads names', () => {
  const s = { city: 'Barnsley', province: 'England', country: 'GB' } as ShopifyStore
  assert.equal(placeOf(s), 'Barnsley, England, United Kingdom')
  assert.equal(placeOf({ city: null, province: null, country: 'XX' } as ShopifyStore), 'XX', 'a code this table does not know is kept as it is')
})

// the verifier: one candidate, its product page, the request's place
const QUOTE = 'Comfy organic cotton boxer shorts in a bright kelly green, cut for an easy fit.'
const URL_ = 'https://lucyandyak.com/products/emmerson-card-holder-in-tulip'
const cand = () => [{ name: '', company: 'Lucy & Yak', contact: null, signal: 'Lucy & Yak added a new product listing', source_url: URL_, score: 80, excerpt: QUOTE, event_date: null }]
const pageSaying = (extra: string) => async () => ({ text: `Lucy & Yak\n${QUOTE}\n${extra}`, title: 'Lucy & Yak', retrievedAt: 1_700_000_000 })
const reasons = (o: Awaited<ReturnType<typeof verifyLeads>>) => [...o.review.map(l => l.review_reason), ...o.leads.map(() => 'passed'), ...Object.keys(o.dropped)]
const ELSEWHERE = 'Lucy & Yak is headquartered in Berlin, Germany.'

test('#763 verifier: a page that places the company elsewhere is a mismatch; the store own stated place, when it agrees with the request, answers it; a stated place that disagrees changes nothing', async () => {
  const where = ['United Kingdom']
  const none = await verifyLeads(cand() as never, pageSaying(ELSEWHERE) as never, NOW, undefined, null, undefined, undefined, where)
  assert.ok(reasons(none).includes('location_mismatch'), `without a stated place the page decides: ${JSON.stringify(reasons(none))}`)
  const agrees = await verifyLeads(cand() as never, pageSaying(ELSEWHERE) as never, NOW, undefined, null, undefined, undefined, where, undefined, new Map([[URL_, 'Barnsley, England, United Kingdom']]))
  assert.ok(!reasons(agrees).includes('location_mismatch'), `the store's own stated UK place answers the place question: ${JSON.stringify(reasons(agrees))}`)
  const disagrees = await verifyLeads(cand() as never, pageSaying(ELSEWHERE) as never, NOW, undefined, null, undefined, undefined, where, undefined, new Map([[URL_, 'Austin, Texas, United States']]))
  assert.ok(reasons(disagrees).includes('location_mismatch'), 'a stated place outside the request never rescues a mismatch')
  const otherUrl = await verifyLeads(cand() as never, pageSaying(ELSEWHERE) as never, NOW, undefined, null, undefined, undefined, where, undefined, new Map([['https://other.example/products/x', 'Barnsley, England, United Kingdom']]))
  assert.ok(reasons(otherUrl).includes('location_mismatch'), "another candidate's stated place is not this one's")
  // a page with no place at all behaves as before, with or without a stated place
  const plain = await verifyLeads(cand() as never, pageSaying('Free returns within 30 days.') as never, NOW, undefined, null, undefined, undefined, where)
  assert.ok(!reasons(plain).includes('location_mismatch'))
})
