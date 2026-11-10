// The separate semantic judge (#782, part of #395): blinded, bounded, and never guessing. Pure orchestration around INJECTED judges: this file calls no model and
// no network; a real model judge is one `Judge` function plugged in later, under its own budget and log.
//
// Rules, each with a seeded test in test/semantic-judge.test.ts:
//  - BLINDED. The judge reads the claim through blindItem (lib/benchmark/runner.ts): no system, product, model or config, identity tokens scrubbed.
//  - UNKNOWN ON TIMEOUT. A judge call that does not settle within `timeout_ms`, or throws, is retried up to `max_attempts` in all, then it is held: unknown.
//  - UNKNOWN ON DISAGREEMENT. Two or more judges must give the same pass/fail; any difference, or any judge that is unknown, makes the claim unknown.
//  - SEPARATE BUDGET AND LOG. The judge spends its own call budget (never the producer's); when it is spent the claim is unknown ("budget"), and every call is logged
//    in the judge's own log with its attempt, outcome and elapsed time.
//  - PROVENANCE. Sources that copy one another are one source: a page declaring `syndicated_from`, or carrying the same normalised text, joins the group of its original,
//    and corroboration counts groups on distinct registrable domains, so a wire story reprinted on ten sites is one confirmation, not ten.
import { blindItem, type BlindItem } from '../benchmark/runner.ts'
import { registrable } from './contract.ts'

export type JudgeVerdict = 'pass' | 'fail' | 'unknown'
export type Judge = (claim: BlindItem, question: string, signal: AbortSignal) => Promise<JudgeVerdict>
export interface JudgeLogEntry { judge: string; attempt: number; outcome: JudgeVerdict | 'timeout' | 'error' | 'budget'; ms: number }
export interface JudgeBudget { max_calls: number; used: number }
export interface JudgeOptions { timeout_ms: number; max_attempts: number; budget: JudgeBudget; log: JudgeLogEntry[]; now?: () => number }
export interface JudgeResult { verdict: JudgeVerdict; reason: string; votes: Record<string, JudgeVerdict> }

// Private marker for our own timer: a judge that throws undefined, null, a string or an Error that merely says "timeout" is an error, never a timeout, and never crashes the catch.
class JudgeTimeout extends Error {}

// One judge, bounded: retried within max_attempts on timeout or error, then held as unknown. Every call spends the judge's own budget and is logged.
async function callJudge(name: string, judge: Judge, claim: BlindItem, question: string, o: JudgeOptions): Promise<JudgeVerdict> {
  const now = o.now ?? Date.now
  for (let attempt = 1; attempt <= o.max_attempts; attempt++) {
    if (o.budget.used >= o.budget.max_calls) { o.log.push({ judge: name, attempt, outcome: 'budget', ms: 0 }); return 'unknown' }
    o.budget.used++
    const ctl = new AbortController(), t0 = now()
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const v = await Promise.race([
        judge(structuredClone(claim), question, ctl.signal),
        new Promise<never>((_, rej) => { timer = setTimeout(() => { ctl.abort(); rej(new JudgeTimeout()) }, o.timeout_ms) }),
      ])
      const verdict: JudgeVerdict = v === 'pass' || v === 'fail' ? v : 'unknown'   // anything else a judge says is unknown
      o.log.push({ judge: name, attempt, outcome: verdict, ms: now() - t0 })
      return verdict
    } catch (e) {
      o.log.push({ judge: name, attempt, outcome: e instanceof JudgeTimeout ? 'timeout' : 'error', ms: now() - t0 })
    } finally { clearTimeout(timer) }
  }
  return 'unknown'
}

// Blind the claim, ask every judge, and agree only when all of them give the same pass or fail.
const isCount = (x: unknown): x is number => typeof x === 'number' && Number.isInteger(x) && x >= 0
const MAX_TIMER_MS = 2147483647
const isPos = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x) && x > 0
// The spend gate fails CLOSED: a budget or bound that is missing, not a number, NaN, infinite, negative or fractional is not a cap, so nothing is called.
function optionsProblem(o: unknown): string | null {
  const b = (o as JudgeOptions | null)?.budget
  if (typeof o !== 'object' || o === null || typeof b !== 'object' || b === null) return 'the judge options or budget are missing'
  if (!isCount(b.max_calls) || !isCount(b.used)) return 'the judge budget (max_calls, used) must be finite whole numbers of at least 0: no cap means no calls'
  if (!isCount((o as JudgeOptions).max_attempts) || (o as JudgeOptions).max_attempts < 1) return 'max_attempts must be a whole number of at least 1'
  if (!isPos((o as JudgeOptions).timeout_ms) || (o as JudgeOptions).timeout_ms > MAX_TIMER_MS) return `timeout_ms must be a positive finite number of at most ${MAX_TIMER_MS} (a larger value is clamped by the timer to about 1 ms and would burn the budget)`
  if ((o as JudgeOptions).now !== undefined && typeof (o as JudgeOptions).now !== 'function') return 'now must be a function when given'
  if (!Array.isArray((o as JudgeOptions).log)) return 'the judge needs its own log'
  return null
}

// Blind the claim, ask every judge, and agree only when all of them give the same pass or fail.
export async function judgeClaim(item: Omit<BlindItem, 'blind_id'>, identityTokens: string[], question: string, judges: Record<string, Judge>, o: JudgeOptions): Promise<JudgeResult> {
  const bad = optionsProblem(o)
  if (bad) return { verdict: 'unknown', reason: `no judge was called: ${bad}`, votes: {} }
  if (typeof judges !== 'object' || judges === null) return { verdict: 'unknown', reason: 'no judges were given', votes: {} }
  const names = Object.keys(judges).filter(n => typeof judges[n] === 'function')
  if (names.length < 2) return { verdict: 'unknown', reason: 'a single judge cannot be checked against another: at least 2 separately configured judges are required', votes: {} }
  if (new Set(names.map(n => judges[n])).size < names.length) return { verdict: 'unknown', reason: 'two names for the same judge are one judge: every judge must be a distinct function', votes: {} }
  if (typeof item !== 'object' || item === null || Array.isArray(item)) return { verdict: 'unknown', reason: 'no judge was called: the claim to judge is missing or not an object', votes: {} }
  if (!Array.isArray(identityTokens) || identityTokens.some(t => typeof t !== 'string')) return { verdict: 'unknown', reason: 'no judge was called: identityTokens must be an array of strings (a bad token is refused, not dropped, so blinding is never weakened)', votes: {} }
  let claim: BlindItem
  try { claim = blindItem(item, 'claim', identityTokens).item } catch { return { verdict: 'unknown', reason: 'no judge was called: the claim could not be blinded', votes: {} } }
  const votes: Record<string, JudgeVerdict> = {}
  for (const n of names) votes[n] = await callJudge(n, judges[n], claim, question, o)
  const set = new Set(Object.values(votes))
  if (set.size === 1 && !set.has('unknown')) return { verdict: [...set][0], reason: `all ${names.length} judges agree`, votes }
  return { verdict: 'unknown', reason: set.has('unknown') ? 'a judge timed out, errored, ran out of budget or could not tell: held as unknown' : 'the judges disagree: held as unknown', votes }
}

// ---- provenance dependency ----
export interface Source { url: string; text?: string | null; syndicated_from?: string | null }
const fp = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/g, ' ')
const host = (u: string) => { try { return new URL(u).hostname.toLowerCase().replace(/^www\./, '') } catch { return null } }
const stripUrl = (u: string) => { try { const x = new URL(u); return `${x.hostname.replace(/^www\./, '')}${x.pathname.replace(/\/$/, '')}` } catch { return u } }

// A reprint almost always adds a dateline, byline or footer, so copies are found by overlap, not equality: two texts are one piece of evidence when at least COPY_SHARE of the
// shorter text's word 5-grams appear in the other (a text under 5 words is one gram), provided the shorter has at least MIN_WORDS words.
const COPY_SHARE = 0.8, MIN_WORDS = 4
const grams = (t: string): Set<string> => { const w = t.split(' ').filter(Boolean), out = new Set<string>(); if (w.length < MIN_WORDS) return out; if (w.length < 5) { out.add(w.join(' ')); return out } for (let i = 0; i + 5 <= w.length; i++) out.add(w.slice(i, i + 5).join(' ')); return out }
const copies = (a: Set<string>, b: Set<string>): boolean => { if (a.size === 0 || b.size === 0) return false; const [s, l] = a.size <= b.size ? [a, b] : [b, a]; let hit = 0; for (const g of s) if (l.has(g)) hit++; return hit / s.size >= COPY_SHARE }
// Malformed sources are dropped, never thrown on: a non-array, a non-object or a source without a string url supports nothing; a non-string text is empty.
const cleanSources = (raw: unknown): Source[] => !Array.isArray(raw) ? [] : raw.filter((s): s is Source => typeof s === 'object' && s !== null && typeof (s as Source).url === 'string')
  .map(s => ({ url: s.url, text: typeof s.text === 'string' ? s.text : null, syndicated_from: typeof s.syndicated_from === 'string' ? s.syndicated_from : null }))

// Groups of sources that are one piece of evidence: a declared syndication link, or overlapping text (a copy with a dateline, byline or footer is still a copy).
export function provenanceGroups(rawSources: Source[]): Source[][] {
  const sources = cleanSources(rawSources)
  const parent = sources.map((_, i) => i)
  const find = (i: number): number => parent[i] === i ? i : (parent[i] = find(parent[i]))
  const join = (a: number, b: number) => { parent[find(a)] = find(b) }
  const byUrl = new Map(sources.map((s, i) => [stripUrl(s.url), i])), byOrigin = new Map<string, number>()
  const g = sources.map(s => grams(s.text ? fp(s.text) : ''))
  sources.forEach((s, i) => {
    if (s.syndicated_from) {
      const j = byUrl.get(stripUrl(s.syndicated_from))
      if (j !== undefined) join(i, j)
      else { const k = stripUrl(s.syndicated_from), at = byOrigin.get(k); if (at === undefined) byOrigin.set(k, i); else join(i, at) }
    }
    for (let k = 0; k < i; k++) if (copies(g[i], g[k])) join(i, k)
  })
  const out = new Map<number, Source[]>(); sources.forEach((s, i) => { const r = find(i); out.set(r, [...(out.get(r) ?? []), s]) })
  return [...out.values()]
}

// How many independent confirmations the sources really are: one per provenance group, and groups on the same registrable domain are still one.
export function independentSources(sources: Source[]): { count: number; domains: string[]; groups: number } {
  const domains = new Set<string>(), groups = provenanceGroups(sources)
  for (const g of groups) { const h = host(g[0].url); if (h) domains.add(registrable(h)) }
  return { count: domains.size, domains: [...domains].sort(), groups: groups.length }
}
