// Durable, tenant-scoped verdict records and the verifier's own daily budget (docs/design/evidence-verifier.md). The
// budget is the evaluator's alone: it is counted from this table, never from the scan's spend, trial or credit ledgers,
// and the scan never draws on it. A run reserves its whole per-run cap inside one serializable transaction before it
// fetches anything, so concurrent runs cannot together pass the tenant's daily cap; the reservation is replaced by the
// actual spend when the run completes. A run that never completes (a crashed process) keeps its reservation for that
// day: budget is never handed back on a guess.
import type { Db } from '../db/client.ts'
import type { Action, Verdict } from './checks.ts'
import type { VerdictRecord } from './service.ts'

export interface DailyCaps { dailyRuns: number; dailyUsd: number }
export const toMicros = (usd: number) => Math.ceil(usd * 1_000_000)

export type Reservation = { ok: true } | { ok: false; reason: string }
type ReserveArgs = { tenantId: string; runId: string; claimHash: string; verifierVersion: string; day: string; reserveUsd: number; caps: DailyCaps; now: number }
const RESERVE_ATTEMPTS = 4
// The driver's SQLSTATE, on the error or (inside a transaction) on its cause chain.
function isSerializationFailure(e: unknown): boolean {
  for (let x = e, depth = 0; x && typeof x === 'object' && depth < 5; depth++) {
    const v = x as { code?: unknown; cause?: unknown }
    if (v.code === '40001' || v.code === '40P01') return true
    x = v.cause
  }
  return false
}

// On Postgres two concurrent reservations of one tenant conflict and one is rolled back by SERIALIZABLE; it is retried a
// bounded number of times, then the run is refused (held), never let through unreserved.
export async function reserveRun(db: Db, o: ReserveArgs): Promise<Reservation> {
  for (let attempt = 1; ; attempt++) {
    try { return await reserveOnce(db, o) } catch (e) {
      if (!isSerializationFailure(e)) throw e
      if (attempt >= RESERVE_ATTEMPTS) return { ok: false, reason: `evaluator budget busy: ${RESERVE_ATTEMPTS} conflicting reservations in a row` }
    }
  }
}

function reserveOnce(db: Db, o: ReserveArgs): Promise<Reservation> {
  const reserve = toMicros(o.reserveUsd)
  return db.tx(function* (t) {
    const row = yield* t.get<{ n: number | string; used: number | string | null }>(
      `SELECT count(*) AS n, COALESCE(SUM(CASE WHEN state = 'running' THEN reserved_micros ELSE spent_micros END), 0) AS used
         FROM evidence_verdicts WHERE tenant_id = ? AND day = ?`, [o.tenantId, o.day])
    const n = Number(row?.n ?? 0), used = Number(row?.used ?? 0)
    if (n + 1 > o.caps.dailyRuns) return { ok: false as const, reason: `evaluator daily run cap reached (${n} of ${o.caps.dailyRuns} runs on ${o.day})` }
    if (used + reserve > toMicros(o.caps.dailyUsd)) return { ok: false as const, reason: `evaluator daily budget reached ($${(used / 1e6).toFixed(4)} of $${o.caps.dailyUsd} used on ${o.day}; a run reserves $${o.reserveUsd})` }
    yield* t.run(`INSERT INTO evidence_verdicts (id, tenant_id, claim_hash, verifier_version, state, day, reserved_micros, created_at)
                  VALUES (?, ?, ?, ?, 'running', ?, ?, ?)`, [o.runId, o.tenantId, o.claimHash, o.verifierVersion, o.day, reserve, o.now])
    return { ok: true as const }
  }, 'serializable')
}

export async function completeRun(db: Db, rec: VerdictRecord, now: number): Promise<void> {
  const res = await db.run(`UPDATE evidence_verdicts SET state = 'done', verdict = ?, action = ?, spent_micros = ?, finished_at = ?, record = ?
                             WHERE id = ? AND tenant_id = ? AND state = 'running'`,
  [rec.verdict, rec.action, toMicros(rec.budget.cost_usd), now, JSON.stringify(rec), rec.run_id, rec.tenant_id])
  if (res.changes !== 1) throw new Error(`evidence verdict ${rec.run_id} is not a running run of this tenant`)
}

export interface StoredVerdict { id: string; claim_hash: string; verifier_version: string; state: 'running' | 'done'; verdict: Verdict | null; action: Action | null; day: string; created_at: number; record: VerdictRecord | null }
type Row = Omit<StoredVerdict, 'record' | 'created_at'> & { created_at: number | string; record: string | null }
const parse = (r: Row): StoredVerdict => ({ ...r, created_at: Number(r.created_at), record: r.record ? JSON.parse(r.record) as VerdictRecord : null })
const COLS = 'id, claim_hash, verifier_version, state, verdict, action, day, created_at, record'

// Reads are always one tenant's own rows.
export async function getVerdict(db: Db, tenantId: string, runId: string): Promise<StoredVerdict | null> {
  const r = await db.get<Row>(`SELECT ${COLS} FROM evidence_verdicts WHERE tenant_id = ? AND id = ?`, [tenantId, runId])
  return r ? parse(r) : null
}
export async function listVerdicts(db: Db, tenantId: string, o: { claimHash?: string; limit?: number } = {}): Promise<StoredVerdict[]> {
  const limit = Math.min(Math.max(1, Math.floor(o.limit ?? 50)), 500)
  const rows = o.claimHash
    ? await db.all<Row>(`SELECT ${COLS} FROM evidence_verdicts WHERE tenant_id = ? AND claim_hash = ? ORDER BY created_at DESC, id LIMIT ?`, [tenantId, o.claimHash, limit])
    : await db.all<Row>(`SELECT ${COLS} FROM evidence_verdicts WHERE tenant_id = ? ORDER BY created_at DESC, id LIMIT ?`, [tenantId, limit])
  return rows.map(parse)
}
