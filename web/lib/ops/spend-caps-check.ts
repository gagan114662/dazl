// #846/#847 operator check: proves the four spend caps of THIS deployment (per scan, per account, per day, per month)
// with zero model spend and zero writes to the app's store. For each cap it reports the effective number, where it came
// from (the account's own entry, the deployment setting, or the built-in default) and what the real reservation code
// does at it, run against a throwaway in-memory SQLite store built with the app's own migrations: the same SQL, the
// same transactions and the same refusal reasons a paid call meets. No provider is called and the app's store is never
// opened, so nothing is spent, reserved or written. Served by app/api/internal/spend-caps (operator secret only).
import Database from 'better-sqlite3'
import { migrateAllSqlite } from '../db/sqlite-migrations.ts'
import { sqliteDb } from '../db/client.ts'
import { SpendRefused } from '../llm/spend-guard.ts'
import { accountLimits, CAP_ENV, OWNER_POOL_LIMIT_REASON, ownerLimits, sharedPool, windowCap, type CapValue, type PoolLimits } from '../llm/spend-pool.ts'
import { HARD_CAP_CAD, MIN_FX_CAD_PER_USD, reserveScanSpend, runWithAccountSpend, runWithScanSpend, scanCapConfig } from '../scan/spend-cap.ts'
import { trialFundable } from '../billing/trial-budget.ts'

type Env = Record<string, string | undefined>
// The step tried after a cap is full: any amount above the cap is refused, this one shows it.
const STEP_USD = 0.01
const SYN_A = 'spend-caps-check-a', SYN_B = 'spend-caps-check-b'
const r6 = (n: number) => Math.round(n * 1e6) / 1e6
const outcome = async (f: () => Promise<unknown>): Promise<string> => {
  try { await f(); return 'admitted' } catch (e) { return e instanceof SpendRefused ? `refused:${e.reason}` : `error:${e instanceof Error ? e.message.slice(0, 80) : 'unknown'}` }
}
export const TENANT_ID = /^[A-Za-z0-9_-]{1,64}$/

export interface WindowSim { admitted_usd: number; next: string; would_refuse_at_usd: number | null; spread_over_days?: number }
export interface SpendCapsReport {
  ok: boolean
  problems: string[]
  model_calls: 0
  app_store_opened: false
  simulated_in: string
  checked_at: string
  caps: {
    scan: { usd: number | null; cad: number | null; fx_cad_per_usd: number | null; source: 'env' | 'default' | 'invalid'; env: string[]; ceiling_cad: number; note: string; simulation: WindowSim }
    account: { tenant: string; given: boolean; path: 'pooled_guard' | 'transport'; day: CapValue; month: CapValue; simulation: { filled_usd: number; next_same_account: string; other_account: string } }
    day: CapValue & { ceiling_usd: number; simulation: WindowSim }
    month: CapValue & { ceiling_usd: number; simulation: WindowSim }
  }
  trial_funded: boolean
}

export async function spendCapsCheck(env: Env = process.env, opts: { tenant?: string | null; nowS?: number } = {}): Promise<SpendCapsReport> {
  const raw = new Database(':memory:')
  try {
    migrateAllSqlite(raw)
    const db = sqliteDb(raw)
    const now = opts.nowS ?? Math.floor(Date.now() / 1000)
    const clock = () => now
    // The transport path: what a model call of an account without its own entry meets (reserveScanSpend outside a scan).
    const viaTransport = (tenant: string, limits: PoolLimits, usd: number, atS = now) =>
      outcome(() => runWithAccountSpend({ db, tenantId: tenant, limits, clock: () => atS }, () => reserveScanSpend('llm.anthropic', () => usd)))

    // Per scan: the hard per-scan cap on the scan's own job row (lib/scan/spend-cap.ts).
    const cfg = scanCapConfig(env)
    const set = (k: string) => env[k] !== undefined && env[k] !== ''
    raw.prepare("INSERT INTO scan_jobs (id, user_id, business_name, industry, location, status, attempts) VALUES ('check-scan', ?, 'check', 'check', 'check', 'running', 1)").run(SYN_A)
    const scanCtx = { db, jobId: 'check-scan', tenantId: SYN_A, attempt: 1, cap: cfg, accountLimits: null, clock }
    let scanSim: WindowSim
    if (cfg.ok) {
      const first = await runWithScanSpend(scanCtx, () => outcome(() => reserveScanSpend('llm.anthropic', () => cfg.capUsd)))
      const next = await runWithScanSpend(scanCtx, () => outcome(() => reserveScanSpend('llm.anthropic', () => STEP_USD)))
      scanSim = { admitted_usd: first === 'admitted' ? r6(cfg.capUsd) : 0, next, would_refuse_at_usd: r6(cfg.capUsd) }
    } else {
      const next = await runWithScanSpend(scanCtx, () => outcome(() => reserveScanSpend('llm.anthropic', () => STEP_USD)))
      scanSim = { admitted_usd: 0, next, would_refuse_at_usd: 0 }
    }
    const scan = {
      usd: cfg.ok ? r6(cfg.capUsd) : null, cad: cfg.ok ? cfg.capCad : null, fx_cad_per_usd: cfg.ok ? cfg.fxCadPerUsd : null,
      source: (!cfg.ok ? 'invalid' : set('DAZL_SCAN_CAP_CAD') || set('DAZL_SCAN_CAP_FX_CAD_PER_USD') ? 'env' : 'default') as 'env' | 'default' | 'invalid',
      env: ['DAZL_SCAN_CAP_CAD', 'DAZL_SCAN_CAP_FX_CAD_PER_USD'], ceiling_cad: HARD_CAP_CAD,
      note: cfg.ok
        ? `CAD ${cfg.capCad} at ${cfg.fxCadPerUsd} CAD per USD; a higher CAD or a lower FX setting is clamped (ceiling CAD ${HARD_CAP_CAD}, FX floor ${MIN_FX_CAD_PER_USD}). A scan's own run budget can only lower it.`
        : 'A setting is malformed (0, negative, text): every paid call of every scan is refused until it is fixed (fails closed).',
      simulation: scanSim,
    }

    // Per day and per month: each window alone, on the transport path (every account without its own entry).
    const dayCap = windowCap('day', null, env), monthCap = windowCap('month', null, env)
    const dFirst = await viaTransport(SYN_A, { day: dayCap.usd }, dayCap.usd)
    const dNext = await viaTransport(SYN_A, { day: dayCap.usd }, STEP_USD)
    const day = { ...dayCap, ceiling_usd: CAP_ENV.day.ceiling, simulation: { admitted_usd: dFirst === 'admitted' ? dayCap.usd : 0, next: dNext, would_refuse_at_usd: dayCap.usd } }
    // The month spread over two days of the same month (the 1st and 2nd at noon UTC), then one more step on the 3rd.
    const month0 = new Date(now * 1000), at = (d: number) => Date.UTC(month0.getUTCFullYear(), month0.getUTCMonth(), d, 12) / 1000
    const half = monthCap.usd / 2
    const m1 = await viaTransport(SYN_B, { month: monthCap.usd }, half, at(1))
    const m2 = await viaTransport(SYN_B, { month: monthCap.usd }, monthCap.usd - half, at(2))
    const mNext = await viaTransport(SYN_B, { month: monthCap.usd }, STEP_USD, at(3))
    const month = { ...monthCap, ceiling_usd: CAP_ENV.month.ceiling, simulation: { admitted_usd: r6((m1 === 'admitted' ? half : 0) + (m2 === 'admitted' ? monthCap.usd - half : 0)), spread_over_days: 2, next: mNext, would_refuse_at_usd: monthCap.usd } }

    // Per account: the caps that apply to one account (the given tenant id, else a synthetic one), on the path that
    // account really takes, and isolation: that account full does not stop another account.
    const given = typeof opts.tenant === 'string' && TENANT_ID.test(opts.tenant)
    const tenant = given ? opts.tenant! : SYN_A
    const named = ownerLimits(tenant, env) !== null
    const lim = accountLimits(tenant, env)
    const fill = Math.min(lim.day, lim.month)
    const one = 'spend-caps-check-account', other = 'spend-caps-check-other'
    // A named account's PooledGuard reports a pool refusal as owner_pool_limit (spend-guard.ts PooledGuard label): same here.
    const reserveAs = async (id: string, usd: number) => named
      ? (await outcome(() => sharedPool(db, id, lim, clock, 0).reserve(usd))).replace(/^refused:over_limit$/, `refused:${OWNER_POOL_LIMIT_REASON}`)
      : viaTransport(id, lim, usd)
    await reserveAs(one, fill)
    const account = {
      tenant, given, path: (named ? 'pooled_guard' : 'transport') as 'pooled_guard' | 'transport',
      day: windowCap('day', tenant, env), month: windowCap('month', tenant, env),
      simulation: { filled_usd: fill, next_same_account: await reserveAs(one, STEP_USD), other_account: await reserveAs(other, STEP_USD) },
    }
    // Settings that are present but not usable: never unlimited (the next source applied, or the scan cap refuses
    // everything), but the operator should fix them.
    const problems = [...new Set([
      ...(cfg.ok ? [] : ['DAZL_SCAN_CAP_CAD / DAZL_SCAN_CAP_FX_CAD_PER_USD is malformed: every paid scan call is refused']),
      ...[day, month, account.day, account.month].flatMap(c => c.ignored.map(k => `${k} is not a positive number: ignored, the next source applies`)),
    ])]
    const refused = (o: string) => o.startsWith('refused:')
    return {
      ok: problems.length === 0 && refused(scanSim.next) && refused(day.simulation.next) && refused(month.simulation.next)
        && refused(account.simulation.next_same_account) && account.simulation.other_account === 'admitted',
      problems,
      model_calls: 0, app_store_opened: false, simulated_in: 'a throwaway in-memory SQLite store with the app migrations (discarded after the check)',
      checked_at: new Date(now * 1000).toISOString(),
      caps: { scan, account, day, month },
      trial_funded: trialFundable(env as NodeJS.ProcessEnv),
    }
  } finally { raw.close() }
}
