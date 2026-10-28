import type Database from 'better-sqlite3'
import type { Db, Tx, TxBody } from './db/client.ts'

// Plan limits are by scan count only (the tenant brings their own LLM key).
export type PlanId = 'free' | 'pro'
export const PLAN_LIMITS: Record<PlanId, { scansPerMonth: number | null }> = {
  free: { scansPerMonth: 50 },
  pro: { scansPerMonth: null }, // unlimited
}

export function migratePlans(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS tenant_plans (
      tenant_id TEXT PRIMARY KEY,
      plan TEXT NOT NULL DEFAULT 'free' CHECK (plan IN ('free','pro')),
      stripe_customer_id TEXT,
      stripe_subscription_id TEXT
    );
  `)
  // Stripe event ordering (lib/billing/stripe.ts): the created time of the last event that set this plan. PG:
  // 0007_stripe_event_order.sql.
  try { db.exec('ALTER TABLE tenant_plans ADD COLUMN stripe_event_at INTEGER') } catch { /* exists */ }
  // A same-second tie Stripe has not settled yet (lib/billing/stripe.ts): that second, until the read settles it.
  try { db.exec('ALTER TABLE tenant_plans ADD COLUMN stripe_reconcile_at INTEGER') } catch { /* exists */ }
}

// Sync reader for callers not yet on the Db layer (scan, monitors, watch). Billing uses readPlan.
export function getPlan(db: Database.Database, tenantId: string): PlanId {
  const r = db.prepare('SELECT plan FROM tenant_plans WHERE tenant_id = ?').get(tenantId) as { plan: PlanId } | undefined
  return r?.plan ?? 'free'
}

export async function readPlan(db: Db, tenantId: string): Promise<PlanId> {
  return (await db.get<{ plan: PlanId }>('SELECT plan FROM tenant_plans WHERE tenant_id = ?', [tenantId]))?.plan ?? 'free'
}

// Sync writer kept for callers and test fixtures not yet on the Db layer; billing uses writePlan.
export function setPlan(db: Database.Database, tenantId: string, plan: PlanId): void {
  db.prepare('INSERT INTO tenant_plans (tenant_id, plan) VALUES (?, ?) ON CONFLICT(tenant_id) DO UPDATE SET plan = excluded.plan').run(tenantId, plan)
}

// A transaction step: billing changes a plan only inside the transaction that records the Stripe event.
export function* writePlan(t: Tx, tenantId: string, plan: PlanId): TxBody<void> {
  yield* t.run('INSERT INTO tenant_plans (tenant_id, plan) VALUES (?, ?) ON CONFLICT (tenant_id) DO UPDATE SET plan = excluded.plan', [tenantId, plan])
}

export function monthStartS(now = new Date()): number {
  return Math.floor(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1) / 1000)
}

// Scans started this UTC month. Genuine failures do not count (the user gets the slot back); cancelled scans keep their charge because their provider work may already have run.
export function scansThisMonth(db: Database.Database, tenantId: string, now = new Date()): number {
  const r = db.prepare("SELECT count(*) AS n FROM scan_jobs WHERE user_id = ? AND created_at >= ? AND (status != 'failed' OR error = 'cancelled') AND funded_by != 'trial'").get(tenantId, monthStartS(now)) as { n: number }
  return r.n
}

export function scanQuota(db: Database.Database, tenantId: string, now = new Date()) {
  const plan = getPlan(db, tenantId)
  const limit = PLAN_LIMITS[plan].scansPerMonth
  const used = scansThisMonth(db, tenantId, now)
  return { plan, used, limit, allowed: limit === null || used < limit }
}
