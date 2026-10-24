// Decides whether ONE more search round is warranted after a scan, and with which queries. Pure: it runs nothing, spends
// nothing and is not wired to any caller. It never changes the user's query, profile or geography, never loosens or
// skips the verifier, and a retried round would still pass every existing gate. Queries come from the profile's own
// signals that the first round did not already use (never invented text, never a quote/date/company claim), and hosts
// whose pages the first round could not read (login or block) are excluded rather than asked for again.
import { sanitizeQueries, withGeography, namesPlace, QUERY_CAP } from '../search/tinyfish.ts'

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
  if (conflicts.length > 0) return { retry: false, why: `owner_decision_required: the request names ${conflicts.join(', ')} but round one could not read it`, queries: [], excludeHosts: [], conflicts }
  const prior = new Set(a.queries.map(norm))
  // The cap applies to the FINAL query (after geography): a signal is used whole or skipped, never chopped, and every
  // profile place (first 3, as withGeography) must be named. Exclusions are added one host at a time while they still fit.
  const places = [...new Set(icp.where.map(w => w.replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim()).filter(w => w.length >= 2 && w.length <= 60))].slice(0, 3)
  const finalize = (q: string) => { const out = withGeography(sanitizeQueries([q], query, now), icp.where)[0]; return out.length <= QUERY_CAP && places.every(pl => namesPlace(out, pl)) ? out : null }
  const queries: string[] = []
  for (const sig of fresh) {
    if (queries.length >= MAX_RETRY_QUERIES) break
    let cur = finalize(sig); if (cur === null) continue
    let draft = sig
    for (const h of excludeHosts) { const t = finalize(`${draft} -site:${h}`); if (t !== null) { draft = `${draft} -site:${h}`; cur = t } }
    if (!prior.has(norm(cur))) queries.push(cur)
  }
  if (queries.length === 0) return no('no_new_queries')
  return { retry: true, why: 'fewer_than_5_verified; signals chosen by literal word overlap with round one, not semantic novelty', queries, excludeHosts, conflicts }
}
