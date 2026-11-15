// #763 (stacked on the Shopify source): two things real data showed.
//  1. products.json published_at does NOT mark a new product. On 12 real UK stores (2026-11-14) 10 had ALL of their listed products
//     "published" inside 90 days, with records created 300 to 800 days earlier (lucyandyak.com: newest "published" 2026-11-13, record
//     created 2025-12-17; missoma.com: published 2026-11-10, created 2024-09-02). A candidate now needs a product whose record was
//     CREATED and published inside the window.
//  2. A store's own stated place (meta.json: city, province, country) is handed to the verifier's place check as one more sentence of
//     the company's own block. It never overrules a page that places the company itself elsewhere, and for a city-level request it is
//     evidence AGAINST a store in another city. On real product pages of three UK stores the place check read "unconfirmed" (no place
//     named), which already passes, so no lead is shown to be rescued by it.
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
  // window edges and broken records: the floor day and today are inside; a record with no created_at, or created after it was published, is not kept
  const edge = (c: string | null, p: string) => readStore('lucyandyak.com', store({ ...product('Edge', 'edge', c ?? '', p), ...(c === null ? { created_at: null as unknown as string } : {}) }), O)
  assert.equal((await edge('2026-08-16T00:00:00+00:00', '2026-08-16T12:00:00+00:00'))?.createdAt, '2026-08-16', 'the first day of the 90-day window is inside')
  assert.equal(await edge('2026-08-15T23:59:00+00:00', '2026-11-14T08:00:00+00:00'), null, 'one day before the window: a re-listing')
  assert.equal((await edge('2026-11-14T01:00:00+00:00', '2026-11-14T02:00:00+00:00'))?.publishedAt, '2026-11-14', 'today is inside')
  assert.equal(await edge(null, '2026-11-10T09:00:00+00:00'), null, 'no created_at: not a provably new record')
  assert.equal(await edge('2026-11-10T09:00:00+00:00', '2026-11-03T09:00:00+00:00'), null, 'created after published is not a sane record')
  const notes: string[] = []
  assert.equal(await readStore('lucyandyak.com', relisted, O, c => notes.push(c)), null); assert.deepEqual(notes, ['no_new_listing'], 'a readable store dropped by this rule is reported')
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
const fate = (o: Awaited<ReturnType<typeof verifyLeads>>) => ({ leads: o.leads.length, review: o.review.map(l => l.review_reason), dropped: Object.keys(o.dropped) })
const run = (extra: string, where: string[], stated?: [string, string]) => verifyLeads(cand() as never, pageSaying(extra) as never, NOW, undefined, null, undefined, undefined, where, undefined, stated ? new Map([stated]) : undefined)
const PASSED = { leads: 1, review: [], dropped: [] }, MISMATCH = { leads: 0, review: ['location_mismatch'], dropped: [] }
const UK = 'Barnsley, England, United Kingdom'

test('#763 verifier: a stated place NEVER overrules a page that places the company itself elsewhere (no bar-lowering)', async () => {
  const bound = 'Lucy & Yak is headquartered in Berlin, Germany.'
  assert.deepEqual(fate(await run(bound, ['United Kingdom'])), MISMATCH)
  assert.deepEqual(fate(await run(bound, ['United Kingdom'], [URL_, UK])), MISMATCH, 'the store saying "United Kingdom" about itself does not rescue a page that says the company is in Berlin')
  // a page that mismatches on its own stays a mismatch, whatever the store states (the independent re-review found these passed)
  for (const page of ['Based in Berlin.', 'Based in Lisbon, Portugal', 'Our factory in Berlin', 'Our warehouse is in Berlin, Germany.', 'We ship from Paris, France.', 'Our founder lives in Paris.']) {
    const alone = fate(await run(page, ['United Kingdom']))
    if (alone.review.includes('location_mismatch')) assert.deepEqual(fate(await run(page, ['United Kingdom'], [URL_, UK])), alone, `a page-only mismatch is final: ${page}`)
  }
  assert.deepEqual(fate(await run('Based in Berlin.', ['United Kingdom'], [URL_, UK])), MISMATCH, 'pinned: this page mismatches on its own')
})

test('#763 verifier: a page that names no place passes as before; the stated place is evidence AGAINST a store outside a city-level request', async () => {
  const plain = 'Free returns within 30 days.'
  assert.deepEqual(fate(await run(plain, ['United Kingdom'])), PASSED)
  assert.deepEqual(fate(await run(plain, ['United Kingdom'], [URL_, UK])), PASSED)
  // a page that merely mentions another place was not a mismatch before and is not one now
  assert.deepEqual(fate(await run('Made in Portugal. Dispatched from our Lisbon warehouse.', ['United Kingdom'], [URL_, UK])), PASSED)
  // "stores in London": the page alone cannot tell; the store's own stated city can
  assert.deepEqual(fate(await run(plain, ['London'])), PASSED, 'without a stated place a page that names no place is not rejected')
  assert.deepEqual(fate(await run(plain, ['London'], [URL_, UK])), MISMATCH, 'a store that states Barnsley is not a London store')
  assert.deepEqual(fate(await run(plain, ['London'], [URL_, 'London, England, United Kingdom'])), PASSED, 'a store that states London is')
})

test('#763 verifier: the stated place belongs to its own candidate only (keyed by the source URL, a trailing slash ignored)', async () => {
  const plain = 'Free returns within 30 days.'
  assert.deepEqual(fate(await run(plain, ['London'], ['https://other.example/products/x', UK])), PASSED, "another candidate's stated place is not this one's")
  assert.deepEqual(fate(await run(plain, ['London'], [`${URL_}/`, UK])), PASSED, 'a key that is not the canonical URL never matches: no stated place, judged as before')
  assert.deepEqual(fate(await run(plain, ['London'], [URL_, UK])), MISMATCH)
})
