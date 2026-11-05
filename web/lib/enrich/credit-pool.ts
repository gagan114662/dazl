// Workspace credit pools for BYOK enrichment providers (#363): Apollo organization lookups (1 credit each) and People
// Data Labs person searches (1 credit per profile returned). Dollar pricing for these depends on the tenant's own plan
// with the vendor, so the hard limit here is an explicit COUNT of credits, per tenant, per UTC day and per UTC month.
//
// The per-scan caps in lib/enrich/index.ts and lib/scan/commenter-import.ts bound one pass. This pool bounds the
// workspace across passes, jobs, retries, restarts and instances: it lives in the shared store (tenant_spend_pools,
// the same table and the same atomic "raise only WHERE it still fits" update as the owner LLM pool in
// lib/llm/spend-pool.ts), keyed by the tenant and a credit period. Credit periods never collide with the LLM pool's:
//   'ca' / 'cp' + 'd:YYYYMMDD' or 'm:YYYYMM'  (Apollo / PDL; day / month), e.g. 'cad:20261102', 'cpm:202611'.
// On these rows the generic amount columns hold CREDITS, not dollars:
//   reserved_usd - credits reserved before calls plus credits settled after them (what the limit is checked against)
//   reported_usd - credits the vendor's own response proved were charged (PDL: profiles returned; Apollo: 1 per lookup
//                  that answered), never an estimate
//   calls        - reservations admitted
//
// Contract:
//  1. reserveCredits before the paid call. It refuses (CreditRefused, no call) when either window would pass its limit,
//     and also when the store cannot save the reservation (fail closed: an unsaved reservation would be lost on restart).
//  2. settleCredits after a call whose charge is known moves the reservation to that charge (a PDL search that returned
//     2 of 5 profiles releases 3). Credits already charged are recorded even past the limit.
//  3. refundCredits only when the call provably was not made (a replayed claim, a refusal before the request).
//  4. A call that failed or whose charge is unknown keeps its full reservation (the vendor may have billed it).
// Apollo's people search (mixed_people/api_search) is documented as 0 credits and reserves nothing here; its per-scan
// call cap is unchanged.
import { asDb, type DbLike, type Tx, type TxBody } from '../db/client.ts'

export type CreditProvider = 'apollo' | 'pdl'
export interface CreditLimits { day: number; month: number }
type Env = Record<string, string | undefined>

// NO built-in limits. A default cap would tighten an existing paid service for every tenant, and no owner decision sets
// one (review of #594). Precedence, per provider and window: (1) the tenant's own saved limit (setCreditLimit, Settings >
// Enrichment), (2) an operator-wide DAZL_<APOLLO|PDL>_CREDITS_<DAY|MONTH> (a positive whole number; anything else is
// ignored, never "unlimited" by typo), (3) UNSET = this pool enforces nothing for that window and the per-scan caps in
// lib/enrich/index.ts remain the only bound. Usage is counted either way so Settings can show it.
// A tenant's limit lives in tenant_spend_pools too (no migration): period 'cl' + a|p + d|m, reserved_usd = the limit.
export type CreditCaps = { day: number | null; month: number | null; source: { day: 'tenant' | 'operator' | null; month: 'tenant' | 'operator' | null } }
const posInt = (v: unknown): number | null => { const n = Number(v); return v != null && v !== '' && Number.isInteger(n) && n > 0 ? n : null }
const limitPeriod = (p: CreditProvider, w: 'day' | 'month') => `cl${p === 'apollo' ? 'a' : 'p'}${w === 'day' ? 'd' : 'm'}`
export function operatorCreditLimits(p: CreditProvider, env: Env = process.env): { day: number | null; month: number | null } {
  return { day: posInt(env[`DAZL_${p.toUpperCase()}_CREDITS_DAY`]), month: posInt(env[`DAZL_${p.toUpperCase()}_CREDITS_MONTH`]) }
}
export async function creditLimits(d: DbLike, tenantId: string, p: CreditProvider, env: Env = process.env): Promise<CreditCaps> {
  const op = operatorCreditLimits(p, env)
  const out: CreditCaps = { day: null, month: null, source: { day: null, month: null } }
  for (const w of ['day', 'month'] as const) {
    const r = await asDb(d).get<{ reserved_usd: number }>('SELECT reserved_usd FROM tenant_spend_pools WHERE tenant_id = ? AND period = ?', [tenantId, limitPeriod(p, w)])
    const own = posInt(r?.reserved_usd)
    out[w] = own ?? op[w]; out.source[w] = own != null ? 'tenant' : op[w] != null ? 'operator' : null
  }
  return out
}
// Save (positive whole number) or clear (null) the tenant's own limit for one window.
export async function setCreditLimit(d: DbLike, tenantId: string, p: CreditProvider, w: 'day' | 'month', limit: number | null): Promise<void> {
  if (limit !== null && !(Number.isInteger(limit) && limit > 0 && limit <= 1_000_000)) throw new Error('credit limit must be a whole number from 1 to 1000000, or null to clear')
  const period = limitPeriod(p, w), at = Math.floor(Date.now() / 1000)
  if (limit === null) { await asDb(d).run('DELETE FROM tenant_spend_pools WHERE tenant_id = ? AND period = ?', [tenantId, period]); return }
  await asDb(d).run('INSERT INTO tenant_spend_pools (tenant_id, period, reserved_usd, reported_usd, calls, updated_at) VALUES (?, ?, ?, 0, 0, ?) ON CONFLICT (tenant_id, period) DO UPDATE SET reserved_usd = excluded.reserved_usd, updated_at = excluded.updated_at', [tenantId, period, limit, at])
}

export function creditPeriod(p: CreditProvider, w: 'day' | 'month', nowS: number): string {
  const iso = new Date(nowS * 1000).toISOString()
  return `c${p === 'apollo' ? 'a' : 'p'}${w === 'day' ? 'd' : 'm'}:${w === 'day' ? iso.slice(0, 10).replace(/-/g, '') : iso.slice(0, 7).replace('-', '')}`
}

export class CreditRefused extends Error {
  reason: 'credit_cap' | 'credit_reservation_not_saved'
  window?: 'day' | 'month' // the window that did not fit (credit_cap only)
  constructor(reason: CreditRefused['reason'], window?: 'day' | 'month') { super(`credit_refused:${reason}`); this.reason = reason; this.window = window }
}
export const creditRefused = (e: unknown): e is CreditRefused => e instanceof CreditRefused

export interface CreditHold { tenantId: string; provider: CreditProvider; units: number; at: number; open: boolean }

export async function reserveCredits(d: DbLike, tenantId: string, provider: CreditProvider, units: number, opts: { env?: Env; now?: number } = {}): Promise<CreditHold> {
  if (!(Number.isInteger(units) && units > 0)) throw new Error('credit reservation must be a positive whole number')
  const at = opts.now ?? Math.floor(Date.now() / 1000)
  let L: CreditCaps
  try { L = await creditLimits(d, tenantId, provider, opts.env) } catch { throw new CreditRefused('credit_reservation_not_saved') }
  try {
    await asDb(d).tx(function* (t: Tx): TxBody<void> {
      for (const [w, limit] of [['day', L.day], ['month', L.month]] as const) {
        const period = creditPeriod(provider, w, at)
        yield* t.run('INSERT INTO tenant_spend_pools (tenant_id, period, reserved_usd, reported_usd, calls, updated_at) VALUES (?, ?, 0, 0, 0, ?) ON CONFLICT (tenant_id, period) DO NOTHING', [tenantId, period, at])
        // Unset limit: count the usage, enforce nothing. Set limit: raise only WHERE it still fits.
        const r = limit === null
          ? yield* t.run('UPDATE tenant_spend_pools SET reserved_usd = reserved_usd + ?, calls = calls + 1, updated_at = ? WHERE tenant_id = ? AND period = ?', [units, at, tenantId, period])
          : yield* t.run('UPDATE tenant_spend_pools SET reserved_usd = reserved_usd + ?, calls = calls + 1, updated_at = ? WHERE tenant_id = ? AND period = ? AND reserved_usd + ? <= ?', [units, at, tenantId, period, units, limit])
        // A window that does not fit rolls back every window already raised.
        if (r.changes !== 1) throw new CreditRefused('credit_cap', w)
      }
    })
  } catch (e) {
    if (e instanceof CreditRefused) throw e
    throw new CreditRefused('credit_reservation_not_saved')
  }
  return { tenantId, provider, units, at, open: true }
}

async function move(d: DbLike, h: CreditHold, delta: number, charged: number): Promise<void> {
  if (!h.open) throw new Error('credit hold already settled')
  if (delta !== 0 || charged !== 0) {
    const nowS = Math.floor(Date.now() / 1000)
    await asDb(d).tx(function* (t: Tx): TxBody<void> {
      for (const w of ['day', 'month'] as const) {
        const r = yield* t.run('UPDATE tenant_spend_pools SET reserved_usd = CASE WHEN reserved_usd + ? < 0 THEN 0 ELSE reserved_usd + ? END, reported_usd = reported_usd + ?, updated_at = ? WHERE tenant_id = ? AND period = ?',
          [delta, delta, charged, nowS, h.tenantId, creditPeriod(h.provider, w, h.at)])
        if (r.changes !== 1) throw new Error('credit pool settle: window row missing')
      }
    })
  }
  h.open = false
}
// The call answered and its charge is known: the reservation moves to exactly that many credits.
export async function settleCredits(d: DbLike, h: CreditHold, charged: number): Promise<void> {
  if (!(Number.isInteger(charged) && charged >= 0)) throw new Error('credit settle: charged must be a whole number >= 0')
  await move(d, h, charged - h.units, charged)
}
// The call was provably never made: the whole reservation is released.
export async function refundCredits(d: DbLike, h: CreditHold): Promise<void> { await move(d, h, -h.units, 0) }

export interface CreditUse { provider: CreditProvider; window: 'day' | 'month'; period: string; reserved: number; charged: number; limit: number | null; source: 'tenant' | 'operator' | null }
// What the tenant has reserved and been charged in the current windows, with the limits (for disclosure and tests).
export async function creditUse(d: DbLike, tenantId: string, opts: { env?: Env; now?: number } = {}): Promise<CreditUse[]> {
  const now = opts.now ?? Math.floor(Date.now() / 1000)
  const out: CreditUse[] = []
  for (const provider of ['apollo', 'pdl'] as const) {
    const L = await creditLimits(d, tenantId, provider, opts.env)
    for (const w of ['day', 'month'] as const) {
      const period = creditPeriod(provider, w, now)
      const r = await asDb(d).get<{ reserved_usd: number; reported_usd: number }>('SELECT reserved_usd, reported_usd FROM tenant_spend_pools WHERE tenant_id = ? AND period = ?', [tenantId, period])
      out.push({ provider, window: w, period, reserved: Number(r?.reserved_usd ?? 0), charged: Number(r?.reported_usd ?? 0), limit: L[w], source: L.source[w] })
    }
  }
  return out
}
