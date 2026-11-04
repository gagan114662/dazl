// Hard per-scan spend cap (#377 / #533 closure blocker 1). Every paid provider call a scan can make reserves its
// worst-case cost against the scan's own durable ledger row BEFORE the request is sent, and is refused (nothing is
// sent) when the reservation would pass the scan's cap. The cap is the owner's CAD 5 per paid scan.
//
// Where it is enforced: at the transport of each paid provider, right before its fetch (lib/llm/provider.ts model
// completions, lib/search/tinyfish.ts search and fetch, lib/enrich/apollo.ts and pdl.ts, lib/scan/fetch-page.ts
// renderViaService). The scan runner (lib/scan/runner.ts runJobUntraced) opens the scan's context around the whole run,
// post-finish enrichment included, so every one of those calls made for the scan finds it. Outside a scan (replies,
// drafts, SEO, previews) there is no scan context and the transport is unchanged: those paths keep their own guards
// (docs/spend-safety.md). test/scan-spend-cap-paths.test.ts fails when a new paid host or transport is added
// without this gate.
//
// The durable record, in the style of #626's one-run claim:
//   - the ledger row is the scan job row itself (scan_jobs.spend_cap_usd / spend_cap_reserved_usd /
//     spend_cap_refusals), so every attempt, retry, restart, worker and instance of the scan draws on one row;
//   - one transaction raises spend_cap_reserved_usd only WHERE the new total still fits the cap, for this job id AND
//     its tenant AND the attempt that owns it, and writes the call's own row (scan_spend_calls, status 'reserved').
//     On Postgres the UPDATE takes the row lock and re-checks the condition against the committed value; on SQLite
//     the Db layer's transaction is IMMEDIATE (one writer). Two workers on the same scan can never pass the cap
//     together;
//   - a refusal is recorded in the same transaction (a 'refused' call row with its reason, and the job's refusal
//     count), then thrown as SpendRefused before any request;
//   - after the call, settle moves the reservation to the vendor-reported cost (status 'settled'), once: a replayed
//     settle changes nothing. A call that failed, or reported no usable cost, keeps its full worst case ('kept').
//     A crash between reserve and settle leaves the row 'reserved' at its worst case, forever: never released.
//
// The cap: DAZL_SCAN_CAP_CAD (default and hard ceiling CAD 5; a higher value is clamped to 5, so no setting can raise
// it) divided by DAZL_SCAN_CAP_FX_CAD_PER_USD (default and floor 1.50 CAD per USD, an all-in rate that includes card
// FX fees, chosen above every Bank of Canada daily rate since 2000; a lower value is clamped up, so no setting can
// raise the USD cap either). Hard ceiling: CAD 5 / 1.50 = USD 3.3333; the column's CHECK holds the same bound in the
// store. A request's own run_budget.max_usd can only lower it. A malformed setting refuses every paid call of the
// scan (recorded). Prices are in USD because every vendor bills in USD.
//
// Prices (worst case per call, before the call). Defaults are public list prices; each is env-overridable:
//   - model completions: the prompt's UTF-8 bytes + INPUT_MARGIN_TOKENS as input tokens and the call's max_tokens as
//     output, at the listed price of the REQUESTED model (SCAN_MODEL_PRICES_USD_PER_M below). Never the token
//     counter's estimate. A model with no listed price is refused. dazl sends no cache_control, so no cache-write
//     surcharge can apply (asserted by the paths test). After the call the reservation moves to the cost the vendor
//     reported for the SERVED model; a served model with no price, or no usable usage, keeps the worst case;
//   - TinyFish search / fetch: DAZL_SCAN_PRICE_TINYFISH_SEARCH_USD / _FETCH_USD (per search / per URL; else the
//     trial's DAZL_TRIAL_TINYFISH_*_USD). Unset: USD 0, but only while dazl's own global daily caps
//     (TINYFISH_GLOBAL_SEARCH_DAILY, TINYFISH_GLOBAL_FETCH_DAILY) stay inside TinyFish's documented free allowance
//     (12,000 searches and 1,000 URLs per UTC day, docs.tinyfish.ai/search-api and /fetch-api, "Billing"); a cap set
//     above it makes the price unknown, and the call is refused;
//   - Apollo: DAZL_SCAN_PRICE_APOLLO_ORG_USD and DAZL_SCAN_PRICE_APOLLO_PEOPLE_USD, default USD 0.20 per request each:
//     one credit at Apollo's published add-on credit price (USD 0.20, apollo.io/pricing). docs.apollo.io/docs/api-pricing
//     lists organization enrichment at 1 credit and does not list the people API search (0 credits), but legacy plans
//     can differ (lib/enrich/index.ts heldCostText), so the people search is priced at one credit too;
//   - PDL: DAZL_SCAN_PRICE_PDL_PROFILE_USD, default USD 0.28 per profile (the published Pro tier-1 monthly price,
//     peopledatalabs.com/pricing/person), reserved for the full size asked for and settled to the profiles returned
//     (PDL bills per profile returned; a 404 "no match" is not billed, docs.peopledatalabs.com "How Credits Work");
//   - the rendering service: DAZL_SCAN_PRICE_RENDER_USD, default USD 0.01 per render (Browserless cloud bills 1 unit
//     per started 30 s at USD 0.0020 per overage unit, browserless.io/pricing; a render is cut at 35 s, so 2 units, and
//     the default allows 5). A self-hosted renderer can set 0.
//   A setting that is not a plain decimal refuses the call (recorded), never falls back to the default.
import type Database from 'better-sqlite3'
import { AsyncLocalStorage } from 'node:async_hooks'
import { randomBytes } from 'node:crypto'
import { asDb, type DbLike, type Tx, type TxBody } from '../db/client.ts'
import { CACHE_READ_FACTOR, CACHE_WRITE_FACTOR, INPUT_MARGIN_TOKENS, PRICES_USD_PER_M, SpendRefused } from '../llm/spend-guard.ts'
import type { CompletionUsage } from '../llm/provider.ts'
import { captureError } from '../ops/errors.ts'

type Env = Record<string, string | undefined>

export const HARD_CAP_CAD = 5
export const MIN_FX_CAD_PER_USD = 1.5
export const HARD_CAP_USD = HARD_CAP_CAD / MIN_FX_CAD_PER_USD
// The bound the store's CHECK holds spend_cap_usd to (HARD_CAP_USD rounded up in the 4th decimal).
export const STORE_CAP_BOUND_USD = 3.3334
// Rounding guard: amounts are doubles; a reservation that fits to within a nano-dollar fits.
const EPS = 1e-9
// A plain decimal: digits, an optional fraction. No sign, exponent, hex, spaces, commas or unicode digits.
const DECIMAL = /^\d{1,6}(?:\.\d{1,9})?$/

export type CapConfig = { ok: true; capCad: number; fxCadPerUsd: number; capUsd: number } | { ok: false; reason: 'cap_config_invalid' }
export function scanCapConfig(env: Env = process.env): CapConfig {
  const num = (raw: string | undefined, dflt: number): number | null => {
    if (raw === undefined || raw === '') return dflt
    if (typeof raw !== 'string' || !DECIMAL.test(raw)) return null
    const v = Number(raw)
    return Number.isFinite(v) && v > 0 ? v : null
  }
  const cad = num(env.DAZL_SCAN_CAP_CAD, HARD_CAP_CAD)
  const fx = num(env.DAZL_SCAN_CAP_FX_CAD_PER_USD, MIN_FX_CAD_PER_USD)
  if (cad === null || fx === null) return { ok: false, reason: 'cap_config_invalid' }
  const capCad = Math.min(cad, HARD_CAP_CAD), fxCadPerUsd = Math.max(fx, MIN_FX_CAD_PER_USD)
  return { ok: true, capCad, fxCadPerUsd, capUsd: Math.min(capCad / fxCadPerUsd, HARD_CAP_USD) }
}

export type SpendKind = 'llm.anthropic' | 'llm.openai' | 'tinyfish.search' | 'tinyfish.fetch' | 'apollo.org' | 'apollo.people' | 'pdl.people' | 'render'
export const SPEND_KINDS: readonly SpendKind[] = ['llm.anthropic', 'llm.openai', 'tinyfish.search', 'tinyfish.fetch', 'apollo.org', 'apollo.people', 'pdl.people', 'render']

// TinyFish's documented free allowance per UTC day (see the header).
export const TINYFISH_FREE_SEARCHES_PER_DAY = 12_000
export const TINYFISH_FREE_URLS_PER_DAY = 1_000
const UNIT_PRICE_ENV: Record<Exclude<SpendKind, 'llm.anthropic' | 'llm.openai'>, string[]> = {
  'tinyfish.search': ['DAZL_SCAN_PRICE_TINYFISH_SEARCH_USD', 'DAZL_TRIAL_TINYFISH_SEARCH_USD'],
  'tinyfish.fetch': ['DAZL_SCAN_PRICE_TINYFISH_FETCH_USD', 'DAZL_TRIAL_TINYFISH_FETCH_USD'],
  'apollo.org': ['DAZL_SCAN_PRICE_APOLLO_ORG_USD'],
  'apollo.people': ['DAZL_SCAN_PRICE_APOLLO_PEOPLE_USD'],
  'pdl.people': ['DAZL_SCAN_PRICE_PDL_PROFILE_USD'],
  render: ['DAZL_SCAN_PRICE_RENDER_USD'],
}
// The documented list-price defaults (see the header). TinyFish has none: it is free inside its allowance, else unknown.
export const DEFAULT_UNIT_USD: Partial<Record<keyof typeof UNIT_PRICE_ENV, number>> = {
  'apollo.org': 0.2,
  'apollo.people': 0.2,
  'pdl.people': 0.28,
  render: 0.01,
}
// Listed USD per million tokens for every model the scan path requests by default (lib/llm/provider.ts configuredModel):
// the shared table (lib/llm/spend-guard.ts PRICES_USD_PER_M, which the other run guards read and which this change
// leaves as it is) plus gpt-4.1, priced at OpenAI's Priority processing rate (USD 3.50 in / 14.00 out per 1M,
// openai.com/api-priority-processing; Standard is 2.00 / 8.00, platform.openai.com/docs/pricing) because dazl sends
// no service_tier and a project's default tier can be Priority. claude-sonnet-4-5 is USD 3 / 15: dazl sends no
// long-context beta header, so a request cannot reach the >200K-token rate. Any other model is refused.
export const SCAN_MODEL_PRICES_USD_PER_M: Readonly<Record<string, { in: number; out: number }>> = Object.freeze({
  ...PRICES_USD_PER_M,
  'gpt-4.1': { in: 3.5, out: 14 },
})
// A served model id with a release date (claude-sonnet-4-5-20250929, gpt-4.1-2025-04-14) is priced as its listed alias.
export function scanModelPrice(model: string | null | undefined): { in: number; out: number } | null {
  if (typeof model !== 'string' || !model) return null
  const own = (k: string) => (Object.prototype.hasOwnProperty.call(SCAN_MODEL_PRICES_USD_PER_M, k) ? SCAN_MODEL_PRICES_USD_PER_M[k] : null)
  return own(model) ?? own(model.replace(/-\d{8}$/, '')) ?? own(model.replace(/-\d{4}-\d{2}-\d{2}$/, ''))
}
// What `units` of a fixed-price call cost in USD. Throws SpendRefused('price_unknown' | 'price_invalid') when no
// price can be stated; the reservation records that refusal.
export function unitCostUsd(kind: keyof typeof UNIT_PRICE_ENV, units: number, env: Env = process.env): number {
  if (!(Number.isInteger(units) && units >= 1 && units <= 1000)) throw new SpendRefused('units_invalid')
  for (const name of UNIT_PRICE_ENV[kind]) {
    const raw = env[name]
    if (raw === undefined || raw === '') continue
    if (typeof raw !== 'string' || !DECIMAL.test(raw)) throw new SpendRefused('price_invalid')
    const p = Number(raw)
    if (!(Number.isFinite(p) && p >= 0)) throw new SpendRefused('price_invalid')
    return p * units
  }
  const dflt = DEFAULT_UNIT_USD[kind]
  if (dflt !== undefined) return dflt * units
  if (kind === 'tinyfish.search' || kind === 'tinyfish.fetch') {
    // Free only while dazl's own global caps keep every call inside the free allowance (lib/search/tinyfish.ts limits).
    const cap = (name: string, dflt: number) => { const v = Number(env[name]); return Number.isFinite(v) && v > 0 ? Math.floor(v) : dflt }
    const inside = kind === 'tinyfish.search'
      ? cap('TINYFISH_GLOBAL_SEARCH_DAILY', 3000) <= TINYFISH_FREE_SEARCHES_PER_DAY
      : cap('TINYFISH_GLOBAL_FETCH_DAILY', 400) <= TINYFISH_FREE_URLS_PER_DAY
    if (inside) return 0
  }
  throw new SpendRefused('price_unknown')
}
// A model completion's worst case (see the header): the requested model's listed price, prompt bytes as input.
export function modelCostUsd(model: string | undefined, prompt: string, maxTokens: number): number {
  if (typeof prompt !== 'string') throw new SpendRefused('cost_invalid')
  if (!(Number.isInteger(maxTokens) && maxTokens >= 1 && maxTokens <= 200_000)) throw new SpendRefused('cost_invalid')
  const p = scanModelPrice(model)
  if (!p) throw new SpendRefused('model_unpriced')
  return ((Buffer.byteLength(prompt, 'utf8') + INPUT_MARGIN_TOKENS) * p.in + maxTokens * p.out) / 1e6
}
// What a finished completion cost, from what the vendor reported for the SERVED model (input, output, cache reads at
// CACHE_READ_FACTOR and cache writes at CACHE_WRITE_FACTOR, as lib/llm/spend-guard.ts completionCost). null when it
// cannot be stated (no usage, an unpriced or missing served model, a missing or invalid count): the worst case stands.
export function servedCostUsd(servedModel: string | null | undefined, usage: CompletionUsage | undefined): number | null {
  const p = scanModelPrice(servedModel)
  if (!p || !usage || typeof usage !== 'object') return null
  const ok = (v: unknown, required: boolean) => (v === undefined ? !required : typeof v === 'number' && Number.isFinite(v) && v >= 0)
  if (!ok(usage.input_tokens, true) || !ok(usage.output_tokens, true) || !ok(usage.cache_creation_input_tokens, false) || !ok(usage.cache_read_input_tokens, false)) return null
  return (usage.input_tokens! * p.in + usage.output_tokens! * p.out + (usage.cache_creation_input_tokens ?? 0) * p.in * CACHE_WRITE_FACTOR + (usage.cache_read_input_tokens ?? 0) * p.in * CACHE_READ_FACTOR) / 1e6
}

export interface ScanSpendCtx {
  db: DbLike
  jobId: string
  tenantId: string
  attempt: number
  cap: CapConfig
  // The request's own run_budget.max_usd, when it set one: it can only lower the cap.
  requestMaxUsd?: number | null
  clock?: () => number
}
const store = new AsyncLocalStorage<ScanSpendCtx>()
// Runs fn with the scan's spend context: every gated paid call inside it (awaited or not) reserves on this scan.
export function runWithScanSpend<T>(ctx: ScanSpendCtx, fn: () => Promise<T>): Promise<T> { return store.run(ctx, fn) }
export function scanSpendContext(): ScanSpendCtx | undefined { return store.getStore() }
// Work a scan starts that is not the scan's own spend (autopilot's outreach drafting, under its own guards) runs outside
// the scan's context: the cap neither counts nor refuses it.
export function outsideScanSpend<T>(fn: () => T): T { return store.exit(fn) }

// A paid step a scan's owner runs on that scan outside its runner (the owner retry of a held enrichment lookup,
// lib/enrich/index.ts retryHeldEnrichment) draws on the same scan's ledger, at the scan's current attempt, under the
// same cap and the scan's own run_budget.max_usd. A job that is not this tenant's still runs fn inside a context,
// so every paid call in it is refused (recorded as scan_not_found), never made outside the cap.
export async function runWithJobSpend<T>(d: DbLike, tenantId: string, jobId: string, fn: () => Promise<T>): Promise<T> {
  let j: { attempts: number | string; run_budget: string | null; csv_domain: string | null } | undefined
  // A read that fails leaves no job: every paid call in fn is then refused (the reservation cannot be made either).
  try { j = await asDb(d).get('SELECT attempts, run_budget, csv_domain FROM scan_jobs WHERE id = ? AND user_id = ?', [jobId, tenantId]) } catch { j = undefined }
  let requestMaxUsd: number | null = null
  if (j && !j.csv_domain && j.run_budget) {
    try { const m = (JSON.parse(j.run_budget) as { max_usd?: unknown } | null)?.max_usd; if (typeof m === 'number' && Number.isFinite(m) && m > 0) requestMaxUsd = m } catch { /* no budget: the cap alone */ }
  }
  return runWithScanSpend({ db: d, jobId, tenantId, attempt: j ? Number(j.attempts) : -1, cap: scanCapConfig(), requestMaxUsd }, fn)
}

export function effectiveCapUsd(ctx: ScanSpendCtx): number | null {
  if (!ctx.cap.ok) return null
  const req = ctx.requestMaxUsd
  const c = typeof req === 'number' && Number.isFinite(req) && req > 0 ? Math.min(ctx.cap.capUsd, req) : ctx.cap.capUsd
  return Math.min(c, HARD_CAP_USD)
}

export interface SpendHold {
  id: string
  kind: SpendKind
  usd: number
  // After the call: the vendor-reported cost (moves the reservation to it), or null to keep the full worst case (the
  // call failed, or reported nothing usable). Once only; never throws (a settle that cannot be saved keeps the worst
  // case, which only over-counts).
  settle(actualUsd: number | null): Promise<void>
}

const reasonOf = (e: unknown): string => (e instanceof SpendRefused ? e.reason : 'cost_invalid').slice(0, 80)
const newId = () => randomBytes(10).toString('hex')

// Reserve a paid call's worst case on the current scan, before the call. Outside a scan: null (no gate here). Inside:
// a hold, or SpendRefused (recorded) when the cost cannot be stated, the setting is malformed, the job is not this
// tenant's running attempt, or the reservation would pass the cap. `cost` is a function so a pricing failure is
// recorded as the refusal.
export async function reserveScanSpend(kind: SpendKind, cost: () => number): Promise<SpendHold | null> {
  const ctx = store.getStore()
  if (!ctx) return null
  const db = asDb(ctx.db)
  const now = ctx.clock ?? (() => Math.floor(Date.now() / 1000))
  const at = now()
  let usd = 0
  let early: string | null = null
  const cap = effectiveCapUsd(ctx)
  if (cap === null) early = 'cap_config_invalid'
  else {
    try { usd = cost() } catch (e) { early = reasonOf(e) }
    if (!early && !(typeof usd === 'number' && Number.isFinite(usd) && usd >= 0)) { early = 'cost_invalid'; usd = 0 }
  }
  if (!SPEND_KINDS.includes(kind)) { early = 'kind_unknown'; kind = String(kind).slice(0, 32) as SpendKind }
  const id = newId()
  const attempt = Number.isSafeInteger(ctx.attempt) ? ctx.attempt : -1
  let refused: string | null
  try {
    refused = await db.tx(function* (t: Tx): TxBody<string | null> {
      let why = early
      if (!why) {
        const r = yield* t.run(
          `UPDATE scan_jobs SET spend_cap_usd = CASE WHEN spend_cap_usd IS NOT NULL AND spend_cap_usd < ? THEN spend_cap_usd ELSE ? END,
             spend_cap_reserved_usd = spend_cap_reserved_usd + ?
           WHERE id = ? AND user_id = ? AND attempts = ? AND status IN ('running', 'done')
             AND spend_cap_reserved_usd + ? <= (CASE WHEN spend_cap_usd IS NOT NULL AND spend_cap_usd < ? THEN spend_cap_usd ELSE ? END) + ?`,
          [cap!, cap!, usd, ctx.jobId, ctx.tenantId, attempt, usd, cap!, cap!, EPS])
        if (r.changes === 1) {
          yield* t.run("INSERT INTO scan_spend_calls (id, user_id, scan_job_id, attempt, kind, reserve_usd, actual_usd, status, reason, created_at, settled_at) VALUES (?, ?, ?, ?, ?, ?, NULL, 'reserved', NULL, ?, NULL)",
            [id, ctx.tenantId, ctx.jobId, attempt, kind, usd, at])
          return null
        }
        // Why it did not fit, read under the same lock: another tenant's (or no) job, a lost attempt, a finished job, or the cap.
        const j = yield* t.get<{ attempts: number | string; status: string }>('SELECT attempts, status FROM scan_jobs WHERE id = ? AND user_id = ?', [ctx.jobId, ctx.tenantId])
        why = !j ? 'scan_not_found' : Number(j.attempts) !== attempt ? 'ownership_lost' : j.status !== 'running' && j.status !== 'done' ? 'scan_not_active' : 'over_cap'
      }
      yield* t.run('UPDATE scan_jobs SET spend_cap_refusals = spend_cap_refusals + 1 WHERE id = ? AND user_id = ?', [ctx.jobId, ctx.tenantId])
      yield* t.run("INSERT INTO scan_spend_calls (id, user_id, scan_job_id, attempt, kind, reserve_usd, actual_usd, status, reason, created_at, settled_at) VALUES (?, ?, ?, ?, ?, ?, NULL, 'refused', ?, ?, NULL)",
        [id, ctx.tenantId, ctx.jobId, attempt, kind, usd, why, at])
      return why
    })
  } catch (e) {
    // The store did not answer: no reservation exists, so the call must not happen. Logged, since it cannot be recorded.
    captureError(e, { source: 'worker', where: 'scan-spend-cap:reserve', tenantId: ctx.tenantId, ref: ctx.jobId })
    throw new SpendRefused('ledger_unavailable')
  }
  if (refused) throw new SpendRefused(refused)
  let done = false
  return {
    id, kind, usd,
    async settle(actualUsd) {
      if (done) return
      done = true
      const actual = typeof actualUsd === 'number' && Number.isFinite(actualUsd) && actualUsd >= 0 ? actualUsd : null
      const write = () => db.tx(function* (t: Tx): TxBody<void> {
        const r = yield* t.run('UPDATE scan_spend_calls SET status = ?, actual_usd = ?, settled_at = ? WHERE id = ? AND user_id = ? AND scan_job_id = ? AND status = \'reserved\'',
          [actual === null ? 'kept' : 'settled', actual, now(), id, ctx.tenantId, ctx.jobId])
        if (r.changes !== 1 || actual === null) return // a replay, or nothing to move: the worst case stands
        const delta = actual - usd
        if (delta !== 0) yield* t.run('UPDATE scan_jobs SET spend_cap_reserved_usd = CASE WHEN spend_cap_reserved_usd + ? < 0 THEN 0 ELSE spend_cap_reserved_usd + ? END WHERE id = ? AND user_id = ?',
          [delta, delta, ctx.jobId, ctx.tenantId])
      })
      try { await write() } catch {
        try { await write() } catch (e) { captureError(e, { source: 'worker', where: 'scan-spend-cap:settle', tenantId: ctx.tenantId, ref: ctx.jobId }) }
      }
    },
  }
}

export interface ScanSpendRow { spend_cap_usd: number | null; spend_cap_reserved_usd: number; spend_cap_refusals: number }
export async function scanSpendRow(d: DbLike, jobId: string, tenantId: string): Promise<ScanSpendRow | undefined> {
  const r = await asDb(d).get<{ spend_cap_usd: number | string | null; spend_cap_reserved_usd: number | string; spend_cap_refusals: number | string }>(
    'SELECT spend_cap_usd, spend_cap_reserved_usd, spend_cap_refusals FROM scan_jobs WHERE id = ? AND user_id = ?', [jobId, tenantId])
  return r && { spend_cap_usd: r.spend_cap_usd === null ? null : Number(r.spend_cap_usd), spend_cap_reserved_usd: Number(r.spend_cap_reserved_usd), spend_cap_refusals: Number(r.spend_cap_refusals) }
}
export interface ScanSpendCall { id: string; scan_job_id: string; attempt: number; kind: string; reserve_usd: number; actual_usd: number | null; status: string; reason: string | null; created_at: number }
export async function scanSpendCalls(d: DbLike, jobId: string, tenantId: string): Promise<ScanSpendCall[]> {
  const rows = await asDb(d).all<Record<string, unknown>>('SELECT id, scan_job_id, attempt, kind, reserve_usd, actual_usd, status, reason, created_at FROM scan_spend_calls WHERE scan_job_id = ? AND user_id = ? ORDER BY created_at, id', [jobId, tenantId])
  return rows.map(r => ({ id: String(r.id), scan_job_id: String(r.scan_job_id), attempt: Number(r.attempt), kind: String(r.kind), reserve_usd: Number(r.reserve_usd), actual_usd: r.actual_usd === null ? null : Number(r.actual_usd), status: String(r.status), reason: r.reason === null ? null : String(r.reason), created_at: Number(r.created_at) }))
}

// SQLite side (Postgres: lib/db/migrations/pg/0048_scan_spend_cap.sql). Called from migrateScan, after scan_jobs exists.
export function migrateScanSpendCap(db: Database.Database): void {
  const has = (c: string) => (db.prepare('PRAGMA table_info(scan_jobs)').all() as { name: string }[]).some(r => r.name === c)
  if (!has('spend_cap_usd')) db.exec(`ALTER TABLE scan_jobs ADD COLUMN spend_cap_usd REAL CHECK (spend_cap_usd IS NULL OR (spend_cap_usd > 0 AND spend_cap_usd <= ${STORE_CAP_BOUND_USD}))`)
  if (!has('spend_cap_reserved_usd')) db.exec('ALTER TABLE scan_jobs ADD COLUMN spend_cap_reserved_usd REAL NOT NULL DEFAULT 0 CHECK (spend_cap_reserved_usd >= 0)')
  if (!has('spend_cap_refusals')) db.exec('ALTER TABLE scan_jobs ADD COLUMN spend_cap_refusals INTEGER NOT NULL DEFAULT 0')
  db.exec(`
    CREATE TABLE IF NOT EXISTS scan_spend_calls (
      id          TEXT PRIMARY KEY,
      user_id     TEXT NOT NULL,
      scan_job_id TEXT NOT NULL,
      attempt     INTEGER NOT NULL,
      kind        TEXT NOT NULL CHECK (length(kind) <= 32),
      reserve_usd REAL NOT NULL CHECK (reserve_usd >= 0),
      actual_usd  REAL CHECK (actual_usd IS NULL OR actual_usd >= 0),
      status      TEXT NOT NULL CHECK (status IN ('reserved','settled','kept','refused')),
      reason      TEXT CHECK (reason IS NULL OR length(reason) <= 80),
      created_at  INTEGER NOT NULL,
      settled_at  INTEGER
    );
    CREATE INDEX IF NOT EXISTS scan_spend_calls_job ON scan_spend_calls (user_id, scan_job_id);
  `)
}
