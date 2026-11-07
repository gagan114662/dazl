// The versioned, executable evaluation contract (#394): one frozen artifact names the business brief, the exact hard
// constraints, the offer, the event predicates, the time window, the entity/person/contact identity bindings and the
// consent/policy status a lead must satisfy - and scoring one lead against it yields PER-FIELD
// pass/fail/unknown/contradicted verdicts, each with evidence pointers, the contract's as-of, the scorer identity and
// a rationale. Unknown is never pass, and contradicted (two evidence sources actively disagree) is worse than fail,
// never folded into either. Precision denominators count unknowns and contradicted as not-validated; the unknown rate
// is reported separately.
//
// Determinism and autonomy: evaluating the same frozen contract + frozen lead evidence with the same scorer version
// is byte-reproducible (no clocks, no randomness, no network; the clock is the contract's as_of). The evaluator reads
// the contract; it cannot change the brief, the constraints or the targeting to improve a score. No routine
// human-in-the-loop grading, lead approval or benchmark review: the deterministic field scorers below ARE the
// evaluation (extends #372's benchmark, #378's actionable rubric, #393's competitive plan, #204's bounded autonomy).
//
// The four lead tiers are derived from the field verdicts only:
//   source_checked        - the company is real on the cited source and the event date is a real day
//   plausible_buyer       - + the ICP fit fields (place, industry, event predicate)
//   actionable_opportunity- + the event is inside the window, the contact is usable, consent/policy allows action
//   outcome_qualified     - + outcome evidence (reply, meeting, booking) exists
// A tier is reached only when every field it adds passes; any fail, unknown or contradicted blocks it and above.

export const CONTRACT_VERSION = 1
export type FieldStatus = 'pass' | 'fail' | 'unknown' | 'contradicted'
export type LeadTier = 'source_checked' | 'plausible_buyer' | 'actionable_opportunity' | 'outcome_qualified'

export interface HardConstraint {
  field: 'place' | 'industry' | 'event_kind' | 'window_days' | 'contact_kind' | 'consent'
  op: 'equals' | 'in' | 'within_days' | 'not_in'
  value: unknown
  source: string                    // which part of the brief demanded it; a constraint with no source is invalid
}

export interface Contract {
  v: typeof CONTRACT_VERSION
  kind: 'dazl.eval-contract'
  id: string
  brief: { request: string; icp_summary: string }
  constraints: HardConstraint[]                          // exact; missing cannot be silently inferred
  offer: { summary: string }
  event_predicates: { kind: string; description: string }[]
  window: { days: number }
  identity: { entity: string[]; person: string[]; contact: string[] }   // fields that must bind for identity
  consent: { policy: string; channels: string[] }
  as_of: string                                          // ISO timestamp: the evaluation's only clock
  scorer: { id: string; version: number }
}

// The frozen lead evidence a contract is evaluated against. Every pointer names where the fact came from; a field
// left absent is unknown (never inferred), and `contradictions` records evidence that actively disagrees.
export interface LeadEvidence {
  company: string
  entity_domains?: string[]                                // domains the evidence registry binds to the company
  source_url?: string                                      // the cited page
  quote_on_page?: boolean                                  // the cited quote is on that page
  event?: { kind?: string; date?: string; place?: string; industry?: string }
  page_says?: { place?: string; event_date?: string }      // what the cited page itself states (conflict detection)
  contact?: { email?: string; kind?: string }              // kind e.g. 'sales' | 'recruiting' | 'generic'
  consent?: { channel?: string; status?: string }          // e.g. 'granted' | 'not_required' | 'none' | 'revoked'
  outcome?: { type: string; date: string }
}

export interface FieldVerdict {
  field: string
  status: FieldStatus
  rationale: string
  evidence: string[]                                       // pointers: URLs, registry keys, page anchors
  as_of: string
  scorer: { id: string; version: number }
}

export interface LeadEvaluation {
  contract: string; contract_v: typeof CONTRACT_VERSION
  lead: string
  verdicts: FieldVerdict[]
  tier: LeadTier | null
  validated_rate: number | null    // pass / all verdicts; unknowns AND contradicted in the denominator
  unknown_rate: number | null
  contradicted_rate: number | null
  status: 'pass' | 'fail' | 'unknown'   // fail if any fail or contradicted; unknown if any unknown; else pass
  as_of: string
  scorer: { id: string; version: number }
}

export class ContractError extends Error {}

const CONSTRAINT_FIELDS = ['place', 'industry', 'event_kind', 'window_days', 'contact_kind', 'consent']
const CONSTRAINT_OPS = ['equals', 'in', 'within_days', 'not_in']
const REAL_DAY = /^(\d{4})-(\d{2})-(\d{2})$/

export function validateContract(c: unknown): Contract {
  const o = c as Partial<Contract> | null
  const bad = (m: string): never => { throw new ContractError(`contract: ${m}`) }
  if (!o || typeof o !== 'object') { throw new ContractError('contract: not an object') }
  if (o.kind !== 'dazl.eval-contract' || o.v !== CONTRACT_VERSION) bad('kind must be dazl.eval-contract, v 1')
  if (!o.id || typeof o.id !== 'string') bad('id required')
  if (!o.brief || typeof o.brief.request !== 'string' || typeof o.brief.icp_summary !== 'string') bad('brief.request and brief.icp_summary required')
  const constraints = Array.isArray(o.constraints) ? o.constraints : undefined
  if (!constraints || constraints.length === 0) { throw new ContractError('contract: at least one hard constraint required - a brief with no constraints cannot be evaluated without inventing them') }
  for (const h of constraints) {
    if (!h || !CONSTRAINT_FIELDS.includes(h.field) || !CONSTRAINT_OPS.includes(h.op)) bad(`bad constraint ${JSON.stringify(h)}`)
    if (h.value === undefined || h.value === null || h.value === '') bad(`constraint ${h.field} has no value - it cannot be silently inferred`)
    if (typeof h.source !== 'string' || !h.source) bad(`constraint ${h.field} names no source`)
  }
  if (!o.offer || typeof o.offer.summary !== 'string') bad('offer.summary required')
  const eventPredicates = Array.isArray(o.event_predicates) ? o.event_predicates : undefined
  if (!eventPredicates || eventPredicates.length === 0) { throw new ContractError('contract: at least one event predicate required') }
  for (const p of eventPredicates) if (!p.kind || typeof p.description !== 'string') bad(`bad event predicate ${JSON.stringify(p)}`)
  if (!o.window || typeof o.window.days !== 'number' || !(o.window.days > 0)) bad('window.days must be a positive number')
  if (!o.identity || !Array.isArray(o.identity.entity) || !Array.isArray(o.identity.person) || !Array.isArray(o.identity.contact)) bad('identity entity/person/contact field lists required')
  if (!o.consent || typeof o.consent.policy !== 'string' || !Array.isArray(o.consent.channels)) bad('consent.policy and consent.channels required')
  if (typeof o.as_of !== 'string' || !Number.isFinite(Date.parse(o.as_of))) bad('as_of must be an ISO timestamp')
  if (!o.scorer || typeof o.scorer.id !== 'string' || typeof o.scorer.version !== 'number') bad('scorer id and version required')
  return o as Contract
}

const RECRUITING = /recruit|talent|careers|jobs@|hr@/i

// One deterministic scorer per contract field. Each returns the verdict with its evidence pointers; none mutates
// the contract, the lead or the targeting.
function fieldVerdicts(c: Contract, lead: LeadEvidence): FieldVerdict[] {
  const at = c.as_of
  const scorer = c.scorer
  const v = (field: string, status: FieldStatus, rationale: string, evidence: string[] = []): FieldVerdict => ({ field, status, rationale, evidence, as_of: at, scorer })
  const out: FieldVerdict[] = []
  const url = lead.source_url ? [lead.source_url] : []

  // identity.entity: the evidence registry binds at least one domain to the company
  const entityOk = (lead.entity_domains ?? []).length > 0
  out.push(v('identity.entity', entityOk ? 'pass' : 'unknown', entityOk ? `entity bound to ${(lead.entity_domains ?? []).join(', ')}` : 'no domain binding in the evidence registry', lead.entity_domains))

  // source.on_page: the cited page exists and carries the quote
  if (!lead.source_url) out.push(v('source.on_page', 'unknown', 'no source URL cited'))
  else if (lead.quote_on_page === undefined) out.push(v('source.on_page', 'unknown', 'the cited page was not checked for the quote', url))
  else out.push(v('source.on_page', lead.quote_on_page ? 'pass' : 'fail', lead.quote_on_page ? 'the quote is on the cited page' : 'the quote is NOT on the cited page', url))

  // event.date_real: a real calendar day; contradicted when the page itself dates the event differently
  if (!lead.event?.date) out.push(v('event.date_real', 'unknown', 'no event date in the evidence', url))
  else {
    const m = REAL_DAY.exec(lead.event.date)
    const t = m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) : NaN
    const real = m && new Date(t).getUTCDate() === +m[3] && new Date(t).getUTCMonth() === +m[2] - 1
    if (!real) out.push(v('event.date_real', 'fail', `event date ${lead.event.date} is not a real calendar date`, url))
    else if (lead.page_says?.event_date && lead.page_says.event_date !== lead.event.date) out.push(v('event.date_real', 'contradicted', `evidence says ${lead.event.date} but the cited page says ${lead.page_says.event_date}`, url))
    else out.push(v('event.date_real', 'pass', `event date ${lead.event.date} is a real calendar day`, url))
  }

  // event.date_in_window: not after as_of, not older than window.days before it
  const asOf = Date.parse(at)
  const days = c.window.days
  if (!lead.event?.date || !REAL_DAY.test(lead.event.date)) out.push(v('event.date_in_window', 'unknown', 'no usable event date', url))
  else {
    const age = Math.round((asOf - Date.parse(`${lead.event.date}T00:00:00Z`)) / 86_400_000)
    if (age < 0) out.push(v('event.date_in_window', 'fail', `event date ${lead.event.date} is after as_of`, url))
    else if (age > days) out.push(v('event.date_in_window', 'fail', `event is ${age} days before as_of, outside the ${days}-day window`, url))
    else out.push(v('event.date_in_window', 'pass', `event is ${age} days before as_of, inside the ${days}-day window`, url))
  }

  // event.predicate: the event kind is one the contract hunts
  const kinds = c.event_predicates.map(p => p.kind)
  if (!lead.event?.kind) out.push(v('event.predicate', 'unknown', 'no event kind in the evidence', url))
  else out.push(v('event.predicate', kinds.includes(lead.event.kind) ? 'pass' : 'fail', `event kind ${lead.event.kind} ${kinds.includes(lead.event.kind) ? 'is' : 'is not'} a hunted predicate`, url))

  // place / industry constraints, with page-vs-evidence contradiction detection
  for (const field of ['place', 'industry'] as const) {
    const want = c.constraints.filter(h => h.field === field)
    if (want.length === 0) continue
    const got = lead.event?.[field]
    if (!got) { out.push(v(`${field}.matches`, 'unknown', `no ${field} in the evidence`, url)); continue }
    const pageSays = field === 'place' ? lead.page_says?.place : undefined
    if (pageSays && pageSays.toLowerCase() !== got.toLowerCase()) { out.push(v(`${field}.matches`, 'contradicted', `evidence says ${got} but the cited page says ${pageSays}`, url)); continue }
    const ok = want.every(h => h.op === 'equals' ? got.toLowerCase() === String(h.value).toLowerCase() : h.op === 'in' ? (h.value as string[]).some(x => got.toLowerCase().includes(x.toLowerCase())) : true)
    out.push(v(`${field}.matches`, ok ? 'pass' : 'fail', ok ? `${field} ${got} satisfies the constraint` : `${field} ${got} violates the constraint`, url))
  }

  // contact.usable: a contact exists, is not a recruiting inbox, and its domain binds to the company
  if (!lead.contact?.email) out.push(v('contact.usable', 'unknown', 'no contact in the evidence', url))
  else if (lead.contact.kind === 'recruiting' || RECRUITING.test(lead.contact.email)) out.push(v('contact.usable', 'fail', `contact ${lead.contact.email} is a recruiting inbox`, url))
  else {
    const dom = lead.contact.email.split('@')[1]?.toLowerCase()
    const bound = (lead.entity_domains ?? []).some(d => dom === d || dom?.endsWith(`.${d}`))
    out.push(v('contact.usable', bound ? 'pass' : 'fail', bound ? `contact domain ${dom} binds to the company` : `contact domain ${dom} does not bind to the company`, url))
  }

  // consent.status: the contract's policy allows action on the contact's channel
  if (!lead.consent?.status) out.push(v('consent.status', 'unknown', 'no consent/policy state in the evidence'))
  else {
    const ok = lead.consent.status === 'granted' || lead.consent.status === 'not_required'
    const channelOk = !lead.consent.channel || c.consent.channels.length === 0 || c.consent.channels.includes(lead.consent.channel)
    out.push(v('consent.status', ok && channelOk ? 'pass' : 'fail', ok && channelOk ? `consent ${lead.consent.status} under ${c.consent.policy}` : `consent ${lead.consent.status}${channelOk ? '' : ` on disallowed channel ${lead.consent.channel}`} blocks action`))
  }

  // outcome.evidence: an outcome exists with a type and a real date
  if (!lead.outcome) out.push(v('outcome.evidence', 'unknown', 'no outcome in the evidence'))
  else if (!lead.outcome.type || !REAL_DAY.test(lead.outcome.date)) out.push(v('outcome.evidence', 'fail', `outcome lacks a type or a real date`, url))
  else out.push(v('outcome.evidence', 'pass', `outcome ${lead.outcome.type} on ${lead.outcome.date}`, url))

  return out
}

const TIER_FIELDS: [LeadTier, string[]][] = [
  ['source_checked', ['identity.entity', 'source.on_page', 'event.date_real']],
  ['plausible_buyer', ['place.matches', 'industry.matches', 'event.predicate']],
  ['actionable_opportunity', ['event.date_in_window', 'contact.usable', 'consent.status']],
  ['outcome_qualified', ['outcome.evidence']],
]

// Evaluate one lead against the contract. Pure: same contract + same evidence + same scorer version, same bytes.
export function evaluateLead(c: Contract, lead: LeadEvidence): LeadEvaluation {
  const verdicts = fieldVerdicts(c, lead)
  const byField = new Map(verdicts.map(x => [x.field, x]))
  let tier: LeadTier | null = null
  for (const [t, fields] of TIER_FIELDS) {
    // a tier field the constraints never demanded (e.g. no place constraint) is not required
    const need = fields.filter(f => byField.has(f))
    if (need.every(f => byField.get(f)!.status === 'pass')) tier = t
    else break
  }
  const n = verdicts.length
  const count = (s: FieldStatus) => verdicts.filter(x => x.status === s).length
  return {
    contract: c.id, contract_v: CONTRACT_VERSION, lead: lead.company, verdicts, tier,
    validated_rate: n ? count('pass') / n : null,
    unknown_rate: n ? count('unknown') / n : null,
    contradicted_rate: n ? count('contradicted') / n : null,
    status: count('fail') || count('contradicted') ? 'fail' : count('unknown') ? 'unknown' : 'pass',
    as_of: c.as_of, scorer: c.scorer,
  }
}
