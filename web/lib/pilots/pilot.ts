// Outcome-based autonomous pilots (#399; docs/design/pilots.md). A pilot is an opt-in customer experiment that runs,
// without per-message approval, strictly inside an authority the customer configured once: audience and exclusions,
// offers, channels, sender identity, volume, spend, time horizon and stop conditions. Pure engine: the sender, the clock and
// the outcome feed are ports; this module never sends anything itself, and only stub senders exist in this repository.
//
//  - Launch is not authority. A pilot runs `staging` (a stub sender) unless its authority is a separately configured,
//    customer-signed record with a verified sender and finite volume and spend bounds AND the deployment allows live pilots
//    (DAZL_PILOTS_LIVE=1). An issue, a plan or a test is never that record.
//  - One arm per prospect. Eligible accounts are assigned to arms by a seeded hash, stratified by cohort. An account whose
//    contact address or domain is already in another arm is skipped, so no prospect hears from two competing arms.
//  - Fail closed, no approvals. An account with an unverified identity or contact, outside the audience, excluded, or
//    needing anything the authority does not cover (an unapproved offer or channel, another sender) is skipped or
//    escalated with its reason. Nobody is asked to approve messages; uncertainty holds.
//  - Idempotent and stoppable. Every action has a stable id; a retry after a crash never sends twice. A pilot can be paused
//    and resumed, and stops on its own at the horizon, on a health anomaly (bounce or complaint rate over its bound) or when
//    the budget or volume is spent. A reply, opt-out or bounce stops that prospect's follow-ups at once; an opt-out also
//    suppresses the address for every arm.
//  - Outcomes, not opens. Reported per arm with denominators and intervals: qualified conversations (an independent
//    qualifier's verdict, unknown is not qualified), held meetings (scheduled, cancelled and no-show are not held), cost
//    per outcome, complaints, opt-outs, bounces. Only events with this pilot's provenance count: benchmark-generated or
//    other emails never demonstrate business lift.
//  - Auditable. Every decision is appended to a log with its provenance; replaying the log rebuilds the state exactly.
import { createHash } from 'node:crypto'

export type Channel = 'email'
export interface Arm { id: string; offer_id: string; sequence: { step: number; delay_days: number; template_ref: string }[] }
export interface Authority {
  pilot_id: string; tenant_id: string
  customer_authorization: { signed_by: string; signed_at: string; record_ref: string } | null   // the customer's own opt-in, configured separately
  audience: { cohorts: string[]; countries: string[] }
  exclusions: { domains: string[]; emails: string[]; companies: string[] }
  offers: string[]; channels: Channel[]
  sender: { identity: string; verified: boolean }
  volume: { max_contacts: number; max_sends_per_day: number }
  spend: { max_usd: number; usd_per_send: number }
  horizon: { start: string; end: string }               // days, inclusive
  stop: { max_bounce_rate: number; max_complaint_rate: number; min_sends_for_rates: number }
  arms: Arm[]; seed: number
}
export interface Account {
  key: string; company: string; domain: string; country: string; cohort: string
  contact: { email: string; verified: boolean } | null
  identity_verified: boolean                             // the identity / date / contact gates already passed (fail-closed upstream)
  needs?: { offer?: string; channel?: string; sender?: string }   // anything this account would need beyond the authority
}

export class PilotError extends Error {}
const sha = (s: string) => createHash('sha256').update(s).digest('hex')
const domainOf = (email: string) => email.slice(email.lastIndexOf('@') + 1).toLowerCase()

export type Mode = 'staging' | 'live'
// Whether a pilot may use a real sender. Everything must hold; the reasons say what is missing.
export function liveGate(a: Authority, env: Record<string, string | undefined> = process.env): { mode: Mode; missing: string[] } {
  const missing: string[] = []
  if (!a.customer_authorization) missing.push('no customer authorization record (an issue or plan is not launch authority)')
  if (!a.sender.verified) missing.push(`sender ${a.sender.identity} is not verified`)
  if (!(Number.isFinite(a.volume.max_contacts) && a.volume.max_contacts > 0 && Number.isFinite(a.volume.max_sends_per_day) && a.volume.max_sends_per_day > 0)) missing.push('volume bounds must be finite and positive')
  if (!(Number.isFinite(a.spend.max_usd) && a.spend.max_usd > 0 && a.spend.usd_per_send > 0)) missing.push('spend bounds must be finite and positive')
  if (env.DAZL_PILOTS_LIVE !== '1') missing.push('live pilots are not enabled for this deployment (DAZL_PILOTS_LIVE)')
  return { mode: missing.length ? 'staging' : 'live', missing }
}

export function checkAuthority(a: Authority): Authority {
  const p: string[] = []
  if (!a.arms.length) p.push('at least one arm')
  for (const arm of a.arms) { if (!a.offers.includes(arm.offer_id)) p.push(`arm ${arm.id}: offer ${arm.offer_id} is not approved`); if (!arm.sequence.length) p.push(`arm ${arm.id}: empty sequence`) }
  if (new Set(a.arms.map(x => x.id)).size !== a.arms.length) p.push('arm ids are unique')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(a.horizon.start) || !/^\d{4}-\d{2}-\d{2}$/.test(a.horizon.end) || a.horizon.end < a.horizon.start) p.push('horizon start <= end, as days')
  if (!(a.stop.max_bounce_rate > 0 && a.stop.max_complaint_rate >= 0 && a.stop.min_sends_for_rates >= 1)) p.push('stop conditions are set')
  if (p.length) throw new PilotError(`pilot ${a.pilot_id}: ${p.join('; ')}`)
  return a
}
export const authorityHash = (a: Authority) => sha(JSON.stringify(a))

// --- assignment -----------------------------------------------------------------------------------------------------

export interface Assignment { account: string; arm: string; cohort: string; email: string }
export interface Skip { account: string; reason: string; escalate: boolean }
// Eligibility, then a seeded, cohort-stratified split. The order of `accounts` does not matter.
export function assignArms(a: Authority, accounts: Account[]): { assigned: Assignment[]; skipped: Skip[] } {
  const skipped: Skip[] = []; const eligible: Account[] = []
  const ex = { d: new Set(a.exclusions.domains.map(x => x.toLowerCase())), e: new Set(a.exclusions.emails.map(x => x.toLowerCase())), c: new Set(a.exclusions.companies.map(x => x.toLowerCase())) }
  for (const acc of [...accounts].sort((x, y) => x.key.localeCompare(y.key))) {
    const email = acc.contact?.email.toLowerCase() ?? null
    const why = !acc.identity_verified ? 'identity not verified: held'
      : !acc.contact || !acc.contact.verified ? 'no verified contact: held'
      : !a.audience.cohorts.includes(acc.cohort) ? `cohort ${acc.cohort} is outside the approved audience`
      : !a.audience.countries.includes(acc.country) ? `country ${acc.country} is outside the approved audience`
      : ex.d.has(acc.domain.toLowerCase()) || ex.d.has(domainOf(email!)) || ex.e.has(email!) || ex.c.has(acc.company.toLowerCase()) ? 'excluded by the authority'
      : acc.needs?.offer && !a.offers.includes(acc.needs.offer) ? `needs offer ${acc.needs.offer}, which is not approved`
      : acc.needs?.channel && !a.channels.includes(acc.needs.channel as Channel) ? `needs channel ${acc.needs.channel}, which is not approved`
      : acc.needs?.sender && acc.needs.sender !== a.sender.identity ? `needs sender ${acc.needs.sender}, not the authorized one`
      : null
    if (why) { skipped.push({ account: acc.key, reason: why, escalate: /needs /.test(why) }); continue }
    eligible.push(acc)
  }
  const assigned: Assignment[] = []; const emails = new Set<string>(); const domains = new Set<string>()
  const byCohort = new Map<string, Account[]>()
  for (const acc of eligible) byCohort.set(acc.cohort, [...(byCohort.get(acc.cohort) ?? []), acc])
  for (const [cohort, accs] of [...byCohort.entries()].sort()) {
    // within a cohort: a seeded order, then arms in turn, so arms are balanced in every cohort
    const ordered = [...accs].sort((x, y) => sha(`${a.seed}|${x.key}`).localeCompare(sha(`${a.seed}|${y.key}`)))
    let k = 0
    for (const acc of ordered) {
      const email = acc.contact!.email.toLowerCase(), dom = acc.domain.toLowerCase()
      if (emails.has(email) || domains.has(dom)) { skipped.push({ account: acc.key, reason: 'the same prospect (address or domain) is already in the pilot: never contacted from two arms', escalate: false }); continue }
      if (assigned.length >= a.volume.max_contacts) { skipped.push({ account: acc.key, reason: 'the authorized contact volume is full', escalate: false }); continue }
      emails.add(email); domains.add(dom)
      assigned.push({ account: acc.key, arm: a.arms[(k + (sha(`${a.seed}|${cohort}`).charCodeAt(0) % a.arms.length)) % a.arms.length].id, cohort, email })
      k++
    }
  }
  return { assigned, skipped }
}

// --- the engine -----------------------------------------------------------------------------------------------------

export type ProspectState = 'active' | 'replied' | 'opted_out' | 'bounced' | 'done'
export type PilotStatus = 'running' | 'paused' | 'stopped'
export interface Provenance { pilot_id: string; arm: string; account: string; action_id?: string }
export type LogEntry =
  | { t: 'assign'; at: string; assignment: Assignment }
  | { t: 'skip'; at: string; skip: Skip }
  | { t: 'send'; at: string; action_id: string; account: string; arm: string; step: number; usd: number; mode: Mode }
  | { t: 'send_failed'; at: string; action_id: string; account: string; reason: string }
  | { t: 'event'; at: string; event: OutcomeEvent }
  | { t: 'status'; at: string; status: PilotStatus; reason: string }
export type OutcomeEvent =
  | { kind: 'reply'; account: string; provenance: Provenance; qualification: 'qualified' | 'not_qualified' | 'unknown' }
  | { kind: 'opt_out'; account: string; provenance: Provenance }
  | { kind: 'bounce'; account: string; provenance: Provenance }
  | { kind: 'complaint'; account: string; provenance: Provenance }
  | { kind: 'meeting'; account: string; provenance: Provenance; meeting_id: string; status: 'scheduled' | 'held' | 'cancelled' | 'no_show' }

export interface PilotState {
  status: PilotStatus; status_reason: string
  prospects: Map<string, { arm: string; email: string; state: ProspectState; next_step: number; last_sent: string | null }>
  sent: Set<string>; suppressed: Set<string>; spent_usd: number; sends_by_day: Map<string, number>
  sends: number; bounces: number; complaints: number
  events: OutcomeEvent[]; foreign_events: number
}
export interface SendPort { send(m: { action_id: string; to: string; from: string; arm: string; step: number; template_ref: string; offer_id: string }): Promise<{ ok: true } | { ok: false; reason: string }> }
// The only sender in this repository: records what it was asked to send and sends nothing.
export const stubSender = (): SendPort & { outbox: Parameters<SendPort['send']>[0][] } => { const outbox: Parameters<SendPort['send']>[0][] = []; return { outbox, send: async m => { outbox.push(m); return { ok: true } } } }

const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10)

export function emptyState(): PilotState {
  return { status: 'running', status_reason: 'started', prospects: new Map(), sent: new Set(), suppressed: new Set(), spent_usd: 0, sends_by_day: new Map(), sends: 0, bounces: 0, complaints: 0, events: [], foreign_events: 0 }
}

// Applies one log entry. Used both while running and to replay a log: the same log always rebuilds the same state.
export function apply(a: Authority, s: PilotState, e: LogEntry): void {
  if (e.t === 'assign') s.prospects.set(e.assignment.account, { arm: e.assignment.arm, email: e.assignment.email, state: 'active', next_step: 1, last_sent: null })
  else if (e.t === 'send') {
    const p = s.prospects.get(e.account)!
    s.sent.add(e.action_id); s.spent_usd = Math.round((s.spent_usd + e.usd) * 1e6) / 1e6; s.sends++
    s.sends_by_day.set(e.at, (s.sends_by_day.get(e.at) ?? 0) + 1)
    p.next_step = e.step + 1; p.last_sent = e.at
    const arm = a.arms.find(x => x.id === p.arm)!
    if (p.next_step > arm.sequence.length) p.state = 'done'
  } else if (e.t === 'status') { s.status = e.status; s.status_reason = e.reason }
  else if (e.t === 'event') {
    const ev = e.event
    if (ev.provenance.pilot_id !== a.pilot_id || !s.prospects.has(ev.account) || s.prospects.get(ev.account)!.arm !== ev.provenance.arm) { s.foreign_events++; return } // not this pilot's: never an outcome
    s.events.push(ev)
    const p = s.prospects.get(ev.account)!
    if (ev.kind === 'reply' && p.state === 'active') p.state = 'replied'
    if (ev.kind === 'reply' && p.state === 'done') p.state = 'replied'
    if (ev.kind === 'opt_out') { p.state = 'opted_out'; s.suppressed.add(p.email) }
    if (ev.kind === 'bounce') { p.state = 'bounced'; s.bounces++ }
    if (ev.kind === 'complaint') { s.complaints++; s.suppressed.add(p.email); if (p.state === 'active') p.state = 'opted_out' }
  }
}

export interface Pilot { authority: Authority; mode: Mode; log: LogEntry[]; state: PilotState }
export function startPilot(a: Authority, accounts: Account[], env?: Record<string, string | undefined>, at = a.horizon.start): Pilot {
  checkAuthority(a)
  const p: Pilot = { authority: a, mode: liveGate(a, env).mode, log: [], state: emptyState() }
  const { assigned, skipped } = assignArms(a, accounts)
  for (const x of assigned) record(p, { t: 'assign', at, assignment: x })
  for (const x of skipped) record(p, { t: 'skip', at, skip: x })
  return p
}
const record = (p: Pilot, e: LogEntry) => { p.log.push(e); apply(p.authority, p.state, e) }
export const replay = (a: Authority, log: LogEntry[]): PilotState => { const s = emptyState(); for (const e of log) apply(a, s, e); return s }

export const pause = (p: Pilot, at: string, reason: string) => { if (p.state.status === 'running') record(p, { t: 'status', at, status: 'paused', reason }) }
export const resume = (p: Pilot, at: string) => { if (p.state.status === 'paused') record(p, { t: 'status', at, status: 'running', reason: 'resumed' }) }
export const ingest = (p: Pilot, at: string, ev: OutcomeEvent) => { record(p, { t: 'event', at, event: ev }); checkHealth(p, at) }

function checkHealth(p: Pilot, at: string) {
  const s = p.state, st = p.authority.stop
  if (s.status === 'stopped' || s.sends < st.min_sends_for_rates) return
  if (s.bounces / s.sends > st.max_bounce_rate) record(p, { t: 'status', at, status: 'stopped', reason: `health: bounce rate ${(s.bounces / s.sends).toFixed(3)} over ${st.max_bounce_rate}` })
  else if (s.complaints / s.sends > st.max_complaint_rate) record(p, { t: 'status', at, status: 'stopped', reason: `health: complaint rate ${(s.complaints / s.sends).toFixed(3)} over ${st.max_complaint_rate}` })
}

// One scheduling pass for `day`: every active prospect whose next step is due gets it, within the day's volume, the
// spend bound and the horizon. Re-running the same day is a no-op for actions already sent.
export async function tick(p: Pilot, day: string, sender: SendPort): Promise<{ sent: number; skipped: string[] }> {
  const a = p.authority, s = p.state, notes: string[] = []
  if (s.status !== 'running') return { sent: 0, skipped: [`pilot is ${s.status}: ${s.status_reason}`] }
  if (day > a.horizon.end) { record(p, { t: 'status', at: day, status: 'stopped', reason: 'horizon reached' }); return { sent: 0, skipped: ['horizon reached'] } }
  if (day < a.horizon.start) return { sent: 0, skipped: ['before the horizon'] }
  let sent = 0
  for (const [account, pr] of [...s.prospects.entries()].sort(([x], [y]) => x.localeCompare(y))) {
    if (s.status !== 'running') break
    if (pr.state !== 'active') continue
    if (s.suppressed.has(pr.email)) { notes.push(`${account}: suppressed`); continue }
    const arm = a.arms.find(x => x.id === pr.arm)!
    const step = arm.sequence.find(x => x.step === pr.next_step)
    if (!step) continue
    if (pr.last_sent && addDays(pr.last_sent, step.delay_days) > day) continue
    const action_id = sha(`${a.pilot_id}|${account}|${step.step}`).slice(0, 24)
    if (s.sent.has(action_id)) continue                                            // idempotent: never twice
    if ((s.sends_by_day.get(day) ?? 0) >= a.volume.max_sends_per_day) { notes.push('daily volume reached'); break }
    if (s.spent_usd + a.spend.usd_per_send > a.spend.max_usd) { record(p, { t: 'status', at: day, status: 'stopped', reason: 'spend bound reached' }); break }
    const r = await sender.send({ action_id, to: pr.email, from: a.sender.identity, arm: arm.id, step: step.step, template_ref: step.template_ref, offer_id: arm.offer_id })
    if (!r.ok) { record(p, { t: 'send_failed', at: day, action_id, account, reason: r.reason }); continue }
    record(p, { t: 'send', at: day, action_id, account, arm: arm.id, step: step.step, usd: a.spend.usd_per_send, mode: p.mode }); sent++
  }
  return { sent, skipped: notes }
}

// --- outcomes -------------------------------------------------------------------------------------------------------

// Wilson score interval for a proportion (95% by default); null with no denominator.
export function wilson(k: number, n: number, z = 1.96): [number, number] | null {
  if (n <= 0) return null
  const ph = k / n, d = 1 + z * z / n, c = ph + z * z / (2 * n), m = z * Math.sqrt(ph * (1 - ph) / n + z * z / (4 * n * n))
  return [Math.round(((c - m) / d) * 1e4) / 1e4, Math.round(((c + m) / d) * 1e4) / 1e4]
}
export interface ArmOutcome {
  arm: string; contacted: number
  qualified_conversations: number; qualified_rate: [number, number] | null
  replies: number; replies_unknown_qualification: number
  meetings_held: number; held_rate: [number, number] | null; meetings_not_held: { cancelled: number; no_show: number; scheduled: number }
  opt_outs: number; bounces: number; complaints: number
  spend_usd: number; cost_per_qualified_usd: number | null; cost_per_held_meeting_usd: number | null
}
export interface PilotReport { pilot_id: string; mode: Mode; status: PilotStatus; status_reason: string; arms: ArmOutcome[]; skipped: number; escalated: Skip[]; foreign_events_ignored: number; note: string }

export function report(p: Pilot): PilotReport {
  const s = p.state
  const arms = p.authority.arms.map(arm => {
    const mine = [...s.prospects.entries()].filter(([, x]) => x.arm === arm.id).map(([k]) => k)
    const contacted = mine.filter(k => p.log.some(e => e.t === 'send' && e.account === k)).length
    const ev = s.events.filter(e => e.provenance.arm === arm.id)
    const firstReply = new Map<string, OutcomeEvent>(); for (const e of ev) if (e.kind === 'reply' && !firstReply.has(e.account)) firstReply.set(e.account, e)
    const qualified = new Set(ev.filter(e => e.kind === 'reply' && e.qualification === 'qualified').map(e => e.account)).size
    // a meeting's LAST status counts: scheduled-then-held is held, held-then-cancelled is not
    const lastMeeting = new Map<string, Extract<OutcomeEvent, { kind: 'meeting' }>>(); for (const e of ev) if (e.kind === 'meeting') lastMeeting.set(e.meeting_id, e)
    const held = new Set([...lastMeeting.values()].filter(m => m.status === 'held').map(m => m.account)).size
    const notHeld = { cancelled: 0, no_show: 0, scheduled: 0 }; for (const m of lastMeeting.values()) if (m.status !== 'held') notHeld[m.status]++
    const spend = Math.round(p.log.filter(e => e.t === 'send' && e.arm === arm.id).reduce((x, e) => x + (e as { usd: number }).usd, 0) * 1e6) / 1e6
    return {
      arm: arm.id, contacted,
      qualified_conversations: qualified, qualified_rate: wilson(qualified, contacted),
      replies: firstReply.size, replies_unknown_qualification: [...firstReply.keys()].filter(k => !ev.some(e => e.kind === 'reply' && e.account === k && e.qualification !== 'unknown')).length,
      meetings_held: held, held_rate: wilson(held, contacted), meetings_not_held: notHeld,
      opt_outs: new Set(ev.filter(e => e.kind === 'opt_out').map(e => e.account)).size, bounces: new Set(ev.filter(e => e.kind === 'bounce').map(e => e.account)).size, complaints: ev.filter(e => e.kind === 'complaint').length,
      spend_usd: spend, cost_per_qualified_usd: qualified ? Math.round((spend / qualified) * 100) / 100 : null, cost_per_held_meeting_usd: held ? Math.round((spend / held) * 100) / 100 : null,
    }
  })
  const skips = p.log.filter((e): e is Extract<LogEntry, { t: 'skip' }> => e.t === 'skip').map(e => e.skip)
  return {
    pilot_id: p.authority.pilot_id, mode: p.mode, status: s.status, status_reason: s.status_reason, arms, skipped: skips.length, escalated: skips.filter(x => x.escalate), foreign_events_ignored: s.foreign_events,
    note: p.mode === 'staging' ? 'STAGING: stub sender, nothing was sent; these are not customer outcomes' : 'live pilot outcomes, this pilot\'s own provenance only; benchmark or other emails are never counted as lift',
  }
}
