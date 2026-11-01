// Which tables hold tenant data and how each is scoped (test/tenant-isolation-db.test.ts holds the schema to this; the
// two-instance sweep, test/pg-table-isolation.test.ts, seeds every tenant-scoped table from it).
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
  watch_seen: { via: ['watch_id', 'watches'] },
  stripe_events: { global: 'Stripe event ids for dedupe; the tenant comes from the event payload' },
  lifecycle_events: { global: "conversion events keyed by verified account email (kind|email, #417): conversion is account-level and deliberately stops that address's queued acquisition work across tenants; account_tenant is attribution only" },
  work_queue_meta: { global: 'queue counters (claim-token sequence), no tenant data' },
  scheduler_runs: { global: 'one row per scheduler tick: times, status, lease generation and tenant counts; per-tenant progress is scheduler_progress (tenant_id)' },
  rate_limits: { global: 'counters keyed by caller (tenant id, account or IP inside the key); holds no tenant data and no route reads it back' },
  app_leases: { global: 'named locks for platform jobs (the scheduled tick); no tenant data' },
  trial_budget_lock: { global: 'one row every free-trial admission locks in turn (lib/billing/trial-budget.ts); a counter, no tenant data' },
}

