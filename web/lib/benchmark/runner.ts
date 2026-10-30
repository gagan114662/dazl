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
//    then judged by the evaluator without the system, product, model or config. Verdicts are mapped back after.
//  - Origin is carried, never upgraded. A batch is all synthetic, all recorded or all live: mixing is refused, so a
//    synthetic fixture can never sit beside, or be presented as, a competitor's live result. scorecard() then refuses
//    to evaluate thresholds for synthetic data.
import { createHash } from 'node:crypto'
import { FIELDS, scorecard, validated, type BenchmarkRun, type Field, type Scorecard, type Task, type TaskRun, type TaskSet, type Verdict } from './scorecard.ts'

export type AdapterOrigin = 'live' | 'recorded' | 'synthetic'
export interface Brief {
  task_id: string; query: string; seller: string | null; language: string; constraints: unknown
  as_of: string; window_days: number | null
}
export interface Limits { usd: number; seconds: number }
export interface Budget { usd_per_task: number; seconds_per_task: number; batch_usd: number }
export interface AdapterConfig { product: string; product_version: string | null; model: string | null; sources: string[]; paid: boolean; notes?: string }
export interface RawItem { company: string; domain?: string | null; contact?: string | null; event_date?: string | null; evidence_urls?: string[]; text?: string | null }
export type Stop = 'budget' | 'timeout' | 'rate_limited' | 'login_required' | 'paywall' | 'feature_unavailable'
export interface AdapterResult { items: RawItem[]; cost_usd: number | null; seconds: number | null; interventions: number; stopped?: Stop; detail?: string }
export interface Adapter {
  system: string; origin: AdapterOrigin; config: AdapterConfig
  available: { ok: true } | { ok: false; reason: string }
  supports?(brief: Brief): true | string
  run(brief: Brief, limits: Limits): Promise<AdapterResult>
}
// What the evaluator sees: no system, product, model or config.
export interface BlindItem { blind_id: string; company: string; domain: string | null; contact: string | null; event_date: string | null; evidence_urls: string[]; text: string | null }
export interface BlindEvaluator { name: string; version: string; independent: boolean; judge(items: BlindItem[], brief: Brief): Promise<Record<string, Partial<Record<Field, Verdict>>>> }

export interface CanonicalItem { rank: number; entity_key: string; company: string; domain: string | null; contact: string | null; event_date: string | null; evidence_urls: string[]; raw: RawItem }
export interface StoredRun { run_id: string; system: string; task_id: string; task: Omit<TaskRun, 'results'>; items: CanonicalItem[]; interventions: number }
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

// --- canonicalisation ---------------------------------------------------------------------------------------------

const hostOf = (d: string | null | undefined): string | null => {
  if (!d) return null
  const h = d.trim().toLowerCase().replace(/^[a-z]+:\/\//, '').split(/[/?#]/)[0].replace(/^www\./, '')
  return /^[a-z0-9.-]+\.[a-z]{2,}$/.test(h) ? h : null
}
const nameKey = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/\b(inc|ltd|llc|limited|gmbh|plc|corp|co)\b\.?/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
// One canonical row per entity, in the system's own order; the raw item is kept beside it. A duplicate entity in the same
// output counts once, at its first rank.
export function canonicalize(items: RawItem[]): CanonicalItem[] {
  const out: CanonicalItem[] = []; const seen = new Set<string>()
  for (const raw of items) {
    const domain = hostOf(raw.domain)
    const key = domain ? `domain:${domain}` : `name:${nameKey(raw.company ?? '')}`
    if (key === 'name:' || seen.has(key)) continue
    seen.add(key)
    out.push({ rank: out.length + 1, entity_key: key, company: String(raw.company ?? '').trim(), domain, contact: raw.contact?.trim() || null, event_date: raw.event_date && /^\d{4}-\d{2}-\d{2}$/.test(raw.event_date) ? raw.event_date : null, evidence_urls: [...(raw.evidence_urls ?? [])], raw: structuredClone(raw) })
  }
  return out
}

// --- the batch ----------------------------------------------------------------------------------------------------

export interface BatchOptions {
  set: TaskSet; adapters: Adapter[]; asOf: string; budget: Budget; seed: number; evaluator: BlindEvaluator
  store?: RunStore; commit?: string | null; startedAt?: string
  allowPaid?: boolean           // a paid live adapter runs only with this AND a finite batch budget
}
export interface SystemReport {
  system: string; origin: AdapterOrigin; status: 'ran' | 'unavailable'; reason: string | null
  tasks: number; complete: number; coverage: number | null
  precision_at_5: number | null; precision_at_10: number | null
  validated: number; unique_actionable_yield: number      // validated entities no other system in the batch validated
  seconds: number | null; spend_usd: number | null; interventions: number
}
export interface BatchResult {
  manifest: { batch_id: string; task_set_version: string; as_of: string; briefs_hash: string; seed: number; budget: Budget; origin: AdapterOrigin; label: string; order: Record<string, string[]>; systems: { system: string; origin: AdapterOrigin; config: AdapterConfig; available: Adapter['available'] }[]; evaluator: { name: string; version: string; independent: boolean } }
  runs: BenchmarkRun[]; scorecards: Scorecard[]; report: SystemReport[]; spent_usd: number
}

const rng = (seed: number) => { let s = (seed >>> 0) || 1; return () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return ((s >>> 0) % 1_000_000) / 1_000_000 } }
const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T | 'timeout'> => {
  let t: ReturnType<typeof setTimeout> | undefined
  return Promise.race([p, new Promise<'timeout'>(r => { t = setTimeout(() => r('timeout'), ms) })]).finally(() => clearTimeout(t))
}
const STOP_STATUS: Record<Stop, TaskRun['status']> = { budget: 'incomplete', timeout: 'incomplete', rate_limited: 'incomplete', login_required: 'unsupported', paywall: 'unsupported', feature_unavailable: 'unsupported' }

export async function runBatch(o: BatchOptions): Promise<BatchResult> {
  const { set, budget } = o
  if (!(budget.usd_per_task > 0 && budget.seconds_per_task > 0 && budget.batch_usd >= 0 && Number.isFinite(budget.batch_usd))) throw new BenchmarkRunError('budget must be preset: positive per-task cost and time limits and a finite batch total')
  const systems = [...o.adapters].sort((a, b) => a.system.localeCompare(b.system))
  if (new Set(systems.map(a => a.system)).size !== systems.length) throw new BenchmarkRunError('two adapters share a system name')
  const origins = new Set(systems.map(a => a.origin))
  if (origins.size !== 1) throw new BenchmarkRunError(`one batch, one origin: got ${[...origins].join(' + ')} (a synthetic fixture never sits beside a live result)`)
  const origin = systems[0].origin
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
      if (prev) { stored.set(`${a.system}|${brief.task_id}`, prev); spent += prev.task.cost_usd ?? (['complete', 'incomplete', 'failed'].includes(prev.task.status) ? budget.usd_per_task : 0); continue } // resumed: reserved exactly as the first time
      const av = avail.get(a.system)!
      if (!av.ok) { const r: StoredRun = { run_id, system: a.system, task_id: brief.task_id, task: { task_id: brief.task_id, status: 'unsupported', reason: `adapter unavailable: ${av.reason}`, seconds: null, cost_usd: null }, items: [], interventions: 0 }; store.put(r); stored.set(`${a.system}|${brief.task_id}`, r) }
    }
    for (const a of rot) {
      const key = `${a.system}|${brief.task_id}`
      if (stored.has(key)) continue
      const run_id = sha(`${batch_id}|${a.system}|${brief.task_id}`).slice(0, 24)
      const put = (task: Omit<TaskRun, 'results'>, items: CanonicalItem[] = [], interventions = 0) => { const r: StoredRun = { run_id, system: a.system, task_id: brief.task_id, task, items, interventions }; store.put(r); stored.set(key, r) }
      const sup = a.supports ? a.supports(brief) : true
      if (sup !== true) { put({ task_id: brief.task_id, status: 'unsupported', reason: `the system cannot express this task: ${sup}`, seconds: null, cost_usd: null }); continue }
      if (spent + budget.usd_per_task > budget.batch_usd) { put({ task_id: brief.task_id, status: 'not_run', reason: `batch budget reached ($${spent.toFixed(2)} of $${budget.batch_usd} spent)`, seconds: null, cost_usd: null }); continue }
      let res: AdapterResult | 'timeout'
      try { res = await withTimeout(a.run(brief, { usd: budget.usd_per_task, seconds: budget.seconds_per_task }), budget.seconds_per_task * 1000) } catch (e) {
        spent += budget.usd_per_task // unknown cost: the whole task limit stays reserved
        put({ task_id: brief.task_id, status: 'failed', reason: `adapter error: ${(e instanceof Error ? e.message : String(e)).slice(0, 200)}`, seconds: null, cost_usd: null }); continue
      }
      if (res === 'timeout') { spent += budget.usd_per_task; put({ task_id: brief.task_id, status: 'incomplete', reason: `timeout after ${budget.seconds_per_task}s`, seconds: budget.seconds_per_task, cost_usd: null }); continue }
      spent += res.cost_usd ?? budget.usd_per_task
      const items = canonicalize(res.items)
      if (res.stopped) { put({ task_id: brief.task_id, status: STOP_STATUS[res.stopped], reason: `${res.stopped}${STOP_STATUS[res.stopped] === 'unsupported' ? ' (never bypassed)' : ''}${res.detail ? `: ${res.detail}` : ''}`, seconds: res.seconds, cost_usd: res.cost_usd }, items, res.interventions); continue }
      if (res.cost_usd !== null && res.cost_usd > budget.usd_per_task) { put({ task_id: brief.task_id, status: 'incomplete', reason: `over the task budget ($${res.cost_usd} > $${budget.usd_per_task})`, seconds: res.seconds, cost_usd: res.cost_usd }, items, res.interventions); continue }
      put({ task_id: brief.task_id, status: 'complete', reason: null, seconds: res.seconds, cost_usd: res.cost_usd }, items, res.interventions)
    }
  }

  // Blind scoring: per task, every complete system's items pooled, opaque ids, shuffled, judged without the system.
  const verdicts = new Map<string, Record<Field, Verdict>>() // `${system}|${task}|${entity}`
  const rand = rng(o.seed ^ 0x9e3779b9)
  for (const brief of briefs) {
    const pool: { blind: BlindItem; ref: string }[] = []
    for (const a of systems) {
      const r = stored.get(`${a.system}|${brief.task_id}`)
      if (!r || r.task.status !== 'complete') continue
      for (const it of r.items) pool.push({ ref: `${a.system}|${brief.task_id}|${it.entity_key}`, blind: { blind_id: sha(`${batch_id}|${a.system}|${brief.task_id}|${it.entity_key}`).slice(0, 16), company: it.company, domain: it.domain, contact: it.contact, event_date: it.event_date, evidence_urls: it.evidence_urls, text: it.raw.text ?? null } })
    }
    if (!pool.length) continue
    for (let k = pool.length - 1; k > 0; k--) { const j = Math.floor(rand() * (k + 1)); [pool[k], pool[j]] = [pool[j], pool[k]] }
    let judged: Record<string, Partial<Record<Field, Verdict>>> = {}
    try { judged = await o.evaluator.judge(pool.map(p => structuredClone(p.blind)), brief) } catch { judged = {} } // an evaluator failure is unknown, never pass
    for (const p of pool) {
      const v = judged[p.blind.blind_id] ?? {}
      verdicts.set(p.ref, Object.fromEntries(FIELDS.map(f => [f, (['pass', 'fail', 'unknown', 'contradicted'] as Verdict[]).includes(v[f] as Verdict) ? v[f] : 'unknown'])) as Record<Field, Verdict>)
    }
  }

  const startedAt = o.startedAt ?? `${o.asOf}T00:00:00Z`
  const runs: BenchmarkRun[] = systems.map(a => ({
    format: 'dazl-benchmark-run', version: 1, system: a.system, system_version: a.config.product_version, origin, task_set_version: set.version, commit: o.commit ?? null,
    config: { ...a.config, batch_id, briefs_hash: hash, as_of: o.asOf, budget, run_order_seed: o.seed }, evaluator: { name: o.evaluator.name, version: o.evaluator.version, independent: o.evaluator.independent },
    started_at: startedAt, source: `benchmark batch ${batch_id}`,
    tasks: briefs.map(b => { const r = stored.get(`${a.system}|${b.task_id}`)!; return { ...r.task, results: r.items.map(it => ({ rank: it.rank, entity_key: it.entity_key, verdicts: verdicts.get(`${a.system}|${b.task_id}|${it.entity_key}`) ?? Object.fromEntries(FIELDS.map(f => [f, 'unknown'])) as Record<Field, Verdict>, evidence: it.evidence_urls })) } }),
  }))
  const cards = runs.map(r => scorecard(set, r))
  const validatedBy = new Map<string, Set<string>>() // entity -> systems that validated it
  for (const r of runs) for (const t of r.tasks) for (const x of t.results) if (validated(x)) { const s = validatedBy.get(x.entity_key) ?? new Set(); s.add(r.system); validatedBy.set(x.entity_key, s) }
  const report: SystemReport[] = systems.map((a, i) => {
    const c = cards[i]; const av = avail.get(a.system)!
    const mine = new Set(runs[i].tasks.flatMap(t => t.results.filter(validated).map(x => x.entity_key)))
    const done = c.tasks.filter(t => t.status === 'complete' && t.precision_at_5 !== null)
    const p5 = done.length ? Math.round((done.reduce((s, t) => s + t.precision_at_5!, 0) / done.length) * 1000) / 1000 : null
    const secs = runs[i].tasks.map(t => t.seconds).filter((s): s is number => s !== null)
    return {
      system: a.system, origin, status: av.ok ? 'ran' : 'unavailable', reason: av.ok ? null : av.reason,
      tasks: c.totals.tasks, complete: c.totals.complete, coverage: av.ok ? Math.round((c.totals.complete / c.totals.tasks) * 1000) / 1000 : null,
      precision_at_5: p5, precision_at_10: c.totals.precision_at_10,
      validated: c.totals.validated, unique_actionable_yield: [...mine].filter(e => validatedBy.get(e)!.size === 1).length,
      seconds: secs.length ? secs.reduce((s, x) => s + x, 0) : null, spend_usd: c.totals.cost_usd,
      interventions: [...stored.values()].filter(r => r.system === a.system).reduce((s, r) => s + r.interventions, 0),
    }
  })
  return {
    manifest: { batch_id, task_set_version: set.version, as_of: o.asOf, briefs_hash: hash, seed: o.seed, budget, origin, label: origin === 'synthetic' ? 'SYNTHETIC fixtures: not live results of any product' : origin === 'recorded' ? 'recorded outputs' : 'live runs', order, systems: systems.map(a => ({ system: a.system, origin: a.origin, config: a.config, available: avail.get(a.system)! })), evaluator: { name: o.evaluator.name, version: o.evaluator.version, independent: o.evaluator.independent } },
    runs, scorecards: cards, report, spent_usd: Math.round(spent * 1e6) / 1e6,
  }
}

// --- adapters -----------------------------------------------------------------------------------------------------

// A system with no authorized adapter: every task is `unsupported` with this reason, never a zero.
export const unavailableAdapter = (system: string, reason: string, origin: AdapterOrigin, product = system): Adapter => ({
  system, origin, available: { ok: false, reason }, config: { product, product_version: null, model: null, sources: [], paid: false },
  run: async () => { throw new BenchmarkRunError(`${system} is unavailable: ${reason}`) },
})

// Outputs recorded (or written by hand, as synthetic) per task, replayed. Its origin is fixed by the caller and never
// 'live': a fixture cannot be presented as a product's live result.
export interface FixtureOutputs { system: string; origin: 'recorded' | 'synthetic'; config: AdapterConfig; tasks: Record<string, AdapterResult | { error: string }> }
export function fixtureAdapter(f: FixtureOutputs): Adapter {
  if ((f.origin as string) === 'live') throw new BenchmarkRunError('a fixture adapter can never be live')
  return {
    system: f.system, origin: f.origin, config: f.config, available: { ok: true },
    supports: b => b.task_id in f.tasks ? true : 'no recorded output for this task',
    run: async b => { const r = f.tasks[b.task_id]; if ('error' in r) throw new Error(r.error); return structuredClone(r) },
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

// A batch described in one JSON file (test/fixtures/benchmark/synthetic-batch.json): its task set, budget, seed, recorded
// or synthetic outputs per system, the systems with no adapter, and (for synthetic batches only) the ground-truth labels.
export interface BatchFile {
  as_of: string; seed: number; budget: Budget; task_set: TaskSet
  systems: FixtureOutputs[]; unavailable?: { system: string; reason: string }[]
  labels: Record<string, Record<string, Partial<Record<Field, Verdict>>>>
}
export function batchFromFile(f: BatchFile): Omit<BatchOptions, 'store' | 'commit'> {
  const origins = new Set(f.systems.map(s => s.origin))
  if (origins.size !== 1) throw new BenchmarkRunError('a batch file holds one origin')
  const origin = [...origins][0]
  if (origin !== 'synthetic') throw new BenchmarkRunError('labels are ground truth only for synthetic batches; a recorded batch needs an independent evaluator')
  return {
    set: f.task_set, asOf: f.as_of, seed: f.seed, budget: f.budget, evaluator: labelEvaluator(f.labels),
    adapters: [...f.systems.map(fixtureAdapter), ...(f.unavailable ?? []).map(u => unavailableAdapter(u.system, u.reason, origin))],
  }
}

export function batchMarkdown(r: BatchResult): string {
  const n = (x: number | null, d = 2) => x === null ? 'n/a' : x.toFixed(d)
  return [
    `# Benchmark batch ${r.manifest.batch_id}`, '',
    `**${r.manifest.label}.** Task set v${r.manifest.task_set_version}, as of ${r.manifest.as_of}, briefs ${r.manifest.briefs_hash.slice(0, 12)}, seed ${r.manifest.seed}.`,
    `Equal budget per task: $${r.manifest.budget.usd_per_task} and ${r.manifest.budget.seconds_per_task}s; batch total $${r.manifest.budget.batch_usd} (spent $${r.spent_usd}). Evaluator: ${r.manifest.evaluator.name} v${r.manifest.evaluator.version} (blind to system).`, '',
    '| system | status | complete / tasks | P@5 | P@10 | validated | unique actionable | seconds | spend | interventions |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...r.report.map(s => `| ${s.system} | ${s.status === 'ran' ? 'ran' : `unavailable: ${s.reason}`} | ${s.complete} / ${s.tasks} | ${n(s.precision_at_5)} | ${n(s.precision_at_10)} | ${s.validated} | ${s.unique_actionable_yield} | ${s.seconds ?? 'n/a'} | ${s.status === 'unavailable' ? 'n/a' : s.spend_usd === null ? 'unknown' : `$${s.spend_usd}`} | ${s.interventions} |`),
    '', 'An unavailable system has no result: it is not ranked. Incomplete, failed and unsupported tasks are not empty markets.',
  ].join('\n')
}
