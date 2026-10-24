// Decides whether ONE more search round is warranted after a scan, and with which queries. Pure: it runs nothing, spends
// nothing and is not wired to any caller. It never changes the user's query, profile or geography, never loosens or
// skips the verifier, and a retried round would still pass every existing gate. Queries come from the profile's own
// signals that the first round did not already use (never invented text, never a quote/date/company claim), and hosts
// whose pages the first round could not read (login or block) are excluded rather than asked for again.
import { sanitizeQueries, withGeography, QUERY_CAP } from '../search/tinyfish.ts'

export interface RetryAttempt { index: number; verified: number; queries: string[]; hitsUniqueUrls: number | null; dropReasons: Record<string, number>; review: { reason: string; url: string }[] }
export interface RetryPlan { retry: boolean; why: string; queries: string[]; excludeHosts: string[] }

export const MAX_VERIFIED_FOR_RETRY = 5 // retry only while fewer than this many leads are verified; needs_review does not count
export const MAX_RETRY_QUERIES = 3
const BLOCKED = new Set(['blocked_by_site', 'login_required'])
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()

export function planRetry(query: string, icp: { signals: string[]; where: string[] }, a: RetryAttempt, now: Date = new Date()): RetryPlan {
  const no = (why: string): RetryPlan => ({ retry: false, why, queries: [], excludeHosts: [] })
  if (a.index >= 1) return no('already_retried')
  if (a.verified >= MAX_VERIFIED_FOR_RETRY) return no('enough_verified')
  const usedText = norm(a.queries.join(' '))
  const fresh = icp.signals.map(s => s.replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim()).filter(s => s.length >= 8 && !usedText.includes(norm(s)))
  if (fresh.length === 0) return no('no_new_signal')
  const excludeHosts = [...new Set(a.review.filter(r => BLOCKED.has(r.reason)).flatMap(r => { try { const u = new URL(r.url); return u.protocol === 'https:' || u.protocol === 'http:' ? [u.hostname.toLowerCase()] : [] } catch { return [] } }))]
  const prior = new Set(a.queries.map(norm))
  const excl = excludeHosts.map(h => `-site:${h}`).join(' ')
  const queries = withGeography(sanitizeQueries(fresh.slice(0, MAX_RETRY_QUERIES).map(s => `${s} ${excl}`.trim()), query, now), icp.where)
    .map(q => q.length > QUERY_CAP ? q.slice(0, QUERY_CAP) : q)
    .filter(q => !prior.has(norm(q)))
  if (queries.length === 0) return no('no_new_queries')
  return { retry: true, why: 'fewer_than_5_verified', queries, excludeHosts }
}
