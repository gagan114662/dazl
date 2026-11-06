// Tenant-isolation coverage for every background job (docs/PLATFORM.md step 4's other half: the API route manifest is
// test/tenant-isolation-manifest.ts). test/job-isolation-manifest.test.ts fails when the tick route imports a lib worker
// that is not listed here, when a queue kind is enqueued without an entry, or when a listed test file or its two-tenant
// test disappears - so new background work cannot ship without isolation classification.
//
// isolation:
//   { covered: '<test file>' } - that file holds a test whose name names two tenants, proving the worker run for one
//                                tenant never reads, changes, sends or deletes another tenant's data.
//   { global: '<reason>' }     - maintenance that takes no tenant id; the reason says why one tenant's data cannot be
//                                harmed by another's, and the named test proves the bounded, gated behavior.

export type JobEntry =
  | { id: string; worker: string; isolation: { covered: string } }
  | { id: string; worker: string; isolation: { global: string; test: string; via?: string } }

export const JOBS: JobEntry[] = [
  // Per-tenant tick workers (app/api/internal/tick/route.ts passes the tenant id explicitly).
  { id: 'tick:reply_sync', worker: 'syncReplies', isolation: { covered: 'reply-optout.test.ts' } },
  { id: 'tick:followups', worker: 'runFollowups', isolation: { covered: 'job-isolation.test.ts' } },
  { id: 'tick:first_touch_drain', worker: 'drainFirstTouch', isolation: { covered: 'job-isolation.test.ts' } },
  { id: 'tick:first_touch_autopilot', worker: 'runAutopilot', isolation: { covered: 'job-isolation.test.ts' } },
  { id: 'tick:sequences', worker: 'runSequences', isolation: { covered: 'job-isolation.test.ts' } },
  { id: 'tick:index_checks', worker: 'runIndexChecks', isolation: { covered: 'indexing.test.ts' } },
  { id: 'tick:pipeline_routing', worker: 'routeQualifiedConversations', isolation: { covered: 'pipeline.test.ts' } },
  // Cross-tenant iterators: they select due rows across tenants; every row must run inside its own tenant's scope.
  { id: 'tick:watches', worker: 'runDueWatches', isolation: { covered: 'job-isolation.test.ts' } },
  { id: 'tick:monitors_enqueue', worker: 'runDueMonitors', isolation: { covered: 'job-isolation.test.ts' } },
  { id: 'tick:monitors_collect', worker: 'collectMonitorResults', isolation: { covered: 'job-isolation.test.ts' } },
  // Queue-enqueued kinds (any enqueue( outside lib/queue internals): one entry per kind literal.
  { id: 'queue:scan', worker: 'runJob', isolation: { covered: 'runner.test.ts' } },
  // Global maintenance: no tenant id is taken; the deletion scope is the risk, so the reason and test are required.
  { id: 'tick:sessions_reap', worker: 'reapAccountHistory', isolation: { global: 'deletes only expired or long-revoked sessions, regardless of tenant; a live session of any tenant never matches', test: 'account-retention.test.ts' } },
  { id: 'tick:first_party_retention', worker: 'purgeFirstPartyRetention', isolation: { global: 'per tenant with a recorded first-party config, deletes only that tenant\x27s first-party rows past its own retention; fenced like every tick writer', test: 'first-party-signals.test.ts' } },
  { id: 'tick:trace_purge', worker: 'purgeExpiredTraces', isolation: { global: 'deletes only rows older than an explicit owner-set retention, bounded per tick; capture on alone purges nothing', test: 'trace-purge-tick.test.ts' } },
  { id: 'tick:audit_purge', worker: 'purgeAudit', isolation: { global: 'off unless AUDIT_RETENTION_DAYS is explicitly valid; then deletes only events older than it, bounded per tick', test: 'audit-retention-tick.test.ts', via: 'AUDIT_RETENTION_DAYS' } },
  { id: 'tick:onboarding_redact', worker: 'redactOnboardingAuditDetails', isolation: { global: 'redacts only content-free onboarding_audit rows past the retention after a tenant erasure completed; live tenants never match', test: 'onboarding-policy.test.ts' } },
  { id: 'tick:onboarding_purge', worker: 'purgeOnboardingAudit', isolation: { global: 'purges only onboarding_audit rows of tenants whose erasure completed past the retention; live or deleting tenants never match', test: 'onboarding-policy.test.ts' } },
]

// Tick-route lib imports that are not tenant work: scheduler bookkeeping, lease fencing, error capture. A new lib
// import into the tick route that is not listed here or in JOBS fails the manifest test.
export const TICK_INFRA = new Set([
  'getScanDb', 'getDb', 'kickRunner', 'sharedScanQueue', 'tryLease', 'dueTenants', 'captureError', 'requestIdOf',
  'classifySync', 'classifyWork', 'finishRun', 'migrateSchedulerRuns', 'recordProgress', 'startRun',
  'auditRetention', 'READ_CONSENT_VERSION', 'DRAIN_HOLD_REASONS',
  // lib/pipeline/deals.ts (#366): lists the tenants with an active routing rule and an unrouted positive reply; like
  // dueTenants it only selects tenant ids, and each one is then routed in its own scope (tick:pipeline_routing).
  'routingTenants',
])
