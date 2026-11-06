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
import { randomBytes } from 'node:crypto'
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
// One lock per tenant+provider serializes every set / lower / clear against every reserve (a wallet-bearing limit must be
// decided in commit order, including unset -> set, where no limit row exists to lock). SQLite: the transaction is already
// exclusive. Postgres: a transaction-scoped advisory lock keyed on the pair; a hash collision only serializes two unrelated
// pairs for a moment, it can never admit or refuse wrongly.
export const creditLockKey = (tenantId: string, p: CreditProvider) => `credit:${tenantId}:${p}`
function* lockPair(t: Tx, tenantId: string, p: CreditProvider): TxBody<void> {
  if (t.kind === 'pg') yield* t.get('SELECT pg_advisory_xact_lock(hashtext(?)) AS locked', [creditLockKey(tenantId, p)])
}
export async function setCreditLimit(d: DbLike, tenantId: string, p: CreditProvider, w: 'day' | 'month', limit: number | null): Promise<void> {
  if (limit !== null && !(Number.isInteger(limit) && limit > 0 && limit <= 1_000_000)) throw new Error('credit limit must be a whole number from 1 to 1000000, or null to clear')
  const period = limitPeriod(p, w), at = Math.floor(Date.now() / 1000)
  await asDb(d).tx(function* (t: Tx): TxBody<void> {
    yield* lockPair(t, tenantId, p)
    if (limit === null) { yield* t.run('DELETE FROM tenant_spend_pools WHERE tenant_id = ? AND period = ?', [tenantId, period]); return }
    yield* t.run('INSERT INTO tenant_spend_pools (tenant_id, period, reserved_usd, reported_usd, calls, updated_at) VALUES (?, ?, ?, 0, 0, ?) ON CONFLICT (tenant_id, period) DO UPDATE SET reserved_usd = excluded.reserved_usd, updated_at = excluded.updated_at', [tenantId, period, limit, at])
  })
}

export function creditPeriod(p: CreditProvider, w: 'day' | 'month', nowS: number): string {
  const iso = new Date(nowS * 1000).toISOString()
  return `c${p === 'apollo' ? 'a' : 'p'}${w === 'day' ? 'd' : 'm'}:${w === 'day' ? iso.slice(0, 10).replace(/-/g, '') : iso.slice(0, 7).replace('-', '')}`
}

// What the refused window looked like when it refused: credits already counted against it, its limit, and what the lookup asked for.
export interface CreditRefusal { window: 'day' | 'month'; used: number; limit: number; requested: number }
// The audit row for a refusal stores these numbers (no company text) so the scan view reports the moment of refusal, not a later re-read.
export const refusalLookup = (r: CreditRefusal): string => `credit ${JSON.stringify(r)}`
export function parseRefusalLookup(lookup: string): CreditRefusal | null {
  if (!lookup.startsWith('credit {')) return null
  try {
    const o = JSON.parse(lookup.slice(7)) as Record<string, unknown>
    const ok = (o.window === 'day' || o.window === 'month') && [o.used, o.limit, o.requested].every(n => typeof n === 'number' && Number.isFinite(n) && n >= 0)
    return ok ? { window: o.window as 'day' | 'month', used: o.used as number, limit: o.limit as number, requested: o.requested as number } : null
  } catch { return null }
}
export class CreditRefused extends Error {
  reason: 'credit_cap' | 'credit_reservation_not_saved'
  window?: 'day' | 'month' // the window that did not fit (credit_cap only)
  detail?: CreditRefusal // the numbers at the moment of refusal (credit_cap only)
  constructor(reason: CreditRefused['reason'], window?: 'day' | 'month', detail?: CreditRefusal) { super(`credit_refused:${reason}`); this.reason = reason; this.window = window; this.detail = detail }
}
export const creditRefused = (e: unknown): e is CreditRefused => e instanceof CreditRefused

// id names the durable hold row (period 'ch:<id>', the same marker-row pattern as the LLM pool's 'p:' markers): inserted in
// the reserving transaction, DELETED in the settling/refunding one. A settle or refund moves exactly the units that row
// records, at most once - a cloned, replayed or concurrent second release finds no row and throws. A hold lost in a crash
// keeps its row and its reservation: an over-count, never a release.
export interface CreditHold { tenantId: string; provider: CreditProvider; units: number; at: number; open: boolean; id: string }
const holdPeriod = (id: string) => `ch:${id}`

// A hold whose own window (its reported_usd, the epoch second it was reserved at) has rolled past both the current day
// and month window is abandoned: nobody still holding that id has a window left to settle or refund into, since the
// counters for that window are frozen in the past regardless. Its 'ch:' marker row is pruned here, under the same
// per-tenant+provider lock a new reservation already holds, so row count stays bounded by live + still-current-window
// holds. This never touches the day/month counter rows: what was reserved/charged in a rolled-over window stays exactly
// as it was (review of #594, F3).
function* pruneStaleHolds(t: Tx, tenantId: string, provider: CreditProvider, at: number): TxBody<void> {
  const curDay = creditPeriod(provider, 'day', at), curMonth = creditPeriod(provider, 'month', at)
  const rows = yield* t.all<{ period: string; reported_usd: number }>('SELECT period, reported_usd FROM tenant_spend_pools WHERE tenant_id = ? AND period LIKE ? AND calls = ?', [tenantId, 'ch:%', provider === 'pdl' ? 1 : 0])
  for (const row of rows) {
    const heldAt = Number(row.reported_usd)
    if (creditPeriod(provider, 'day', heldAt) === curDay || creditPeriod(provider, 'month', heldAt) === curMonth) continue
    yield* t.run('DELETE FROM tenant_spend_pools WHERE tenant_id = ? AND period = ?', [tenantId, row.period])
  }
}

async function reserveOnce(id: string, d: DbLike, tenantId: string, provider: CreditProvider, units: number, opts: { env?: Env; now?: number; /** test seam: force the hold id (collision test) */ holdId?: string; /** test seam: runs after the limit decision inputs are read, before the reservation commits */ beforeReserve?: () => Promise<void> } = {}): Promise<CreditHold> {
  if (!(Number.isInteger(units) && units > 0)) throw new Error('credit reservation must be a positive whole number')
  const at = opts.now ?? Math.floor(Date.now() / 1000)
  // The limit is decided INSIDE the reserving statement, never from an earlier read: a tenant limit row (set, lowered,
  // raised or cleared by a concurrent save) is compared in the same UPDATE that raises the window, so a stale read
  // cannot admit a reservation past a newer limit. Operator env is the fallback per window; neither = unenforced.
  const op = operatorCreditLimits(provider, opts.env)
  await opts.beforeReserve?.()
  try {
    await asDb(d).tx(function* (t: Tx): TxBody<void> {
      yield* lockPair(t, tenantId, provider)
      yield* pruneStaleHolds(t, tenantId, provider, at)
      for (const w of ['day', 'month'] as const) {
        const period = creditPeriod(provider, w, at)
        yield* t.run('INSERT INTO tenant_spend_pools (tenant_id, period, reserved_usd, reported_usd, calls, updated_at) VALUES (?, ?, 0, 0, 0, ?) ON CONFLICT (tenant_id, period) DO NOTHING', [tenantId, period, at])
        const own = yield* t.get<{ reserved_usd: number }>('SELECT reserved_usd FROM tenant_spend_pools WHERE tenant_id = ? AND period = ?', [tenantId, limitPeriod(provider, w)])
        const limit = posInt(own?.reserved_usd) ?? op[w]
        // Unset limit: count the usage, enforce nothing. Set limit: raise only WHERE it still fits.
        const r = limit === null
          ? yield* t.run('UPDATE tenant_spend_pools SET reserved_usd = reserved_usd + ?, calls = calls + 1, updated_at = ? WHERE tenant_id = ? AND period = ?', [units, at, tenantId, period])
          : yield* t.run('UPDATE tenant_spend_pools SET reserved_usd = reserved_usd + ?, calls = calls + 1, updated_at = ? WHERE tenant_id = ? AND period = ? AND reserved_usd + ? <= COALESCE((SELECT reserved_usd FROM tenant_spend_pools WHERE tenant_id = ? AND period = ?), ?)', [units, at, tenantId, period, units, tenantId, limitPeriod(provider, w), limit])
        // A window that does not fit rolls back every window already raised.
        if (r.changes !== 1) {
          const cur = yield* t.get<{ reserved_usd: number }>('SELECT reserved_usd FROM tenant_spend_pools WHERE tenant_id = ? AND period = ?', [tenantId, period])
          throw new CreditRefused('credit_cap', w, { window: w, used: Number(cur?.reserved_usd ?? 0), limit: limit!, requested: units })
        }
      }
      yield* t.run('INSERT INTO tenant_spend_pools (tenant_id, period, reserved_usd, reported_usd, calls, updated_at) VALUES (?, ?, ?, ?, ?, ?)', [tenantId, holdPeriod(id), units, at, provider === 'pdl' ? 1 : 0, at])
    })
  } catch (e) {
    if (e instanceof CreditRefused) throw e
    throw new CreditRefused('credit_reservation_not_saved')
  }
  return { tenantId, provider, units, at, open: true, id }
}

// period is capped at 12 chars: 'ch:' + 9 base-36 chars (~46 bits). A primary-key collision fails the unique INSERT, which rolls
// the whole reservation back; a bounded retry picks a fresh id, then the reservation is refused (fail closed). Never overwrites.
const newHoldId = () => Array.from(randomBytes(9), b => (b % 36).toString(36)).join('') // 36^9 ids; the modulo bias is irrelevant for uniqueness
export async function reserveCredits(d: DbLike, tenantId: string, provider: CreditProvider, units: number, opts: Parameters<typeof reserveOnce>[5] = {}): Promise<CreditHold> {
  if (opts.holdId) return reserveOnce(opts.holdId, d, tenantId, provider, units, opts)
  let last: unknown
  for (let attempt = 0; attempt < 3; attempt++) {
    try { return await reserveOnce(newHoldId(), d, tenantId, provider, units, opts) } catch (e) {
      if (!(e instanceof CreditRefused) || e.reason !== 'credit_reservation_not_saved') throw e // a cap refusal is final, only an unsaved reservation retries
      last = e
    }
  }
  throw last
}

async function move(d: DbLike, h: CreditHold, charged: number | 'refund'): Promise<void> {
  if (!h.open) throw new Error('credit hold already settled')
  const nowS = Math.floor(Date.now() / 1000)
  await asDb(d).tx(function* (t: Tx): TxBody<void> {
    // The durable hold row is the single source of truth for what this hold is worth and whether it is still open.
    // The row, not the object, decides units, provider and the ORIGINAL window time: reserved_usd = units, reported_usd = the
    // reservation's epoch second (its day/month windows), calls = provider (0 apollo, 1 pdl). A tampered or stale object
    // cannot move another amount, another provider's pool or another month's window.
    const row = yield* t.get<{ reserved_usd: number; reported_usd: number; calls: number }>('SELECT reserved_usd, reported_usd, calls FROM tenant_spend_pools WHERE tenant_id = ? AND period = ?', [h.tenantId, holdPeriod(h.id)])
    if (!row) throw new Error('credit hold already settled')
    yield* lockPair(t, h.tenantId, Number(row.calls) === 1 ? 'pdl' : 'apollo') // the row's provider, never the object's
    if ((yield* t.run('DELETE FROM tenant_spend_pools WHERE tenant_id = ? AND period = ?', [h.tenantId, holdPeriod(h.id)])).changes !== 1) throw new Error('credit hold already settled')
    const units = Number(row.reserved_usd), at = Number(row.reported_usd), prov: CreditProvider = Number(row.calls) === 1 ? 'pdl' : 'apollo'
    const reported = charged === 'refund' ? 0 : charged
    const delta = (charged === 'refund' ? 0 : charged) - units
    for (const w of ['day', 'month'] as const) {
      const r = yield* t.run('UPDATE tenant_spend_pools SET reserved_usd = CASE WHEN reserved_usd + ? < 0 THEN 0 ELSE reserved_usd + ? END, reported_usd = reported_usd + ?, updated_at = ? WHERE tenant_id = ? AND period = ?',
        [delta, delta, reported, nowS, h.tenantId, creditPeriod(prov, w, at)])
      if (r.changes !== 1) throw new Error('credit pool settle: window row missing')
    }
  })
  h.open = false
}
// The call answered and its charge is known: the reservation moves to exactly that many credits.
export async function settleCredits(d: DbLike, h: CreditHold, charged: number): Promise<void> {
  if (!(Number.isInteger(charged) && charged >= 0)) throw new Error('credit settle: charged must be a whole number >= 0')
  await move(d, h, charged)
}
// The call was provably never made: the whole reservation is released.
export async function refundCredits(d: DbLike, h: CreditHold): Promise<void> { await move(d, h, 'refund') }

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
