// Recorded benchmark batches (#397): the Dazl adapter (#786), competitor adapters only where authorized (#787) and the
// one-command scored batch over them (#788). Pure apart from the file reader the caller injects: no network, no model,
// no account, no spend. A recorded output is replayed as it was captured; it is never re-run here.
//
//  - The adapter registry (scoreboard/benchmark/adapters.json, committed and reviewed) lists EVERY system of the
//    benchmark. A system that needs an owner authorization and has none (today: Pancake, Gojiberry and the plain-ChatGPT
//    baseline) is `unavailable` with its reason in every batch, whether or not someone supplied a file for it: an
//    unauthorized recording is ignored and the batch says so. It is never a made-up loser and never omitted.
//  - A recording is checked whole against the committed frozen task set: a task the set does not have, another system's
//    name, another task set version or a malformed config refuses the batch (invalid_input). A malformed task inside a
//    recording fails THAT task (recorded, with its full cost limit reserved), never the others.
//  - Its sha256 is part of the system's config, so a different recording is a different batch id: a stored run of one
//    recording is never reused for another.
//  - The evaluator is always the independent verifier (verified-evaluator.ts) over the verifier's own snapshots; a
//    recorded batch can never be scored by labels or by the producer itself.
import { createHash } from 'node:crypto'
import { BenchmarkRunError, fixtureAdapter, unavailableAdapter, type Adapter, type AdapterConfig, type AdapterResult, type BatchOptions, type Budget, type FixtureOutputs, type RawItem } from './runner.ts'
import type { TaskSet } from './scorecard.ts'
import { parseSnapshots, verifierEvaluator } from './verified-evaluator.ts'

export const REGISTRY_FORMAT = 'dazl-benchmark-adapters'
export const RECORDING_FORMAT = 'dazl-benchmark-recording'
export const RECORDED_BATCH_FORMAT = 'dazl-benchmark-recorded-batch'
export const RECORDING_LIMITS = { items_per_task: 500, sources: 20, text: 500 }

const isRec = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isName = (x: unknown): x is string => typeof x === 'string' && /^[a-z0-9][a-z0-9.-]{0,40}$/.test(x)
const str = (v: unknown, max = RECORDING_LIMITS.text): string | null => typeof v === 'string' && v.trim() !== '' && v.length <= max ? v.trim() : null
const show = (v: unknown) => v === undefined ? 'missing' : (JSON.stringify(v) ?? String(v)).slice(0, 80)
const sha = (v: unknown) => createHash('sha256').update(JSON.stringify(v) ?? 'null').digest('hex')

// --- the adapter registry ------------------------------------------------------------------------------------------

// An owner authorization, quoted from the owner's own words (date, time and scope), never a GitHub comment on the shared
// login. The code checks its shape; the review of the commit that adds it checks that the words are Gagan's.
// It is bound to one recording (its sha256) on one task set, and capped: it cannot be reused for another recording or
// widened by a later batch.
export interface Authorization { granted_by: 'gagan'; granted_at: string; owner_words: string; channel: string; scope: string; max_usd: number; task_set_version: string; recording_sha256: string }
export interface RegistryEntry { system: string; product: string; requires_authorization: boolean; authorization: Authorization | null; unavailable_reason: string | null; note: string | null }

export function authorizationProblem(a: unknown, system: string): string | null {
  if (a === null || a === undefined) return 'no owner authorization is recorded'
  if (!isRec(a)) return 'the authorization record is not an object'
  if (a.granted_by !== 'gagan') return `granted_by ${show(a.granted_by)}: only the owner (gagan) can authorize a competitor account or baseline`
  if (typeof a.granted_at !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(a.granted_at) || !Number.isFinite(Date.parse(a.granted_at))) return `granted_at ${show(a.granted_at)} is not a date and time`
  if (!str(a.owner_words) || (a.owner_words as string).trim().length < 10) return 'owner_words (the owner\'s own words, verbatim) are missing'
  if (!str(a.channel, 60)) return 'channel (where the owner said it) is missing'
  if (!str(a.scope) || !(a.scope as string).toLowerCase().includes(system.toLowerCase())) return `the scope must name the system ${system}`
  if (!(typeof a.max_usd === 'number' && Number.isFinite(a.max_usd) && a.max_usd >= 0)) return `max_usd ${show(a.max_usd)} is not a preset non-negative cap`
  if (typeof a.task_set_version !== 'string' || !a.task_set_version) return 'task_set_version (the one task set it covers) is missing'
  if (typeof a.recording_sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(a.recording_sha256)) return 'recording_sha256 (the one recording it covers) is missing or not a sha256'
  const extra = Object.keys(a).filter(k => !['granted_by', 'granted_at', 'owner_words', 'channel', 'scope', 'max_usd', 'task_set_version', 'recording_sha256'].includes(k))
  if (extra.length) return `unknown authorization field(s) ${extra.join(', ')}`
  return null
}

export function checkRegistry(raw: unknown): RegistryEntry[] {
  if (!isRec(raw) || raw.format !== REGISTRY_FORMAT || raw.version !== 1 || !Array.isArray(raw.systems)) throw new BenchmarkRunError(`the adapter registry is not a ${REGISTRY_FORMAT} v1 file with a systems list`)
  const out: RegistryEntry[] = []
  raw.systems.forEach((e: unknown, i: number) => {
    if (!isRec(e) || !isName(e.system)) throw new BenchmarkRunError(`registry systems[${i}] has no plain system name`)
    if (out.some(x => x.system === e.system)) throw new BenchmarkRunError(`registry lists ${e.system} twice`)
    if (typeof e.requires_authorization !== 'boolean') throw new BenchmarkRunError(`registry ${e.system}: requires_authorization must be true or false`)
    // Only Dazl's own recorded run needs no competitor authorization; every other system does, always.
    if (e.system !== 'dazl' && e.requires_authorization !== true) throw new BenchmarkRunError(`registry ${e.system}: every system other than dazl requires an owner authorization`)
    out.push({ system: e.system, product: str(e.product, 120) ?? e.system, requires_authorization: e.requires_authorization, authorization: (e.authorization ?? null) as Authorization | null, unavailable_reason: str(e.unavailable_reason), note: str(e.note) })
  })
  if (!out.length) throw new BenchmarkRunError('the adapter registry lists no system')
  return out
}

// --- recordings ----------------------------------------------------------------------------------------------------

export interface Recording { format: typeof RECORDING_FORMAT; version: 1; system: string; task_set_version: string; captured_at: string; config: AdapterConfig; tasks: Record<string, unknown> }

const configOf = (c: unknown): AdapterConfig => {
  if (!isRec(c)) throw new BenchmarkRunError('the recording has no config')
  const product = str(c.product, 120)
  const nullable = (v: unknown, k: string) => { if (v === null || v === undefined) return null; const s = str(v, 120); if (!s) throw new BenchmarkRunError(`config.${k} ${show(v)} is not a string or null`); return s }
  if (!product) throw new BenchmarkRunError('config.product is missing')
  if (!Array.isArray(c.sources) || c.sources.length > RECORDING_LIMITS.sources || !c.sources.every(s => str(s, 200))) throw new BenchmarkRunError(`config.sources must be a list of at most ${RECORDING_LIMITS.sources} strings`)
  if (typeof c.paid !== 'boolean') throw new BenchmarkRunError('config.paid must be true or false')
  return { product, product_version: nullable(c.product_version, 'product_version'), model: nullable(c.model, 'model'), sources: (c.sources as string[]).map(s => s.trim()), paid: c.paid }
}
const nonNeg = (x: unknown) => x === null || (typeof x === 'number' && Number.isFinite(x) && x >= 0)
const STOPS = ['budget', 'timeout', 'rate_limited', 'login_required', 'paywall', 'feature_unavailable']
// One recorded task: the adapter result, or why it cannot be replayed (that task then fails, recorded).
function taskOf(v: unknown): AdapterResult | { error: string } {
  if (!isRec(v)) return { error: 'malformed recording: the task entry is not an object' }
  if (typeof v.error === 'string') return { error: v.error.slice(0, 200) || 'recorded error' }
  if (!Array.isArray(v.items)) return { error: 'malformed recording: items is not a list' }
  if (v.items.length > RECORDING_LIMITS.items_per_task) return { error: `malformed recording: ${v.items.length} items, at most ${RECORDING_LIMITS.items_per_task}` }
  if (!nonNeg(v.cost_usd)) return { error: `malformed recording: cost_usd ${show(v.cost_usd)} is not a non-negative number or null` }
  if (!nonNeg(v.seconds)) return { error: `malformed recording: seconds ${show(v.seconds)} is not a non-negative number or null` }
  if (!(typeof v.interventions === 'number' && Number.isSafeInteger(v.interventions) && v.interventions >= 0)) return { error: `malformed recording: interventions ${show(v.interventions)} is not a non-negative integer` }
  if (v.stopped !== undefined && !STOPS.includes(v.stopped as string)) return { error: `malformed recording: stopped ${show(v.stopped)} is not one of ${STOPS.join(', ')}` }
  return { items: v.items as RawItem[], cost_usd: v.cost_usd as number | null, seconds: v.seconds as number | null, interventions: v.interventions, ...(v.stopped ? { stopped: v.stopped as AdapterResult['stopped'] } : {}), ...(typeof v.detail === 'string' ? { detail: v.detail.slice(0, 200) } : {}) }
}

export const recordingSha = (raw: unknown) => sha(raw)
export function checkRecording(raw: unknown, set: TaskSet, system: string): FixtureOutputs {
  if (!isRec(raw) || raw.format !== RECORDING_FORMAT || raw.version !== 1) throw new BenchmarkRunError(`${system}: the recording is not a ${RECORDING_FORMAT} v1 file`)
  if (raw.system !== system) throw new BenchmarkRunError(`${system}: the recording is of system ${show(raw.system)}`)
  if (raw.task_set_version !== set.version) throw new BenchmarkRunError(`${system}: the recording ran task set v${show(raw.task_set_version)}, the batch is v${set.version}`)
  if (typeof raw.captured_at !== 'string' || !Number.isFinite(Date.parse(raw.captured_at))) throw new BenchmarkRunError(`${system}: captured_at ${show(raw.captured_at)} is not a time`)
  if (!isRec(raw.tasks)) throw new BenchmarkRunError(`${system}: tasks is not an object keyed by task id`)
  const ids = new Set(set.tasks.map(t => t.id))
  const foreign = Object.keys(raw.tasks).filter(k => !ids.has(k))
  if (foreign.length) throw new BenchmarkRunError(`${system}: the recording has task(s) not in frozen task set v${set.version}: ${foreign.slice(0, 5).join(', ')}`)
  const config = configOf(raw.config)
  const tasks = Object.fromEntries(Object.entries(raw.tasks).map(([k, v]) => [k, taskOf(v)]))
  return { system, origin: 'recorded', config: { ...config, notes: `recording sha256 ${sha(raw)}, captured ${raw.captured_at}` }, tasks }
}

// --- the Dazl adapter (#786): a scripts/scoreboard.mts result as a recording ---------------------------------------

interface SbLeadIn { company?: unknown; company_domain?: unknown; event_date?: unknown; source_url?: unknown; signal?: unknown; quarantined_at?: unknown; person_title?: unknown; routes?: unknown; site_evidence?: unknown }
const INCOMPLETE_STOP: Record<string, AdapterResult['stopped']> = { budget_stopped: 'budget', scan_timeout: 'timeout' }
// Dazl's own recorded run, canonicalised into the recording the runner replays. Everything it presented is kept with
// its evidence (the raw lead is the item); what it quarantined itself is not presented, so it is not an output. The
// domain is Dazl's claim, confirmed or not: the verifier checks the binding itself. A person and a contact route carry
// the page they were read on only when the recording has it (site_evidence); otherwise those checks are unknown.
export function dazlRecordingFromScoreboard(sb: unknown, set: TaskSet): Recording {
  if (!isRec(sb) || typeof sb.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(sb.date) || !Array.isArray(sb.rows)) throw new BenchmarkRunError('not a scripts/scoreboard.mts result (needs date YYYY-MM-DD and rows)')
  const ids = new Set(set.tasks.map(t => t.id)), seen = new Set<string>()
  const tasks: Record<string, unknown> = {}
  sb.rows.forEach((r: unknown, i: number) => {
    if (!isRec(r) || typeof r.id !== 'string') throw new BenchmarkRunError(`rows[${i}] has no id`)
    if (!ids.has(r.id)) throw new BenchmarkRunError(`row ${r.id} is not a task of frozen task set v${set.version}`)
    if (seen.has(r.id)) throw new BenchmarkRunError(`row ${r.id} is recorded twice: one record per task, never merged or picked`)
    seen.add(r.id)
    const seconds = typeof r.seconds === 'number' && Number.isFinite(r.seconds) && r.seconds >= 0 ? r.seconds : null
    const error = typeof r.error === 'string' ? r.error : null
    if (r.complete !== true) {
      const stop = error ? INCOMPLETE_STOP[error] : undefined
      tasks[r.id] = stop ? { items: [], cost_usd: null, seconds, interventions: 0, stopped: stop, detail: error } : { error: `dazl run did not complete: ${error ?? 'no reason recorded'}`, seconds }
      return
    }
    if (!Array.isArray(r.leads)) { tasks[r.id] = { error: 'malformed scoreboard row: complete, but leads is not a list (a truncated result is not an empty market)' }; return }
    const leads = r.leads as SbLeadIn[]
    const items = leads.filter(l => isRec(l) && (l.quarantined_at === null || l.quarantined_at === undefined)).map((l): RawItem => {
      const ev = (Array.isArray(l.site_evidence) ? l.site_evidence : []).filter(isRec)
      const srcOf = (kind: string, value: string) => { const e = ev.find(x => x.kind === kind && x.value === value && typeof x.source_url === 'string'); return e ? e.source_url as string : null }
      const pt = typeof l.person_title === 'string' ? l.person_title : null
      const cut = pt ? pt.indexOf(', ') : -1
      const personSrc = pt ? srcOf('person', pt) : null
      const route = (Array.isArray(l.routes) ? l.routes : []).filter(isRec).find(x => x.kind === 'email' && x.role_ok === true && typeof x.value === 'string')
      const contact = route ? route.value as string : null
      const src = typeof l.source_url === 'string' ? l.source_url : null
      return {
        company: typeof l.company === 'string' ? l.company : '', domain: typeof l.company_domain === 'string' ? l.company_domain : null,
        contact, contact_source_url: contact ? srcOf('email', contact) : null,
        event_date: typeof l.event_date === 'string' ? l.event_date : null, event_source_url: src, evidence_urls: src ? [src] : [],
        text: typeof l.signal === 'string' ? l.signal : null,
        person: pt && cut > 0 && personSrc ? { name: pt.slice(0, cut), title: pt.slice(cut + 2), source_url: personSrc } : null,
        original: l,                                                     // Dazl's whole lead as recorded, for audit
      }
    })
    tasks[r.id] = { items, cost_usd: null, seconds, interventions: 0 }   // the scoreboard records one shared budget, not a per-task cost: unknown, never 0
  })
  return {
    format: RECORDING_FORMAT, version: 1, system: 'dazl', task_set_version: set.version, captured_at: `${sb.date}T23:59:59Z`,
    config: { product: 'dazl', product_version: typeof sb.commit === 'string' ? sb.commit : null, model: typeof sb.model === 'string' ? sb.model : null, sources: ['dazl scan pipeline (web/scripts/scoreboard.mts)'], paid: true },
    tasks,
  }
}

// --- the recorded batch (#788) -------------------------------------------------------------------------------------

export interface RecordedBatchFile { format: typeof RECORDED_BATCH_FORMAT; version: 1; as_of: string; seed: number; budget: Budget; task_set_version: string; recordings: Record<string, string>; snapshots: string; min_independent_origins: number }
export interface RecordedDeps { registry: unknown; committedSet: TaskSet | null; read(file: string): unknown }
export interface RecordedNote { system: string; used: boolean; reason: string | null }
export const minOrigins = (v: unknown): number | undefined => {
  if (v === undefined) return undefined
  if (!(typeof v === 'number' && Number.isSafeInteger(v) && v >= 1 && v <= 5)) throw new BenchmarkRunError(`min_independent_origins ${show(v)} must be an integer 1..5`)
  return v
}

export function recordedBatch(f: unknown, deps: RecordedDeps): { options: Omit<BatchOptions, 'store' | 'commit'>; notes: RecordedNote[] } {
  if (!isRec(f) || f.format !== RECORDED_BATCH_FORMAT || f.version !== 1) throw new BenchmarkRunError(`not a ${RECORDED_BATCH_FORMAT} v1 file`)
  const set = deps.committedSet
  if (!set) throw new BenchmarkRunError(`a recorded batch must run a committed frozen task set; none is committed for v${show(f.task_set_version)}`)
  if (f.task_set_version !== set.version) throw new BenchmarkRunError(`the batch names task set v${show(f.task_set_version)}, the committed set is v${set.version}`)
  if (!Number.isSafeInteger(f.seed)) throw new BenchmarkRunError(`seed ${show(f.seed)} is not an integer`)
  if (!isRec(f.budget) || !['usd_per_task', 'seconds_per_task', 'batch_usd'].every(k => typeof (f.budget as Record<string, unknown>)[k] === 'number')) throw new BenchmarkRunError('budget must give usd_per_task, seconds_per_task and batch_usd as numbers')
  if (!isRec(f.recordings) || !Object.values(f.recordings).every(p => typeof p === 'string' && p.trim())) throw new BenchmarkRunError('recordings must map a system to a recording file')
  if (typeof f.snapshots !== 'string' || !f.snapshots.trim()) throw new BenchmarkRunError('snapshots (the verifier\'s own captures) is required: a recorded batch is never scored without them')
  // The corroboration level is a stated choice of the batch (and of its preregistered plan, #398), never a silent default.
  if (f.min_independent_origins === undefined) throw new BenchmarkRunError('min_independent_origins is required in a recorded batch (2 = independently corroborated, 1 = source-checked)')
  const min = minOrigins(f.min_independent_origins)
  const registry = checkRegistry(deps.registry)
  const unknown = Object.keys(f.recordings).filter(s => !registry.some(e => e.system === s))
  if (unknown.length) throw new BenchmarkRunError(`recording(s) for system(s) not in the adapter registry: ${unknown.join(', ')}`)
  const notes: RecordedNote[] = []
  const budget = f.budget as unknown as Budget
  const adapters: Adapter[] = registry.map(e => {
    const file = (f.recordings as Record<string, string>)[e.system]
    const authProblem = e.requires_authorization ? authorizationProblem(e.authorization, e.system) : null
    if (authProblem) {
      const reason = `${e.unavailable_reason ?? `no authorized ${e.product} adapter`} (${authProblem})${file ? '; a recording was supplied and ignored: it is not authorized' : ''}`
      notes.push({ system: e.system, used: false, reason }); return unavailableAdapter(e.system, reason, 'recorded', e.product)
    }
    if (!file) { const reason = `authorized, but no recording of ${e.product} was supplied for this batch`; notes.push({ system: e.system, used: false, reason }); return unavailableAdapter(e.system, reason, 'recorded', e.product) }
    const raw = deps.read(file)
    const fx = checkRecording(raw, set, e.system)
    if (e.requires_authorization) {
      // The authorization covers exactly this recording on this task set, within its cap: the worst-case exposure counts
      // every replayed task at its recorded cost, or at the full per-task limit when the cost is unknown.
      const a = e.authorization as Authorization
      const exposure = Object.values(fx.tasks).reduce((s, t) => s + ('error' in t ? budget.usd_per_task : t.cost_usd ?? budget.usd_per_task), 0)
      const why = a.task_set_version !== set.version ? `the authorization covers task set v${a.task_set_version}, not v${set.version}`
        : a.recording_sha256 !== recordingSha(raw) ? 'the authorization covers a different recording (sha256 mismatch)'
          : exposure > a.max_usd ? `worst-case exposure $${exposure} is over the authorized cap $${a.max_usd}` : null
      if (why) { const reason = `${e.product}: ${why}; not run`; notes.push({ system: e.system, used: false, reason }); return unavailableAdapter(e.system, reason, 'recorded', e.product) }
    }
    notes.push({ system: e.system, used: true, reason: null })
    return fixtureAdapter(fx)
  })
  const snapshots = parseSnapshots(deps.read(f.snapshots))
  // A recorded batch is scored only on captures attributed to the verifier, and never on a file a system under test
  // names itself as the author of. (Attribution is a recorded string, not a signature: see docs/BENCHMARK.md.)
  if (!snapshots.attributed) throw new BenchmarkRunError(`the snapshots file is not attributed to the verifier: ${snapshots.problems.slice(0, 3).join('; ')}`)
  const by = snapshots.captured_by!.toLowerCase()
  const names = (e: RegistryEntry) => by.includes(e.system.toLowerCase()) || by.includes(e.product.toLowerCase())
  const self = registry.find(e => names(e) && (e.system !== 'dazl' || !by.includes('verifier')))   // "dazl-verifier" is the verifier; "dazl" alone is the producer
  if (self) throw new BenchmarkRunError(`the snapshots were captured by "${snapshots.captured_by}", a system under test, not by the verifier`)
  const evaluator = verifierEvaluator({ snapshots, min_independent_origins: min })
  return { options: { set, committedSet: set, asOf: f.as_of as string, seed: f.seed as number, budget, adapters, evaluator }, notes }
}
