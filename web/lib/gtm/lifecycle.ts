// dazl's own acquisition lifecycle (#404): prospect -> qualified conversation -> signup -> first usable result ->
// repeat useful run -> paid -> retained. Activation is delivered value (a finished run with at least one usable lead),
// not a key entered or a scan started. Each customer is counted once however many visits, messages or plays touched
// them; events replay idempotently by id. Attribution is first-party and labelled honestly: 'direct' when the signup
// itself came through a dazl outreach link the person consented to, 'assisted' when an earlier outreach touch matched
// the same identity, otherwise 'unknown'. Nothing here is causal credit: a tagged URL alone never proves the outreach
// caused the signup. Synthetic and staging rows are excluded before counting.

export type LifecycleEvent =
  | { id: string; at: number; customer: string; kind: 'touch'; channel: string; identity: string | null }   // outreach touch, matched identity if any
  | { id: string; at: number; customer: string; kind: 'conversation'; qualified: boolean }
  | { id: string; at: number; customer: string; kind: 'signup'; viaTaggedLink: boolean; consented: boolean; identity: string | null }
  | { id: string; at: number; customer: string; kind: 'setup'; step: 'key' | 'mailbox' | 'offer' }
  | { id: string; at: number; customer: string; kind: 'run'; status: 'done' | 'failed'; usableLeads: number }
  | { id: string; at: number; customer: string; kind: 'payment'; status: 'paid' | 'failed' | 'refunded' }
  | { id: string; at: number; customer: string; kind: 'cancel' }
  | { id: string; at: number; customer: string; kind: 'cost'; usd: number; what: 'research' | 'enrichment' | 'evaluation' | 'model' | 'send' }

export interface CustomerMeta { customer: string; synthetic: boolean; staging: boolean }

export type Stage = 'prospect' | 'qualified' | 'signed_up' | 'abandoned_setup' | 'zero_result' | 'activated' | 'repeat' | 'paid' | 'payment_failed' | 'refunded' | 'churned' | 'lapsed' | 'retained'
export type Attribution = 'direct' | 'assisted' | 'unknown'

export const DAY = 86400_000
export const REPEAT_GAP_DAYS = 1      // a second useful run on a later day, not a retry minutes later
// Retention is shown by payments, never by time alone: one early payment is not retention however long ago it was.
// A customer is retained when a successful payment landed at least RETAINED_DAYS after their first one AND their
// latest successful payment still covers today (one monthly period plus grace). Paying once and then going quiet,
// with no cancel event, is 'lapsed'. See docs/notes/retention-definition.md for how this compares with the ops
// funnel's 25/35-day definition.
export const RETAINED_DAYS = 60       // a successful payment at least this long after the first one
export const PAYMENT_GRACE_DAYS = 5   // a renewal may land this late without the customer counting as lapsed
export const PAID_COVER_DAYS = 30 + PAYMENT_GRACE_DAYS                  // one monthly period plus grace
export const RETENTION_MATURE_DAYS = RETAINED_DAYS + PAYMENT_GRACE_DAYS  // first payment old enough for that renewal to be due
export const ABANDON_DAYS = 7         // signed up, no finished run within this window

export interface CustomerState {
  customer: string; stage: Stage; attribution: Attribution
  signupAt: number | null; activatedAt: number | null; paidAt: number | null; lastPaidAt: number | null; renewedAt: number | null
  usefulRuns: number; zeroResultRuns: number; costUsd: number
}

// One as-of cutoff for every row, whatever its kind (signups, runs, payments, costs): a row dated after asOf has not
// happened yet as far as this report is concerned, so a future-dated or replayed-late row never counts. The cutoff is
// applied before de-duplication, so a replay of an id with a later date cannot displace the original.
export function upTo(events: LifecycleEvent[], asOf: number): LifecycleEvent[] {
  return events.filter(e => Number.isFinite(e.at) && e.at <= asOf)
}

function dedupe(events: LifecycleEvent[]): LifecycleEvent[] {
  const seen = new Set<string>()
  return events.filter(e => (seen.has(e.id) ? false : (seen.add(e.id), true))).sort((a, b) => a.at - b.at || a.id.localeCompare(b.id))
}

export function customerState(customer: string, events: LifecycleEvent[], now: number): CustomerState {
  const ev = dedupe(upTo(events, now).filter(e => e.customer === customer))
  const s: CustomerState = { customer, stage: 'prospect', attribution: 'unknown', signupAt: null, activatedAt: null, paidAt: null, lastPaidAt: null, renewedAt: null, usefulRuns: 0, zeroResultRuns: 0, costUsd: 0 }
  let qualified = false, ranAny = false, paying = false, refunded = false, cancelled = false, paymentFailed = false
  const usefulDays = new Set<number>()
  for (const e of ev) {
    if (e.kind === 'cost') s.costUsd += e.usd
    else if (e.kind === 'conversation' && e.qualified) qualified = true
    else if (e.kind === 'signup' && s.signupAt === null) {
      s.signupAt = e.at
      const touched = ev.some(t => t.kind === 'touch' && t.at <= e.at && t.identity !== null && t.identity === e.identity)
      s.attribution = e.viaTaggedLink && e.consented && touched ? 'direct' : touched ? 'assisted' : 'unknown'
    } else if (e.kind === 'run' && s.signupAt !== null) {
      ranAny = ranAny || e.status === 'done'
      if (e.status === 'done' && e.usableLeads > 0) {
        s.activatedAt ??= e.at
        usefulDays.add(Math.floor(e.at / (REPEAT_GAP_DAYS * DAY)))
      } else if (e.status === 'done') s.zeroResultRuns++
    } else if (e.kind === 'payment') {
      if (e.status === 'paid') {
        paying = true; paymentFailed = false; refunded = false; s.paidAt ??= e.at; s.lastPaidAt = e.at
        if (s.renewedAt === null && e.at - s.paidAt >= RETAINED_DAYS * DAY) s.renewedAt = e.at
      }
      else if (e.status === 'failed') { paymentFailed = true }
      else { refunded = true; paying = false }
    } else if (e.kind === 'cancel') { cancelled = true; paying = false }
  }
  s.usefulRuns = usefulDays.size
  if (s.signupAt === null) { s.stage = qualified ? 'qualified' : 'prospect'; return s }
  // Money states first: what the customer did last with billing decides, then value delivered.
  if (refunded) s.stage = 'refunded'
  else if (cancelled && s.paidAt !== null) s.stage = 'churned'
  else if (paymentFailed) s.stage = 'payment_failed'
  else if (paying && s.lastPaidAt !== null && now - s.lastPaidAt > PAID_COVER_DAYS * DAY) s.stage = 'lapsed'
  else if (paying && s.renewedAt !== null) s.stage = 'retained'
  else if (paying) s.stage = 'paid'
  else if (s.usefulRuns >= 2) s.stage = 'repeat'
  else if (s.activatedAt !== null) s.stage = 'activated'
  else if (ranAny) s.stage = 'zero_result'
  else if (now - s.signupAt >= ABANDON_DAYS * DAY) s.stage = 'abandoned_setup'
  else s.stage = 'signed_up'
  return s
}

export interface CohortReport {
  cohortStart: number; cohortEnd: number; mature: boolean
  customers: number; byStage: Partial<Record<Stage, number>>; byAttribution: Record<Attribution, number>
  activationRate: number | null; paidRate: number | null
  retentionRate: number | null   // retained / retentionMature, both over the same eligible set
  retentionMature: number        // paying customers whose first payment is old enough for the renewal to be due
  costUsd: number; costPerActivated: number | null; costPerRetainedPaying: number | null
  sourceCoverage: number | null  // share of signups whose attribution is known (direct or assisted)
  excluded: number               // synthetic or staging customers left out
}

const rate = (a: number, b: number) => (b === 0 ? null : a / b)

// One signup cohort: customers who signed up in [start, end). Immature until the retention window has passed for the
// whole cohort, so a young cohort's retention is never read as final. Within any cohort, only customers whose first
// payment is at least RETENTION_MATURE_DAYS old count toward the retention rate.
export function cohortReport(events: LifecycleEvent[], meta: CustomerMeta[], start: number, end: number, now: number): CohortReport {
  const excludedIds = new Set(meta.filter(m => m.synthetic || m.staging).map(m => m.customer))
  const ids = [...new Set(upTo(events, now).map(e => e.customer))]
  const states = ids.filter(id => !excludedIds.has(id)).map(id => customerState(id, events, now)).filter(s => s.signupAt !== null && s.signupAt >= start && s.signupAt < end)
  const byStage: Partial<Record<Stage, number>> = {}
  const byAttribution: Record<Attribution, number> = { direct: 0, assisted: 0, unknown: 0 }
  for (const s of states) { byStage[s.stage] = (byStage[s.stage] ?? 0) + 1; byAttribution[s.attribution]++ }
  const activated = states.filter(s => s.activatedAt !== null).length
  const paidEver = states.filter(s => s.paidAt !== null).length
  // Retention uses one eligible set for both sides of the rate: paying customers whose first payment is old enough for
  // the renewal to be due. A retained customer who is not yet mature is in neither, so the rate can never exceed 100%.
  const eligible = states.filter(s => s.paidAt !== null && now - s.paidAt >= RETENTION_MATURE_DAYS * DAY)
  const retentionMature = eligible.length
  const retained = eligible.filter(s => s.stage === 'retained').length
  const costUsd = Math.round(states.reduce((t, s) => t + s.costUsd, 0) * 100) / 100
  return {
    cohortStart: start, cohortEnd: end, mature: now - end >= RETENTION_MATURE_DAYS * DAY,
    customers: states.length, byStage, byAttribution,
    activationRate: rate(activated, states.length), paidRate: rate(paidEver, states.length), retentionRate: rate(retained, retentionMature), retentionMature,
    costUsd, costPerActivated: activated ? costUsd / activated : null, costPerRetainedPaying: retained ? costUsd / retained : null,
    sourceCoverage: rate(byAttribution.direct + byAttribution.assisted, states.length),
    excluded: ids.filter(id => excludedIds.has(id)).length,
  }
}
