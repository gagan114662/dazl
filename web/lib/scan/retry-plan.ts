// Decides whether ONE more search round is warranted after a scan, and with which queries. Pure: it runs nothing, spends
// nothing and is not wired to any caller. It never changes the user's query, profile or geography, never loosens or
// skips the verifier, and a retried round would still pass every existing gate. Queries come from the profile's own
// signals that the first round did not already use (never invented text, never a quote/date/company claim), and hosts
// whose pages the first round could not read (login or block) are excluded rather than asked for again.
import { sanitizeQueries, withGeography, QUERY_CAP } from '../search/tinyfish.ts'

export interface RetryAttempt { index: number; verified: number; queries: string[]; hitsUniqueUrls: number | null; dropReasons: Record<string, number>; review: { reason: string; url: string }[] }
export interface RetryPlan { retry: boolean; why: string; queries: string[]; excludeHosts: string[]; conflicts: string[] } // conflicts: hosts the user asked for that round one could not read; never excluded, left for the owner

export const MAX_VERIFIED_FOR_RETRY = 5 // retry only while fewer than this many leads are verified; needs_review does not count
export const MAX_RETRY_QUERIES = 3
const BLOCKED = new Set(['blocked_by_site', 'login_required'])
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
// A signal counts as already asked when most of its content words appear in the first round's queries (phrase variants are not new).
const FILLER = new Set(['recently', 'posted', 'job', 'jobs', 'about', 'public', 'of', 'the', 'a', 'an', 'and', 'or', 'in', 'to', 'for', 'with', 'on', 'at', 'is', 'are', 'mentioning'])
const words = (s: string) => norm(s).split(' ').filter(w => w.length > 1 && !FILLER.has(w))
const stem = (w: string) => w.replace(/(ing|ed|es|s)$/, '')
const alreadyAsked = (signal: string, usedWords: Set<string>) => { const w = words(signal); return w.length > 0 && w.filter(x => usedWords.has(stem(x))).length / w.length >= 0.6 }
// Hosts: lower-case, no trailing dot, common www/mobile prefixes folded into the apex. Lookalikes stay distinct hosts.
const hostKey = (h: string) => h.toLowerCase().replace(/\.$/, '').replace(/^(?:www|m|mobile|l|lm)\./, '')

export function planRetry(query: string, icp: { signals: string[]; where: string[] }, a: RetryAttempt, now: Date = new Date()): RetryPlan {
  const no = (why: string): RetryPlan => ({ retry: false, why, queries: [], excludeHosts: [], conflicts: [] })
  if (a.index >= 1) return no('already_retried')
  if (a.verified >= MAX_VERIFIED_FOR_RETRY) return no('enough_verified')
  const usedWords = new Set(a.queries.flatMap(q => words(q)).map(stem))
  const fresh = icp.signals.map(s => s.replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim()).filter(s => s.length >= 8 && !alreadyAsked(s, usedWords))
  if (fresh.length === 0) return no('no_new_signal')
  const blocked = [...new Set(a.review.filter(r => BLOCKED.has(r.reason)).flatMap(r => { try { const u = new URL(r.url); return u.protocol === 'https:' || u.protocol === 'http:' ? [hostKey(u.hostname)] : [] } catch { return [] } }))]
  const req = query.toLowerCase()
  const userNamed = (h: string) => new RegExp(`(?<![a-z0-9.-])(?:[a-z0-9-]+\\.)*${h.replace(/\./g, '\\.')}(?![a-z0-9-])`).test(req)
  const conflicts = blocked.filter(userNamed)
  const excludeHosts = blocked.filter(h => !userNamed(h))
  const prior = new Set(a.queries.map(norm))
  const excl = excludeHosts.map(h => `-site:${h}`).join(' ')
  const queries = withGeography(sanitizeQueries(fresh.slice(0, MAX_RETRY_QUERIES).map(s => `${s} ${excl}`.trim()), query, now), icp.where)
    .map(q => q.length > QUERY_CAP ? q.slice(0, QUERY_CAP) : q)
    .filter(q => !prior.has(norm(q)))
  if (queries.length === 0) return no('no_new_queries')
  return { retry: true, why: 'fewer_than_5_verified', queries, excludeHosts, conflicts }
}
