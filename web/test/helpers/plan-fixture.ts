// Plan fixtures for tests on a raw SQLite handle (the app reads and writes plans on the Db layer, lib/plans.ts).
import type Database from 'better-sqlite3'
import type { PlanId } from '../../lib/plans.ts'

export function setPlan(db: Database.Database, tenantId: string, plan: PlanId): void {
  db.prepare('INSERT INTO tenant_plans (tenant_id, plan) VALUES (?, ?) ON CONFLICT(tenant_id) DO UPDATE SET plan = excluded.plan').run(tenantId, plan)
}
export function getPlan(db: Database.Database, tenantId: string): PlanId {
  return (db.prepare('SELECT plan FROM tenant_plans WHERE tenant_id = ?').get(tenantId) as { plan: PlanId } | undefined)?.plan ?? 'free'
}
