// #533 / #1205 live (prod 37d46761, job fbaf13da...): a hiring lead must be proven by ONE specific posting of the requested role.
// Pure; no network. Two checks, both generic (page shape and the request's own words; no domain, city, industry or role list):
//  - an aggregate page (a market report, a search / results / browse / category listing, salary or outlook statistics) is not a posting:
//    it names no single opening and dates none, so it never proves a hiring signal;
//  - a posting whose title names none of the requested roles is another vacancy ("treatment coordinator" for "front desk receptionist").
import type { RequestedHiringRole } from './hiring-role-match.ts'

const AGGREGATE_SEGMENT = /^(?:market-?reports?|marketreport|reports?|search|results?|browse|listings?|categor(?:y|ies)|directory|trends?|outlook|salar(?:y|ies)|wages?|statistics|stats|insights?|explore)$/i
const SEARCH_PARAM = /^(?:q|query|keywords?|search|what|term|searchterm|kw)$/i

export function isAggregateJobPage(rawUrl: string): boolean {
  let u: URL
  try { u = new URL(rawUrl) } catch { return false }
  if (u.pathname.split('/').filter(Boolean).some(s => AGGREGATE_SEGMENT.test(decodeURIComponent(s)))) return true
  for (const k of u.searchParams.keys()) if (SEARCH_PARAM.test(k)) return true
  return false
}

const words = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').split(/[^\p{L}\p{N}]+/u).filter(Boolean)
const stem = (w: string) => w.replace(/(?:ies)$/, 'y').replace(/(?<!s)s$/, '')
// A requested role is named when its head noun (the last word: "receptionist" of "front desk receptionist") is in the text. Lenient on
// qualifiers ("dental receptionist" is a receptionist posting), strict on the role itself.
export function namesRequestedRole(text: string, roles: RequestedHiringRole[]): boolean {
  const have = new Set(words(text).map(stem))
  return roles.some(r => { const w = words(r.term); return w.length > 0 && have.has(stem(w[w.length - 1])) })
}

export type HiringPostingVerdict = { ok: true } | { ok: false; reason: 'posting_not_specific' | 'job_role_mismatch' }
export function hiringPostingVerdict(c: { source_url: string; signal: string | null; excerpt?: string | null }, roles: RequestedHiringRole[]): HiringPostingVerdict {
  if (isAggregateJobPage(c.source_url)) return { ok: false, reason: 'posting_not_specific' }
  if (roles.length && !namesRequestedRole(`${c.signal ?? ''} ${c.excerpt ?? ''}`, roles)) return { ok: false, reason: 'job_role_mismatch' }
  return { ok: true }
}
