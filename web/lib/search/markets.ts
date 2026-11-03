// Multi-market search planning (#391). A request that names places in several countries or languages ("SaaS companies in
// Tokyo, Dubai and Pune hiring sales managers") used to be searched as ONE country and ONE language (icp.country /
// icp.language), so the other markets were silently never visited. Here every search query is bound to exactly one market
// of the profile (lib/scan/icp.ts `markets`, at most 3), searched with THAT market's country and language, and every market
// gets at least one query when the budget has one to give. Bounded: the number of queries never grows (queries are only
// assigned and, for an uncovered market, one query of an over-served market is re-pointed at it). Pure: no network.
import type { Market } from '../scan/icp.ts'
import { namesPlace, withGeography } from './tinyfish.ts'

export interface MarketTask { query: string; market: Market | null }

export const marketLabel = (m: Market): string => `${m.where} (${m.country ?? '-'}/${m.language ?? '-'})`

// The markets a scan searches: only a profile with 2+ validated markets is multi-market; anything else keeps the single
// country/language search exactly as before.
export function searchMarkets(icp: { markets?: Market[] } | null | undefined): Market[] {
  const m = icp?.markets
  return Array.isArray(m) && m.length >= 2 ? m.slice(0, 3) : []
}

const escapeRe = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
function repoint(query: string, from: Market, to: Market): string {
  const re = new RegExp(`(?<![\\p{L}\\p{N}])${from.where.split(/\s+/).map(escapeRe).join('\\s+')}(?![\\p{L}\\p{N}])`, 'giu')
  const out = query.replace(re, to.where)
  return out === query ? withGeography([query], [to.where])[0] : out
}

export function planMarketQueries(queries: string[], markets: Market[]): MarketTask[] {
  if (markets.length < 2) return queries.map(query => ({ query, market: null }))
  // A query that names a market's place belongs to it; every other query goes to the market with the fewest queries so far
  // (profile order breaks ties) and gets that market's place appended.
  const named = queries.map(q => markets.find(m => namesPlace(q, m.where)) ?? null)
  const count = new Map(markets.map(m => [m, named.filter(n => n === m).length]))
  const tasks: MarketTask[] = queries.map((q, i) => {
    if (named[i]) return { query: q, market: named[i] }
    const m = markets.reduce((best, x) => (count.get(x)! < count.get(best)! ? x : best), markets[0])
    count.set(m, count.get(m)! + 1)
    return { query: withGeography([q], [m.where])[0], market: m }
  })
  // Coverage: a market no query was bound to borrows the LAST query of the market with the most queries (2+), with that
  // market's place swapped for its own. A market stays unvisited only when no market has a query to spare (reported).
  for (const m of markets) {
    if (tasks.some(t => t.market === m)) continue
    const counts = markets.map(d => ({ d, n: tasks.filter(t => t.market === d).length })).sort((a, b) => b.n - a.n)
    const donor = counts[0]
    if (!donor || donor.n < 2) continue
    let i = -1
    for (let j = tasks.length - 1; j >= 0; j--) if (tasks[j].market === donor.d && !/site:/i.test(tasks[j].query)) { i = j; break }
    if (i < 0) for (let j = tasks.length - 1; j >= 0; j--) if (tasks[j].market === donor.d) { i = j; break }
    tasks[i] = { query: repoint(tasks[i].query, donor.d, m), market: m }
  }
  return tasks
}

// Per-market measurement for the run report: queries sent, unique result URLs, candidates the verifier saw and how many
// were usable (verified) or held for review. A URL belongs to the first market whose query returned it. Markets with no
// query are listed with queries: 0 (not visited), never left out. usable_yield = verified / candidates (null: no candidate).
export interface MarketPlan { market: string; country: string | null; language: string | null; queries: number }
export interface MarketYield extends MarketPlan { result_urls: number; candidates: number; verified: number; needs_review: number; usable_yield: number | null }
export const marketPlan = (markets: Market[], tasks: MarketTask[]): MarketPlan[] =>
  markets.map(m => ({ market: marketLabel(m), country: m.country ?? null, language: m.language ?? null, queries: tasks.filter(t => t.market === m).length }))
const bare = (u: string) => u.replace(/\/+$/, '')
export function marketYield(plan: MarketPlan[], urls: { url: string; market?: string | null }[], fates: { url: string; fate: string }[]): MarketYield[] {
  return plan.map(p => {
    const own = new Set(urls.filter(u => u.market === p.market).map(u => bare(u.url)))
    const mine = fates.filter(f => own.has(bare(f.url)))
    const verified = mine.filter(f => f.fate === 'verified').length
    return { ...p, result_urls: own.size, candidates: mine.length, verified, needs_review: mine.filter(f => f.fate.startsWith('review')).length, usable_yield: mine.length ? Math.round((verified / mine.length) * 100) / 100 : null }
  })
}
