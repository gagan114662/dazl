// Dazl's own acquisition funnel (#404): prospect -> qualified conversation -> signup -> first usable result -> repeat
// useful run -> paid -> retained, computed read-only from events the product already records. No analytics vendor, no
// tracking pixel, no new table: every number comes from this store.
//
// Who is measured. The growth workspace (DAZL_GROWTH_TENANT_ID) is an ordinary customer workspace that dazl uses to find
// its own customers with the same plays, outreach and preview mechanics it sells; nothing here bypasses a gate. The
// report is aggregate-only (counts, rates, dollars): it never returns an email, a name or a workspace id.
//
// Definitions (each is a constant below, reported back in `definitions`):
//   customer     one account (users row), keyed by its normalized email. Visits, messages and plays never add a second
//                one. Invited members (an accepted invitation) are seats on someone else's account, not acquisitions.
//   activation   the account's first INDEPENDENTLY usable result: its own play (a query, not a CSV import, not a test
//                fixture) finished 'done' with at least one source-checked lead (scan_jobs.verified >= 1) and at least
//                one lead that is not rejected, not in review and has a verified event date. A key entry, a profile or
//                a scan start is not activation; a claimed preview is someone else's run and is not activation either.
//                The read-time holds of the Home preview (time window, currentness, domain review) are not reapplied.
//   setup state  exactly one of: abandoned_setup (no own play started), runs_failed (plays started, none finished),
//                zero_result (plays finished, none usable), activated.
//   repeat use   a second usable own play finished at least REPEAT_GAP_S after the activating one, within the window.
//   paid         the first Stripe-applied plan change to Pro on a workspace the account owns (audit trail, actor
//                'stripe'), else the verified checkout conversion (lifecycle_events 'payment') when no audit row exists.
//   payment states (distinct): payment_failed (invoice.payment_failed seen), refunded (charge.refunded seen with the whole charge refunded; a partial refund is counted apart as partial_refunds and never
//                lowers retention: a goodwill credit is not a lost customer),
//                churned (subscription ended), lapsed (downgraded to Free without ending: unpaid/paused/incomplete).
//   retained@N   paid, and on Pro with no refund N days after the first payment. Only accounts whose N days have
//                fully elapsed are counted (eligible); the rest are immature, never counted as lost or kept.
//   attribution  first-party and exact only: direct = the account claimed a preview the growth workspace sent it;
//                assisted = the growth workspace sent outreach to this exact address before the signup; unattributed =
//                neither (an unrelated signup, a same-company colleague, a same-name person); unknown = the address
//                unsubscribed from the growth workspace (its contact history is not used). Never causal: there is no
//                randomized holdout, so `causal` is always 'not_established'. A tagged URL is not read at all.
//   synthetic    reserved test domains (RFC 2606/6761), the growth workspace's own members, test-fixture plays and
//                test messages are excluded and counted. On a staging server everything is excluded.
import type { Db } from '../db/client.ts'
import { isStaging, type Env } from '../staging.ts'
import { completionCost } from '../llm/spend-guard.ts'
import type { CompletionUsage } from '../llm/provider.ts'
import { modelUsageEnabled } from '../scan/model-usage.ts'

export const ACTIVATION_DAYS = 14
export const REPEAT_DAYS = 30
export const REPEAT_GAP_S = 24 * 3600
export const RETENTION_DAYS = [30, 90] as const
const DAY = 86400

export type Attribution = 'direct' | 'assisted' | 'unattributed' | 'unknown_opted_out'
export type SetupState = 'abandoned_setup' | 'runs_failed' | 'zero_result' | 'activated'
export interface Windowed { eligible: number; count: number; rate: number | null }

export interface FunnelReport {
  generated_at: number
  environment: 'production' | 'staging'
  definitions: Record<string, string>
  prospects: { contacted: number; qualified_conversations: number; signed_up: number; activated: number; paid: number; reply_reading: boolean; bookings_hook: boolean }
  attribution: { direct: number; assisted: number; unattributed: number; unknown_opted_out: number; causal: 'not_established'; by_source: { signal_kind: string | null; source_kind: string | null; contacted: number; qualified: number; signed_up: number; activated: number; paid: number }[] }
  totals: CohortRow
  cohorts: CohortRow[]
  cost: { components: CostComponent[]; model_spend: { token_priced_usd: number; pool_reported_usd: number; counted_usd: number; rule: string }; recorded_usd: number; complete: false; per_activated_paying: { customers: number; usd_lower_bound: number | null }; per_retained_paying: { window_days: number; customers: number; usd_lower_bound: number | null } }
  coverage: { attribution_known: number; payment_timeline: { audit: number; lifecycle_fallback: number }; retention_unknown: number; refund_events: number; partial_refund_events: number; unmatched_paid_workspaces: number; unsettled_trial_reservations: number; notes: string[] }
  excluded: { staging_environment: boolean; synthetic_accounts: number; internal_accounts: number; invited_members: number; test_runs: number; test_messages: number }
}

// recorded: every call of this kind is priced; partial: some calls have no price (no usage, an unlisted model, invalid
// counts) or recording is off, so usd is a lower bound; not_recorded: dazl stores no dollar figure for it at all.
export interface CostComponent { name: string; usd: number | null; status: 'recorded' | 'partial' | 'not_recorded'; note: string; priced_calls?: number; unpriced_calls?: number }

export interface CohortRow {
  cohort: string // UTC signup month, or 'all'
  signups: number
  attribution: Record<Attribution, number>
  setup: Record<SetupState, number>
  activated: Windowed      // within ACTIVATION_DAYS of signup
  repeat_use: Windowed     // within REPEAT_DAYS of activation, among activated
  paid: number
  activated_paying: number
  payment_failed: number
  refunded: number
  partial_refunds: number
  churned: number
  lapsed: number
  retained: Record<string, Windowed> // 'd30', 'd90', among paying
  mature: boolean          // every signup in the cohort has had the full activation and repeat windows
}

// ---------- load ----------

const n = (v: unknown): number | null => v === null || v === undefined ? null : Number(v)
export const normEmail = (e: string | null | undefined): string => (e ?? '').trim().toLowerCase()
export function syntheticEmail(email: string): boolean {
  const d = email.slice(email.lastIndexOf('@') + 1)
  if (!email.includes('@') || !d) return true
  const tld = d.slice(d.lastIndexOf('.') + 1)
  return ['test', 'example', 'invalid', 'localhost'].includes(tld) || /(^|\.)example\.(com|net|org)$/.test(d)
}
const testRun = (j: { industry: string; location: string }) => j.industry === 'test only' && j.location === 'test only'

export interface Data {
  users: { id: string; email: string; created_at: number }[]
  owners: { tenant_id: string; member_id: string; role: string }[]
  invited: Set<string>
  jobs: { user_id: string; status: string; query: string | null; csv_domain: string | null; industry: string; location: string; finished_at: number | null; created_at: number; verified: number | null; usable: number }[]
  billing: { tenant_id: string; action: string; summary: string; at: number }[]
  ended: { tenant_id: string; ended_at: number | null }[]
  plans: { tenant_id: string; plan: string }[]
  checkout: { email: string; account_tenant: string | null; created_at: number }[]
  claims: { claimed_by_tenant: string; claimed_at: number | null }[]
  sent: { id: string; to_email: string; sent_at: number | null; test: number; signal_kind: string | null; source_kind: string | null }[]
  positive: Set<string>
  bookings: { email: string; created_at: number }[]
  optedOut: Set<string>
  replyReading: boolean
  bookingsHook: boolean
  researchUsd: number
  trial: { tenant_id: string; spent_usd: number | null; settled_at: number | null }[]
  modelRows: ModelRow[]
}

// ---------- model cost (#404) ----------
// Every model call of the growth workspace is priced from the tokens the vendor reported for it, at the listed price of
// the model that SERVED it (lib/llm/spend-guard.ts completionCost: input, output, cache writes and reads). A call with no
// usage, an unlisted model or invalid counts is an unpriced call, never $0; a row that records a refusal before any
// request was made is not a call. Prompt and response text are never read.
export type ModelPurpose = 'scans' | 'outreach_drafting' | 'evaluation'
export interface ModelRow { purpose: ModelPurpose; model: string | null; usage: CompletionUsage | undefined; call: boolean }
export interface PricedPurpose { usd: number; priced_calls: number; unpriced_calls: number }
// No model dazl lists takes more than this in one call; a larger count is a corrupt row (unpriced), not a cost.
export const MAX_CALL_TOKENS = 10_000_000
// Draft-polish outcomes recorded before any provider request (lib/outreach/draft-llm.ts recordRefusal / spend refusal).
const DRAFT_NO_CALL = new Set(['no_key', 'no_profile', 'offer_conflict', 'offer_unconfirmed', 'offer_unreadable', 'spend_limit'])

const count = (v: unknown): number | undefined => {
  if (v === null || v === undefined) return undefined
  const x = typeof v === 'number' ? v : typeof v === 'string' && /^\d{1,15}$/.test(v) ? Number(v) : NaN // Postgres BIGINT arrives as a string
  return Number.isInteger(x) && x >= 0 && x <= MAX_CALL_TOKENS ? x : NaN
}
// Usage from stored counts; none at all is no usage. Any count that is not a sane non-negative integer makes the call unpriced.
export function usageOf(input: unknown, output: unknown, cacheRead?: unknown, cacheWrite?: unknown): CompletionUsage | undefined {
  const i = count(input), o = count(output), r = count(cacheRead), w = count(cacheWrite)
  if (i === undefined && o === undefined && r === undefined && w === undefined) return undefined
  return { input_tokens: i ?? NaN, output_tokens: o ?? NaN, ...(r !== undefined ? { cache_read_input_tokens: r } : {}), ...(w !== undefined ? { cache_creation_input_tokens: w } : {}) }
}
// lead_qualifications.usage is the provider's usage object as JSON text. Anything else (not JSON, not an object, too long) is no usage.
export function jsonUsage(text: unknown): CompletionUsage | undefined {
  if (typeof text !== 'string' || text.length > 2000) return undefined
  let u: unknown
  try { u = JSON.parse(text) } catch { return undefined }
  if (!u || typeof u !== 'object' || Array.isArray(u)) return undefined
  const o = u as Record<string, unknown>
  const num = (v: unknown) => v === undefined || v === null ? v : typeof v === 'number' ? v : NaN // a string count in JSON is invalid
  return usageOf(num(o.input_tokens), num(o.output_tokens), num(o.cache_read_input_tokens), num(o.cache_creation_input_tokens))
}
export function priceModelRows(rows: readonly ModelRow[]): Record<ModelPurpose, PricedPurpose> {
  const out: Record<ModelPurpose, PricedPurpose> = { scans: { usd: 0, priced_calls: 0, unpriced_calls: 0 }, outreach_drafting: { usd: 0, priced_calls: 0, unpriced_calls: 0 }, evaluation: { usd: 0, priced_calls: 0, unpriced_calls: 0 } }
  for (const r of rows) {
    if (!r.call) continue
    const o = out[r.purpose]
    const c = completionCost(r.model, r.usage)
    if ('usd' in c && Number.isFinite(c.usd)) { o.usd += c.usd; o.priced_calls++ } else o.unpriced_calls++
  }
  return out
}

async function load(db: Db, growth: string): Promise<Data> {
  const users = (await db.all<{ id: string; email: string; created_at: unknown }>('SELECT id, email, created_at FROM users'))
    .map(u => ({ id: u.id, email: normEmail(u.email), created_at: n(u.created_at) ?? 0 }))
  const owners = await db.all<{ tenant_id: string; member_id: string; role: string }>('SELECT tenant_id, member_id, role FROM memberships')
  const invited = new Set((await db.all<{ accepted_by: string }>('SELECT accepted_by FROM invitations WHERE accepted_at IS NOT NULL AND accepted_by IS NOT NULL')).map(r => r.accepted_by))
  const jobs = (await db.all<Record<string, unknown>>(
    `SELECT j.user_id, j.status, j.query, j.csv_domain, j.industry, j.location, j.finished_at, j.created_at, j.verified,
            (SELECT count(*) FROM leads l WHERE l.scan_job_id = j.id AND l.quarantined_at IS NULL AND l.review_reason IS NULL
               AND l.date_status = 'verified' AND l.event_date IS NOT NULL) AS usable
     FROM scan_jobs j`)).map(j => ({
    user_id: String(j.user_id), status: String(j.status), query: (j.query as string | null) ?? null, csv_domain: (j.csv_domain as string | null) ?? null,
    industry: String(j.industry), location: String(j.location), finished_at: n(j.finished_at), created_at: n(j.created_at) ?? 0, verified: n(j.verified), usable: n(j.usable) ?? 0,
  }))
  const billing = (await db.all<{ tenant_id: string; action: string; summary: string; at: unknown }>(
    "SELECT tenant_id, action, summary, at FROM audit_events WHERE actor_id = 'stripe' AND action IN ('billing.plan_changed', 'billing.payment_failed', 'billing.refunded') ORDER BY at, seq"))
    .map(r => ({ ...r, at: n(r.at) ?? 0 }))
  const ended = (await db.all<{ tenant_id: string; ended_at: unknown }>('SELECT tenant_id, ended_at FROM stripe_ended_subscriptions')).map(r => ({ tenant_id: r.tenant_id, ended_at: n(r.ended_at) }))
  const plans = await db.all<{ tenant_id: string; plan: string }>('SELECT tenant_id, plan FROM tenant_plans')
  const checkout = (await db.all<{ email: string; account_tenant: string | null; created_at: unknown }>("SELECT email, account_tenant, created_at FROM lifecycle_events WHERE kind = 'payment' AND activated_at IS NOT NULL"))
    .map(r => ({ email: normEmail(r.email), account_tenant: r.account_tenant, created_at: n(r.created_at) ?? 0 }))
  const claims = (await db.all<{ claimed_by_tenant: string; claimed_at: unknown }>('SELECT claimed_by_tenant, claimed_at FROM preview_claims WHERE seller_tenant_id = ? AND claimed_by_tenant IS NOT NULL', [growth]))
    .map(r => ({ claimed_by_tenant: r.claimed_by_tenant, claimed_at: n(r.claimed_at) }))
  const sent = (await db.all<Record<string, unknown>>(
    `SELECT m.id, m.to_email, m.sent_at, m.test, c.signal_kind, c.source_kind FROM outreach_messages m
     LEFT JOIN outreach_signal_context c ON c.message_id = m.id AND c.tenant_id = m.tenant_id
     WHERE m.tenant_id = ? AND m.status = 'sent'`, [growth])).map(r => ({
    id: String(r.id), to_email: normEmail(r.to_email as string), sent_at: n(r.sent_at), test: n(r.test) ?? 0,
    signal_kind: (r.signal_kind as string | null) ?? null, source_kind: (r.source_kind as string | null) ?? null,
  }))
  const positive = new Set((await db.all<{ outreach_message_id: string }>(
    "SELECT outreach_message_id FROM inbound_messages WHERE tenant_id = ? AND classification = 'positive' AND outreach_message_id IS NOT NULL", [growth])).map(r => r.outreach_message_id))
  const bookings = (await db.all<{ attendee_email: string; created_at: unknown }>('SELECT attendee_email, created_at FROM calcom_bookings WHERE tenant_id = ?', [growth]))
    .map(r => ({ email: normEmail(r.attendee_email), created_at: n(r.created_at) ?? 0 }))
  const optedOut = new Set((await db.all<{ email: string }>("SELECT email FROM suppressions WHERE tenant_id = ? AND reason = 'unsubscribe'", [growth])).map(r => normEmail(r.email)))
  const replyReading = !!(await db.get('SELECT 1 AS x FROM mail_read_consent WHERE tenant_id = ?', [growth]))
  const bookingsHook = !!(await db.get('SELECT 1 AS x FROM calcom_hooks WHERE tenant_id = ?', [growth]))
  const pool = await db.get<{ usd: unknown }>("SELECT coalesce(sum(reported_usd), 0) AS usd FROM tenant_spend_pools WHERE tenant_id = ? AND period LIKE 'm:%'", [growth])
  const trial = (await db.all<{ tenant_id: string; spent_usd: unknown; settled_at: unknown }>('SELECT tenant_id, spent_usd, settled_at FROM trial_reservations'))
    .map(r => ({ tenant_id: r.tenant_id, spent_usd: n(r.spent_usd), settled_at: n(r.settled_at) }))
  // the growth workspace's own model calls only (its plays, profile generation, draft polish, lead qualification); a dazl-funded
  // trial run of a customer is the trial subsidy above, never these rows
  const str = (v: unknown) => typeof v === 'string' ? v : null
  const modelRows: ModelRow[] = [
    ...(await db.all<Record<string, unknown>>('SELECT model_served, input_tokens, output_tokens FROM scan_model_calls WHERE tenant_id = ?', [growth]))
      .map(r => ({ purpose: 'scans' as const, model: str(r.model_served), usage: usageOf(r.input_tokens, r.output_tokens), call: true })),
    ...(await db.all<Record<string, unknown>>('SELECT outcome, model, input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens FROM outreach_llm_usage WHERE tenant_id = ?', [growth]))
      .map(r => { const usage = usageOf(r.input_tokens, r.output_tokens, r.cache_read_input_tokens, r.cache_creation_input_tokens); return { purpose: 'outreach_drafting' as const, model: str(r.model), usage, call: usage !== undefined || !DRAFT_NO_CALL.has(String(r.outcome)) } }),
    // every claim row may have been billed (a running one is in flight or crashed; a failed one kept its claim because the request may have gone out)
    ...(await db.all<Record<string, unknown>>('SELECT served_model, usage FROM lead_qualifications WHERE tenant_id = ?', [growth]))
      .map(r => ({ purpose: 'evaluation' as const, model: str(r.served_model), usage: jsonUsage(r.usage), call: true })),
  ]
  return { users, owners, invited, jobs, billing, ended, plans, checkout, claims, sent, positive, bookings, optedOut, replyReading, bookingsHook, researchUsd: n(pool?.usd) ?? 0, trial, modelRows }
}

// ---------- compute ----------

interface Customer {
  email: string; signup_at: number; cohort: string; attribution: Attribution; tenants: Set<string>
  setup: SetupState; activated_at: number | null; repeat_at: number | null
  paid_at: number | null; paid_source: 'audit' | 'lifecycle_fallback' | null
  payment_failed: boolean; refunded_at: number | null; partial_refund: boolean; churned_at: number | null; lapsed_at: number | null
  proAt: ((t: number) => boolean | null) | null
}

const month = (s: number) => new Date(s * 1000).toISOString().slice(0, 7)
const rate = (c: number, e: number): number | null => e > 0 ? c / e : null
const win = (eligible: number, count: number): Windowed => ({ eligible, count, rate: rate(count, eligible) })
// Activation is the first usable result WITHIN ACTIVATION_DAYS of signup. A later first result still sets the setup state
// (the account did get value) but is not an activation, so it never feeds repeat use, activated-paying or cost per activated.
const activatedInWindow = (c: Customer) => c.activated_at !== null && c.activated_at <= c.signup_at + ACTIVATION_DAYS * DAY
const parse = (s: string): Record<string, unknown> => { try { const v = JSON.parse(s); return v && typeof v === 'object' ? v : {} } catch { return {} } }

export function computeFunnel(d: Data, opts: { now: number; staging: boolean; internal: Set<string>; modelUsage?: boolean }): FunnelReport {
  const now = opts.now
  const excluded = { staging_environment: opts.staging, synthetic_accounts: 0, internal_accounts: 0, invited_members: 0, test_runs: 0, test_messages: 0 }
  // the growth workspace's own people are dazl, not customers (funnelReport also drops its memberships)
  const growthMembers = opts.internal
  const ownersOf = new Map<string, string[]>()
  for (const m of d.owners) {
    if (m.role === 'owner') ownersOf.set(m.tenant_id, [...(ownersOf.get(m.tenant_id) ?? []), m.member_id])
  }
  // a workspace belongs to one account: its founder (a personal workspace id IS the founder's users.id) or its single
  // owner. Zero or several owners stay unmatched, never guessed (the same rule as lib/outreach/lifecycle.ts).
  const userIds = new Set(d.users.map(u => u.id))
  const accountOf = (tenant: string): string | null => userIds.has(tenant) ? tenant : (ownersOf.get(tenant)?.length === 1 ? ownersOf.get(tenant)![0] : null)

  const customers = new Map<string, Customer>() // by user id
  const internalEmails = new Set<string>()
  for (const u of d.users) {
    if (growthMembers.has(u.id)) { excluded.internal_accounts++; internalEmails.add(u.email); continue }
    if (opts.staging || syntheticEmail(u.email)) { excluded.synthetic_accounts++; continue }
    if (d.invited.has(u.id)) { excluded.invited_members++; continue }
    customers.set(u.id, { email: u.email, signup_at: u.created_at, cohort: month(u.created_at), attribution: 'unattributed', tenants: new Set([u.id]),
      setup: 'abandoned_setup', activated_at: null, repeat_at: null, paid_at: null, paid_source: null, payment_failed: false, refunded_at: null, partial_refund: false, churned_at: null, lapsed_at: null, proAt: null })
  }
  for (const t of ownersOf.keys()) { const a = accountOf(t); if (a && customers.has(a)) customers.get(a)!.tenants.add(t) }
  const byTenant = (t: string) => { const a = accountOf(t); return a ? customers.get(a) ?? null : null }

  // setup, activation and repeat use from the account's own plays
  const runs = new Map<string, { started: boolean; finished: boolean; usable: number[] }>()
  for (const j of d.jobs) {
    if (testRun(j)) { excluded.test_runs++; continue }
    if (!j.query || j.csv_domain) continue
    const c = byTenant(j.user_id)
    if (!c) continue
    const r = runs.get(c.email) ?? { started: false, finished: false, usable: [] }
    r.started = true
    if (j.status === 'done') {
      r.finished = true
      if ((j.verified ?? 0) >= 1 && j.usable >= 1) r.usable.push(j.finished_at ?? j.created_at)
    }
    runs.set(c.email, r)
  }
  for (const c of customers.values()) {
    const r = runs.get(c.email)
    if (!r) continue
    const u = [...r.usable].sort((a, b) => a - b)
    c.setup = u.length ? 'activated' : r.finished ? 'zero_result' : 'runs_failed'
    if (u.length) {
      c.activated_at = u[0]
      c.repeat_at = u.find(t => t >= u[0] + REPEAT_GAP_S) ?? null
    }
  }

  // payments: the Stripe-applied audit trail per workspace, folded onto the owning account
  const unmatchedPaid = new Set<string>()
  const timeline = new Map<Customer, { at: number; pro: boolean }[]>()
  for (const e of d.billing) {
    const c = byTenant(e.tenant_id)
    if (!c) { if (e.action === 'billing.plan_changed' && parse(e.summary).plan === 'pro' && !growthMembers.has(e.tenant_id)) unmatchedPaid.add(e.tenant_id); continue }
    const s = parse(e.summary)
    if (e.action === 'billing.payment_failed') c.payment_failed = true
    // stripe.ts stores full:true only when Stripe says the whole charge is refunded; anything else (false, missing, malformed) is
    // treated as partial, so a doubtful row can never drop a paying customer from retention.
    else if (e.action === 'billing.refunded') { if (s.full === true) { if (c.refunded_at === null) c.refunded_at = e.at } else c.partial_refund = true }
    else {
      const pro = s.plan === 'pro'
      timeline.set(c, [...(timeline.get(c) ?? []), { at: e.at, pro }])
      if (pro && c.paid_at === null) { c.paid_at = e.at; c.paid_source = 'audit' }
      if (!pro && c.paid_at !== null) {
        if (s.ends === true) { if (c.churned_at === null) c.churned_at = e.at }
        else if (c.lapsed_at === null) c.lapsed_at = e.at
      }
    }
  }
  for (const [c, tl] of timeline) c.proAt = (t: number) => { let pro = false; for (const e of tl) if (e.at <= t) pro = e.pro; return pro }
  // fallback: a verified checkout conversion with no audit row (history from before the audit trail)
  const currentPlan = new Map(d.plans.map(p => [p.tenant_id, p.plan]))
  const endedAt = new Map<string, number>()
  for (const e of d.ended) if (e.ended_at !== null) endedAt.set(e.tenant_id, Math.min(endedAt.get(e.tenant_id) ?? Infinity, e.ended_at))
  const byEmail = new Map([...customers.values()].map(c => [c.email, c]))
  for (const p of d.checkout) {
    const c = (p.account_tenant ? byTenant(p.account_tenant) : null) ?? byEmail.get(p.email) ?? null
    if (!c || c.paid_at !== null) continue
    c.paid_at = p.created_at; c.paid_source = 'lifecycle_fallback'
    const ends = [...c.tenants].map(t => endedAt.get(t)).filter((x): x is number => x !== undefined && x >= p.created_at)
    if (ends.length) { c.churned_at = Math.min(...ends); const ch = c.churned_at; c.proAt = t => t < ch }
    else if ([...c.tenants].some(t => currentPlan.get(t) === 'pro')) c.proAt = () => true
    else c.proAt = null // on Free now, with no recorded end: when it stopped is unknown
  }

  // attribution: first-party, exact address only
  const firstSent = new Map<string, { at: number; signal_kind: string | null; source_kind: string | null; ids: string[] }>()
  for (const m of d.sent) {
    if (m.test) { excluded.test_messages++; continue }
    if (m.sent_at === null || syntheticEmail(m.to_email) || internalEmails.has(m.to_email)) continue
    const f = firstSent.get(m.to_email)
    if (!f) firstSent.set(m.to_email, { at: m.sent_at, signal_kind: m.signal_kind, source_kind: m.source_kind, ids: [m.id] })
    else { f.ids.push(m.id); if (m.sent_at < f.at) Object.assign(f, { at: m.sent_at, signal_kind: m.signal_kind, source_kind: m.source_kind }) }
  }
  const claimedBy = new Map<string, number>()
  for (const cl of d.claims) { const c = byTenant(cl.claimed_by_tenant); if (c) claimedBy.set(c.email, Math.min(claimedBy.get(c.email) ?? Infinity, cl.claimed_at ?? Infinity)) }
  for (const c of customers.values()) {
    if (d.optedOut.has(c.email)) c.attribution = 'unknown_opted_out'
    else if (claimedBy.has(c.email)) c.attribution = 'direct'
    else if ((firstSent.get(c.email)?.at ?? Infinity) < c.signup_at) c.attribution = 'assisted'
  }

  // cohorts
  const row = (cohort: string, cs: Customer[]): CohortRow => {
    const att = { direct: 0, assisted: 0, unattributed: 0, unknown_opted_out: 0 } as Record<Attribution, number>
    const setup = { abandoned_setup: 0, runs_failed: 0, zero_result: 0, activated: 0 } as Record<SetupState, number>
    for (const c of cs) { att[c.attribution]++; setup[c.setup]++ }
    const actElig = cs.filter(c => c.signup_at + ACTIVATION_DAYS * DAY <= now)
    const activated = actElig.filter(activatedInWindow)
    const repElig = cs.filter(c => activatedInWindow(c) && c.activated_at! + REPEAT_DAYS * DAY <= now)
    const repeat = repElig.filter(c => c.repeat_at !== null && c.repeat_at <= c.activated_at! + REPEAT_DAYS * DAY)
    const paying = cs.filter(c => c.paid_at !== null)
    const retained: Record<string, Windowed> = {}
    for (const w of RETENTION_DAYS) {
      const at = (c: Customer) => c.paid_at! + w * DAY
      const elig = paying.filter(c => at(c) <= now && c.proAt !== null)
      retained[`d${w}`] = win(elig.length, elig.filter(c => c.proAt!(at(c)) && (c.refunded_at === null || c.refunded_at > at(c))).length)
    }
    return {
      cohort, signups: cs.length, attribution: att, setup,
      activated: win(actElig.length, activated.length), repeat_use: win(repElig.length, repeat.length),
      paid: paying.length, activated_paying: paying.filter(activatedInWindow).length,
      payment_failed: cs.filter(c => c.payment_failed).length, refunded: cs.filter(c => c.refunded_at !== null).length, partial_refunds: cs.filter(c => c.partial_refund).length,
      churned: cs.filter(c => c.churned_at !== null).length, lapsed: cs.filter(c => c.lapsed_at !== null && c.churned_at === null).length,
      retained, mature: cs.every(c => c.signup_at + (ACTIVATION_DAYS + REPEAT_DAYS) * DAY <= now),
    }
  }
  const all = [...customers.values()]
  const cohortKeys = [...new Set(all.map(c => c.cohort))].sort()
  const totals = row('all', all)

  // prospects contacted by the growth workspace, one per address
  const sources = new Map<string, FunnelReport['attribution']['by_source'][number]>()
  const pf = { contacted: 0, qualified_conversations: 0, signed_up: 0, activated: 0, paid: 0 }
  for (const [email, f] of firstSent) {
    const qualified = f.ids.some(id => d.positive.has(id)) || d.bookings.some(b => b.email === email && b.created_at >= f.at)
    const c = byEmail.get(email)
    const signed = !!c && c.signup_at > f.at && c.attribution !== 'unknown_opted_out'
    const key = `${f.signal_kind ?? ''}\u0000${f.source_kind ?? ''}`
    const s = sources.get(key) ?? { signal_kind: f.signal_kind, source_kind: f.source_kind, contacted: 0, qualified: 0, signed_up: 0, activated: 0, paid: 0 }
    const add = (o: { contacted: number; signed_up: number; activated: number; paid: number }) => {
      o.contacted++
      if (signed) { o.signed_up++; if (activatedInWindow(c!)) o.activated++; if (c!.paid_at !== null) o.paid++ }
    }
    add(pf); add(s)
    if (qualified) { pf.qualified_conversations++; s.qualified++ }
    sources.set(key, s)
  }

  // cost: what the store records in dollars; everything else is named as not recorded
  const tenantsOf = new Set(all.flatMap(c => [...c.tenants]))
  const trialRows = d.trial.filter(t => tenantsOf.has(t.tenant_id))
  const trialUsd = trialRows.reduce((s, t) => s + (t.settled_at !== null ? t.spent_usd ?? 0 : 0), 0)
  // Model spend: the token-priced calls, or the spend pool's vendor-settled total when that is larger. The pool holds the
  // same calls (only while an owner limit is set) plus a few kinds with no token row; adding the two would count a call twice.
  const priced = priceModelRows(d.modelRows)
  const tokenUsd = priced.scans.usd + priced.outreach_drafting.usd + priced.evaluation.usd
  const modelUsd = Math.max(tokenUsd, d.researchUsd)
  const recorded = modelUsd + trialUsd
  const scanRecording = opts.modelUsage !== false
  const activatedPaying = all.filter(c => c.paid_at !== null && activatedInWindow(c)).length
  const retainedPaying = all.filter(c => c.paid_at !== null && c.proAt !== null && c.paid_at + RETENTION_DAYS[0] * DAY <= now && c.proAt(c.paid_at + RETENTION_DAYS[0] * DAY) && (c.refunded_at === null || c.refunded_at > c.paid_at + RETENTION_DAYS[0] * DAY)).length
  const round = (x: number) => Math.round(x * 100) / 100
  const line = (name: string, p: PricedPurpose, off: boolean, note: string): CostComponent =>
    ({ name, usd: round(p.usd), status: p.unpriced_calls > 0 || off ? 'partial' : 'recorded', priced_calls: p.priced_calls, unpriced_calls: p.unpriced_calls, note })

  return {
    generated_at: now,
    environment: opts.staging ? 'staging' : 'production',
    definitions: {
      customer: 'one account per normalized email; invited members are excluded',
      activation: `first own play finished with >= 1 source-checked lead and >= 1 lead not rejected, not in review, with a verified event date; within ${ACTIVATION_DAYS} days of signup`,
      repeat_use: `a second usable own play finished >= ${REPEAT_GAP_S / 3600} h after activation, within ${REPEAT_DAYS} days`,
      paid: 'first Stripe-applied plan change to Pro on an owned workspace (audit trail); verified checkout conversion when no audit row exists',
      retained: `on Pro without a full refund N days after first payment (a partial refund does not count against retention); N in ${RETENTION_DAYS.join(', ')}; only fully elapsed windows count`,
      attribution: 'direct = claimed a preview from the growth workspace; assisted = exact address contacted before signup; never causal',
      qualified_conversation: 'a rule-classified positive reply to the growth workspace (only while reply reading is on) or a Cal.com booking from that exact address',
    },
    prospects: { ...pf, reply_reading: d.replyReading, bookings_hook: d.bookingsHook },
    attribution: { ...totals.attribution, causal: 'not_established', by_source: [...sources.values()].sort((a, b) => b.contacted - a.contacted) },
    totals,
    cohorts: cohortKeys.map(k => row(k, all.filter(c => c.cohort === k))),
    cost: {
      components: [
        line('scans', priced.scans, !scanRecording,
          `model calls of the growth workspace's plays and profile generation (scan_model_calls), at the served model's listed price; that table keeps no cache or web-search counts, and research calls report no tokens (unpriced)${scanRecording ? '' : '; recording is off on this server (DAZL_MODEL_USAGE=0), so later calls are missing'}`),
        line('outreach_drafting', priced.outreach_drafting, false, 'draft polish calls (outreach_llm_usage), input, output and cache tokens at the served model\'s listed price'),
        line('evaluation', priced.evaluation, false, 'lead qualification calls (lead_qualifications), from the usage the vendor returned, at the served model\'s listed price'),
        { name: 'trial_subsidy', usd: round(trialUsd), status: 'recorded', note: 'settled dazl-funded trial runs of measured accounts' },
        { name: 'enrichment', usd: null, status: 'not_recorded', note: 'Apollo / People Data Labs credits have no listed dollar price in dazl, so they are not converted' },
      ],
      model_spend: { token_priced_usd: round(tokenUsd), pool_reported_usd: round(d.researchUsd), counted_usd: round(modelUsd), rule: 'the larger of the two; the spend pool settles the same calls while an owner limit is set, so they are never added' },
      recorded_usd: round(recorded),
      complete: false,
      per_activated_paying: { customers: activatedPaying, usd_lower_bound: activatedPaying ? round(recorded / activatedPaying) : null },
      per_retained_paying: { window_days: RETENTION_DAYS[0], customers: retainedPaying, usd_lower_bound: retainedPaying ? round(recorded / retainedPaying) : null },
    },
    coverage: {
      attribution_known: all.length ? (all.length - totals.attribution.unknown_opted_out) / all.length : 1,
      payment_timeline: { audit: all.filter(c => c.paid_source === 'audit').length, lifecycle_fallback: all.filter(c => c.paid_source === 'lifecycle_fallback').length },
      retention_unknown: all.filter(c => c.paid_at !== null && c.proAt === null).length,
      refund_events: d.billing.filter(e => e.action === 'billing.refunded').length,
      partial_refund_events: d.billing.filter(e => e.action === 'billing.refunded' && parse(e.summary).full !== true).length,
      unmatched_paid_workspaces: unmatchedPaid.size,
      unsettled_trial_reservations: trialRows.filter(t => t.settled_at === null).length,
      notes: [
        ...(d.replyReading ? [] : ['reply reading is off for the growth workspace: positive replies are unobserved, not zero']),
        ...(d.bookingsHook ? [] : ['no Cal.com hook on the growth workspace: bookings are unobserved, not zero']),
        'refunds are seen only when the Stripe webhook endpoint is subscribed to charge.refunded',
      ],
    },
    excluded,
  }
}

// The report for the growth workspace. growthTenant is the configured workspace id; its members are dazl's own people.
export async function funnelReport(db: Db, growthTenant: string, opts: { now?: number; env?: Env } = {}): Promise<FunnelReport> {
  const now = opts.now ?? Math.floor(Date.now() / 1000)
  const staging = isStaging(opts.env ?? process.env)
  const d = await load(db, growthTenant)
  // the growth workspace's members (and, for a personal workspace, its founder) are internal: never customers, and the
  // workspace itself is never a customer's
  const internal = new Set(d.owners.filter(m => m.tenant_id === growthTenant).map(m => m.member_id))
  internal.add(growthTenant)
  return computeFunnel({ ...d, owners: d.owners.filter(m => m.tenant_id !== growthTenant) }, { now, staging, internal, modelUsage: modelUsageEnabled(opts.env ?? process.env) })
}
