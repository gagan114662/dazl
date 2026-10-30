// The lead-evaluation contract (#394), versioned: what an evaluation of one verified lead says, field by field, and which
// tier of lead it validates. The independent evaluators (./evaluators.ts) produce the verdicts; this file only assembles
// them, so the scan's own checks are never its judge. Shared vocabulary with the product's yield report
// (lib/scan/actionable.ts, #378): "source-checked" and "actionable".
//
// Tiers are cumulative; each needs every field of the tiers below it:
//   source_checked          the quote is on the cited page AND the event date is real, in the window and stated in the text
//   plausible_buyer         + the cited page names a requested place (or the brief names none) AND ICP fit >= FIT_MIN
//   actionable_opportunity  + a contact at the company's own domain that is not a hiring inbox AND a consent/policy record
//   outcome_qualified       + an observed outcome (qualified reply / held meeting, #399)
// A tier is pass only when every required field passes; fail when any is fail or contradicted; otherwise unknown. Unknown is
// never pass, and tier rates count unknowns in the denominator (not validated) with the unknown rate reported separately.
// A scan replay has no consent or outcome record, so its leads never reach the top two tiers: that is reported, not hidden.
import { FIT_MIN } from '../scan/scoreboard.ts'
import type { EvalContext, Evaluator, Verdict, VerdictStatus } from './evaluators.ts'

export const LEAD_CONTRACT = 'dazl.lead-eval/1'
export type Field = 'evidence' | 'event_date' | 'place' | 'fit' | 'contact' | 'consent' | 'outcome'
export type Tier = 'source_checked' | 'plausible_buyer' | 'actionable_opportunity' | 'outcome_qualified'
export type TierStatus = 'pass' | 'fail' | 'unknown'
export const TIERS: { tier: Tier; fields: Field[] }[] = [
  { tier: 'source_checked', fields: ['evidence', 'event_date'] },
  { tier: 'plausible_buyer', fields: ['place', 'fit'] },
  { tier: 'actionable_opportunity', fields: ['contact', 'consent'] },
  { tier: 'outcome_qualified', fields: ['outcome'] },
]
// Which evaluator speaks to which field. An evaluator not listed here is run-level (world_closed, no_tenant_leak) or
// case-level (expected_outcomes).
export const FIELD_OF: Record<string, Field> = {
  evidence_in_world: 'evidence',
  event_date_in_window: 'event_date', event_date_on_page: 'event_date',
  place_on_page: 'place',
  contact_domain_matches_company: 'contact', contact_not_recruiting_inbox: 'contact',
}
const RUN_GATES = ['world_closed', 'no_tenant_leak']

export interface FieldVerdict { status: VerdictStatus; rationale: string; evidence: string[]; by: string[] }
export interface LeadEvaluation {
  contract: typeof LEAD_CONTRACT
  lead: { company: string; source_url: string }
  as_of: string
  scorer: Record<string, number>          // evaluator id -> version that produced the verdicts
  fields: Record<Field, FieldVerdict>
  tiers: Record<Tier, TierStatus>
  tier: Tier | null                       // the highest tier that passes
}
export interface TierSummary { claimed: number; by_tier: Record<Tier, { pass: number; fail: number; unknown: number; validated_rate: number | null; unknown_rate: number | null }> }
export interface BriefCheck { ok: boolean; problems: string[] }

// Missing or invalid constraints are reported, never filled in: an evaluator that needs one returns unknown.
export function checkBrief(icp: unknown, expectWindow?: number): BriefCheck {
  const b = (icp && typeof icp === 'object' ? icp : {}) as { window_days?: unknown; where?: unknown; signals?: unknown }
  const problems: string[] = []
  const w = expectWindow ?? b.window_days
  if (w === undefined) problems.push('window_days missing')
  else if (typeof w !== 'number' || !Number.isInteger(w) || w <= 0) problems.push(`window_days invalid (${JSON.stringify(w)})`)
  if (b.where !== undefined && !(Array.isArray(b.where) && b.where.every(x => typeof x === 'string'))) problems.push('where must be a list of places')
  if (!Array.isArray(b.signals) || b.signals.length === 0) problems.push('signals missing: no event predicate to judge against')
  return { ok: problems.length === 0, problems }
}

// Worst-first: contradicted, fail, unknown, pass.
const RANK: Record<VerdictStatus, number> = { contradicted: 3, fail: 2, unknown: 1, pass: 0 }
function combine(vs: Verdict[], none: FieldVerdict): FieldVerdict {
  if (vs.length === 0) return none
  const worst = vs.reduce((a, b) => RANK[b.status] > RANK[a.status] ? b : a)
  return { status: worst.status, rationale: worst.rationale, evidence: [...new Set(vs.flatMap(v => v.evidence ?? []))], by: [...new Set(vs.map(v => v.evaluator))] }
}

export function leadContract(ctx: EvalContext, verdicts: Verdict[], evaluators: Evaluator[]): { leads: LeadEvaluation[]; tiers: TierSummary; brief: BriefCheck } {
  const { kase, world, result } = ctx
  const brief = checkBrief(kase.input.icp, kase.expect.window_days)
  const scorer = Object.fromEntries(evaluators.map(e => [e.id, e.version]))
  const run = verdicts.filter(v => RUN_GATES.includes(v.evaluator))
  const leak = run.some(v => v.evaluator === 'no_tenant_leak' && v.status !== 'pass')
  const closed = run.every(v => v.evaluator !== 'world_closed' || v.status === 'pass')
  const where = (kase.input.icp as { where?: unknown }).where
  const noPlaceAsked = Array.isArray(where) && where.length === 0
  const leads = result.leads.filter(l => l.review_reason === null).map((l): LeadEvaluation => {
    const mine = verdicts.filter(v => v.subject === `lead:${l.company}` && FIELD_OF[v.evaluator])
    const of = (f: Field) => mine.filter(v => FIELD_OF[v.evaluator] === f)
    const fv = (status: VerdictStatus, rationale: string): FieldVerdict => ({ status, rationale, evidence: [], by: [] })
    const fields: Record<Field, FieldVerdict> = {
      evidence: combine(of('evidence'), fv('unknown', 'no evidence verdict')),
      event_date: combine(of('event_date'), fv('unknown', 'no event date')),
      place: combine(of('place'), noPlaceAsked ? fv('pass', 'the brief names no place') : fv('unknown', 'no place verdict')),
      fit: typeof l.fit === 'number' ? fv(l.fit >= FIT_MIN ? 'pass' : 'fail', `ICP fit ${l.fit} of 5 (needs ${FIT_MIN})`) : fv('unknown', 'ICP fit not graded'),
      contact: combine(of('contact'), fv('unknown', 'no contact route')),
      consent: fv('unknown', 'no consent or policy record in a scan replay (outreach path, #399)'),
      outcome: fv('unknown', 'no observed outcome in a scan replay (#399)'),
    }
    const tiers = {} as Record<Tier, TierStatus>
    let below: TierStatus = 'pass'
    for (const { tier, fields: req } of TIERS) {
      const st = req.map(f => fields[f].status)
      const own: TierStatus = st.some(s => s === 'fail' || s === 'contradicted') ? 'fail' : st.some(s => s === 'unknown') ? 'unknown' : 'pass'
      // A tier is no better than the one below it; a leak fails everything, a replay that met a world miss validates nothing.
      let t: TierStatus = below === 'fail' || own === 'fail' ? 'fail' : below === 'unknown' || own === 'unknown' ? 'unknown' : 'pass'
      if (leak) t = 'fail'; else if (!closed && t === 'pass') t = 'unknown'
      tiers[tier] = t; below = t
    }
    const passed = TIERS.filter(x => tiers[x.tier] === 'pass').map(x => x.tier)
    return { contract: LEAD_CONTRACT, lead: { company: l.company, source_url: l.source_url }, as_of: world.as_of, scorer, fields, tiers, tier: passed.at(-1) ?? null }
  })
  const by_tier = Object.fromEntries(TIERS.map(({ tier }) => {
    const n = leads.length
    const c = (s: TierStatus) => leads.filter(e => e.tiers[tier] === s).length
    return [tier, { pass: c('pass'), fail: c('fail'), unknown: c('unknown'), validated_rate: n ? c('pass') / n : null, unknown_rate: n ? c('unknown') / n : null }]
  })) as TierSummary['by_tier']
  return { leads, tiers: { claimed: leads.length, by_tier }, brief }
}
