// Which tables hold tenant data and how each is scoped: by its own tenant column, through a parent row, or global by
// design. test/tenant-isolation-db.test.ts holds the live schema to this on both engines, so a new table must be
// classified here; tenant export and deletion (lib/tenant/lifecycle.ts) and the isolation sweeps read it.
export const TENANT_COLUMNS = ['tenant_id', 'user_id']
// Tables without a tenant column of their own: scoped through a parent row, or global by design.
export const NOT_DIRECT: Record<string, { via: [string, string] } | { global: string }> = {
  users: { global: 'the tenant itself: users.id is the tenant id' },
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
  work_queue_meta: { global: 'queue counters (claim-token sequence), no tenant data' },
  tenant_tombstones: { global: 'deleted tenants: id, when, state and what was retained (lib/tenant/lifecycle.ts); kept so a restored backup re-applies the deletion' },
  tenant_tombstone_keys: { global: 'ids of deleted parent rows (scan jobs, leads, batches, monitors, watches) so a late child write is refused' },
  scheduler_runs: { global: 'one row per scheduler tick: times, status, lease generation and tenant counts; per-tenant progress is scheduler_progress (tenant_id)' },
  rate_limits: { global: 'counters keyed by caller (tenant id, account or IP inside the key); holds no tenant data and no route reads it back' },
  app_leases: { global: 'named locks for platform jobs (the scheduled tick); no tenant data' },
  trial_budget_lock: { global: 'one row every free-trial admission locks in turn (lib/billing/trial-budget.ts); a counter, no tenant data' },
}

