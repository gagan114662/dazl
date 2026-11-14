// #763: Shopify stores, from Shopify's own public store data. Free, no key, direct HTTP.
//
// Why: a request such as "ecommerce brands in the United Kingdom running on Shopify that launched a new product in the last 90 days"
// found nothing on staging (job 6cb4b14f, 2026-11-13: 3 searches, 30 hits, 0 candidates, no_discovery). The searches returned pages
// ABOUT Shopify (its blog, careers, partner pages) and "top Shopify stores UK" listicles, none of which states a dated launch by a
// named shop. But the listicles LINK the shops (one of them: about 60 store domains), and every ordinary Shopify store answers two
// public JSON endpoints:
//   /meta.json      -> { name, city, province, country, myshopify_domain, ... }     the shop's own stated place
//   /products.json  -> { products: [{ title, handle, body_html, published_at, ... }] } its products with their publish times
// So: store domains come from the scan's own search hits (a hit's host, and the links on a hit that is a store list); a store is kept
// when its meta.json says it is a Shopify store in the country the request names; and its newest product published inside the
// request's window is the evidence, cited by that product's own page.
//
// What this is NOT: a store directory (it only reads stores this scan's searches surfaced), a crawler (two requests per store, a
// fixed budget), or proof by itself (each item is a candidate; the normal verifier still reads the cited product page). Large
// headless brands answer neither endpoint and are simply not found here. published_at is the store's own structured publish time
// for that product; it is carried as the item's date and labelled as such.
import type { AdapterInput, SafeGet } from './types.ts'
import { isRecord, looksLikeHtml } from './types.ts'

export interface ShopifyStore {
  host: string; name: string; city: string | null; province: string | null; country: string
  productUrl: string; productTitle: string; publishedAt: string // YYYY-MM-DD, the store's own publish day for the product
  quote: string // text from the product's own description (or its title), expected on the product page
}

const MAX_LIST_PAGES = 6, MAX_HOSTS = 120, MAX_STORES = 40, CONCURRENCY = 8
// hosts that are never a merchant's own store: the platform itself, social networks, search, CDNs, app stores, review sites
const NOT_A_STORE = /(^|\.)(shopify\.com|shopifycdn\.com|shopify\.dev|facebook\.com|instagram\.com|twitter\.com|x\.com|linkedin\.com|youtube\.com|youtu\.be|tiktok\.com|pinterest\.[a-z.]+|google\.[a-z.]+|gstatic\.com|googleapis\.com|apple\.com|amazon\.[a-z.]+|ebay\.[a-z.]+|etsy\.com|wikipedia\.org|reddit\.com|medium\.com|github\.com|trustpilot\.com|clutch\.co|g2\.com|w3\.org|schema\.org|cloudflare\.com|jsdelivr\.net|fontshare\.com|whatsapp\.com|t\.me|wa\.me|bit\.ly)$/i
// a search hit that is a LIST of stores (its links are store domains): its URL path says so ("top-shopify-stores-uk", "best-ecommerce-brands",
// "shopify-store-examples"). A page wrongly taken for a list costs one request and yields hosts that fail the meta.json check.
const STORE_LIST = /(?:top|best|leading|popular|successful|examples?|stores|brands|shops|websites|sites)/i // tested on the URL's PATH only, never its host
const isStoreList = (u: string): boolean => { try { const x = new URL(u); return x.protocol === 'https:' && STORE_LIST.test(x.pathname) } catch { return false } }

// The country the request names, as ISO codes Shopify's meta.json uses. Empty when it names none this table knows; the scan then
// passes the profile's own country code, and with neither the source reads nothing (it never returns stores from every country).
const COUNTRIES: [RegExp, string][] = [
  [/\b(united kingdom|great britain|britain|england|scotland|wales|northern ireland)\b|\bU\.?K\.?\b/i, 'GB'],
  [/\b(united states|america)\b/i, 'US'],
  [/\b(?:USA|U\.S\.A\.?|U\.S\.?|US)(?![a-z])/, 'US'], // the abbreviation only in capitals: "us" is a word
  [/\bcanada\b/i, 'CA'],
  [/\baustralia\b/i, 'AU'],
  [/\bnew zealand\b/i, 'NZ'],
  [/\bireland\b/i, 'IE'],
  [/\bgermany\b/i, 'DE'],
  [/\bfrance\b/i, 'FR'],
  [/\bnetherlands\b/i, 'NL'],
  [/\bindia\b/i, 'IN'],
  [/\bsingapore\b/i, 'SG'],
]
export function countriesIn(text: string): string[] { const t = text.replace(/northern ireland/gi, 'United Kingdom'); return [...new Set(COUNTRIES.filter(([re]) => re.test(t)).map(([, c]) => c))] }
// "in the last 90 days" / "past 30 days" -> that many days; else 90
export function windowDaysIn(text: string): number { const m = /\b(?:last|past)\s+(\d{1,3})\s+days\b/i.exec(text); const n = m ? Number(m[1]) : 90; return n >= 1 && n <= 365 ? n : 90 }
// Searches that return LISTS of stores (their links are the store domains this source reads). At most two, and only inside the scan's own
// search budget: with one search they are skipped, with two one is asked, with three or more two.
export const storeListQueries = (budget: number): string[] => ['top Shopify stores brands list', 'best Shopify store examples by brand'].slice(0, budget >= 3 ? 2 : budget >= 2 ? 1 : 0)
export const mentionsShopify = (...texts: (string | null | undefined)[]): boolean => texts.some(t => !!t && /\bshopify\b/i.test(t))

const hostOf = (u: string): string | null => { try { const h = new URL(u).hostname.toLowerCase(); return /^[a-z0-9.-]+\.[a-z]{2,}$/.test(h) && !NOT_A_STORE.test(h) ? h : null } catch { return null } }
const plain = (html: string): string => html.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#39;|&rsquo;/g, "'").replace(/&quot;/g, '"').replace(/&[a-z#0-9]+;/gi, ' ').replace(/\s+/g, ' ').trim()
const json = (body: string): unknown => { if (looksLikeHtml(body)) return null; try { return JSON.parse(body) } catch { return null } }
const str = (v: unknown): string | null => typeof v === 'string' && v.trim() ? v.trim() : null

// Store hosts this scan's own searches surfaced: each hit's host, plus the links on hits that are store lists.
export async function storeHosts(discovered: string[], http: SafeGet, note?: (code: string) => void): Promise<string[]> {
  const hosts = new Set<string>()
  for (const u of discovered) { const h = hostOf(u); if (h) hosts.add(h) }
  const lists = [...new Set(discovered.filter(isStoreList))].slice(0, MAX_LIST_PAGES)
  for (const page of await Promise.all(lists.map(u => http(u, { accept: 'text/html' }).catch(() => null)))) {
    if (!page || page.status !== 200) { note?.('list_unreadable'); continue }
    for (const m of page.body.matchAll(/href\s*=\s*["'](https?:\/\/[^"'\s>]+)["']/gi)) { const h = hostOf(m[1]); if (h) hosts.add(h); if (hosts.size >= MAX_HOSTS) break }
    // a list that names its stores as text ("sunspel.com") rather than as links: bare domains in the page's text. A wrong guess costs one request (no meta.json, dropped).
    for (const m of page.body.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ').matchAll(/\b((?:www\.)?[a-z0-9][a-z0-9-]{1,40}\.(?:com|co\.uk|uk|shop|store|co|cc|london))\b/gi)) { const h = hostOf(`https://${m[1]}`); if (h) hosts.add(h); if (hosts.size >= MAX_HOSTS) break }
  }
  return [...hosts].slice(0, MAX_HOSTS)
}

// One store: its meta.json (is it a Shopify store, where is it) and its newest product published inside the window.
export async function readStore(host: string, http: SafeGet, o: { countries: string[]; windowDays: number; now: Date }, note?: (code: string) => void): Promise<ShopifyStore | null> {
  const metaRes = await http(`https://${host}/meta.json`, { accept: 'application/json' }).catch(() => null)
  if (!metaRes || metaRes.status !== 200) return null // not a Shopify store this source can read (headless, blocked, not Shopify): not an error
  const meta = json(metaRes.body)
  if (!isRecord(meta) || !str(meta.myshopify_domain)) return null
  const country = (str(meta.country) ?? '').toUpperCase()
  if (o.countries.length > 0 && !o.countries.includes(country)) return null
  const prodRes = await http(`https://${host}/products.json?limit=30`, { accept: 'application/json' }).catch(() => null)
  if (!prodRes || prodRes.status !== 200) { note?.(prodRes?.status === 429 ? 'throttled' : 'products_unreadable'); return null }
  if (prodRes.truncated) { note?.('oversize'); return null }
  const body = json(prodRes.body)
  const products = isRecord(body) && Array.isArray(body.products) ? body.products.filter(isRecord) : null
  if (!products) { note?.('products_unreadable'); return null }
  const today = o.now.toISOString().slice(0, 10), floor = new Date(o.now.getTime() - o.windowDays * 86_400_000).toISOString().slice(0, 10)
  let best: { day: string; title: string; handle: string; quote: string } | null = null
  for (const p of products) {
    const day = (str(p.published_at) ?? '').slice(0, 10), title = str(p.title), handle = str(p.handle)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || day < floor || day > today || !title || !handle || !/^[a-z0-9][a-z0-9-]*$/i.test(handle)) continue
    const text = plain(str(p.body_html) ?? ''), quote = (text.length >= 20 ? text : title).slice(0, 300)
    if (quote.length < 20) continue
    if (!best || day > best.day) best = { day, title, handle, quote }
  }
  if (!best) return null // a readable store with nothing published inside the window: not a lead for this request
  return { host, name: plain(str(meta.name) ?? host).slice(0, 80) || host, city: str(meta.city), province: str(meta.province), country, productUrl: `https://${host}/products/${best.handle}`, productTitle: best.title.slice(0, 160), publishedAt: best.day, quote: best.quote }
}

// countries: the ISO codes a kept store must be in (the request's own words, else the profile's country). EMPTY reads nothing: a
// request whose country this source cannot name gets no stores rather than stores from everywhere.
// The whole collection has one time limit (budgetMs): hosts not started by then are skipped and reported ('time_budget'), so a slow
// or hostile list of hosts cannot hold the scan.
export const SHOPIFY_BUDGET_MS = 45_000
export async function collectShopifyStores(input: Pick<AdapterInput, 'query' | 'discovered' | 'http' | 'note'> & { countries?: string[]; budgetMs?: number }, now = new Date()): Promise<ShopifyStore[]> {
  const countries = (input.countries?.length ? input.countries : countriesIn(input.query)).map(c => c.toUpperCase())
  if (countries.length === 0) { input.note?.('no_country'); return [] }
  const started = Date.now(), budget = input.budgetMs ?? SHOPIFY_BUDGET_MS
  const hosts = await storeHosts(input.discovered ?? [], input.http, input.note)
  const o = { countries, windowDays: windowDaysIn(input.query), now }
  const out: ShopifyStore[] = [], seen = new Set<string>()
  let next = 0, cut = false
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, hosts.length) }, async () => {
    while (next < hosts.length && out.length < MAX_STORES) {
      if (Date.now() - started > budget) { if (!cut) { cut = true; input.note?.('time_budget') } return }
      const host = hosts[next++]
      const s = await readStore(host, input.http, o, input.note).catch(() => { input.note?.('store_error'); return null })
      if (s && !seen.has(s.name.toLowerCase()) && out.length < MAX_STORES) { seen.add(s.name.toLowerCase()); out.push(s) }
    }
  }))
  return out.sort((a, b) => (a.publishedAt < b.publishedAt ? 1 : a.publishedAt > b.publishedAt ? -1 : a.host.localeCompare(b.host)))
}

export const placeOf = (s: ShopifyStore): string => [s.city, s.province, s.country].filter(Boolean).join(', ')
// The candidate a store becomes: the shop as the company, its newest in-window product as the dated signal, the product page as the source.
export const storeLead = (s: ShopifyStore): { name: string; company: string; contact: null; signal: string; source_url: string; excerpt: string } => ({
  name: '', company: s.name, contact: null, source_url: s.productUrl, excerpt: s.quote,
  signal: `${s.name} (${placeOf(s)}), a Shopify store at ${s.host}, published a new product "${s.productTitle}" on ${s.publishedAt}.`,
})

