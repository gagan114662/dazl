// Native search permissions use the scan's canonical identity and ownership fence.
// Unknown requests keep their whole allowance; only a verified response releases unused searches.
import { randomUUID } from 'node:crypto'
import { asDb, type Tx, type TxBody } from '../db/client.ts'
import type { ScanSpendCtx } from '../scan/spend-cap.ts'
import type { SearchBudget, SearchReservation } from './search-budget.ts'

type Entry = { allowance: number; used: number | null }
function count(entries: Entry[]): number {
  let total = 0
  for (const entry of entries) {
    if (!Number.isSafeInteger(entry.allowance) || entry.allowance < 0 || entry.allowance > 15 ||
      (entry.used !== null && (!Number.isSafeInteger(entry.used) || entry.used < 0 || entry.used > entry.allowance))) {
      throw new Error('Native search counter is invalid')
    }
    total += entry.used ?? entry.allowance
  }
  if (total > 15) throw new Error('Native search counter is invalid')
  return total
}
export function persistedSearchBudget(ctx: ScanSpendCtx, ceiling: number): SearchBudget {
  const db = asDb(ctx.db)
  const lock = function* (t: Tx): TxBody<void> {
    const r = yield* t.run(`UPDATE scan_jobs SET claimed_at = claimed_at
      WHERE id = ? AND user_id = ? AND attempts = ? AND status = 'running'`,
    [ctx.jobId, ctx.tenantId, ctx.attempt])
    if (r.changes !== 1) throw new Error('Native search ownership lost')
  }
  return {
    async reserve(requested): Promise<SearchReservation> {
      const id = randomUUID()
      const allowance = await db.tx(function* (t: Tx): TxBody<number> {
        yield* lock(t)
        const entries = yield* t.all<Entry>('SELECT allowance, used FROM scan_native_search_calls WHERE scan_job_id = ? AND user_id = ?', [ctx.jobId, ctx.tenantId])
        const available = Math.max(0, ceiling - count(entries))
        const amount = Math.min(requested, available)
        if (amount > 0) yield* t.run(`INSERT INTO scan_native_search_calls
          (id,user_id,scan_job_id,attempt,allowance,used) VALUES (?,?,?,?,?,NULL)`,
        [id, ctx.tenantId, ctx.jobId, ctx.attempt, amount])
        return amount
      })
      let done = false
      return { allowance, async settle(used) {
        if (done) return
        done = true
        if (typeof used !== 'number' || !Number.isSafeInteger(used) || used < 0 || used > allowance) {
          throw new Error('Native search usage is unavailable; allowance retained')
        }
        if (allowance === 0) return
        await db.tx(function* (t: Tx): TxBody<void> {
          yield* lock(t)
          const r = yield* t.run(`UPDATE scan_native_search_calls SET used = ?
            WHERE id = ? AND user_id = ? AND scan_job_id = ? AND attempt = ? AND used IS NULL`,
          [used, id, ctx.tenantId, ctx.jobId, ctx.attempt])
          if (r.changes !== 1) throw new Error('Native search settlement unavailable')
        })
      } }
    },
  }
}
