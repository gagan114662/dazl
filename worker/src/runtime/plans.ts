// Plan limits and per-tenant usage metering. Limits are per calendar month
// (UTC) except maxEmployees, which is a standing cap.
export type Plan = "free" | "pro";
export type UsageKind = "cycle" | "llm_call" | "email_sent";

export interface PlanLimits {
  maxEmployees: number;
  maxLeads: number;
  cycle: number;
  llm_call: number;
  email_sent: number;
}

export const PLAN_LIMITS: Record<Plan, PlanLimits> = {
  free: { maxEmployees: 2, maxLeads: 500, cycle: 100, llm_call: 200, email_sent: 50 },
  pro: { maxEmployees: 25, maxLeads: 50000, cycle: 5000, llm_call: 10000, email_sent: 2000 },
};

export function isPlan(value: unknown): value is Plan {
  return value === "free" || value === "pro";
}

export function monthStartEpoch(nowMs: number): number {
  const now = new Date(nowMs);
  return Math.floor(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1) / 1000);
}

export async function getTenantPlan(db: D1Database, tenantId: string): Promise<Plan> {
  const row = await db.prepare("SELECT plan FROM tenants WHERE tenant_id = ?").bind(tenantId).first<{ plan: string }>();
  return isPlan(row?.plan) ? row!.plan as Plan : "free";
}

export async function usageThisMonth(db: D1Database, tenantId: string, kind: UsageKind): Promise<number> {
  const row = await db
    .prepare("SELECT COALESCE(SUM(units), 0) AS used FROM usage_events WHERE tenant_id = ? AND kind = ? AND created_at >= ?")
    .bind(tenantId, kind, monthStartEpoch(Date.now()))
    .first<{ used: number }>();
  return row?.used ?? 0;
}

export interface QuotaResult { allowed: boolean; used: number; limit: number; plan: Plan }

export async function checkQuota(db: D1Database, tenantId: string, kind: UsageKind, units = 1): Promise<QuotaResult> {
  const plan = await getTenantPlan(db, tenantId);
  const limit = PLAN_LIMITS[plan][kind];
  const used = await usageThisMonth(db, tenantId, kind);
  return { allowed: used + units <= limit, used, limit, plan };
}

export async function recordUsage(db: D1Database, tenantId: string, kind: UsageKind, units = 1): Promise<void> {
  await db.prepare("INSERT INTO usage_events (tenant_id, kind, units) VALUES (?, ?, ?)").bind(tenantId, kind, units).run();
}

export function quotaExceededResponse(kind: string, quota: QuotaResult): Response {
  return new Response(
    JSON.stringify({ error: "quota_exceeded", kind, plan: quota.plan, used: quota.used, limit: quota.limit }),
    { status: 402, headers: { "content-type": "application/json" } }
  );
}

// Thrown when a metered action is refused for quota; route error handling maps
// it to a 402.
export class QuotaError extends Error {
  constructor(public kind: string, public quota: QuotaResult) { super("quota_exceeded"); }
  toResponse(): Response { return quotaExceededResponse(this.kind, this.quota); }
}

// Atomically reserve `units` of a monthly quota. A single INSERT ... SELECT
// ... WHERE evaluates the current total and inserts in one statement, so
// concurrent callers cannot jointly overshoot the limit (unlike check-then-
// record). Refund a reservation with recordUsage(db, tenant, kind, -units).
export async function reserveUsage(db: D1Database, tenantId: string, kind: UsageKind, units = 1): Promise<QuotaResult & { reserved: boolean }> {
  const plan = await getTenantPlan(db, tenantId);
  const limit = PLAN_LIMITS[plan][kind];
  const result = await db
    .prepare(
      "INSERT INTO usage_events (tenant_id, kind, units) SELECT ?1, ?2, ?3 WHERE " +
        "(SELECT COALESCE(SUM(units), 0) FROM usage_events WHERE tenant_id = ?1 AND kind = ?2 AND created_at >= ?4) + ?3 <= ?5"
    )
    .bind(tenantId, kind, units, monthStartEpoch(Date.now()), limit)
    .run();
  const reserved = result.meta.changes > 0;
  const used = reserved ? await usageThisMonth(db, tenantId, kind) : await usageThisMonth(db, tenantId, kind);
  return { allowed: reserved, reserved, used, limit, plan };
}
