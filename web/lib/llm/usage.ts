import type Database from 'better-sqlite3'
import { PLANS, type Plan } from './plans.ts'

export function migrateUsage(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS tenant_plans (
      tenant_id TEXT PRIMARY KEY,
      plan TEXT NOT NULL DEFAULT 'free' CHECK (plan IN ('free','pro'))
    );
    CREATE TABLE IF NOT EXISTS llm_usage (
      tenant_id TEXT NOT NULL,
      period TEXT NOT NULL,                -- 'YYYY-MM' (UTC)
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cost_micro_usd INTEGER NOT NULL DEFAULT 0,
      reserved_tokens INTEGER NOT NULL DEFAULT 0,   -- in-flight calls
      reserved_cost_micro_usd INTEGER NOT NULL DEFAULT 0,
      calls INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (tenant_id, period)
    );
  `)
}

export const periodOf = (d = new Date()) => d.toISOString().slice(0, 7)

export function getPlan(db: Database.Database, tenantId: string): Plan {
  const r = db.prepare('SELECT plan FROM tenant_plans WHERE tenant_id = ?').get(tenantId) as { plan: Plan['id'] } | undefined
  return PLANS[r?.plan ?? 'free']
}

export function setPlan(db: Database.Database, tenantId: string, plan: Plan['id']): void {
  db.prepare('INSERT INTO tenant_plans (tenant_id, plan) VALUES (?, ?) ON CONFLICT(tenant_id) DO UPDATE SET plan = excluded.plan').run(tenantId, plan)
}

export function getUsage(db: Database.Database, tenantId: string, period = periodOf()) {
  const plan = getPlan(db, tenantId)
  const u = (db.prepare('SELECT input_tokens, output_tokens, cost_micro_usd, calls FROM llm_usage WHERE tenant_id = ? AND period = ?').get(tenantId, period) as
    | { input_tokens: number; output_tokens: number; cost_micro_usd: number; calls: number }
    | undefined) ?? { input_tokens: 0, output_tokens: 0, cost_micro_usd: 0, calls: 0 }
  return {
    plan: plan.id,
    period,
    tokens_used: u.input_tokens + u.output_tokens,
    token_limit: plan.monthlyTokenLimit,
    calls: u.calls,
  }
}

// Reserve the worst case (prompt estimate + max output) before calling the
// vendor, so concurrent calls cannot overshoot the quota. Settled after.
export function reserve(db: Database.Database, tenantId: string, tokens: number, costMicroUsd: number, period = periodOf()): boolean {
  const plan = getPlan(db, tenantId)
  return db.transaction(() => {
    db.prepare('INSERT OR IGNORE INTO llm_usage (tenant_id, period) VALUES (?, ?)').run(tenantId, period)
    const r = db
      .prepare(
        `UPDATE llm_usage SET reserved_tokens = reserved_tokens + ?, reserved_cost_micro_usd = reserved_cost_micro_usd + ?
         WHERE tenant_id = ? AND period = ?
           AND input_tokens + output_tokens + reserved_tokens + ? <= ?
           AND cost_micro_usd + reserved_cost_micro_usd + ? <= ?`,
      )
      .run(tokens, costMicroUsd, tenantId, period, tokens, plan.monthlyTokenLimit, costMicroUsd, plan.monthlyCostLimitMicroUsd)
    return r.changes === 1
  })()
}

export function settle(
  db: Database.Database,
  tenantId: string,
  reserved: { tokens: number; costMicroUsd: number },
  actual: { inputTokens: number; outputTokens: number; costMicroUsd: number } | null,
  period = periodOf(),
): void {
  db.prepare(
    `UPDATE llm_usage SET reserved_tokens = MAX(0, reserved_tokens - ?), reserved_cost_micro_usd = MAX(0, reserved_cost_micro_usd - ?),
       input_tokens = input_tokens + ?, output_tokens = output_tokens + ?, cost_micro_usd = cost_micro_usd + ?, calls = calls + ?
     WHERE tenant_id = ? AND period = ?`,
  ).run(
    reserved.tokens, reserved.costMicroUsd,
    actual?.inputTokens ?? 0, actual?.outputTokens ?? 0, actual?.costMicroUsd ?? 0, actual ? 1 : 0,
    tenantId, period,
  )
}
