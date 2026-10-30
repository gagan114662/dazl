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
  // The subscription's status as Stripe last reported it (lib/billing/stripe.ts): active, past_due after a failed
  // payment while Stripe retries, unpaid, canceled... The plan is what entitles; this says why. PG: 0009_subscription_status.sql.
  try { db.exec('ALTER TABLE tenant_plans ADD COLUMN subscription_status TEXT') } catch { /* exists */ }
}

// Every read and write here is on the Db layer (SQLite or Postgres). The sync quota for the scan code still on the raw
// handle is lib/billing/plans-sqlite.ts, re-exported below so its callers' imports are unchanged.
export const PLAN_SQL = 'SELECT plan FROM tenant_plans WHERE tenant_id = ?'
export async function readPlan(db: Db, tenantId: string): Promise<PlanId> {
  return (await db.get<{ plan: PlanId }>(PLAN_SQL, [tenantId]))?.plan ?? 'free'
}

// The subscription status Stripe last reported, null without one.
const BILLING_STATUS_SQL = 'SELECT subscription_status FROM tenant_plans WHERE tenant_id = ?'
export async function readBillingStatus(db: Db, tenantId: string): Promise<string | null> {
  return (await db.get<{ subscription_status: string | null }>(BILLING_STATUS_SQL, [tenantId]))?.subscription_status ?? null
}

// A transaction step: billing changes a plan only inside the transaction that records the Stripe event.
export function* writePlan(t: Tx, tenantId: string, plan: PlanId): TxBody<void> {
  yield* t.run('INSERT INTO tenant_plans (tenant_id, plan) VALUES (?, ?) ON CONFLICT (tenant_id) DO UPDATE SET plan = excluded.plan', [tenantId, plan])
}
// writePlan on its own, outside a Stripe event (operator and test fixtures).
export function savePlan(db: Db, tenantId: string, plan: PlanId): Promise<void> {
  return db.tx(t => writePlan(t, tenantId, plan))
}

export function monthStartS(now = new Date()): number {
  return Math.floor(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1) / 1000)
}

// Scans started this UTC month. Genuine failures do not count (the user gets the slot back); cancelled scans keep their charge because their provider work may already have run.
export const SCANS_THIS_MONTH_SQL = "SELECT count(*) AS n FROM scan_jobs WHERE user_id = ? AND created_at >= ? AND (status != 'failed' OR error = 'cancelled') AND funded_by != 'trial'"
// The quota for a plan and a count of scans. The scan route takes the plan from the shared store (getDb(), where the
// Stripe webhook writes it) and the count from the store its scans are written to, which is still the raw SQLite
// handle (lib/billing/plans-sqlite.ts); on SQLite both are the same connection.
export const planQuota = (plan: PlanId, used: number) => {
  const limit = PLAN_LIMITS[plan].scansPerMonth
  return { plan, used, limit, allowed: limit === null || used < limit }
}
// The plan, this month's scans and the limit, on the Db layer (SQLite or Postgres).
export async function readScanQuota(db: Db, tenantId: string, now = new Date()) {
  const used = Number((await db.get<{ n: number }>(SCANS_THIS_MONTH_SQL, [tenantId, monthStartS(now)]))!.n)
  return planQuota(await readPlan(db, tenantId), used)
}

export { scanQuota, scansThisMonth } from './billing/plans-sqlite.ts'
