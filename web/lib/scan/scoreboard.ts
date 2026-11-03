import { isRecruitingInbox } from '../recruiting-inbox.ts'
import { titleMatches } from '../people/rank.ts'
// Scoreboard: how many leads a scan returns that a salesperson could act on today. This is the number every change
// is judged by (docs/DECISIONS.md, "review before main"). Pure scoring only; scripts/scoreboard.ts runs the scans.
//
// A lead is QUALIFIED when all hold:
//   verified   - the verifier kept it (cited page fetched, quote on page, company named), not a needs-review row
//   recent     - the event is dated within the last 90 days (undated does not count)
//   fit        - the tenant's model graded ICP fit >= 4 of 5
//   reachable  - a contact route exists: a contact on the lead or a contact enrichment holding an email or phone
// "named" (a person's name) is reported but not required: a reachable company inbox is still actionable.

export interface ScoredLeadInput {
  name: string
  contact: string | null
  review_reason: string | null
  event_date: string | null
  fit: number | null
  contacts: string[] // values of contact enrichments for this lead
}

export interface LeadScoreCard { verified: boolean; recent: boolean; fit: boolean; named: boolean; reachable: boolean; qualified: boolean }
export interface SearchScore { leads: number; verified: number; recent: number; fit: number; named: number; reachable: number; qualified: number }

const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i
const PHONE = /\+?\d[\d\s().-]{6,}\d/
export const RECENT_DAYS = 90
export const FIT_MIN = 4

export const isReachable = (v: string | null | undefined): boolean => {
  if (!v) return false
  const emails = v.match(new RegExp(EMAIL.source, 'gi')) ?? []
  if (emails.some(email => !isRecruitingInbox(email))) return true
  // Phone-like digits inside an email are not a separate contact route.
  return PHONE.test(v.replace(new RegExp(EMAIL.source, 'gi'), ''))
}

export function scoreLead(l: ScoredLeadInput, now: Date = new Date()): LeadScoreCard {
  const verified = !l.review_reason
  const age = l.event_date && /^\d{4}-\d{2}-\d{2}$/.test(l.event_date) ? (now.getTime() - Date.parse(`${l.event_date}T00:00:00Z`)) / 86_400_000 : null
  const recent = age !== null && age >= -1 && age <= RECENT_DAYS
  const fit = typeof l.fit === 'number' && l.fit >= FIT_MIN
  const named = l.name.trim().length > 0
  const reachable = isReachable(l.contact) || l.contacts.some(isReachable)
  return { verified, recent, fit, named, reachable, qualified: verified && recent && fit && reachable }
}

export function scoreSearch(leads: ScoredLeadInput[], now: Date = new Date()): SearchScore {
  const s: SearchScore = { leads: leads.length, verified: 0, recent: 0, fit: 0, named: 0, reachable: 0, qualified: 0 }
  for (const l of leads) {
    const c = scoreLead(l, now)
    for (const k of ['verified', 'recent', 'fit', 'named', 'reachable', 'qualified'] as const) if (c[k]) s[k]++
  }
  return s
}

// What this score does NOT yet measure (Instinct review): buyer need beyond a dated public signal, whether the contact
// is the right decision-maker, and consent. It is "qualified v1", stated as such wherever it is shown.
export const SCORE_LIMITS = 'v1 score: verified dated signal + model-graded ICP fit + any email/phone. It does not yet prove buyer need, that the contact is the right decision-maker, or consent.'

export function scoreboardMarkdown(rows: { search: string; status: string; error: string | null; complete?: boolean; score: SearchScore }[], meta: { commit: string; date: string; model?: string; rubric?: string; uniqueQualified?: number; budgetUsd?: number }): string {
  const total = rows.reduce((a, r) => a + r.score.qualified, 0)
  const incomplete = rows.filter(r => r.complete === false).length
  const lines = [
    `# Scoreboard ${meta.date} (commit ${meta.commit})`,
    '',
    `**Qualified leads: ${total}** across ${rows.length} searches${meta.uniqueQualified !== undefined ? `, **${meta.uniqueQualified} unique companies**` : ''} (verified + dated within ${RECENT_DAYS} days + fit >= ${FIT_MIN}/5 + email or phone).`,
    ...(incomplete ? ['', `**${incomplete} of ${rows.length} searches INCOMPLETE** (budget, timeout or key): their counts are not zero results, they are unknown.`] : []),
    ...(meta.model || meta.rubric || meta.budgetUsd ? ['', `Grading model ${meta.model ?? '?'}, rubric ${meta.rubric ?? '?'} (sha256 of lib/scan/score.ts), total budget $${meta.budgetUsd ?? '?'}.`] : []),
    '',
    SCORE_LIMITS,
    '',
    '| Search | Status | Leads | Verified | Recent | Fit | Named | Reachable | Qualified |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...rows.map(r => `| ${r.search.replace(/\|/g, '/')} | ${r.status}${r.error ? ` (${r.error})` : ''} | ${r.score.leads} | ${r.score.verified} | ${r.score.recent} | ${r.score.fit} | ${r.score.named} | ${r.score.reachable} | **${r.score.qualified}** |`),
  ]
  return lines.join('\n') + '\n'
}

// ---------- Rubric v2 (#378) and proof-backed timing (#377) ----------
// v1 above is kept untouched so historical scoreboards stay readable. v2 reports candidate /
// source-checked / fit / current-event / right-person / reachable (email and phone separately) /
// eligible as DISTINCT counters and derives qualified from the same effective gates as the run
// report and the draft guard. The recency window comes from the REQUEST, not a fixed 90 days.
export const RUBRIC_VERSION = 'v2'

// The closed set of recognized event-date proofs (canonical contract with the runner; anything else
// fails closed to "no proof"). NULL means no proof. Written only where the proof is computed; no
// historical backfill.
export type EventDateProof = 'page_bound' | 'ats_structured'
export const isEventDateProof = (v: unknown): v is EventDateProof => v === 'page_bound' || v === 'ats_structured'

export const isCalendarDay = (d: string): boolean => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return false
  const [y, m, dd] = d.split('-').map(Number)
  const t = new Date(Date.UTC(y, m - 1, dd))
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === dd
}

// Strict hiring-trigger test. The multilingual HIRING query regex also matches a bare "Opening ..."
// (an expansion signal), which is fine for a fail-closed fit cap but would fail OPEN here, so this
// rule uses the stored signal kind plus strict hiring wording only. A non-English hiring signal with
// no kind is held unconfirmed (conservative), never upgraded.
const HIRING_EN = /\bhiring\b|\bwe'?re hiring\b|\bjob (posting|opening|ad)\b|\bopen(ing)? (role|position)s?\b|\bvacanc(?:y|ies)\b|\bis (recruiting|looking for an? )/i
// ats_structured proves the POSTING event's date. It supports timing only when the lead's claimed
// trigger is hiring; it is never a funding or other trigger's date.
export const isHiringTrigger = (signal: string | null | undefined, signalKind?: string | null): boolean =>
  signalKind === 'hiring' || signalKind === 'hiring_relevant_role' || HIRING_EN.test(signal ?? '')

// The only path from a stored grade to a NOW claim: a recognized proof that is compatible with the
// lead's trigger, a valid calendar day, strictly not in the future (UTC day contract: age >= 0), and
// inside the REQUEST's window WHEN the request has one. A missing window invents no gate: a
// recognized non-future proof is enough; the upper bound applies only when a window was requested.
export function proofBackedTiming(l: { event_date?: string | null; event_date_proof?: string | null; signal?: string | null; signal_kind?: string | null }, windowDays: number | null | undefined, now: Date = new Date()): boolean {
  if (!isEventDateProof(l.event_date_proof)) return false
  if (l.event_date_proof === 'ats_structured' && !isHiringTrigger(l.signal, l.signal_kind)) return false
  if (!l.event_date || !isCalendarDay(l.event_date)) return false
  const age = (now.getTime() - Date.parse(`${l.event_date}T00:00:00Z`)) / 86_400_000
  if (age < 0) return false
  return windowDays == null || age <= windowDays
}

// Recency wording in a request: the request asks for a CURRENT event but carries no numeric window.
export const TIMING_REQUESTED = /\b(?:recent(?:ly)?|currently|newly|latest|just\s+(?:raised|announced|opened|launched|hired|posted)|(?:hiring|hired|raised|announced|opened|launched|posted)\s+(?:now|recently))\b/i

// Read-side surfacing (#377): a stored intent grade is shown only when the SAME proof rule as the
// write side holds: recognized, trigger-compatible proof, a valid calendar day, strictly not in the
// future, and inside the request's window when the request has one (proofBackedTiming). A request
// that asks for recency without a numeric window has an UNRESOLVED bound: nothing surfaces as
// proof-backed on it. Anything else is held at 0 and labelled unconfirmed. The stored grade is
// never rewritten.
// WHY a stored intent does not surface as proof-backed, ruled out in the SAME order as the surfacing preconditions
// and proofBackedTiming, so card copy can name the actual gap next to the badge instead of a blanket "unconfirmed"
// (#498 whole-card coherence). null = proof-backed. surfaceStoredIntent is defined on this, so the two can never disagree.
export type TimingUnconfirmedReason = 'no_saved_grade' | 'unresolved_recency_bound' | 'no_proof' | 'proof_kind_mismatch' | 'bad_date' | 'future_date' | 'out_of_window'
// The event-DAY proof alone, with no recency-window judgement: true when the cited source is shown to date the event
// (recognized, trigger-compatible proof on a valid past calendar day). Copy about the event day itself keys on this;
// timing qualification still goes through timingUnconfirmedReason, whose unresolved/failed window must NOT negate a
// proven association. The proof predicates MUST stay the same four as timingUnconfirmedReason's proof block below.
export function eventDayVerified(l: { event_date?: string | null; event_date_proof?: string | null; signal?: string | null; signal_kind?: string | null }, opts: { now?: Date } = {}): boolean {
  if (!isEventDateProof(l.event_date_proof)) return false
  if (l.event_date_proof === 'ats_structured' && !isHiringTrigger(l.signal, l.signal_kind)) return false
  if (!l.event_date || !isCalendarDay(l.event_date)) return false
  const age = ((opts.now ?? new Date()).getTime() - Date.parse(`${l.event_date}T00:00:00Z`)) / 86_400_000
  return age >= 0
}

export function timingUnconfirmedReason(l: { intent: number | null; event_date?: string | null; event_date_proof?: string | null; signal?: string | null; signal_kind?: string | null }, opts: { windowDays?: number | null; now?: Date; timingRequired?: boolean } = {}): TimingUnconfirmedReason | null {
  const windowDays = opts.windowDays ?? null
  if (l.intent == null) return 'no_saved_grade'
  if (opts.timingRequired && windowDays == null) return 'unresolved_recency_bound'
  if (!isEventDateProof(l.event_date_proof)) return 'no_proof'
  if (l.event_date_proof === 'ats_structured' && !isHiringTrigger(l.signal, l.signal_kind)) return 'proof_kind_mismatch'
  if (!l.event_date || !isCalendarDay(l.event_date)) return 'bad_date'
  const age = ((opts.now ?? new Date()).getTime() - Date.parse(`${l.event_date}T00:00:00Z`)) / 86_400_000
  if (age < 0) return 'future_date'
  if (windowDays != null && age > windowDays) return 'out_of_window'
  return null
}
export function surfaceStoredIntent(l: { intent: number | null; event_date?: string | null; event_date_proof?: string | null; signal?: string | null; signal_kind?: string | null }, opts: { windowDays?: number | null; now?: Date; timingRequired?: boolean } = {}): { intent: number; timing: 'proof_backed' | 'unconfirmed' } {
  if (timingUnconfirmedReason(l, opts) === null) return { intent: l.intent!, timing: 'proof_backed' }
  return { intent: 0, timing: 'unconfirmed' }
}

// routes are company-published contact routes with role appropriateness already classified by the
// caller (the run/report side uses the same rule as actionable.ts). Nothing is guessed here.
export interface RouteInput { kind: 'email' | 'phone'; value: string; role_ok: boolean }
export interface ScoredLeadInputV2 {
  name: string
  review_reason: string | null
  confidence: number | null
  quarantined: boolean
  excluded: boolean
  held: boolean               // a required gate's pass record could not be saved (the SAME hold the draft guard uses)
  fit: number | null
  company_domain_confirmed: boolean
  person_title: string | null // "<name>, <title>" of the best company-published person; null when none
  routes: RouteInput[]
  event_date: string | null
  event_date_proof: string | null
  signal: string | null
  signal_kind: string | null
  eligible?: boolean | null   // send eligibility when known; null/absent = unknown (reported, never counted)
}
export interface ScoreOptsV2 { who: string; windowDays: number | null; timingRequired: boolean; now?: Date }
export interface LeadScoreCardV2 { source_checked: boolean; fit: boolean; current_event: boolean; right_person: boolean; reachable_email: boolean; reachable_phone: boolean; eligible: boolean; actionable: boolean; proof_backed_actionable: boolean; qualified: boolean }
export interface SearchScoreV2 { leads: number; source_checked: number; fit: number; current_event: number; right_person: number; reachable_email: number; reachable_phone: number; eligible: number; eligible_unknown: number; actionable: number; proof_backed_actionable: number; qualified: number }

// Role match mirrors actionable.ts's personMatchesRole (founder-level or the requested role). Kept as
// a local copy because actionable.ts imports this module; the reconciliation fixture asserts both
// gates agree on the same job.
const FOUNDER_TITLE = /\b(?:founder|co-?founder|ceo|chief executive|managing director|owner|president)\b/i
export function scoreLeadV2(l: ScoredLeadInputV2, opts: ScoreOptsV2): LeadScoreCardV2 {
  const source_checked = !l.review_reason && l.confidence != null
  const fit = typeof l.fit === 'number' && l.fit >= FIT_MIN
  const current_event = proofBackedTiming(l, opts.windowDays, opts.now ?? new Date())
  const title = (l.person_title ?? '').split(',').slice(1).join(',').trim()
  const right_person = title.length > 0 && (FOUNDER_TITLE.test(title) || titleMatches(title, opts.who).length > 0)
  const reachable_email = l.routes.some(r => r.kind === 'email' && r.role_ok && !isRecruitingInbox(r.value))
  const reachable_phone = l.routes.some(r => r.kind === 'phone' && r.role_ok)
  const eligible = l.eligible === true
  const gated = l.quarantined || l.excluded || l.held
  const actionable = source_checked && !gated && fit && l.company_domain_confirmed && right_person && (reachable_email || reachable_phone)
  const proof_backed_actionable = actionable && current_event
  // "qualified / ready": never a rebrand of the timing-free count. When the request carries a timing
  // requirement, proof-backed timing is required; an explicit send-ineligibility always disqualifies.
  // A timing requirement with no numeric window (recency wording only) is an UNRESOLVED bound: the
  // lead is not labelled qualified on an unbounded age check. An explicit window gates as before.
  const qualified = actionable && l.eligible !== false && (opts.timingRequired ? (opts.windowDays != null && current_event) : true)
  return { source_checked, fit, current_event, right_person, reachable_email, reachable_phone, eligible, actionable, proof_backed_actionable, qualified }
}

export function scoreSearchV2(leads: ScoredLeadInputV2[], opts: ScoreOptsV2): SearchScoreV2 {
  const s: SearchScoreV2 = { leads: leads.length, source_checked: 0, fit: 0, current_event: 0, right_person: 0, reachable_email: 0, reachable_phone: 0, eligible: 0, eligible_unknown: 0, actionable: 0, proof_backed_actionable: 0, qualified: 0 }
  for (const l of leads) {
    const c = scoreLeadV2(l, opts)
    for (const k of ['source_checked', 'fit', 'current_event', 'right_person', 'reachable_email', 'reachable_phone', 'actionable', 'proof_backed_actionable', 'qualified'] as const) if (c[k]) s[k]++
    if (c.eligible) s.eligible++
    if (l.eligible == null) s.eligible_unknown++
  }
  return s
}

// What v2 still does NOT measure: actual buyer need beyond the evidenced trigger, and consent. The
// timing-free "actionable" count is always labelled as such; it is never presented as "ready".
export const SCORE_LIMITS_V2 = 'v2 score: source-checked + fit >= ' + FIT_MIN + '/5 + confirmed domain + role-matched person + company-published route; proof_backed adds an event date bound to the company and event on the cited page (or an ATS posting date for a hiring trigger) inside the requested window. It still does not prove buyer need or consent.'

export function scoreboardMarkdownV2(rows: { search: string; status: string; error: string | null; complete?: boolean; score: SearchScoreV2 }[], meta: { commit: string; date: string; model?: string; rubric?: string; uniqueQualified?: number; budgetUsd?: number }): string {
  const total = rows.reduce((a, r) => a + r.score.qualified, 0)
  const incomplete = rows.filter(r => r.complete === false).length
  const lines = [
    `# Scoreboard ${meta.date} (commit ${meta.commit})`,
    '',
    `**Qualified leads: ${total}** across ${rows.length} searches${meta.uniqueQualified !== undefined ? `, **${meta.uniqueQualified} unique companies**` : ''} (rubric ${RUBRIC_VERSION}: source-checked + fit + confirmed domain + role-matched person + published route${rows.length ? ' + proof-backed timing where the request requires it' : ''}).`,
    `The "Actionable" column is actionable with timing not yet proven; "Proof-backed" adds a verified current event inside the requested window. Neither is "ready" on its own unless stated.`,
    ...(incomplete ? ['', `**${incomplete} of ${rows.length} searches INCOMPLETE** (budget, timeout or key): their counts are not zero results, they are unknown.`] : []),
    ...(meta.model || meta.rubric || meta.budgetUsd ? ['', `Grading model ${meta.model ?? '?'}, rubric ${meta.rubric ?? '?'}, total budget $${meta.budgetUsd ?? '?'}.`] : []),
    '',
    SCORE_LIMITS_V2,
    '',
    '| Search | Status | Leads | Source-checked | Fit | Current event | Right person | Email | Phone | Actionable (timing not yet proven) | Proof-backed | Qualified |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...rows.map(r => `| ${r.search.replace(/\|/g, '/')} | ${r.status}${r.error ? ` (${r.error})` : ''} | ${r.score.leads} | ${r.score.source_checked} | ${r.score.fit} | ${r.score.current_event} | ${r.score.right_person} | ${r.score.reachable_email} | ${r.score.reachable_phone} | ${r.score.actionable} | ${r.score.proof_backed_actionable} | **${r.score.qualified}** |`),
  ]
  return lines.join('\n') + '\n'
}
