// The scan quota on the raw SQLite handle, for the two callers still on it: the scan route (app/api/scan/route.ts,
// which writes its scans there) and CSV import (lib/scan/csv-import.ts). Both are scan code, ported by the scan
// owner; everything else reads plans and quotas on the Db layer (lib/plans.ts readPlan / readScanQuota), with the same
// SQL. Delete this file when those two move.
import type Database from 'better-sqlite3'
import { monthStartS, planQuota, PLAN_SQL, SCANS_THIS_MONTH_SQL, type PlanId } from '../plans.ts'

export function scansThisMonth(db: Database.Database, tenantId: string, now = new Date()): number {
  return (db.prepare(SCANS_THIS_MONTH_SQL).get(tenantId, monthStartS(now)) as { n: number }).n
}

export function scanQuota(db: Database.Database, tenantId: string, now = new Date()) {
  const plan = (db.prepare(PLAN_SQL).get(tenantId) as { plan: PlanId } | undefined)?.plan ?? 'free'
  return planQuota(plan, scansThisMonth(db, tenantId, now))
}
