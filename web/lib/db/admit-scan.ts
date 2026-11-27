import type { Db, Tx, TxBody } from './client.ts'
import { monthStartS, planQuota, SCANS_THIS_MONTH_SQL, type PlanId } from '../plans.ts'

export interface ScanAdmissionOptions {
  plan: PlanId
  quotaLifted?: boolean
  check?: () => void
  now?: Date
}

// The quota count and all admission writes share one transaction. SQLite's Db
// adapter starts IMMEDIATE. Postgres serializes admissions for this account,
// then the quota statement reads the commits that preceded its turn.
export function admitScan<T>(db: Db, tenantId: string, options: ScanAdmissionOptions, create: (t: Tx) => TxBody<T>) {
  return db.tx(function* (t) {
    if (t.kind === 'pg') {
      yield* t.get("SELECT pg_advisory_xact_lock(hashtextextended('scan_quota:' || ?, 0))", [tenantId])
    }
    options.check?.()
    const row = yield* t.get<{ n: number }>(SCANS_THIS_MONTH_SQL, [tenantId, monthStartS(options.now)])
    const quota = planQuota(options.plan, Number(row!.n))
    if (!quota.allowed && !options.quotaLifted) return { ok: false as const, quota }
    return { ok: true as const, value: yield* create(t) }
  })
}
