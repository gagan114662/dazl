// Independent evidence-verification service for discovered leads (#395, docs/design/evidence-verifier.md).
//
// Independence from the discovering model: (1) blindClaim keeps only the claim, never the producer's model, rationale,
// confidence, verdict or page text; (2) every cited source is fetched again by the verifier itself through its own
// fetcher (never the scan's cache or excerpt); (3) the checks are the verifier's own deterministic code (checks.ts,
// text.ts), sharing nothing with the scan's extraction or verifier; (4) semantic predicates go to a separately
// configured judge that must not be the producer's model, gets only the predicate and the fetched text, and must answer
// the same way twice. Every run is versioned (VERIFIER_VERSION + per-check versions), budgeted (its own per-run and
// daily caps, separate from the scan's), logged in its own record (not the scan's logs), tenant-scoped, and stored with
// the snapshots and judge samples it decided on, so replayRecord reproduces the verdict without the network.
//
// Outcomes are automatic: fail -> skip, unknown -> hold, pass -> accept. A timeout, fetch error, judge disagreement or
// exhausted budget is unknown -> hold after bounded retries. Nothing here creates a task for a person.
import { createHash, randomBytes } from 'node:crypto'
import { getDb, type Db } from '../db/client.ts'
import { fetchPublicHtml } from '../net/public-fetch.ts'
import { blindClaim, type LeadClaim } from './claim.ts'
import { CHECK_VERSIONS, decide, overall, provenanceGroups, type Action, type CheckResult, type JudgeSample, type JudgeTrail, type Snapshot, type Verdict } from './checks.ts'
import { canonicalOf, htmlToText, linkedDomains, metadataDays, registrable } from './text.ts'
import { completeRun, reserveRun, type DailyCaps } from './store.ts'

export const VERIFIER_VERSION = 'evidence-verifier/1'
export const RECORD_VERSION = 1
export const MAX_TEXT_CHARS = 100_000       // per stored snapshot; an absence on a cut text is unknown, never fail
export const JUDGE_TEXT_CHARS = 20_000      // of the predicate's source sent to the judge
export const FETCH_ATTEMPTS = 2             // per source, on timeout or transport error
export const JUDGE_ATTEMPTS = 3             // per predicate, to collect two usable answers
export const JUDGE_CALL_CEILING_USD = 0.01  // charged for a judge call that reports no cost (never 0)
export const FETCH_TIMEOUT_MS = 10_000
export const JUDGE_TIMEOUT_MS = 15_000
export const WINDOW_DAYS = 90

export interface Budget extends DailyCaps { maxFetches: number; maxJudgeCalls: number; maxRunUsd: number }
export const DEFAULT_BUDGET: Budget = { maxFetches: 8, maxJudgeCalls: 6, maxRunUsd: 0.06, dailyRuns: 500, dailyUsd: 2 }

export type FetchResult = { ok: true; html: string; final_url: string; status: number } | { ok: false; error: 'timeout' | 'error' | 'not_html'; status?: number }
export type SourceFetcher = (url: string, signal: AbortSignal) => Promise<FetchResult>
export interface JudgeQuestion { company: string; predicate: string; source_url: string; source_text: string }
export interface Judge { id: string; model: string; ask(q: JudgeQuestion, signal: AbortSignal): Promise<{ answer: 'yes' | 'no' | 'unclear'; cost_usd: number | null }> }

// Sources the verifier may fetch: public http(s) pages. Sign-in-walled social networks are never fetched (no LinkedIn,
// no signed-in collection), whatever the claim cites.
const NOT_AUTHORIZED = new Set(['linkedin.com', 'facebook.com', 'instagram.com', 'x.com', 'twitter.com', 'tiktok.com', 'threads.net'])
export function authorizedSource(url: string): boolean {
  try {
    const u = new URL(url)
    if ((u.protocol !== 'https:' && u.protocol !== 'http:') || u.username || u.password) return false
    const d = registrable(u.hostname)
    return !!d && !NOT_AUTHORIZED.has(d)
  } catch { return false }
}

// The default fetcher: the app's SSRF-safe public fetch (public hosts only, every redirect re-checked, size and time caps).
export const publicSourceFetcher: SourceFetcher = async (url) => {
  const r = await fetchPublicHtml(url)
  if ('error' in r) return { ok: false, error: r.error === 'timeout' ? 'timeout' : r.error === 'not_html' ? 'not_html' : 'error', status: r.status }
  return { ok: true, html: r.html, final_url: r.finalUrl, status: r.status }
}

export interface LogEntry { at: number; kind: 'fetch' | 'judge' | 'budget' | 'error'; target: string; outcome: string; ms: number }
export interface VerdictRecord {
  record_version: number
  verifier_version: string
  check_versions: Record<string, number>
  run_id: string
  tenant_id: string
  claim_hash: string
  as_of: string
  window_days: number
  verdict: Verdict
  action: Action
  checks: CheckResult[]
  claim: LeadClaim
  claim_problems: string[]
  dropped_fields: string[]
  sources: Snapshot[]
  provenance: string[][]
  judge: { id: string; independent: boolean } | null
  judgements: JudgeTrail[]
  budget: { caps: Budget; fetches: number; judge_calls: number; cost_usd: number; refused: string | null }
  log: LogEntry[]
  started_at: number
  finished_at: number
}

export interface VerifyOptions {
  tenantId: string
  asOf?: string
  db?: Db
  fetchSource?: SourceFetcher
  judge?: Judge | null
  budget?: Partial<Budget>
  windowDays?: number
  now?: () => number
  fetchTimeoutMs?: number
  judgeTimeoutMs?: number
}

const withTimeout = async <T>(ms: number, run: (signal: AbortSignal) => Promise<T>): Promise<T | 'timeout'> => {
  const ac = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([run(ac.signal), new Promise<'timeout'>(res => { timer = setTimeout(() => { ac.abort(); res('timeout') }, ms) })])
  } finally { clearTimeout(timer) }
}

function emptySnapshot(url: string, outcome: Snapshot['outcome'], status: number | null = null): Snapshot {
  return { url, outcome, final_url: null, status, text: '', truncated: false, meta_days: [], canonical: null, linked_domains: [], sha256: null }
}

// The cited URLs the claim depends on, event source first, deduplicated.
function citedUrls(c: LeadClaim): string[] {
  const all = [c.event.source_url, ...c.event.corroborating_urls, ...c.quotes.map(q => q.source_url), c.person?.source_url, c.contact?.source_url, ...c.predicates.map(p => p.source_url)]
  return [...new Set(all.filter((u): u is string => !!u))]
}

export async function verifyClaim(input: unknown, o: VerifyOptions): Promise<{ record: VerdictRecord; persisted: boolean }> {
  if (!o.tenantId || typeof o.tenantId !== 'string') throw new Error('verifyClaim needs the tenant it runs for')
  const now = o.now ?? Date.now
  const started = now()
  const asOf = o.asOf ?? new Date(started).toISOString()
  const caps: Budget = { ...DEFAULT_BUDGET, ...o.budget }
  const windowDays = o.windowDays ?? WINDOW_DAYS
  const fetchSource = o.fetchSource ?? publicSourceFetcher
  const judge = o.judge ?? null
  const db = o.db ?? await getDb()
  const blind = blindClaim(input)
  const runId = `ev_${randomBytes(12).toString('hex')}`
  const log: LogEntry[] = []
  const spend = { fetches: 0, judge_calls: 0, cost_usd: 0 }
  const judgeIndependent = !!judge && (!blind.producerModel || blind.producerModel.trim().toLowerCase() !== judge.model.trim().toLowerCase())

  const build = (sources: Snapshot[], judgements: JudgeTrail[], refused: string | null): VerdictRecord => {
    const checks = refused ? [] : decide({ claim: blind.claim, problems: blind.problems, sources, judgements, asOf, windowDays })
    const { verdict, action } = overall(checks)
    return {
      record_version: RECORD_VERSION, verifier_version: VERIFIER_VERSION, check_versions: { ...CHECK_VERSIONS },
      run_id: runId, tenant_id: o.tenantId, claim_hash: blind.claimHash, as_of: asOf, window_days: windowDays,
      verdict, action, checks, claim: blind.claim, claim_problems: blind.problems, dropped_fields: blind.dropped,
      sources, provenance: provenanceGroups(sources), judge: judge ? { id: judge.id, independent: judgeIndependent } : null, judgements,
      budget: { caps, fetches: spend.fetches, judge_calls: spend.judge_calls, cost_usd: Math.round(spend.cost_usd * 1e6) / 1e6, refused },
      log, started_at: started, finished_at: now(),
    }
  }

  const reserved = await reserveRun(db, { tenantId: o.tenantId, runId, claimHash: blind.claimHash, verifierVersion: VERIFIER_VERSION, day: new Date(started).toISOString().slice(0, 10), reserveUsd: caps.maxRunUsd, caps, now: Math.floor(started / 1000) })
  if (!reserved.ok) {
    log.push({ at: now(), kind: 'budget', target: 'run', outcome: reserved.reason, ms: 0 })
    return { record: build([], [], reserved.reason), persisted: false }
  }

  const sources: Snapshot[] = []
  const judgements: JudgeTrail[] = []
  try {
    for (const url of citedUrls(blind.claim)) sources.push(await fetchOne(url))
    for (const [i, p] of blind.claim.predicates.entries()) judgements.push(await judgeOne(i, p))
  } catch (e) {
    // A defect in the verifier itself: recorded, and the run holds (never passes) with whatever it had.
    log.push({ at: now(), kind: 'error', target: 'run', outcome: String((e as Error)?.message ?? e).slice(0, 200), ms: 0 })
  }
  let record: VerdictRecord
  try { record = build(sources, judgements, null) } catch (e) {
    const why = `verifier error: ${String((e as Error)?.message ?? e).slice(0, 200)}`
    log.push({ at: now(), kind: 'error', target: 'checks', outcome: why, ms: 0 })
    record = build(sources, judgements, why) // no checks: unknown -> hold, and the reservation is still settled below
  }
  const errored = log.some(l => l.kind === 'error')
  if (errored) { record.verdict = record.verdict === 'fail' ? 'fail' : 'unknown'; record.action = record.verdict === 'fail' ? 'skip' : 'hold' }
  await completeRun(db, record, Math.floor(now() / 1000))
  return { record, persisted: true }

  async function fetchOne(url: string): Promise<Snapshot> {
    if (!authorizedSource(url)) { log.push({ at: now(), kind: 'fetch', target: url, outcome: 'unauthorized', ms: 0 }); return emptySnapshot(url, 'unauthorized') }
    let last: Snapshot = emptySnapshot(url, 'error')
    for (let attempt = 0; attempt < FETCH_ATTEMPTS; attempt++) {
      if (spend.fetches >= caps.maxFetches) { log.push({ at: now(), kind: 'budget', target: url, outcome: `fetch cap ${caps.maxFetches} reached`, ms: 0 }); return emptySnapshot(url, 'budget') }
      spend.fetches++
      const t0 = now()
      let res: FetchResult | 'timeout'
      try { res = await withTimeout(o.fetchTimeoutMs ?? FETCH_TIMEOUT_MS, s => fetchSource(url, s)) } catch { res = { ok: false, error: 'error' } }
      const outcome = res === 'timeout' ? 'timeout' : res.ok ? 'ok' : res.error
      log.push({ at: now(), kind: 'fetch', target: url, outcome, ms: now() - t0 })
      if (res !== 'timeout' && res.ok) {
        const text = htmlToText(res.html)
        return {
          url, outcome: 'ok', final_url: res.final_url, status: res.status, text: text.slice(0, MAX_TEXT_CHARS), truncated: text.length > MAX_TEXT_CHARS,
          meta_days: metadataDays(res.html), canonical: canonicalOf(res.html), linked_domains: [...linkedDomains(res.html)].sort(),
          sha256: createHash('sha256').update(res.html).digest('hex'),
        }
      }
      last = emptySnapshot(url, res === 'timeout' ? 'timeout' : res.error === 'not_html' ? 'not_html' : 'error', res === 'timeout' ? null : res.status ?? null)
      if (res !== 'timeout' && res.error === 'not_html') break // not transient
    }
    return last
  }

  async function judgeOne(i: number, p: { text: string; source_url: string }): Promise<JudgeTrail> {
    const trail: JudgeTrail = { predicate: i, judge_id: judge?.id ?? null, refused: null, samples: [] }
    if (!judge) { trail.refused = 'no evaluator judge is configured'; return trail }
    if (!judgeIndependent) { trail.refused = "the judge is the producer's own model: not independent"; return trail }
    const src = sources.find(s => s.url === p.source_url)
    if (!src || src.outcome !== 'ok') { trail.refused = `the predicate's source could not be read (${src?.outcome ?? 'not fetched'})`; return trail }
    const q: JudgeQuestion = { company: blind.claim.company, predicate: p.text, source_url: p.source_url, source_text: src.text.slice(0, JUDGE_TEXT_CHARS) }
    for (let attempt = 0; attempt < JUDGE_ATTEMPTS && trail.samples.filter(s => s.answer === 'yes' || s.answer === 'no').length < 2; attempt++) {
      if (spend.judge_calls >= caps.maxJudgeCalls || spend.cost_usd + JUDGE_CALL_CEILING_USD > caps.maxRunUsd) {
        trail.refused = `evaluator run budget reached after ${trail.samples.length} judge attempt(s)`
        log.push({ at: now(), kind: 'budget', target: `predicate:${i}`, outcome: trail.refused, ms: 0 })
        break
      }
      spend.judge_calls++
      const t0 = now()
      let sample: JudgeSample
      try {
        const res = await withTimeout(o.judgeTimeoutMs ?? JUDGE_TIMEOUT_MS, s => judge.ask(q, s))
        sample = res === 'timeout' ? { answer: 'timeout', cost_usd: JUDGE_CALL_CEILING_USD }
          : { answer: res.answer === 'yes' || res.answer === 'no' ? res.answer : 'unclear', cost_usd: typeof res.cost_usd === 'number' && Number.isFinite(res.cost_usd) && res.cost_usd >= 0 ? res.cost_usd : JUDGE_CALL_CEILING_USD }
      } catch { sample = { answer: 'error', cost_usd: JUDGE_CALL_CEILING_USD } }
      spend.cost_usd += sample.cost_usd
      trail.samples.push(sample)
      log.push({ at: now(), kind: 'judge', target: `predicate:${i}`, outcome: sample.answer, ms: now() - t0 })
    }
    return trail
  }
}

// Recomputes a stored record's verdict from its own snapshots and judge samples (no network, no judge call). A record whose
// replay differs was produced by different check code than its versions say.
export function replayRecord(rec: VerdictRecord): { same: boolean; verdict: Verdict; action: Action; checks: CheckResult[] } {
  if (rec.budget.refused) return { same: rec.checks.length === 0, verdict: 'unknown', action: 'hold', checks: [] }
  const checks = decide({ claim: rec.claim, problems: rec.claim_problems, sources: rec.sources, judgements: rec.judgements, asOf: rec.as_of, windowDays: rec.window_days })
  const errored = rec.log.some(l => l.kind === 'error')
  let { verdict, action } = overall(checks)
  if (errored && verdict !== 'fail') { verdict = 'unknown'; action = 'hold' }
  return { same: verdict === rec.verdict && action === rec.action && JSON.stringify(checks) === JSON.stringify(rec.checks), verdict, action, checks }
}
