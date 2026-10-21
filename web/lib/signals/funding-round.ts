// Funding-round signal: recent Series A/B (and seed) raises from free news RSS feeds,
// matched to a scan's verified leads by company name. Discovery is plain RSS/Atom XML -
// no scraping. Jina Reader (lib/scrape/jina.ts, a third-party service the URL is sent to)
// is only called for the article page when the feed item itself lacks the amount or
// stage, and only for public https URLs, capped per scan; failures fall back to what
// the feed already said. Crunchbase is never touched (its terms prohibit scraping).
import { parseFeed } from '../sources/rss.ts'
import { nameTokens } from './index.ts'
import { scrapePage } from '../scrape/jina.ts'

const TIMEOUT = 8000
const WINDOW_DAYS = 60
const MAX_JINA_PER_SCAN = 2
export const DEFAULT_FEEDS = [
  'https://techcrunch.com/category/startups/feed/',
  'https://venturebeat.com/feed/',
]

export interface RoundItem { url: string; title: string; date: string; company: string; amount: string | null; stage: string | null }

const RAISE = /\b(raises?|raised|lands?|snags?|closes?|gets|secures?|bags)\b[\s\S]{0,60}?\$\s?([\d.]+)\s?(m|b|k|million|billion|thousand)\b/i
const STAGE = /\b(pre-seed|seed|series\s?[a-f](?:\d?)|bridge|growth|venture round|private equity)\b/i
const FUNDY = /\b(raises?|raised|funding|funded|series\s?[a-f]|seed round|venture|investment)\b/i

// "Acme raises $30M Series B" -> { company: 'Acme', amount: '$30M', stage: 'Series B' }
export function extractRaise(title: string): { company: string; amount: string | null; stage: string | null } | null {
  if (!FUNDY.test(title)) return null
  const stageM = title.match(STAGE)
  const amtM = title.match(RAISE) ?? title.match(/\$\s?([\d.]+)\s?(m|b|k|million|billion|thousand)\b/i)
  if (!amtM && !stageM) return null
  const amount = amtM ? `$${amtM[2] ?? amtM[1]}${(/^(m|million)$/i.test(amtM[3] ?? amtM[2]) ? 'M' : /^(b|billion)$/i.test(amtM[3] ?? amtM[2]) ? 'B' : 'K')}` : null
  const stage = stageM ? (/seed/i.test(stageM[1]) && !/pre/i.test(stageM[1]) ? 'Seed' : stageM[1].replace(/\s+/g, ' ').replace(/^./, c => c.toUpperCase()).replace(/series\s?/i, 'Series ')) : null
  // company = text before the raise verb, minus trailing noise like "exclusive:" or "report:"
  const verb = title.match(RAISE) ?? title.match(/\b(funding|funded|lands|closes|secures)\b/i)
  let company = verb && verb.index !== undefined ? title.slice(0, verb.index) : title
  company = company.replace(/^(exclusive|report|scoop|breaking|watch)\s*[:\-]\s*/i, '').replace(/[\s,;:\-–]+$/, '').trim()
  if (company.length < 2 || company.length > 60) return null
  return { company, amount, stage }
}

export function matchesCompany(company: string, candidate: string): boolean {
  const want = nameTokens(company)
  if (!want.length) return false
  const have = new Set(nameTokens(candidate))
  return want.every(t => have.has(t))
}

const isPublicHttp = (u: string): boolean => {
  try {
    const x = new URL(u)
    if (x.protocol !== 'https:' || x.username || x.password) return false
    const h = x.hostname
    if (/^(localhost|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|0\.0\.0\.0|\[)/.test(h)) return false
    return h.includes('.')
  } catch { return false }
}

async function fetchFeedItems(feed: string, fetchImpl: typeof fetch): Promise<{ url: string; title: string; date: string | null }[]> {
  try {
    const res = await fetchImpl(feed, { headers: { 'user-agent': 'dazl/1.0', accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9' }, signal: AbortSignal.timeout(TIMEOUT) })
    if (!res.ok) return []
    return parseFeed(await res.text(), 40)
  } catch { return [] }
}

// Recent raise announcements across the configured feeds, deduped by URL, newest first.
export async function fundingNews(fetchImpl: typeof fetch = fetch, feeds: string[] = DEFAULT_FEEDS, now: Date = new Date()): Promise<RoundItem[]> {
  const cutoff = now.getTime() - WINDOW_DAYS * 86400_000
  const seen = new Set<string>()
  const out: RoundItem[] = []
  for (const feed of feeds.slice(0, 5)) {
    for (const item of await fetchFeedItems(feed, fetchImpl)) {
      if (!item.date || new Date(item.date).getTime() < cutoff || seen.has(item.url)) continue
      const r = extractRaise(item.title)
      if (!r) continue
      seen.add(item.url)
      out.push({ url: item.url, title: item.title, date: item.date, ...r })
    }
  }
  return out.sort((a, b) => (a.date < b.date ? 1 : -1))
}

// Latest matching raise for a lead's company. When the feed item lacks the amount or
// stage, ONE Jina Reader call per item (capped per scan) reads the article page for it.
// Jina failure or rate limit just means the feed-only fields stand - never a hard error.
export async function fundingRoundFor(
  company: string,
  news: RoundItem[],
  deps: { fetchImpl?: typeof fetch; jina?: (url: string) => Promise<string>; jinaLeft?: { n: number }; now?: Date } = {},
): Promise<{ date: string; url: string; amount: string | null; stage: string | null; daysAgo: number } | null> {
  const now = deps.now ?? new Date()
  const hit = news.find(n => matchesCompany(company, n.company) || matchesCompany(company, n.title))
  if (!hit) return null
  let { amount, stage } = hit
  if ((!amount || !stage) && isPublicHttp(hit.url)) {
    const budget = deps.jinaLeft ?? { n: MAX_JINA_PER_SCAN }
    if (budget.n > 0) {
      budget.n--
      try {
        const md = await (deps.jina ?? scrapePage)(hit.url)
        const body = extractRaise(md.replace(/\s+/g, ' ').slice(0, 4000))
        amount = amount ?? body?.amount ?? null
        stage = stage ?? body?.stage ?? null
      } catch { /* rate-limited or down: keep feed-only fields */ }
    }
  }
  const daysAgo = Math.max(0, Math.round((now.getTime() - new Date(hit.date).getTime()) / 86400_000))
  return { date: hit.date, url: hit.url, amount, stage, daysAgo }
}
