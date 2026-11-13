// Blinded, equal-budget competitive benchmark runner (#397; docs/BENCHMARK.md, "Runner"). It produces the per-system
// BenchmarkRun that scorecard.ts (#372) scores, and a batch report across systems; it is not a second scoreboard.
//
// What it guarantees:
//  - Same task for everyone. Briefs are frozen (deep-frozen and hashed) before the first run. Every system gets the
//    identical brief object, the same as-of day and window, and the same per-task time and cost limits.
//  - Fair order. The adapter order rotates per task (seeded), so no system always runs first.
//  - Idempotent. Each (batch, system, task) has a stable run id; a re-run with the same store reuses what is recorded
//    and calls nothing again. Any change to the briefs, systems, budget or seed is a different batch id.
//  - Honest gaps. A system without an authorized adapter is `unsupported` with its reason - never a made-up loser with
//    zero results. Budget, timeout and rate stops are `incomplete`, a login wall, paywall or missing feature is
//    `unsupported` (it is never bypassed), and an adapter error is `failed`. None of these is an empty market.
//  - Durable budget. A batch total is reserved before each task (an unknown cost reserves the full task limit); once it
//    would be exceeded the remaining tasks are `not_run`. A paid live adapter needs explicit authorization and a preset
//    finite budget, or it does not run.
//  - Blind scoring. Outputs are canonicalised (raw kept), pooled per task across systems, given opaque ids and shuffled,
//    then judged by the evaluator without the system, product, model or config. Verdicts are mapped back after. Any
//    system, product or model name inside an item's text or contact is replaced with [system], and an evidence URL that
//    names one is withheld, so an output cannot sign itself.
//  - Frozen task set. A recorded or live batch must run the committed task set for its version, unchanged; a synthetic
//    batch given a committed set must match it too.
//  - Scoring hook. contractEvaluator() puts any per-lead contract scorer (the #394 evaluation contract,
//    lib/evals/contract.ts evaluateLead) behind the same blind interface; each judgement's record is kept in the result.
//  - Origin is carried, never upgraded. A batch is all synthetic, all recorded or all live: mixing is refused, so a
//    synthetic fixture can never sit beside, or be presented as, a competitor's live result. scorecard() then refuses
//    to evaluate thresholds for synthetic data.
import { createHash } from 'node:crypto'
import { CONTRACT_FIELDS as SHARED_FIELDS, scorecardVerdicts } from '../evals/contract.ts'
import { FIELDS, problemSummary, scorecard, validated, type BenchmarkRun, type Field, type Scorecard, type Task, type TaskRun, type TaskSet, type Verdict } from './scorecard.ts'
import { parseSnapshots, verifierEvaluator } from './verified-evaluator.ts'

export type AdapterOrigin = 'live' | 'recorded' | 'synthetic'
export interface Brief {
  task_id: string; query: string; seller: string | null; language: string; constraints: unknown
  as_of: string; window_days: number | null
}
export interface Limits { usd: number; seconds: number }
export interface Budget { usd_per_task: number; seconds_per_task: number; batch_usd: number }
export interface AdapterConfig { product: string; product_version: string | null; model: string | null; sources: string[]; paid: boolean; notes?: string }
// One lead as a system output it. The optional provenance fields (where the event, the quotes, the person and the contact
// route were printed) are what the independent verifier (verified-evaluator.ts) re-reads on its own snapshots; a system
// that does not give them simply gets those checks as unknown, never pass.
export interface RawItem {
  company: string; domain?: string | null; contact?: string | null; event_date?: string | null; evidence_urls?: string[]; text?: string | null
  event_source_url?: string | null                        // the page that states the event (default: the first evidence url)
  quotes?: { text: string; source_url: string }[]
  person?: { name: string; title: string; source_url: string } | null
  contact_source_url?: string | null                      // the page the contact address is printed on
  original?: unknown                                      // the system's own record of this lead, kept for audit; never read by scoring
}
export type Stop = 'budget' | 'timeout' | 'rate_limited' | 'login_required' | 'paywall' | 'feature_unavailable'
export interface AdapterResult { items: RawItem[]; cost_usd: number | null; seconds: number | null; interventions: number; stopped?: Stop; detail?: string }
export interface Adapter {
  system: string; origin: AdapterOrigin; config: AdapterConfig
  available: { ok: true } | { ok: false; reason: string }
  supports?(brief: Brief): true | string
  run(brief: Brief, limits: Limits): Promise<AdapterResult>
}
// What the evaluator sees: no system, product, model or config.
export interface BlindItem {
  blind_id: string; company: string; domain: string | null; contact: string | null; event_date: string | null; evidence_urls: string[]; text: string | null
  event_source_url: string | null; quotes: { text: string; source_url: string }[]; person: { name: string; title: string; source_url: string } | null; contact_source_url: string | null
  // Names (never values) of evidence the producer supplied that cannot be checked: malformed, or withheld because it
  // names a system. The verifier keeps the field that needed it unknown, so dropping evidence can never help a lead pass.
  unchecked: ('quote' | 'person' | 'event_source_url' | 'contact_source_url')[]
}
// One judgement per blind id: the four scorecard fields, plus an optional record (rationale, tier, evidence) kept for audit.
export type Judgement = Partial<Record<Field, Verdict>> & { record?: unknown }
export interface BlindEvaluator { name: string; version: string; independent: boolean; config?: Record<string, unknown>; judge(items: BlindItem[], brief: Brief): Promise<Record<string, Judgement>> }
export interface Evaluation { blind_id: string; system: string; task_id: string; entity_key: string; verdicts: Record<Field, Verdict>; record: unknown }

export interface CanonicalItem {
  rank: number; entity_key: string; company: string; domain: string | null; contact: string | null; event_date: string | null; evidence_urls: string[]; raw: RawItem
  event_source_url?: string | null; quotes?: { text: string; source_url: string }[]; person?: { name: string; title: string; source_url: string } | null; contact_source_url?: string | null
  unchecked?: BlindItem['unchecked']
}
// dropped_items: output rows the runner could not canonicalise (not an object, no company name, past MAX_ITEMS_PER_TASK);
// they are counted here and in the task reason, never silently lost and never scored.
// invoked: the adapter's run() was called for this task (a login wall or paywall it hit after starting still counts as an
// attempt, so its time, cost and interventions stay visible); absent on runs recorded before this field existed.
export interface StoredRun { run_id: string; system: string; task_id: string; task: Omit<TaskRun, 'results'>; items: CanonicalItem[]; interventions: number; dropped_items?: number; invoked?: boolean }
export interface RunStore { get(runId: string): StoredRun | undefined; put(r: StoredRun): void }
export const memoryStore = (): RunStore & { runs: Map<string, StoredRun> } => { const runs = new Map<string, StoredRun>(); return { runs, get: id => runs.get(id), put: r => { runs.set(r.run_id, r) } } }

export class BenchmarkRunError extends Error {}
const sha = (s: string) => createHash('sha256').update(s).digest('hex')
const deepFreeze = <T>(o: T): T => { if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); for (const v of Object.values(o)) deepFreeze(v) } return o }

// --- briefs -------------------------------------------------------------------------------------------------------

const windowOf = (c: unknown): number | null => {
  let w: number | null = null
  const walk = (v: unknown) => { if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { if (k === 'within_days' && typeof x === 'number') w = w === null ? x : Math.min(w, x); else walk(x) } }
  walk(c); return w
}
export function freezeBriefs(set: TaskSet, asOf: string): { briefs: readonly Brief[]; hash: string } {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf)) throw new BenchmarkRunError(`as_of must be a day (YYYY-MM-DD), got ${asOf}`)
  const briefs = set.tasks.map(t => {
    const x = t as Task & { brief?: { seller?: string }; constraints?: unknown }
    return { task_id: t.id, query: t.query, seller: x.brief?.seller ?? null, language: t.language, constraints: structuredClone(x.constraints ?? null), as_of: asOf, window_days: windowOf(x.constraints) }
  })
  return { briefs: deepFreeze(briefs), hash: sha(JSON.stringify(briefs)) }
}

// Key-order-independent JSON, so a committed task set and a batch's copy compare by content.
const stable = (v: unknown): string => Array.isArray(v) ? `[${v.map(stable).join(',')}]` : v && typeof v === 'object' ? `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`).join(',')}}` : JSON.stringify(v) ?? 'null'
// Null when the batch may run this task set; otherwise why not. `committed` is the task set committed for set.version
// (scoreboard/benchmark/v<version>/tasks.json), or null when none is.
export function frozenSetProblem(set: TaskSet, committed: TaskSet | null, origin: AdapterOrigin): string | null {
  if (!set || !Array.isArray(set.tasks) || !set.tasks.length) return 'the task set has no tasks'
  if (new Set(set.tasks.map(t => t.id)).size !== set.tasks.length) return 'the task set repeats a task id'
  if (!committed) return origin === 'synthetic' ? null : `a ${origin} batch must run a committed frozen task set; none is committed for v${set.version}`
  if (committed.version !== set.version) return `the committed task set is v${committed.version}, the batch names v${set.version}`
  if (stable(committed.tasks) !== stable(set.tasks) || committed.frozen_at !== set.frozen_at) return `the batch's task set v${set.version} differs from the committed frozen one (a change is a new version)`
  return null
}

// --- blinding -----------------------------------------------------------------------------------------------------

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
// The names that would reveal a system: its system id, product and model (three characters or more).
export function identityTokens(adapters: Pick<Adapter, 'system' | 'config'>[]): string[] {
  const t = new Set<string>()
  for (const a of adapters) for (const s of [a.system, a.config.product, a.config.model]) if (s && s.trim().length >= 3) t.add(s.trim().toLowerCase())
  return [...t].sort((a, b) => b.length - a.length)
}
// Strip identity tokens from what the evaluator reads. Company and domain are the lead itself and stay as they are.
// Free text and the contact are scrubbed to [system]; anything the verifier must match verbatim on a page (an evidence
// or source url, a quote, a person's name or title) is withheld instead when it names a system, so a scrubbed copy can
// never fail or pass a check it would not have on the real text: the check that needed it becomes unknown.
export function blindItem(it: Omit<BlindItem, 'blind_id' | 'unchecked'> & { unchecked?: BlindItem['unchecked'] }, blind_id: string, tokens: string[]): { item: BlindItem; redactions: number } {
  let redactions = 0
  const re = tokens.length ? new RegExp(tokens.map(escapeRe).join('|'), 'gi') : null
  const names = (s: string | null | undefined) => !!s && !!re && new RegExp(re.source, 'i').test(s)
  const scrub = (s: string | null) => { if (s === null || !re) return s; return s.replace(re, () => { redactions++; return '[system]' }) }
  const evidence_urls = it.evidence_urls.map(u => { if (names(u)) { redactions++; return '[evidence url withheld: names a system]' } return u })
  const withheld = <T,>(v: T | null, ...parts: (string | null | undefined)[]): T | null => { if (v === null) return null; if (parts.some(names)) { redactions++; return null } return v }
  const unchecked = new Set<BlindItem['unchecked'][number]>(it.unchecked ?? [])
  const quotes = (it.quotes ?? []).filter(q => { if (names(q.text) || names(q.source_url)) { redactions++; unchecked.add('quote'); return false } return true })
  const person = withheld(it.person ?? null, it.person?.name, it.person?.title, it.person?.source_url)
  if (it.person && !person) unchecked.add('person')
  const event_source_url = withheld(it.event_source_url ?? null, it.event_source_url)
  if (it.event_source_url && !event_source_url) unchecked.add('event_source_url')
  const contact_source_url = withheld(it.contact_source_url ?? null, it.contact_source_url)
  if (it.contact_source_url && !contact_source_url) unchecked.add('contact_source_url')
  return {
    item: {
      blind_id, company: it.company, domain: it.domain, contact: scrub(it.contact), event_date: it.event_date, evidence_urls, text: scrub(it.text),
      event_source_url, quotes, person, contact_source_url, unchecked: [...unchecked].sort(),
    },
    redactions,
  }
}

// --- canonicalisation ---------------------------------------------------------------------------------------------

const hostOf = (d: string | null | undefined): string | null => {
  if (typeof d !== 'string' || !d) return null
  const h = d.trim().toLowerCase().replace(/^[a-z]+:\/\//, '').split(/[/?#]/)[0].replace(/^www\./, '')
  return /^[a-z0-9.-]+\.[a-z]{2,}$/.test(h) ? h : null
}
const nameKey = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/\b(inc|ltd|llc|limited|gmbh|plc|corp|co)\b\.?/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
// One output can hold at most this many leads; the rest are dropped and counted (a precision@10 needs ten, and an
// unbounded output must not exhaust the evaluator).
export const MAX_ITEMS_PER_TASK = 50
const text = (v: unknown, max: number): string | null => typeof v === 'string' && v.trim() !== '' ? v.trim().slice(0, max) : null
const url = (v: unknown): string | null => { const s = text(v, 2000); if (!s) return null; try { const u = new URL(s); return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString() : null } catch { return null } }
const isRec = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
// One canonical row per entity, in the system's own order; the raw item is kept beside it. A duplicate entity in the same
// output counts once, at its first rank. The input is untrusted (a recorded file): a row that is not an object or has no
// company name is dropped and counted, a malformed optional field is null, and nothing here throws.
export const canonicalize = (items: unknown): CanonicalItem[] => canonicalizeCounted(items).items
export function canonicalizeCounted(items: unknown): { items: CanonicalItem[]; dropped: number } {
  const out: CanonicalItem[] = []; let dropped = 0
  const seen = new Set<string>()
  for (const raw of Array.isArray(items) ? items : []) {
    const company = isRec(raw) ? text(raw.company, 200) : null
    if (!isRec(raw) || !company) { dropped++; continue }
    const domain = hostOf(raw.domain as string | null)
    const key = domain ? `domain:${domain}` : `name:${nameKey(company)}`
    if (key === 'name:') { dropped++; continue }
    if (seen.has(key)) continue
    if (out.length >= MAX_ITEMS_PER_TASK) { dropped++; continue }
    seen.add(key)
    const quotes = (Array.isArray(raw.quotes) ? raw.quotes : []).slice(0, 5).flatMap(q => { const t = isRec(q) ? text(q.text, 500) : null, u = isRec(q) ? url(q.source_url) : null; return t && u ? [{ text: t, source_url: u }] : [] })
    const p = isRec(raw.person) ? raw.person : null
    const person = p && text(p.name, 150) && text(p.title, 150) && url(p.source_url) ? { name: text(p.name, 150)!, title: text(p.title, 150)!, source_url: url(p.source_url)! } : null
    const given = (v: unknown) => v !== undefined && v !== null && v !== ''
    const unchecked: BlindItem['unchecked'] = []
    if (given(raw.quotes) && !(Array.isArray(raw.quotes) && raw.quotes.length <= 5 && quotes.length === raw.quotes.length)) unchecked.push('quote')
    if (given(raw.person) && !person) unchecked.push('person')
    if (given(raw.event_source_url) && !url(raw.event_source_url)) unchecked.push('event_source_url')
    if (given(raw.contact_source_url) && !url(raw.contact_source_url)) unchecked.push('contact_source_url')
    let clone: RawItem
    try { clone = structuredClone(raw) as unknown as RawItem } catch { clone = { company } }   // a non-cloneable value (function, symbol) is not kept
    out.push({
      rank: out.length + 1, entity_key: key, company, domain, contact: text(raw.contact, 254),
      event_date: typeof raw.event_date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw.event_date) ? raw.event_date : null,
      evidence_urls: (Array.isArray(raw.evidence_urls) ? raw.evidence_urls : []).filter((u): u is string => typeof u === 'string').slice(0, 10),
      event_source_url: url(raw.event_source_url), quotes, person, contact_source_url: url(raw.contact_source_url), unchecked,
      raw: clone,
    })
  }
  return { items: out, dropped }
}

// --- the batch ----------------------------------------------------------------------------------------------------

export interface BatchOptions {
  set: TaskSet; adapters: Adapter[]; asOf: string; budget: Budget; seed: number; evaluator: BlindEvaluator
  store?: RunStore; commit?: string | null; startedAt?: string
  allowPaid?: boolean           // a paid live adapter runs only with this AND a finite batch budget
  committedSet?: TaskSet | null // the committed frozen task set for set.version; required unless the batch is synthetic
}
export interface SystemReport {
  // ran: at least one task was attempted (complete, incomplete or failed). not_started: the adapter was available but
  // no task started (every task unsupported by it, or not_run on the batch budget): its reason says why, and it has no
  // precision, yield or rank to show. unavailable: no authorized adapter.
  system: string; origin: AdapterOrigin; status: 'ran' | 'not_started' | 'unavailable'; reason: string | null
  tasks: number; attempted: number; complete: number; coverage: number | null
  precision_at_5: number | null; precision_at_10: number | null
  validated: number; unique_actionable_yield: number      // validated entities no other system in the batch validated
  seconds: number | null; spend_usd: number | null; interventions: number
}
export interface BatchResult {
  // batch_id names the RUNS (what each system was asked and returned: reused from a store). scored_id names this SCORING of
  // them: it also covers the evaluator's name, version and config (its snapshots digest and thresholds), so re-judging the
  // same runs with other pages or another threshold is a different scored batch and never overwrites the first.
  manifest: { batch_id: string; scored_id: string; task_set_version: string; as_of: string; briefs_hash: string; seed: number; budget: Budget; origin: AdapterOrigin; label: string; order: Record<string, string[]>; systems: { system: string; origin: AdapterOrigin; config: AdapterConfig; available: Adapter['available'] }[]; evaluator: { name: string; version: string; independent: boolean; config: Record<string, unknown> | null }; blinding: { identity_tokens: number; redactions: number } }
  runs: BenchmarkRun[]; scorecards: Scorecard[]; report: SystemReport[]; spent_usd: number
  evaluations: Evaluation[]     // every blind judgement mapped back to its system after judging, with its record
  interventions: Record<string, Record<string, number>>   // system -> task -> operator interventions
}

const rng = (seed: number) => { let s = (seed >>> 0) || 1; return () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return ((s >>> 0) % 1_000_000) / 1_000_000 } }
const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T | 'timeout'> => {
  let t: ReturnType<typeof setTimeout> | undefined
  return Promise.race([p, new Promise<'timeout'>(r => { t = setTimeout(() => r('timeout'), ms) })]).finally(() => clearTimeout(t))
}
const VERDICTS: Verdict[] = ['pass', 'fail', 'unknown', 'contradicted']
const STOP_STATUS: Record<Stop, TaskRun['status']> = { budget: 'incomplete', timeout: 'incomplete', rate_limited: 'incomplete', login_required: 'unsupported', paywall: 'unsupported', feature_unavailable: 'unsupported' }
const ATTEMPTED: TaskRun['status'][] = ['complete', 'incomplete', 'failed']
const nonNegOrNull = (x: unknown) => x === null || (typeof x === 'number' && Number.isFinite(x) && x >= 0)
// Why an adapter's result cannot be taken as it is (null when it can). Adapters replay untrusted recorded files, so a
// wrong type here must fail that task, recorded, instead of corrupting the budget sum or the run.
export function adapterResultProblem(res: unknown): string | null {
  if (!isRec(res)) return 'the result is not an object'
  if (!Array.isArray(res.items)) return 'items is not a list'
  if (!nonNegOrNull(res.cost_usd)) return `cost_usd ${JSON.stringify(res.cost_usd) ?? 'missing'} is not a non-negative number or null`
  if (!nonNegOrNull(res.seconds)) return `seconds ${JSON.stringify(res.seconds) ?? 'missing'} is not a non-negative number or null`
  if (!(typeof res.interventions === 'number' && Number.isSafeInteger(res.interventions) && res.interventions >= 0)) return `interventions ${JSON.stringify(res.interventions) ?? 'missing'} is not a non-negative integer`
  if (res.stopped !== undefined && !Object.hasOwn(STOP_STATUS, res.stopped as string)) return `stopped ${JSON.stringify(res.stopped)} is not one of ${Object.keys(STOP_STATUS).join(', ')}`
  if (res.detail !== undefined && typeof res.detail !== 'string') return 'detail is not a string'
  return null
}

export async function runBatch(o: BatchOptions): Promise<BatchResult> {
  const { set, budget } = o
  if (!(budget.usd_per_task > 0 && budget.seconds_per_task > 0 && budget.batch_usd >= 0 && Number.isFinite(budget.batch_usd))) throw new BenchmarkRunError('budget must be preset: positive per-task cost and time limits and a finite batch total')
  const systems = [...o.adapters].sort((a, b) => a.system.localeCompare(b.system))
  if (new Set(systems.map(a => a.system)).size !== systems.length) throw new BenchmarkRunError('two adapters share a system name')
  const origins = new Set(systems.map(a => a.origin))
  if (origins.size !== 1) throw new BenchmarkRunError(`one batch, one origin: got ${[...origins].join(' + ')} (a synthetic fixture never sits beside a live result)`)
  const origin = systems[0].origin
  const frozen = frozenSetProblem(set, o.committedSet ?? null, origin)
  if (frozen) throw new BenchmarkRunError(frozen)
  const { briefs, hash } = freezeBriefs(set, o.asOf)
  const batch_id = sha(JSON.stringify({ v: set.version, as_of: o.asOf, hash, systems: systems.map(a => [a.system, a.origin, a.config]), budget, seed: o.seed })).slice(0, 24)
  const store = o.store ?? memoryStore()
  const avail = new Map<string, Adapter['available']>(systems.map((a): [string, Adapter['available']] => {
    if (!a.available.ok) return [a.system, a.available]
    if (a.origin === 'live' && a.config.paid && !(o.allowPaid && budget.batch_usd > 0)) return [a.system, { ok: false as const, reason: 'paid run needs explicit authorization and a preset batch budget' }]
    return [a.system, a.available]
  }))
  const runnable = systems.filter(a => avail.get(a.system)!.ok)
  const order: Record<string, string[]> = {}
  let spent = 0
  const stored = new Map<string, StoredRun>() // `${system}|${task}`

  for (const [i, brief] of briefs.entries()) {
    const shift = runnable.length ? (i + o.seed) % runnable.length : 0
    const rot = [...runnable.slice(shift), ...runnable.slice(0, shift)]
    order[brief.task_id] = rot.map(a => a.system)
    for (const a of systems) {
      const run_id = sha(`${batch_id}|${a.system}|${brief.task_id}`).slice(0, 24)
      const prev = store.get(run_id)
      if (prev) { stored.set(`${a.system}|${brief.task_id}`, prev); spent += prev.task.cost_usd ?? ((prev.invoked ?? ATTEMPTED.includes(prev.task.status)) ? budget.usd_per_task : 0); continue } // resumed: reserved exactly as the first time
      const av = avail.get(a.system)!
      if (!av.ok) { const r: StoredRun = { run_id, system: a.system, task_id: brief.task_id, task: { task_id: brief.task_id, status: 'unsupported', reason: `adapter unavailable: ${av.reason}`, seconds: null, cost_usd: null }, items: [], interventions: 0 }; store.put(r); stored.set(`${a.system}|${brief.task_id}`, r) }
    }
    for (const a of rot) {
      const key = `${a.system}|${brief.task_id}`
      if (stored.has(key)) continue
      const run_id = sha(`${batch_id}|${a.system}|${brief.task_id}`).slice(0, 24)
      let invoked = false
      const put = (task: Omit<TaskRun, 'results'>, items: CanonicalItem[] = [], interventions = 0, dropped = 0) => {
        const t = dropped ? { ...task, reason: [task.reason, `${dropped} malformed or excess output row(s) dropped, not scored`].filter(Boolean).join('; ') } : task
        const r: StoredRun = { run_id, system: a.system, task_id: brief.task_id, task: t, items, interventions, ...(dropped ? { dropped_items: dropped } : {}), ...(invoked ? { invoked: true } : {}) }; store.put(r); stored.set(key, r)
      }
      const sup = a.supports ? a.supports(brief) : true
      if (sup !== true) { put({ task_id: brief.task_id, status: 'unsupported', reason: `the system cannot express this task: ${sup}`, seconds: null, cost_usd: null }); continue }
      if (spent + budget.usd_per_task > budget.batch_usd) { put({ task_id: brief.task_id, status: 'not_run', reason: `batch budget reached ($${spent.toFixed(2)} of $${budget.batch_usd} spent)`, seconds: null, cost_usd: null }); continue }
      let res: AdapterResult | 'timeout'
      invoked = true
      try { res = await withTimeout(a.run(brief, { usd: budget.usd_per_task, seconds: budget.seconds_per_task }), budget.seconds_per_task * 1000) } catch (e) {
        spent += budget.usd_per_task // unknown cost: the whole task limit stays reserved
        put({ task_id: brief.task_id, status: 'failed', reason: `adapter error: ${(e instanceof Error ? e.message : String(e)).slice(0, 200)}`, seconds: measuredSeconds(e), cost_usd: null }); continue
      }
      if (res === 'timeout') { spent += budget.usd_per_task; put({ task_id: brief.task_id, status: 'incomplete', reason: `timeout after ${budget.seconds_per_task}s`, seconds: budget.seconds_per_task, cost_usd: null }); continue }
      const bad = adapterResultProblem(res)
      if (bad) { spent += budget.usd_per_task; put({ task_id: brief.task_id, status: 'failed', reason: `malformed adapter result: ${bad}`.slice(0, 300), seconds: null, cost_usd: null }); continue } // unknown cost: the whole limit stays reserved
      spent += res.cost_usd ?? budget.usd_per_task
      const { items, dropped } = canonicalizeCounted(res.items)
      if (res.stopped) {
        // A login wall, paywall or missing feature is unsupported: its time, cost and interventions are kept, but partial
        // output from it is never scored (an unsupported task has no results), only counted in the reason.
        const unsupported = STOP_STATUS[res.stopped] === 'unsupported'
        const partial = unsupported && items.length ? `; ${items.length} partial result(s) not scored` : ''
        put({ task_id: brief.task_id, status: STOP_STATUS[res.stopped], reason: `${res.stopped}${unsupported ? ' (never bypassed)' : ''}${res.detail ? `: ${res.detail.slice(0, 200)}` : ''}${partial}`, seconds: res.seconds, cost_usd: res.cost_usd }, unsupported ? [] : items, res.interventions, dropped); continue
      }
      if (res.seconds !== null && res.seconds > budget.seconds_per_task) { put({ task_id: brief.task_id, status: 'incomplete', reason: `over the task time limit (${res.seconds}s > ${budget.seconds_per_task}s)`, seconds: res.seconds, cost_usd: res.cost_usd }, items, res.interventions, dropped); continue }
      if (res.cost_usd !== null && res.cost_usd > budget.usd_per_task) { put({ task_id: brief.task_id, status: 'incomplete', reason: `over the task budget ($${res.cost_usd} > $${budget.usd_per_task})`, seconds: res.seconds, cost_usd: res.cost_usd }, items, res.interventions, dropped); continue }
      put({ task_id: brief.task_id, status: 'complete', reason: null, seconds: res.seconds, cost_usd: res.cost_usd }, items, res.interventions, dropped)
    }
  }

  // Blind scoring: per task, every complete system's items pooled, opaque ids, shuffled, judged without the system.
  const verdicts = new Map<string, Record<Field, Verdict>>() // `${system}|${task}|${entity}`
  const evaluations: Evaluation[] = []
  const tokens = identityTokens(systems)
  let redactions = 0
  const rand = rng(o.seed ^ 0x9e3779b9)
  for (const brief of briefs) {
    const pool: { blind: BlindItem; ref: string; system: string; entity_key: string }[] = []
    for (const a of systems) {
      const r = stored.get(`${a.system}|${brief.task_id}`)
      if (!r || r.task.status !== 'complete') continue
      for (const it of r.items) {
        const b = blindItem({ company: it.company, domain: it.domain, contact: it.contact, event_date: it.event_date, evidence_urls: it.evidence_urls, text: typeof it.raw.text === 'string' ? it.raw.text.slice(0, 2000) : null, event_source_url: it.event_source_url ?? null, quotes: it.quotes ?? [], person: it.person ?? null, contact_source_url: it.contact_source_url ?? null, unchecked: it.unchecked ?? [] }, sha(`${batch_id}|${a.system}|${brief.task_id}|${it.entity_key}`).slice(0, 16), tokens)
        redactions += b.redactions
        pool.push({ ref: `${a.system}|${brief.task_id}|${it.entity_key}`, blind: b.item, system: a.system, entity_key: it.entity_key })
      }
    }
    if (!pool.length) continue
    for (let k = pool.length - 1; k > 0; k--) { const j = Math.floor(rand() * (k + 1)); [pool[k], pool[j]] = [pool[j], pool[k]] }
    let judged: Record<string, Judgement> = {}, failure: string | null = null
    try { judged = await o.evaluator.judge(pool.map(p => structuredClone(p.blind)), brief) ?? {} } catch (e) { judged = {}; failure = (e instanceof Error ? e.message : String(e)).slice(0, 200) } // an evaluator failure is unknown, never pass
    for (const p of pool) {
      const v = Object.hasOwn(judged, p.blind.blind_id) ? judged[p.blind.blind_id] ?? {} : {}
      const fields = Object.fromEntries(FIELDS.map(f => [f, VERDICTS.includes(v[f] as Verdict) ? v[f] : 'unknown'])) as Record<Field, Verdict>
      verdicts.set(p.ref, fields)
      evaluations.push({ blind_id: p.blind.blind_id, system: p.system, task_id: brief.task_id, entity_key: p.entity_key, verdicts: fields, record: failure ? { error: `evaluator failed: ${failure}` } : Object.hasOwn(judged, p.blind.blind_id) ? structuredClone(v.record ?? null) : { error: 'evaluator returned no judgement for this item' } })
    }
  }

  const startedAt = o.startedAt ?? `${o.asOf}T00:00:00Z`
  const runs: BenchmarkRun[] = systems.map(a => ({
    format: 'dazl-benchmark-run', version: 1, system: a.system, system_version: a.config.product_version, origin, task_set_version: set.version, commit: o.commit ?? null,
    config: { ...a.config, batch_id, briefs_hash: hash, as_of: o.asOf, budget, run_order_seed: o.seed }, evaluator: { name: o.evaluator.name, version: o.evaluator.version, independent: o.evaluator.independent },
    started_at: startedAt, source: `benchmark batch ${batch_id}`,
    tasks: briefs.map(b => { const r = stored.get(`${a.system}|${b.task_id}`)!; return { ...r.task, results: r.items.map(it => ({ rank: it.rank, entity_key: it.entity_key, verdicts: verdicts.get(`${a.system}|${b.task_id}|${it.entity_key}`) ?? Object.fromEntries(FIELDS.map(f => [f, 'unknown'])) as Record<Field, Verdict>, evidence: it.evidence_urls })) } }),
  }))
  const cards = runs.map(r => { const c = scorecard(set, r); if (c.status === 'invalid_input') throw new BenchmarkRunError(`the runner built an invalid run for ${r.system}: ${problemSummary(c.problems)}`); return c })
  const validatedBy = new Map<string, Set<string>>() // entity -> systems that validated it
  for (const r of runs) for (const t of r.tasks) for (const x of t.results) if (validated(x)) { const s = validatedBy.get(x.entity_key) ?? new Set(); s.add(r.system); validatedBy.set(x.entity_key, s) }
  const report: SystemReport[] = systems.map((a, i) => {
    const c = cards[i]; const av = avail.get(a.system)!
    const mine = new Set(runs[i].tasks.flatMap(t => t.results.filter(validated).map(x => x.entity_key)))
    const done = c.tasks.filter(t => t.status === 'complete' && t.precision_at_5 !== null)
    const p5 = done.length ? Math.round((done.reduce((s, t) => s + t.precision_at_5!, 0) / done.length) * 1000) / 1000 : null
    const secs = runs[i].tasks.map(t => t.seconds).filter((s): s is number => s !== null)
    const attempted = briefs.filter(b => { const r = stored.get(`${a.system}|${b.task_id}`)!; return r.invoked ?? ATTEMPTED.includes(r.task.status) }).length
    const why = () => { const n = new Map<string, number>(); for (const t of runs[i].tasks) { const k = `${t.status}${t.reason ? ` (${t.reason})` : ''}`; n.set(k, (n.get(k) ?? 0) + 1) } return `no task started: ${[...n].map(([k, x]) => `${x} ${k}`).join('; ')}`.slice(0, 400) }
    return {
      system: a.system, origin, status: !av.ok ? 'unavailable' : attempted ? 'ran' : 'not_started', reason: !av.ok ? av.reason : attempted ? null : why(),
      tasks: c.totals.tasks, attempted, complete: c.totals.complete, coverage: av.ok ? Math.round((c.totals.complete / c.totals.tasks) * 1000) / 1000 : null,
      precision_at_5: p5, precision_at_10: c.totals.precision_at_10,
      validated: c.totals.validated, unique_actionable_yield: [...mine].filter(e => validatedBy.get(e)!.size === 1).length,
      seconds: secs.length ? secs.reduce((s, x) => s + x, 0) : null, spend_usd: c.totals.cost_usd,
      interventions: [...stored.values()].filter(r => r.system === a.system).reduce((s, r) => s + r.interventions, 0),
    }
  })
  return {
    manifest: { batch_id, scored_id: sha(JSON.stringify({ batch_id, evaluator: { name: o.evaluator.name, version: o.evaluator.version, independent: o.evaluator.independent, config: o.evaluator.config ?? null } })).slice(0, 24), task_set_version: set.version, as_of: o.asOf, briefs_hash: hash, seed: o.seed, budget, origin, label: origin === 'synthetic' ? 'SYNTHETIC fixtures: not live results of any product' : origin === 'recorded' ? 'recorded outputs' : 'live runs', order, systems: systems.map(a => ({ system: a.system, origin: a.origin, config: a.config, available: avail.get(a.system)! })), evaluator: { name: o.evaluator.name, version: o.evaluator.version, independent: o.evaluator.independent, config: o.evaluator.config ? structuredClone(o.evaluator.config) : null }, blinding: { identity_tokens: tokens.length, redactions } },
    runs, scorecards: cards, report, spent_usd: Math.round(spent * 1e6) / 1e6, evaluations: evaluations.sort((a, b) => a.task_id.localeCompare(b.task_id) || a.system.localeCompare(b.system) || a.entity_key.localeCompare(b.entity_key)),
    interventions: Object.fromEntries(systems.map(a => [a.system, Object.fromEntries(briefs.map(b => [b.task_id, stored.get(`${a.system}|${b.task_id}`)!.interventions]))])),
  }
}

// --- adapters -----------------------------------------------------------------------------------------------------

// A system with no authorized adapter: every task is `unsupported` with this reason, never a zero.
export const unavailableAdapter = (system: string, reason: string, origin: AdapterOrigin, product = system): Adapter => ({
  system, origin, available: { ok: false, reason }, config: { product, product_version: null, model: null, sources: [], paid: false },
  run: async () => { throw new BenchmarkRunError(`${system} is unavailable: ${reason}`) },
})

// Time an adapter measured before it failed (a recorded failure keeps it): kept for the per-tool time report, status stays failed.
function measuredSeconds(e: unknown): number | null {
  const s = (e as { seconds?: unknown } | null)?.seconds
  return typeof s === 'number' && Number.isFinite(s) && s >= 0 ? s : null
}

// Outputs recorded (or written by hand, as synthetic) per task, replayed. Its origin is fixed by the caller and never
// 'live': a fixture cannot be presented as a product's live result.
export interface FixtureOutputs { system: string; origin: 'recorded' | 'synthetic'; config: AdapterConfig; tasks: Record<string, AdapterResult | { error: string; seconds?: number | null }> }
export function fixtureAdapter(f: FixtureOutputs): Adapter {
  if ((f.origin as string) === 'live') throw new BenchmarkRunError('a fixture adapter can never be live')
  return {
    system: f.system, origin: f.origin, config: f.config, available: { ok: true },
    supports: b => b.task_id in f.tasks ? true : 'no recorded output for this task',
    run: async b => { const r = f.tasks[b.task_id]; if ('error' in r) throw Object.assign(new Error(r.error), { seconds: r.seconds ?? null }); return structuredClone(r) },
  }
}

// Synthetic ground truth for fixture batches: verdicts per (task, entity key, or a domain/company in the blind item).
// Only ever paired with synthetic outputs; the scorecard refuses to evaluate thresholds on them.
export function labelEvaluator(labels: Record<string, Record<string, Partial<Record<Field, Verdict>>>>, name = 'synthetic-labels'): BlindEvaluator {
  return {
    name, version: '1', independent: true,
    judge: async (items, brief) => Object.fromEntries(items.map(it => {
      const t = labels[brief.task_id] ?? {}
      const v = (it.domain && t[`domain:${it.domain}`]) || t[`name:${nameKey(it.company)}`] || {}
      return [it.blind_id, v]
    })),
  }
}

// --- scoring hook: the #394 evaluation contract -------------------------------------------------------------------
// The shape of lib/evals/contract.ts evaluateLead()'s LeadEvaluation (#394, PR #571) that the runner reads. It is
// structural so the hook takes that function as it is once it lands, without this file depending on an unmerged module.
export interface ContractLeadEvaluation {
  contract: string; contract_hash?: string; tier: string | null; status: 'pass' | 'fail' | 'unknown'; scorer: { id: string; version: number }
  verdicts: { field: string; status: string; rationale?: string; evidence?: string[] }[]
}
// Which contract fields decide each scorecard field, and what "unknown" means, are defined ONCE in lib/evals/contract.ts (#394) and used here and in
// scorecard.ts, so the contract's summary and the scorecard cannot disagree.
export const CONTRACT_FIELDS: Record<Field, readonly string[]> = SHARED_FIELDS
export function contractVerdicts(e: ContractLeadEvaluation): Record<Field, Verdict> { return scorecardVerdicts(e.verdicts) as Record<Field, Verdict> }

export interface ContractHook<C, E> {
  name: string; version: string
  contractFor(brief: Brief): C | null                       // the frozen contract for this task; null -> every item unknown (never inferred)
  evidenceFor(item: BlindItem, brief: Brief): E              // the blind item as the contract's lead evidence
  evaluate(contract: C, evidence: E): ContractLeadEvaluation // e.g. evaluateLead from lib/evals/contract.ts
}
// A BlindEvaluator over a contract scorer. It reads only the blind items and the frozen brief, so it cannot see a system
// or change the targeting; an item it cannot score is unknown with the error recorded.
export function contractEvaluator<C, E>(h: ContractHook<C, E>): BlindEvaluator {
  return {
    name: h.name, version: h.version, independent: true,
    judge: async (items, brief) => {
      const contract = h.contractFor(brief)
      return Object.fromEntries(items.map((it): [string, Judgement] => {
        if (contract === null) return [it.blind_id, { record: { error: `no evaluation contract for task ${brief.task_id}` } }]
        try {
          const e = h.evaluate(contract, h.evidenceFor(it, brief))
          // Every judgement carries the frozen contract hash it was scored under, so a result is auditable and reproducible. A scorer that returns no hash is not trusted.
          if (!e.contract_hash) return [it.blind_id, { record: { error: `no contract hash on the evaluation for task ${brief.task_id}: the result cannot be audited, so it is unknown`, contract: e.contract } }]
          return [it.blind_id, { ...contractVerdicts(e), record: { contract: e.contract, contract_hash: e.contract_hash, tier: e.tier, status: e.status, scorer: e.scorer, verdicts: e.verdicts } }]
        } catch (err) { return [it.blind_id, { record: { error: `contract scorer failed: ${(err instanceof Error ? err.message : String(err)).slice(0, 200)}` } }] }
      }))
    },
  }
}

// A batch described in one JSON file (test/fixtures/benchmark/synthetic-batch.json): its task set, budget, seed, recorded
// or synthetic outputs per system, the systems with no adapter, and how it is judged: the ground-truth labels, or the
// independent verifier over the verifier's own page snapshots (verified-evaluator.ts; synthetic-verified-batch.json).
// Recorded batches have their own file format and adapters (recorded.ts).
export interface BatchFile {
  as_of: string; seed: number; budget: Budget; task_set: TaskSet
  systems: FixtureOutputs[]; unavailable?: { system: string; reason: string }[]
  labels?: Record<string, Record<string, Partial<Record<Field, Verdict>>>>
  evaluator?: { kind: 'verifier'; snapshots: unknown; min_independent_origins?: number }
}
export function batchFromFile(f: BatchFile): Omit<BatchOptions, 'store' | 'commit'> {
  const origins = new Set(f.systems.map(s => s.origin))
  if (origins.size !== 1) throw new BenchmarkRunError('a batch file holds one origin')
  const origin = [...origins][0]
  if (origin !== 'synthetic') throw new BenchmarkRunError('labels are ground truth only for synthetic batches; a recorded batch needs an independent evaluator')
  const ev = f.evaluator
  if (ev !== undefined && !(ev && typeof ev === 'object' && ev.kind === 'verifier')) throw new BenchmarkRunError('evaluator must be { kind: "verifier", snapshots, min_independent_origins? } or absent (labels)')
  if (ev && f.labels !== undefined) throw new BenchmarkRunError('a batch is judged by labels or by the verifier, never both')
  if (!ev && !(f.labels && typeof f.labels === 'object')) throw new BenchmarkRunError('a synthetic batch needs labels or a verifier evaluator')
  const min = ev?.min_independent_origins
  if (min !== undefined && !(Number.isSafeInteger(min) && min >= 1 && min <= 5)) throw new BenchmarkRunError(`min_independent_origins ${JSON.stringify(min)} must be an integer 1..5`)
  return {
    set: f.task_set, asOf: f.as_of, seed: f.seed, budget: f.budget, evaluator: ev ? verifierEvaluator({ snapshots: parseSnapshots(ev.snapshots), min_independent_origins: min }) : labelEvaluator(f.labels!),
    adapters: [...f.systems.map(fixtureAdapter), ...(f.unavailable ?? []).map(u => unavailableAdapter(u.system, u.reason, origin))],
  }
}

export function batchMarkdown(r: BatchResult): string {
  const n = (x: number | null, d = 2) => x === null ? 'n/a' : x.toFixed(d)
  return [
    `# Benchmark batch ${r.manifest.batch_id} (scored ${r.manifest.scored_id})`, '',
    `**${r.manifest.label}.** Task set v${r.manifest.task_set_version}, as of ${r.manifest.as_of}, briefs ${r.manifest.briefs_hash.slice(0, 12)}, seed ${r.manifest.seed}.`,
    `Equal budget per task: $${r.manifest.budget.usd_per_task} and ${r.manifest.budget.seconds_per_task}s; batch total $${r.manifest.budget.batch_usd} (spent $${r.spent_usd}). Evaluator: ${r.manifest.evaluator.name} v${r.manifest.evaluator.version} (blind to system).`, '',
    '| system | status | complete / tasks | P@5 | P@10 | validated | unique actionable | seconds | spend | interventions |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...r.report.map(s => `| ${s.system} | ${s.status === 'ran' ? 'ran' : `${s.status === 'unavailable' ? 'unavailable' : 'not started'}: ${s.reason}`} | ${s.complete} / ${s.tasks} | ${n(s.precision_at_5)} | ${n(s.precision_at_10)} | ${s.validated} | ${s.unique_actionable_yield} | ${s.seconds ?? 'n/a'} | ${s.status !== 'ran' ? 'n/a' : s.spend_usd === null ? 'unknown' : `$${s.spend_usd}`} | ${s.interventions} |`),
    '', 'An unavailable or not-started system has no result: it is not ranked. Incomplete, failed and unsupported tasks are not empty markets.',
  ].join('\n')
}
