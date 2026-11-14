// #763: the Shopify source (lib/sources/shopify.ts). Fixtures are in the shapes real stores returned on 2026-11-14
// (snagtights.com/meta.json and lucyandyak.com/meta.json read through the TinyFish fetcher; a "top Shopify stores UK" list page
// read directly): Shopify's meta.json has name / city / province / country / myshopify_domain, products.json has
// products[{ title, handle, body_html, published_at }]. No network: the HTTP getter is a stub.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { collectShopifyStores, countriesIn, mentionsShopify, readStore, storeHosts, storeLead, storeListQueries, windowDaysIn } from '../lib/sources/shopify.ts'
import type { HttpResult, SafeGet } from '../lib/sources/types.ts'

const NOW = new Date('2026-11-14T12:00:00Z')
const META = (o: Record<string, unknown>) => JSON.stringify({ id: 27843408, name: 'Snag', city: 'Livingston', province: 'Scotland', country: 'GB', currency: 'GBP', domain: 'snagtights.com', url: 'https://snagtights.com', myshopify_domain: 'snagtights.myshopify.com', description: 'Welcome to the home of ridiculously comfy tights', ships_to_countries: ['GB'], money_format: '£{{amount}}', published_collections_count: 80, published_products_count: 700, ...o })
const PRODUCT = (title: string, handle: string, published_at: string | null, body = '<p><meta charset="utf-8"><span>Emmerson is our new card holder, made from organic cotton twill in a bright tulip print.</span></p>') => ({ id: 15704149066102, title, handle, body_html: body, published_at, created_at: published_at, updated_at: '2026-11-13T10:00:00+00:00', vendor: 'Lucy & Yak', product_type: 'Accessories', tags: ['new'], variants: [{ id: 1, title: 'One Size', price: '12.00' }], images: [] })
const PRODUCTS = (...p: ReturnType<typeof PRODUCT>[]) => JSON.stringify({ products: p })
const LIST = `<!doctype html><html><body><h1>Top 50+ Shopify Stores in the UK</h1>
  <a href="https://snagtights.com/">Snag</a> <a href="https://lucyandyak.com/collections/new">Lucy &amp; Yak</a> <a href="https://www.instagram.com/snag">ig</a>
  <a href="https://www.shopify.com/uk/plus">Shopify Plus</a><p>Also loved: usbrand.com and headless.co.uk</p><script>var x = "https://tracker.example.com/t.js"</script></body></html>`

// a stub store network: path -> answer per host
function net(stores: Record<string, { meta?: string | number; products?: string | number | { truncated: true } }>, pages: Record<string, string> = {}) {
  const calls: string[] = []
  const http: SafeGet = async (url): Promise<HttpResult | null> => {
    calls.push(url)
    if (pages[url] !== undefined) return { status: 200, body: pages[url] }
    const u = new URL(url), s = stores[u.hostname]
    if (!s) return { status: 404, body: '<!doctype html><html>not found</html>' }
    const v = u.pathname === '/meta.json' ? s.meta : u.pathname === '/products.json' ? s.products : undefined
    if (v === undefined) return { status: 404, body: '' }
    if (typeof v === 'number') return { status: v, body: '' }
    if (typeof v === 'object') return { status: 200, body: '{"products":[', truncated: true }
    return { status: 200, body: v }
  }
  return { http, calls }
}

test('#763 request parsing: the country the request names, its window, whether it is about Shopify, and how many list searches fit the budget', () => {
  assert.deepEqual(countriesIn('Ecommerce brands in the United Kingdom running on Shopify'), ['GB'])
  assert.deepEqual(countriesIn('Shopify stores in the UK and the US'), ['GB', 'US'])
  assert.deepEqual(countriesIn('Shopify stores in Ukraine'), [], 'a country this table does not know names none ("Ukraine" is not "UK")')
  assert.deepEqual(countriesIn('brands that focus on us and our customers'), [], 'the word "us" is not the United States')
  assert.equal(windowDaysIn('launched a new product in the last 90 days'), 90); assert.equal(windowDaysIn('in the past 30 days'), 30); assert.equal(windowDaysIn('recently'), 90); assert.equal(windowDaysIn('last 999 days'), 90)
  assert.equal(mentionsShopify('Ecommerce brands running on Shopify', null), true); assert.equal(mentionsShopify('ecommerce brands', 'Uses Shopify platform'), true); assert.equal(mentionsShopify('ecommerce brands', undefined, 'new product'), false)
  assert.deepEqual([1, 2, 3, 8].map(n => storeListQueries(n).length), [0, 1, 2, 2], 'inside the scan search budget: never the only search')
})

test('#763 store hosts come from this scan own hits: hit hosts, links and plain-text domains on store-list hits; platforms and socials are never stores', async () => {
  const listUrl = 'https://www.huptechweb.example/blogs/top-shopify-stores-uk'
  const { http, calls } = net({}, { [listUrl]: LIST })
  const hosts = await storeHosts([listUrl, 'https://www.shopify.com/uk/blog/x', 'https://gymshark.example/products/a', 'https://www.linkedin.com/company/x', 'not a url'], http)
  assert.deepEqual(hosts.sort(), ['gymshark.example', 'headless.co.uk', 'lucyandyak.com', 'snagtights.com', 'usbrand.com', 'www.huptechweb.example'].sort())
  assert.deepEqual(calls, [listUrl], 'only the list page is read; an ordinary hit is not fetched for links')
  const notes: string[] = []
  assert.deepEqual(await storeHosts(['https://lists.example/best-shopify-brands'], async () => ({ status: 503, body: '' }), c => notes.push(c)), ['lists.example'])
  assert.deepEqual(notes, ['list_unreadable'], 'an unreadable list is reported, never a silent empty')
})

test('#763 one store: kept only if meta.json says a Shopify store in the requested country, with a product published inside the window; the evidence is that product page', async () => {
  const o = { countries: ['GB'], windowDays: 90, now: NOW }
  const { http } = net({
    'snagtights.com': { meta: META({}), products: PRODUCTS(PRODUCT('Old Tights', 'old-tights', '2026-01-02T09:00:00+00:00'), PRODUCT('Emmerson - Card Holder Organic Cotton in Tulip', 'emmerson-card-holder-in-tulip', '2026-11-10T09:00:00+00:00'), PRODUCT('Scheduled', 'scheduled', '2026-12-25T09:00:00+00:00'), PRODUCT('Draft', 'draft', null)) },
    'usbrand.com': { meta: META({ name: 'US Brand', country: 'US', city: 'Austin', myshopify_domain: 'usbrand.myshopify.com' }), products: PRODUCTS(PRODUCT('New', 'new', '2026-11-10T09:00:00+00:00')) },
    'notshopify.example': { meta: JSON.stringify({ name: 'Some site', country: 'GB' }), products: PRODUCTS(PRODUCT('New', 'new', '2026-11-10T09:00:00+00:00')) },
    'stale.example': { meta: META({ name: 'Stale', myshopify_domain: 'stale.myshopify.com' }), products: PRODUCTS(PRODUCT('Old', 'old', '2026-05-01T09:00:00+00:00')) },
    'headless.co.uk': { meta: 404 },
    'wall.example': { meta: '<!doctype html><html><body>Checking your browser</body></html>' },
    'throttled.example': { meta: META({ name: 'Throttled', myshopify_domain: 't.myshopify.com' }), products: 429 },
    'huge.example': { meta: META({ name: 'Huge', myshopify_domain: 'h.myshopify.com' }), products: { truncated: true } },
  })
  const snag = await readStore('snagtights.com', http, o)
  assert.deepEqual(snag, { host: 'snagtights.com', name: 'Snag', city: 'Livingston', province: 'Scotland', country: 'GB', productUrl: 'https://snagtights.com/products/emmerson-card-holder-in-tulip', productTitle: 'Emmerson - Card Holder Organic Cotton in Tulip', publishedAt: '2026-11-10', quote: 'Emmerson is our new card holder, made from organic cotton twill in a bright tulip print.' })
  assert.equal(await readStore('usbrand.com', http, o), null, 'a store in another country is not a lead for a UK request')
  assert.notEqual(await readStore('usbrand.com', http, { ...o, countries: [] }), null, 'a request that names no country drops no store for its country')
  assert.equal(await readStore('notshopify.example', http, o), null, 'no myshopify_domain: not a Shopify store')
  assert.equal(await readStore('stale.example', http, o), null, 'nothing published inside the window')
  assert.equal(await readStore('headless.co.uk', http, o), null); assert.equal(await readStore('wall.example', http, o), null, 'a bot wall (HTML at a JSON address) is not data')
  const notes: string[] = []
  assert.equal(await readStore('throttled.example', http, o, c => notes.push(c)), null); assert.equal(await readStore('huge.example', http, o, c => notes.push(c)), null)
  assert.deepEqual(notes, ['throttled', 'oversize'], 'a store that answered but could not be read is reported')
  // the candidate it becomes
  assert.deepEqual(storeLead(snag!), { name: '', company: 'Snag', contact: null, source_url: 'https://snagtights.com/products/emmerson-card-holder-in-tulip', excerpt: 'Emmerson is our new card holder, made from organic cotton twill in a bright tulip print.', signal: 'Snag (Livingston, Scotland, GB), a Shopify store at snagtights.com, published a new product "Emmerson - Card Holder Organic Cotton in Tulip" on 2026-11-10.' })
})

test('#763 the whole source: stores from a list hit, country and window applied, one candidate per store, newest first; a store that throws does not stop the others', async () => {
  const listUrl = 'https://www.huptechweb.example/blogs/top-shopify-stores-uk'
  const { http, calls } = net({
    'snagtights.com': { meta: META({}), products: PRODUCTS(PRODUCT('Autumn Tights', 'autumn-tights', '2026-10-01T09:00:00+00:00')) },
    'lucyandyak.com': { meta: META({ name: 'Lucy & Yak', city: 'Barnsley', province: 'England', myshopify_domain: 'lucy-yak.myshopify.com' }), products: PRODUCTS(PRODUCT('Emmerson - Card Holder Organic Cotton in Tulip', 'emmerson-card-holder-in-tulip', '2026-11-12T09:00:00+00:00')) },
    'usbrand.com': { meta: META({ name: 'US Brand', country: 'US', myshopify_domain: 'usbrand.myshopify.com' }), products: PRODUCTS(PRODUCT('New', 'new', '2026-11-10T09:00:00+00:00')) },
  }, { [listUrl]: LIST })
  const broken: SafeGet = async (url, opts) => { if (url.includes('headless.co.uk')) throw new Error('socket hang up'); return http(url, opts) }
  const notes: string[] = []
  const stores = await collectShopifyStores({ query: 'Ecommerce brands in the United Kingdom running on Shopify that launched a new product in the last 90 days', discovered: [listUrl], http: broken, note: c => notes.push(c) }, NOW)
  assert.deepEqual(stores.map(s => [s.name, s.publishedAt, s.city]), [['Lucy & Yak', '2026-11-12', 'Barnsley'], ['Snag', '2026-10-01', 'Livingston']])
  assert.ok(!calls.some(u => /shopify\.com|instagram\.com|tracker\.example/.test(u)), 'the platform, socials and script URLs are never probed')
  assert.ok(calls.filter(u => u.includes('usbrand.com')).every(u => u.endsWith('/meta.json')), 'a store in the wrong country costs one request: its products are never read')
  assert.deepEqual(await collectShopifyStores({ query: 'Shopify stores in the UK', discovered: [], http }, NOW), [], 'no hits, no stores: it never invents a domain')
})

test('#763 the scan asks for store lists and runs the source before the no-candidates stop', () => {
  const runner = readFileSync(new URL('../lib/scan/runner.ts', import.meta.url), 'utf8')
  const source = runner.indexOf('await collectShopifyStores('), stop = runner.indexOf("// a trial whose budget refused a step stops with what it has (finishTrialBudget, via the catch below)", source)
  assert.ok(source > 0 && stop > source, 'the Shopify source is collected before the stop that ends a scan with no candidates')
  assert.match(runner, /const storeLists = mentionsShopify\(job\.query, icp\.summary, \.\.\.\(icp\.signals \?\? \[\]\)\) \? storeListQueries\(budgetN\) : \[\]/)
  assert.match(runner, /withGeography\(\[\.\.\.storeLists, \.\.\.direct, \.\.\.tech,/)
})
