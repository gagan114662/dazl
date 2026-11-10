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

// One judge, bounded: retried within max_attempts on timeout or error, then held as unknown. Every call spends the judge's own budget and is logged.
async function callJudge(name: string, judge: Judge, claim: BlindItem, question: string, o: JudgeOptions): Promise<JudgeVerdict> {
  const now = o.now ?? Date.now
  for (let attempt = 1; attempt <= Math.max(1, o.max_attempts); attempt++) {
    if (o.budget.used >= o.budget.max_calls) { o.log.push({ judge: name, attempt, outcome: 'budget', ms: 0 }); return 'unknown' }
    o.budget.used++
    const ctl = new AbortController(), t0 = now()
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const v = await Promise.race([
        judge(structuredClone(claim), question, ctl.signal),
        new Promise<never>((_, rej) => { timer = setTimeout(() => { ctl.abort(); rej(new Error('timeout')) }, o.timeout_ms) }),
      ])
      const verdict: JudgeVerdict = v === 'pass' || v === 'fail' ? v : 'unknown'   // anything else a judge says is unknown
      o.log.push({ judge: name, attempt, outcome: verdict, ms: now() - t0 })
      return verdict
    } catch (e) {
      o.log.push({ judge: name, attempt, outcome: (e as Error).message === 'timeout' ? 'timeout' : 'error', ms: now() - t0 })
    } finally { clearTimeout(timer) }
  }
  return 'unknown'
}

// Blind the claim, ask every judge, and agree only when all of them give the same pass or fail.
export async function judgeClaim(item: Omit<BlindItem, 'blind_id'>, identityTokens: string[], question: string, judges: Record<string, Judge>, o: JudgeOptions): Promise<JudgeResult> {
  const names = Object.keys(judges)
  if (names.length < 2) return { verdict: 'unknown', reason: 'a single judge cannot be checked against another: at least 2 separately configured judges are required', votes: {} }
  const { item: claim } = blindItem(item, 'claim', identityTokens)
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

// Groups of sources that are one piece of evidence: a declared syndication link, or identical normalised text (more than a trivial amount of it).
export function provenanceGroups(sources: Source[]): Source[][] {
  const parent = sources.map((_, i) => i)
  const find = (i: number): number => parent[i] === i ? i : (parent[i] = find(parent[i]))
  const join = (a: number, b: number) => { parent[find(a)] = find(b) }
  const byText = new Map<string, number>(), byUrl = new Map(sources.map((s, i) => [stripUrl(s.url), i]))
  sources.forEach((s, i) => {
    if (s.syndicated_from) { const j = byUrl.get(stripUrl(s.syndicated_from)); if (j !== undefined) join(i, j); else { const k = `origin:${stripUrl(s.syndicated_from)}`; const at = byText.get(k); if (at === undefined) byText.set(k, i); else join(i, at) } }
    const t = s.text ? fp(s.text) : ''
    if (t.length >= 80) { const at = byText.get(t); if (at === undefined) byText.set(t, i); else join(i, at) }
  })
  const out = new Map<number, Source[]>(); sources.forEach((s, i) => { const r = find(i); out.set(r, [...(out.get(r) ?? []), s]) })
  return [...out.values()]
}

// How many independent confirmations the sources really are: one per provenance group, and groups on the same registrable domain are still one.
export function independentSources(sources: Source[]): { count: number; domains: string[]; groups: number } {
  const domains = new Set<string>()
  for (const g of provenanceGroups(sources)) { const h = host(g[0].url); if (h) domains.add(registrable(h)) }
  return { count: domains.size, domains: [...domains].sort(), groups: provenanceGroups(sources).length }
}
