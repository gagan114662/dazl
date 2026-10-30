// What a replay of a case returns (the harness lives in test/helpers/eval-replay.ts, because it needs the raw SQLite handle
// runJob takes). Kept here so the evaluators, which are pure, depend only on this shape and on the canary values.
import type { Trace, TraceLead } from './trace.ts'

export const CASE_TENANT = 'eval-tenant-a'
export const CANARY_TENANT = 'eval-tenant-b'
export const CANARY = { company: 'Canary Tenant B Ltd', contact: 'canary@tenant-b.invalid', signal: 'CANARY-TENANT-B: this row belongs to another tenant', source_url: 'https://tenant-b.invalid/canary' }

export interface WorldMiss { kind: 'model' | 'search' | 'page' | 'tinyfish_page' | 'http'; key: string }
export interface ReplayLead extends TraceLead { company_domain: string | null; date_status: string | null; tenant: string }
export interface ReplayResult {
  outcome: 'done' | 'failed' | 'retry'
  job: { status: string; error: string | null; candidates: number | null; verified: number | null; needs_review: number | null; drop_reasons: string | null }
  leads: ReplayLead[]          // the case tenant's leads only
  canaryIntact: boolean        // the other tenant's rows are exactly as seeded
  misses: WorldMiss[]
  autopilotCalls: number
  trace: Trace
}
