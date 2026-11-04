// Which tables hold tenant data and how each is scoped: by its own tenant column, through a parent row, or global by
// design. test/tenant-isolation-db.test.ts holds the live schema to this on both engines, so a new table must be
// classified here; tenant export and deletion (lib/tenant/lifecycle.ts) and the isolation sweeps read it.
export const TENANT_COLUMNS = ['tenant_id', 'user_id']
// Tables without a tenant column of their own: scoped through a parent row, or global by design.
export const NOT_DIRECT: Record<string, { via: [string, string] } | { global: string }> = {
  users: { global: 'accounts (actors); a personal workspace id equals its founder users.id' },
  organizations: { global: 'the tenant itself: organizations.id is the tenant id (lib/workspaces.ts)' },
  leads: { via: ['scan_job_id', 'scan_jobs'] },
  lead_sources: { via: ['lead_id', 'leads'] },
  scan_source_runs: { via: ['job_id', 'scan_jobs'] },
  scan_source_stats: { via: ['job_id', 'scan_jobs'] },
  scan_run_report: { via: ['job_id', 'scan_jobs'] },
  commenter_rows: { via: ['batch_id', 'commenter_batches'] },
  csv_rows: { via: ['batch_id', 'csv_batches'] },
  monitor_runs: { via: ['monitor_id', 'monitors'] },
  monitor_seen: { via: ['monitor_id', 'monitors'] },
  monitor_cursors: { via: ['monitor_id', 'monitors'] },
  watch_seen: { via: ['watch_id', 'watches'] },
  stripe_events: { global: 'Stripe event ids for dedupe; the tenant comes from the event payload' },
  lifecycle_events: { global: "conversion events keyed by verified account email (kind|email, #417): conversion is account-level and deliberately stops that address's queued acquisition work across tenants; account_tenant is attribution only" },
  work_queue_meta: { global: 'queue counters (claim-token sequence), no tenant data' },
  tenant_tombstones: { global: 'deleted tenants: id, when, state and what was retained (lib/tenant/lifecycle.ts); kept so a restored backup re-applies the deletion' },
  tenant_tombstone_keys: { global: 'ids of deleted parent rows (scan jobs, leads, batches, monitors, watches) so a late child write is refused' },
  scheduler_runs: { global: 'one row per scheduler tick: times, status, lease generation and tenant counts; per-tenant progress is scheduler_progress (tenant_id)' },
  rate_limits: { global: 'counters keyed by caller; a key can embed a tenant id, an account or an IP, nothing else of the tenant, and no route reads it back; the deletion erases every key naming the tenant' },
  app_leases: { global: 'named locks for platform jobs (the scheduled tick); no tenant data' },
  preview_claim_events: { global: "claim-attempt audit (#416): outcome codes keyed by claim id only; holds no tenant data, email, IP or token" },
  audit_purge_gate: { global: 'one row that exists only inside the audit retention purge transaction (lib/audit.ts); no tenant data' },
  onboarding_audit_purge_gate: { global: 'one row that exists only inside the onboarding-audit purge/redaction transaction (lib/outreach/onboarding-policy.ts); no tenant data' },
  audit_closing_gate: { global: "one row per closing tenant deletion, existing only inside deleteTenant's own closing transactions (lib/tenant/lifecycle.ts); never at rest, so the audit INSERT exception it gates stays closed" },
  preview_claims: { global: "issued proof previews bound to a recipient email (#416): run/seller/recipient/expiry are immutable at insert, claimed_by_tenant is set once atomically; served by token, per-tenant reads use claimed_by_tenant" },
  trial_budget_lock: { global: 'one row every free-trial admission locks in turn (lib/billing/trial-budget.ts); a counter, no tenant data' },
  worker_catalog: { global: 'reviewed worker versions registered at runtime (lib/workers/store.ts): name, version, code hash, definition; platform code, no tenant data' },
  worker_deployments: { global: 'one row per runtime worker: active version, state, generation and limits (lib/workers/store.ts); no tenant data' },
  worker_events: { global: 'append-only operator/host lifecycle trail for runtime workers: actor, name, version, code hash; never a tenant id (grants are also written to the tenant audit trail, audit_events)' },
}


// The tombstone tables themselves are never in scope (lib/tenant/lifecycle.ts).
const TOMB_TABLES = new Set(['tenant_tombstones', 'tenant_tombstone_keys'])
export type Scope = { table: string; how: 'direct'; col: string } | { table: string; how: 'via'; col: string; parent: string }
export function classify(cols: Map<string, string[]>): Scope[] {
  const out: Scope[] = []
  for (const [t, cs] of [...cols].sort(([a], [b]) => a.localeCompare(b))) {
    if (TOMB_TABLES.has(t) || t === 'dazl_schema_migrations') continue
    const nd = NOT_DIRECT[t]
    if (nd && 'global' in nd) continue
    const col = cs.find(c => TENANT_COLUMNS.includes(c))
    if (col) out.push({ table: t, how: 'direct', col })
    else if (nd && 'via' in nd && cs.includes(nd.via[0])) out.push({ table: t, how: 'via', col: nd.via[0], parent: nd.via[1] })
  }
  return out
}
