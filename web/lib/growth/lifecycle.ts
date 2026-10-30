// Dazl's own acquisition funnel (issue #404): signup -> first real lead -> repeat useful scan -> paid -> retained, per
// tenant and per first-party acquisition source. Every definition is here, in one place, and every number is computed
// from rows the product writes when the thing happens (users, scan_jobs, leads, and the lifecycle_events below), never
// from a counter someone bumps.
//
// What the product did not record before this module, and now records as append-only events (idempotent: one row per
// kind and reference, so a redelivered webhook or a retried request counts once):
//   signup             the first-party source tag the sign-up came with (?utm_source= / ?ref= on the sign-up link),
//                      normalised; no event means the source is unknown, and the signup stays unattributed
//   payment_succeeded  a Stripe invoice paid with amount_paid > 0 (ref = invoice id)
//   payment_failed     a Stripe invoice whose payment failed (ref = invoice id)
//   refund             a Stripe charge's refunded total as of one event (ref = <charge id>:<cumulative amount_refunded>,
//                      so a later, larger refund on the same charge is its own row and the history is kept; invoice =
//                      the invoice it paid; full = Stripe's refunded flag)
//   subscription_ended a subscription Stripe ended (ref = subscription id)
// Written by the Stripe webhook (lib/billing/stripe.ts) in the same transaction as the event's processed record, and
// by sign-up. No private mailbox data, no third-party destination.
import type Database from 'better-sqlite3'
import type { Db, Tx, TxBody } from '../db/client.ts'

export function migrateLifecycle(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS lifecycle_events (
    kind TEXT NOT NULL CHECK (kind IN ('signup','payment_succeeded','payment_failed','refund','subscription_ended')),
    ref TEXT NOT NULL CHECK (length(ref) BETWEEN 1 AND 200),
    tenant_id TEXT NOT NULL,
    occurred_at INTEGER NOT NULL,
    amount_cents INTEGER,
    invoice TEXT,
    full_refund INTEGER,
    source TEXT CHECK (source IS NULL OR length(source) <= 40),
    PRIMARY KEY (kind, ref)
  );
  CREATE INDEX IF NOT EXISTS lifecycle_events_tenant ON lifecycle_events (tenant_id, kind);`)
}

export type LifecycleKind = 'signup' | 'payment_succeeded' | 'payment_failed' | 'refund' | 'subscription_ended'
export interface LifecycleEvent { kind: LifecycleKind; ref: string; tenant_id: string; occurred_at: number; amount_cents?: number | null; invoice?: string | null; full_refund?: boolean | null; source?: string | null }
const INSERT_SQL = 'INSERT INTO lifecycle_events (kind, ref, tenant_id, occurred_at, amount_cents, invoice, full_refund, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (kind, ref) DO NOTHING'
const params = (e: LifecycleEvent) => [e.kind, e.ref.slice(0, 200), e.tenant_id, Math.floor(e.occurred_at), e.amount_cents ?? null, e.invoice ?? null, e.full_refund == null ? null : e.full_refund ? 1 : 0, e.source ?? null]
export function* recordEventTx(t: Tx, e: LifecycleEvent): TxBody<boolean> {
  return (yield* t.run(INSERT_SQL, params(e))).changes === 1
}
export async function recordEvent(db: Db, e: LifecycleEvent): Promise<boolean> {
  return (await db.run(INSERT_SQL, params(e))).changes === 1
}

// A first-party source tag: lower-case [a-z0-9._-], at most 40 characters. Anything else (empty, a URL, an email, a
// value with spaces) is not a tag and is dropped, so it reads as unknown rather than as a made-up source.
export function normaliseSource(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const s = v.trim().toLowerCase()
  return /^[a-z0-9][a-z0-9._-]{0,39}$/.test(s) ? s : null
}

// ---------- definitions ----------
export const DEFINITIONS = {
  tenant: 'a personal workspace: one account (users.id); a customer is counted once however many visits, scans or payments it has',
  excluded: 'synthetic and staging tenants: an account whose email is at a reserved test domain (example.com/.net/.org, or a .test, .example, .invalid or .localhost name), and any tenant listed in excludeTenants',
  signed_up: 'the account exists (users.created_at)',
  real_lead: 'a lead from one of the tenant\'s scans that a user would see as verified: not held for review (review_reason empty, confidence set, not held by a failed required gate), not quarantined, has a company, not a hidden low-fit lead (fit 1), and not a test-source lead',
  activated: 'the tenant has a scan that finished successfully (status done) with at least one real lead. A scan with zero real leads is not activation, nor is a failed, cancelled or unfinished scan that saved leads, nor entering a key or starting a scan',
  repeat: 'after activating, a second successfully finished scan with at least one real lead, started at least REPEAT_GAP_S after the activating scan started',
  paid: 'a Stripe invoice paid with an amount above zero that has not been fully refunded: fully refunded once any refund event for it says so, or its charges\' largest recorded refunded total reaches the amount paid, in whatever order the events arrived (a failed payment is not paid; a partial refund still is)',
  retained: 'retained at N days (retainDays, default 30): a paid, not fully refunded invoice dated at least N-5 days after the first one, i.e. evidence of a renewal, not just the absence of a cancellation; a tenant whose first payment is younger than N+5 days is not mature and stays out of the retention rate. N=30 is one monthly renewal, N=60 two',
  churned: 'paid, then the subscription ended, without being retained',
  source: 'the first-party tag the sign-up came with; none recorded = unknown (never guessed). A tag says where the sign-up link came from: it is not causal credit',
} as const
export const REPEAT_GAP_S = 24 * 3600
// Retention at N days: a renewal at least N - RETAIN_GRACE_DAYS after the first payment; mature at N + RETAIN_GRACE_DAYS.
export const RETAIN_DAYS = 30
export const RETAIN_GRACE_DAYS = 5
export const RETAIN_AFTER_S = (RETAIN_DAYS - RETAIN_GRACE_DAYS) * 86400
export const RETAIN_MATURE_S = (RETAIN_DAYS + RETAIN_GRACE_DAYS) * 86400
const RESERVED = /@([a-z0-9-]+\.)*(example\.(com|net|org)|[a-z0-9-]+\.(test|example|invalid|localhost))$/i

export type Stage = 'excluded' | 'signed_up_only' | 'zero_result' | 'activated' | 'repeat' | 'payment_failed' | 'refunded' | 'paid' | 'retained' | 'churned'
export interface TenantFunnel {
  tenant_id: string; source: string; signed_up_at: number
  scans: number; scans_with_real_leads: number; real_leads: number
  activated_at: number | null; repeat_at: number | null
  paid_at: number | null; payments: number; failed_payments: number; refunded_payments: number
  retained: boolean | null           // null: not mature yet (or never paid)
  churned_at: number | null
  stage: Stage                       // the furthest distinct state, for the per-tenant table
}

const REAL_LEAD = `l.review_reason IS NULL AND l.confidence IS NOT NULL AND l.quarantined_at IS NULL AND l.company <> ''
  AND (l.fit IS NULL OR l.fit > 1) AND (l.source_kind IS NULL OR l.source_kind <> 'test')
  AND NOT EXISTS (SELECT 1 FROM lead_enrichments h WHERE h.lead_id = l.id AND h.connector = 'scan:gate' AND h.kind = 'gate_failed')`
const USERS_SQL = 'SELECT id, email, created_at FROM users ORDER BY created_at, id'
const SCANS_SQL = `SELECT j.user_id AS tenant_id, j.id, j.created_at, j.status, (SELECT count(*) FROM leads l WHERE l.scan_job_id = j.id AND ${REAL_LEAD}) AS real_leads
  FROM scan_jobs j ORDER BY j.created_at, j.id`
const EVENTS_SQL = 'SELECT kind, ref, tenant_id, occurred_at, amount_cents, invoice, full_refund, source FROM lifecycle_events ORDER BY occurred_at, kind, ref'

export interface FunnelOptions { now: number; excludeTenants?: string[]; retainDays?: number }
export async function tenantFunnels(db: Db, opts: FunnelOptions): Promise<TenantFunnel[]> {
  const users = await db.all<{ id: string; email: string; created_at: number | null }>(USERS_SQL)
  const scans = await db.all<{ tenant_id: string; id: string; created_at: number; status: string; real_leads: number }>(SCANS_SQL)
  const events = await db.all<{ kind: LifecycleKind; ref: string; tenant_id: string; occurred_at: number; amount_cents: number | null; invoice: string | null; full_refund: number | null; source: string | null }>(EVENTS_SQL)
  const exclude = new Set(opts.excludeTenants ?? [])
  const retainDays = opts.retainDays ?? RETAIN_DAYS
  const retainAfter = (retainDays - RETAIN_GRACE_DAYS) * 86400, retainMature = (retainDays + RETAIN_GRACE_DAYS) * 86400
  return users.map(u => {
    const mine = scans.filter(s => s.tenant_id === u.id)
    const ev = events.filter(e => e.tenant_id === u.id)
    // delivered value: a scan that finished (a failed or unfinished scan's saved leads are not a delivered result)
    const useful = mine.filter(s => s.status === 'done' && Number(s.real_leads) > 0)
    const activated = useful[0] ?? null
    const repeat = activated ? useful.find(s => s.id !== activated.id && Number(s.created_at) - Number(activated.created_at) >= REPEAT_GAP_S) ?? null : null
    const succeeded = ev.filter(e => e.kind === 'payment_succeeded' && Number(e.amount_cents) > 0)
    // Refund rows are cumulative totals per charge, kept as history; the projection is order-independent: an invoice is
    // fully refunded once any row says so, or once the largest refunded total recorded for it reaches what was paid.
    const refunds = ev.filter(e => e.kind === 'refund' && e.invoice)
    const refundedInvoices = new Set(succeeded.filter(p => refunds.some(r => r.invoice === p.ref && (r.full_refund === 1 || Number(r.amount_cents) >= Number(p.amount_cents)))).map(p => p.ref))
    const paidOk = succeeded.filter(e => !refundedInvoices.has(e.ref))
    const first = paidOk[0] ?? null
    const second = first ? paidOk.find(e => Number(e.occurred_at) - Number(first.occurred_at) >= retainAfter) ?? null : null
    const mature = !!first && opts.now - Number(first.occurred_at) >= retainMature
    const retained = !first ? null : second ? true : mature ? false : null
    const ended = first ? ev.find(e => e.kind === 'subscription_ended' && Number(e.occurred_at) >= Number(first.occurred_at)) ?? null : null
    const churnedAt = ended && !second ? Number(ended.occurred_at) : null
    const failed = ev.filter(e => e.kind === 'payment_failed').length
    const signup = ev.find(e => e.kind === 'signup')
    const excluded = exclude.has(u.id) || RESERVED.test(u.email)
    const stage: Stage = excluded ? 'excluded'
      : second ? 'retained' : churnedAt ? 'churned' : first ? 'paid'
      : succeeded.length ? 'refunded' : failed ? 'payment_failed'
      : repeat ? 'repeat' : activated ? 'activated' : mine.length ? 'zero_result' : 'signed_up_only'
    return {
      tenant_id: u.id, source: signup?.source ?? 'unknown', signed_up_at: Number(u.created_at ?? 0),
      scans: mine.length, scans_with_real_leads: useful.length, real_leads: mine.reduce((a, s) => a + Number(s.real_leads), 0),
      activated_at: activated ? Number(activated.created_at) : null, repeat_at: repeat ? Number(repeat.created_at) : null,
      paid_at: first ? Number(first.occurred_at) : null, payments: paidOk.length, failed_payments: failed,
      refunded_payments: succeeded.filter(e => refundedInvoices.has(e.ref)).length,
      retained, churned_at: churnedAt, stage,
    }
  })
}

export interface FunnelRow {
  source: string
  signed_up: number; activated: number; repeat: number; paid: number
  retained: number; retention_mature: number            // retained of the paid tenants old enough to tell
  churned: number; zero_result: number; signed_up_only: number; payment_failed: number; refunded: number
}
const zero = (source: string): FunnelRow => ({ source, signed_up: 0, activated: 0, repeat: 0, paid: 0, retained: 0, retention_mature: 0, churned: 0, zero_result: 0, signed_up_only: 0, payment_failed: 0, refunded: 0 })
export interface FunnelReport {
  as_of: number; definitions: typeof DEFINITIONS
  excluded_tenants: number; source_coverage: { tagged: number; unknown: number }
  total: FunnelRow; by_source: FunnelRow[]
  note: string
}
export function funnelReport(tenants: TenantFunnel[], now: number): FunnelReport {
  const counted = tenants.filter(t => t.stage !== 'excluded')
  const add = (r: FunnelRow, t: TenantFunnel) => {
    r.signed_up++
    if (t.activated_at !== null) r.activated++
    if (t.repeat_at !== null) r.repeat++
    if (t.paid_at !== null) r.paid++
    if (t.retained !== null) r.retention_mature++
    if (t.retained === true) r.retained++
    if (t.churned_at !== null) r.churned++
    if (t.stage === 'zero_result') r.zero_result++
    if (t.stage === 'signed_up_only') r.signed_up_only++
    if (t.stage === 'payment_failed') r.payment_failed++
    if (t.stage === 'refunded') r.refunded++
  }
  const total = zero('all'), by = new Map<string, FunnelRow>()
  for (const t of counted) { add(total, t); const r = by.get(t.source) ?? zero(t.source); add(r, t); by.set(t.source, r) }
  return {
    as_of: now, definitions: DEFINITIONS,
    excluded_tenants: tenants.length - counted.length,
    source_coverage: { tagged: counted.filter(t => t.source !== 'unknown').length, unknown: counted.filter(t => t.source === 'unknown').length },
    total, by_source: [...by.values()].sort((a, b) => b.signed_up - a.signed_up || a.source.localeCompare(b.source)),
    note: 'Counts of tenants, each counted once. Sources are first-party sign-up tags: where the link came from, not proof it caused the sign-up. Retention is over mature paid tenants only.',
  }
}
