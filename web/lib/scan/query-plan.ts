// A visible, typed query plan compiled from the request text (#380): hard filters and preferences, AND / OR / NOT between EVENT clauses, a separate time clock
// per clause, the geography semantics, and hard exclusions. Evaluation is three-valued (true / false / UNKNOWN) so a fact nobody could check is never read as
// false (and never as true); each clause is proven on its own record for the entity it names. The plan never widens itself: widening is only SUGGESTED
// (widenOptions) for the user to choose. Pure: no network, no database; the compiler is deterministic (no model call), and an ambiguous request says so.
import { parseWindowDays, windowStatus } from './window.ts'

export type FactKind = 'funding' | 'hiring' | 'leadership_hire' | 'expansion' | 'launch' | 'tech_switch' | 'event'
export type Pred =
  | { op: 'and' | 'or'; of: Pred[] }
  | { op: 'not'; of: Pred }
  | { op: 'fact'; id: string; kind: FactKind; text: string; window_days: number | null }
export interface Geography { places: string[]; semantics: 'city' | 'region' | 'country' | 'none' }
export interface QueryPlan { source: string; hard: Pred; preferred: Pred[]; geography: Geography; exclude: string[]; ambiguities: string[]; widening: 'user_choice' }

const KIND: [FactKind, RegExp][] = [
  ['leadership_hire', /\b(?:first|new)\s+(?:vp|vice president|cro|cto|cfo|ceo|head|director|chief)\b[^,;]*?\b(?:hired|hire|appointed|joined|named)\b|\b(?:hired|appointed|named)\b[^,;]*?\b(?:vp|vice president|cro|cto|cfo|ceo|head of|director|chief)\b/i],
  ['funding', /\b(?:seed|series\s+[a-e]|pre-seed|funding|funded|raised|raises|raise|round|investment)\b/i],
  ['hiring', /\b(?:hiring|hires|is hiring|recruiting|job openings?|open roles?|postings?)\b/i],
  ['expansion', /\b(?:opened|opening|expanding|expansion|new (?:office|location|clinic|site)|second (?:office|location))\b/i],
  ['launch', /\b(?:launch(?:ed|es|ing)?|released?|unveil(?:ed|s)?)\b/i],
  ['tech_switch', /\b(?:switch(?:ed|ing)?|migrat(?:ed|ing)|replac(?:ed|ing)|new (?:software|system|platform|tool))\b/i],
]
const EXCLUDE = /\b(?:excluding|exclude|except(?: for)?|skip|without|not including|other than|but not)\s+([^.;]+)/gi
const SPLIT_AND = /\s+(?:and|&)\s+/i, SPLIT_OR = /\s+or\s+|\s*\/\s*/i
const clean = (s: string) => s.replace(/\s+/g, ' ').replace(/^[\s,;:.-]+|[\s,;:.-]+$/g, '')
export const kindOf = (t: string): FactKind | null => KIND.find(([, re]) => re.test(t))?.[0] ?? null

// The event part of a request: what follows the subject up to the exclusions / place. Clauses joined by AND are both required; by OR either; a clause may carry its
// own "within N days / past N weeks / in the last month".
function eventText(request: string): string {
  const q = request.replace(EXCLUDE, ' ').replace(/\.$/, '')
  const m = /\b(?:that|who|which|with|having)\b\s+(.*)$/i.exec(q)
  return clean(m ? m[1] : q)
}
function clausesOf(text: string, defaultWindow: number | null): Pred[] {
  return text.split(SPLIT_AND).map(clean).filter(Boolean).flatMap((seg): Pred[] => {
    const alts = seg.split(SPLIT_OR).map(clean).filter(Boolean)
    const facts: Pred[] = alts.flatMap((a): Pred[] => { const kind = kindOf(a); return kind ? [{ op: 'fact', id: '', kind, text: a, window_days: parseWindowDays(a) ?? defaultWindow }] : [] })
    return facts.length === 0 ? [] : facts.length === 1 ? facts : [{ op: 'or', of: facts }]
  })
}
const number = (p: Pred, n = { i: 0 }): Pred => p.op === 'fact' ? { ...p, id: `c${++n.i}` } : p.op === 'not' ? { op: 'not', of: number(p.of, n) } : { op: p.op, of: p.of.map(x => number(x, n)) }

export function compilePlan(request: string, opts: { where?: string[]; country?: boolean } = {}): QueryPlan {
  const ambiguities: string[] = []
  const text = eventText(request)
  const defaultWindow = parseWindowDays(request)
  // A clause may name its own window; a window stated once at the end applies to a clause that names none ("seed funding and hiring sales within the past 90 days").
  const clauses = clausesOf(text, defaultWindow)
  const hard: Pred = number(clauses.length === 1 ? clauses[0] : { op: 'and', of: clauses })
  if (clauses.length === 0) ambiguities.push('No event condition could be read from the request; only the profile filters would apply.')
  if (/\b(?:and\/or|and or)\b/i.test(request)) ambiguities.push('"and/or" is ambiguous: is each event required, or is either enough?')
  if (clauses.length > 1 && /,/.test(text) && !/\b(?:and|or)\b/i.test(text)) ambiguities.push('Several conditions are listed with no "and" / "or": it is not clear whether all are required.')
  const exclude = [...request.matchAll(EXCLUDE)].flatMap(m => m[1].split(/,|\band\b|\bor\b/i).map(clean).filter(Boolean))
  const places = (opts.where ?? []).map(clean).filter(Boolean)
  const geography: Geography = { places, semantics: places.length === 0 ? 'none' : places.every(p => /,|\b(?:city|nyc|london|toronto|paris|berlin)\b/i.test(p) || /^[A-Z][a-z]+(?: [A-Z][a-z]+)*$/.test(p)) && opts.country !== true ? 'city' : 'country' }
  return { source: request, hard, preferred: [], geography, exclude, ambiguities, widening: 'user_choice' }
}

// ---- evaluation: three-valued, per-clause proof, separate clocks ----
export type Tri = 'true' | 'false' | 'unknown'
export interface Proof { url: string; quote: string; date: string | null; entity_bound: boolean }
export interface FactResult { id: string; text: string; kind: FactKind; state: Tri; proof: Proof | null; missing: string | null }
export interface Evaluation { state: Tri; clauses: FactResult[]; excluded: string | null }

export function evaluatePlan(plan: QueryPlan, facts: Record<string, { state: Tri; proof?: Proof | null }>, entity: { name: string; tags?: string[] }, now: Date = new Date()): Evaluation {
  const clauses: FactResult[] = []
  const go = (p: Pred): Tri => {
    if (p.op === 'fact') {
      const f = facts[p.id]
      // A clause is true only on ITS OWN proof: a url and a verbatim quote, bound to this entity, dated inside THIS clause's window (an undated or stale proof is unknown / false, never true).
      let state: Tri = f?.state ?? 'unknown', missing: string | null = null
      if (state === 'true') {
        const pr = f!.proof
        if (!pr || !pr.url || pr.quote.trim().length < 12) { state = 'unknown'; missing = 'no source quote' }
        else if (!pr.entity_bound) { state = 'unknown'; missing = 'the source is not tied to this company' }
        else if (p.window_days) { const st = windowStatus(pr.date, p.window_days, now); if (st !== 'inside') { state = st === 'stale' ? 'false' : 'unknown'; missing = st === 'stale' ? `older than ${p.window_days} days` : `no usable date inside ${p.window_days} days` } }
      } else if (state === 'unknown') missing = 'not checked or not found yet'
      clauses.push({ id: p.id, text: p.text, kind: p.kind, state, proof: state === 'true' ? f!.proof ?? null : null, missing: state === 'true' ? null : missing ?? (state === 'false' ? 'checked: not the case' : null) })
      return state
    }
    if (p.op === 'not') { const v = go(p.of); return v === 'true' ? 'false' : v === 'false' ? 'true' : 'unknown' }
    const vs = p.of.map(go)
    return p.op === 'and' ? (vs.includes('false') ? 'false' : vs.every(v => v === 'true') ? 'true' : 'unknown') : (vs.includes('true') ? 'true' : vs.every(v => v === 'false') ? 'false' : 'unknown')
  }
  const hit = plan.exclude.find(x => x && [entity.name, ...(entity.tags ?? [])].some(t => t.toLowerCase().includes(x.toLowerCase())))
  const state = go(plan.hard)
  // An excluded entity is a hard no whatever its events say.
  return { state: hit ? 'false' : state, clauses, excluded: hit ?? null }
}

// Suggestions only; nothing here changes the plan. The user picks.
export function widenOptions(plan: QueryPlan): string[] {
  const out: string[] = []
  const walk = (p: Pred) => { if (p.op === 'fact') { if (p.window_days && p.window_days < 365) out.push(`Widen "${p.text}" from ${p.window_days} days to ${Math.min(365, p.window_days * 2)} days`) } else if (p.op === 'not') walk(p.of); else p.of.forEach(walk) }
  walk(plan.hard)
  if (plan.hard.op === 'and') out.push('Treat the conditions as "either" instead of "all" (more results, weaker match)')
  if (plan.geography.semantics === 'city') out.push(`Search the wider region around ${plan.geography.places.join(' / ')}`)
  return out
}
// A plain-language rendering of the plan, for the visible "what dazl will look for" panel.
export function describePlan(p: Pred, depth = 0): string {
  if (p.op === 'fact') return `${p.text}${p.window_days ? ` (within ${p.window_days} days)` : ''}`
  if (p.op === 'not') return `NOT ${describePlan(p.of, depth + 1)}`
  const j = p.of.map(x => describePlan(x, depth + 1)).join(p.op === 'and' ? ' AND ' : ' OR ')
  return depth > 0 && p.of.length > 1 ? `(${j})` : j
}
