import type Database from 'better-sqlite3'

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
}

export function getPlan(db: Database.Database, tenantId: string): PlanId {
  const r = db.prepare('SELECT plan FROM tenant_plans WHERE tenant_id = ?').get(tenantId) as { plan: PlanId } | undefined
  return r?.plan ?? 'free'
}

export function setPlan(db: Database.Database, tenantId: string, plan: PlanId): void {
  db.prepare('INSERT INTO tenant_plans (tenant_id, plan) VALUES (?, ?) ON CONFLICT(tenant_id) DO UPDATE SET plan = excluded.plan').run(tenantId, plan)
}

export function monthStartS(now = new Date()): number {
  return Math.floor(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1) / 1000)
}

// Scans started this UTC month. Failed scans do not count: the user gets the slot back.
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
