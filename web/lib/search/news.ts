// Free, keyless news search: Bing News RSS. A second search backend beside TinyFish, so lead finding does not depend on
// one paid provider's quota or coverage, and still works when TinyFish is off. Dated news (funding, openings,
// expansions, hiring announcements) for any query, country and language. Nothing about the query is fixed here: the
// queries are the scan's own (direct + model-planned, already carrying the buyer's place), the market is the ICP's.
//
// Feed links point at a Bing click-through URL whose url= parameter is the publisher's article; that real URL is what
// the evidence cites, so the verifier fetches the publisher page itself. Hits carry title, description and pubDate.
import type { SafeGet } from '../sources/types.ts'
import type { SearchHit } from './tinyfish.ts'
import { decodeText, toDate } from '../sources/rss.ts'

export const newsEnabled = (env: Record<string, string | undefined> = process.env) => env.NEWS_SEARCH_ENABLED !== '0'
export const NEWS_PER_SCAN = 4

// Bing market code from the ICP (language-COUNTRY, e.g. pt-PT, en-IN). Unknown parts are left to Bing's default.
export function bingMarket(country?: string, language?: string): string | null {
  if (country && language) return `${language.toLowerCase()}-${country.toUpperCase()}`
  return null
}

export function newsUrl(query: string, market: string | null): string {
  const q = new URLSearchParams({ q: query.slice(0, 250), format: 'rss', ...(market ? { mkt: market, setlang: market.split('-')[0] } : {}) })
  return `https://www.bing.com/news/search?${q}`
}

// The publisher URL from a Bing click-through link; a direct https link is kept as is. Anything else is dropped.
export function publisherUrl(link: string): string | null {
  let u: URL
  try { u = new URL(decodeText(link)) } catch { return null }
  if (/(^|\.)bing\.com$/i.test(u.hostname)) {
    const real = u.searchParams.get('url')
    if (!real) return null
    try { const r = new URL(real); return r.protocol === 'https:' && !/(^|\.)bing\.com$/i.test(r.hostname) ? r.toString() : null } catch { return null }
  }
  return u.protocol === 'https:' ? u.toString() : null
}

export function parseNewsRss(xml: string, max = 15): SearchHit[] {
  const out: SearchHit[] = []
  for (const [, block] of [...xml.matchAll(/<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/gi)].slice(0, max * 2)) {
    const get = (name: string) => block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i'))?.[1]
    const url = publisherUrl(get('link') ?? '')
    const title = decodeText(get('title') ?? '')
    if (!url || title.length < 5 || url.length > 480) continue
    out.push({ url, title: title.slice(0, 200), snippet: decodeText(get('description') ?? '').slice(0, 400), date: toDate(get('pubDate')) })
    if (out.length >= max) break
  }
  return out
}

// One request per query, at most NEWS_PER_SCAN. A failed or empty query only means fewer hits.
export async function newsSearch(http: SafeGet, queries: string[], market: string | null): Promise<SearchHit[]> {
  const hits: SearchHit[] = []
  const seen = new Set<string>()
  for (const q of queries.slice(0, NEWS_PER_SCAN)) {
    const r = await http(newsUrl(q, market), { accept: 'application/rss+xml, application/xml, text/xml' }).catch(() => null)
    if (!r || r.status !== 200 || !r.body) continue
    for (const h of parseNewsRss(r.body)) if (!seen.has(h.url)) { seen.add(h.url); hits.push(h) }
  }
  return hits
}
