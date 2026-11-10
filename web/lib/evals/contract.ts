// The evaluation contract (#394): the versioned, executable definition of "a good lead", so success is stated once, frozen, and scored without a human.
// Pure and deterministic: no network, no model, no clock (the contract carries its own as_of). The same frozen contract and the same evidence give the same
// result, byte for byte.
//
// Rules this file enforces:
//  - Nothing is inferred. A contract with a missing or malformed hard constraint is INVALID (validateContract lists every problem) and cannot be frozen.
//  - Every field verdict is pass | fail | unknown | contradicted with a rationale and evidence pointers. Unknown is never pass.
//  - "High-intent" means INDEPENDENTLY CORROBORATED: event.predicate passes only when the event is evidenced by at least `min_independent_sources`
//    sources on different registrable domains, and none of them is the company's own site counted twice. One source, or one source repeated, is unknown.
//  - The evaluator cannot change targeting: the contract is deep-frozen and hashed; evaluateLead refuses a contract whose hash is not the one it was frozen with.
//  - Denominators: summarize() counts unknown (and contradicted) results as not validated, and reports the unknown rate on its own.
// The field ids match what the benchmark runner reads (lib/benchmark/runner.ts CONTRACT_FIELDS), so contractEvaluator() takes evaluateLead as it is.
import { createHash } from 'node:crypto'

export const CONTRACT_VERSION = 'dazl.evaluation-contract/1'
export const SCORER = { id: 'dazl.lead-contract', version: 1 } as const
export type Status = 'pass' | 'fail' | 'unknown' | 'contradicted'
export const STATUSES: Status[] = ['pass', 'fail', 'unknown', 'contradicted']

export interface Contract {
  schema: typeof CONTRACT_VERSION
  id: string
  version: number
  as_of: string                              // YYYY-MM-DD: the day "recent" is measured from
  brief: { seller: string; offer: string }   // who is selling what; context only, never used to widen a constraint
  constraints: {
    places: string[]                         // the leads must be in one of these (empty = explicitly not constrained)
    industries: string[]                     // likewise
    event_kinds: string[]                    // the trigger events that count (non-empty)
    window_days: number                      // the event must be dated within this many days before as_of
    min_independent_sources: number          // independent corroboration needed for the event (>= 1)
    require_consent: boolean                 // a lead whose consent/policy status is not "allowed" cannot validate
  }
}
export interface ContractProblem { path: string; reason: string }

const DAY = /^\d{4}-\d{2}-\d{2}$/
export const isDay = (s: unknown): s is string => typeof s === 'string' && DAY.test(s) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s
const strList = (v: unknown) => Array.isArray(v) && v.every(x => typeof x === 'string' && x.trim() !== '')

export function validateContract(raw: unknown): ContractProblem[] {
  const p: ContractProblem[] = []
  const bad = (path: string, reason: string) => p.push({ path, reason })
  const c = raw as Partial<Contract> | null
  if (!c || typeof c !== 'object') return [{ path: '', reason: 'contract is not an object' }]
  if (c.schema !== CONTRACT_VERSION) bad('schema', `must be ${CONTRACT_VERSION}`)
  if (typeof c.id !== 'string' || !c.id.trim()) bad('id', 'required')
  if (!Number.isInteger(c.version) || (c.version as number) < 1) bad('version', 'a positive integer is required')
  if (!isDay(c.as_of)) bad('as_of', 'a real YYYY-MM-DD day is required (the contract never reads the clock)')
  if (!c.brief || typeof c.brief.seller !== 'string' || !c.brief.seller.trim()) bad('brief.seller', 'required')
  if (!c.brief || typeof c.brief.offer !== 'string' || !c.brief.offer.trim()) bad('brief.offer', 'required')
  const k = c.constraints
  if (!k || typeof k !== 'object') { bad('constraints', 'required'); return p }
  if (!strList(k.places)) bad('constraints.places', 'an array of non-empty strings is required (empty means "not constrained", and must be written)')
  if (!strList(k.industries)) bad('constraints.industries', 'an array of non-empty strings is required (empty means "not constrained", and must be written)')
  if (!strList(k.event_kinds) || (k.event_kinds as string[]).length === 0) bad('constraints.event_kinds', 'at least one event kind is required')
  if (!Number.isInteger(k.window_days) || (k.window_days as number) < 1) bad('constraints.window_days', 'a positive integer is required')
  if (!Number.isInteger(k.min_independent_sources) || (k.min_independent_sources as number) < 1) bad('constraints.min_independent_sources', 'an integer >= 1 is required')
  if (typeof k.require_consent !== 'boolean') bad('constraints.require_consent', 'true or false must be stated')
  return p
}

const canon = (v: unknown): unknown => Array.isArray(v) ? v.map(canon) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v as object).sort().map(k => [k, canon((v as Record<string, unknown>)[k])])) : v
export const contractHash = (c: Contract) => createHash('sha256').update(JSON.stringify(canon(c))).digest('hex')
const deepFreeze = <T,>(o: T): T => { if (o && typeof o === 'object') { Object.values(o as object).forEach(deepFreeze); Object.freeze(o) } return o }

export interface FrozenContract { contract: Readonly<Contract>; hash: string }
export function freezeContract(raw: unknown): FrozenContract {
  const problems = validateContract(raw)
  if (problems.length) throw new Error(`invalid evaluation contract: ${problems.map(x => `${x.path || 'contract'}: ${x.reason}`).join('; ')}`)
  const contract = deepFreeze(structuredClone(raw as Contract))
  return { contract, hash: contractHash(contract) }
}

// What an independent evidence collector hands the evaluator for one lead. Every field is a fact about the world, never a score, and any of it may be absent.
export interface LeadEvidence {
  company: string
  claimed_domain?: string | null
  source_url?: string | null
  quote?: string | null                      // what the lead says the source said
  page_text?: string | null                  // the page as fetched, independently of the lead's own claim
  observed_names?: string[]                  // company names the cited page actually carries
  observed_domains?: string[]                // domains the cited page is published on or points to as the company
  places?: string[]                          // places the cited page names
  industries?: string[]                      // industries the cited page names
  event?: { kind: string; date?: string | null; sources: { url: string }[]; contradicted_by?: { url: string }[] } | null
  consent?: 'allowed' | 'blocked' | null
  contact?: { email?: string | null; phone?: string | null } | null
}
export interface FieldVerdict { field: string; status: Status; rationale: string; evidence?: string[] }
export interface LeadEvaluation {
  contract: string; contract_hash: string; tier: 'validated' | null; status: 'pass' | 'fail' | 'unknown'
  scorer: { id: string; version: number }; verdicts: FieldVerdict[]
}

const norm = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
const has = (hay: string, needle: string) => ` ${norm(hay)} `.includes(` ${norm(needle)} `)
const host = (u: string) => { try { return new URL(u).hostname.toLowerCase().replace(/^www\./, '') } catch { return null } }
// A registrable domain without a public-suffix list: the last two labels, or three when the second-last is a short country-code style label (co.uk, com.au).
export const registrable = (h: string) => { const l = h.split('.'); return l.length <= 2 ? h : (l[l.length - 2].length <= 3 && l[l.length - 1].length === 2) ? l.slice(-3).join('.') : l.slice(-2).join('.') }
const RECRUITING = /^(careers?|jobs?|hr|recruit(ing|ment|er)?|talent|hiring|people|apply|work)@/i
const dayNum = (s: string) => Date.parse(`${s}T00:00:00Z`) / 86_400_000

export function evaluateLead(frozen: FrozenContract, e: LeadEvidence): LeadEvaluation {
  if (contractHash(frozen.contract as Contract) !== frozen.hash) throw new Error('the evaluation contract changed after it was frozen: its hash no longer matches')
  const k = frozen.contract.constraints
  const v: FieldVerdict[] = []
  const add = (field: string, status: Status, rationale: string, evidence?: string[]) => { v.push({ field, status, rationale, ...(evidence?.length ? { evidence } : {}) }) }

  // identity.entity: the cited page is about the company the lead names.
  const names = (e.observed_names ?? []).filter(Boolean), doms = (e.observed_domains ?? []).map(d => registrable(d.toLowerCase().replace(/^www\./, '')))
  const claimed = e.claimed_domain ? registrable(e.claimed_domain.toLowerCase().replace(/^www\./, '')) : null
  if (!names.length && !doms.length) add('identity.entity', 'unknown', 'the cited page names no company and no company domain, so the identity cannot be checked')
  else if (names.some(n => norm(n) === norm(e.company)) || (claimed && doms.includes(claimed))) add('identity.entity', 'pass', 'the cited page carries the lead\'s company name or its domain', [e.source_url ?? ''].filter(Boolean))
  else add('identity.entity', 'contradicted', `the cited page is about ${names[0] ?? doms[0]}, not ${e.company}`, [e.source_url ?? ''].filter(Boolean))

  // source.on_page: the quote the lead relies on is on the page as independently fetched.
  if (!e.quote) add('source.on_page', 'fail', 'the lead gives no quote')
  else if (!e.page_text) add('source.on_page', 'unknown', 'the cited page was not fetched, so the quote cannot be checked')
  else add('source.on_page', has(e.page_text, e.quote) ? 'pass' : 'fail', has(e.page_text, e.quote) ? 'the quote is on the cited page' : 'the quote is not on the cited page', [e.source_url ?? ''].filter(Boolean))

  // place.matches / industry.matches: scored only when the contract constrains them.
  const listCheck = (field: string, wanted: string[], seen: string[] | undefined, noun: string) => {
    if (!wanted.length) return
    if (!seen || !seen.length) add(field, 'unknown', `the cited page names no ${noun}, so it cannot be matched`)
    else if (wanted.some(w => seen.some(s => norm(s) === norm(w)))) add(field, 'pass', `the cited page names a requested ${noun}`)
    else add(field, 'fail', `the cited page names ${seen.join(', ')}, none of the requested ${noun}s`)
  }
  listCheck('place.matches', k.places, e.places, 'place'); listCheck('industry.matches', k.industries, e.industries, 'industry')

  // event.predicate: the right kind of event, independently corroborated.
  const ev = e.event
  if (!ev) add('event.predicate', 'unknown', 'no event is evidenced')
  else if (!k.event_kinds.some(x => norm(x) === norm(ev.kind))) add('event.predicate', 'fail', `the event is "${ev.kind}", not one of ${k.event_kinds.join(', ')}`)
  else if ((ev.contradicted_by ?? []).length) add('event.predicate', 'contradicted', `${ev.contradicted_by!.length} source(s) contradict the event`, ev.contradicted_by!.map(s => s.url))
  else {
    const own = claimed
    const doms2 = new Set(ev.sources.map(s => host(s.url)).filter((h): h is string => !!h).map(registrable))
    const n = doms2.size, ownOnly = own !== null && n === 1 && doms2.has(own)
    if (n >= k.min_independent_sources) add('event.predicate', 'pass', `${n} independent source domain(s) evidence the event (needed ${k.min_independent_sources})`, ev.sources.map(s => s.url))
    else add('event.predicate', 'unknown', `${n} independent source domain(s) evidence the event, ${k.min_independent_sources} needed${ownOnly ? ' (the only source is the company\'s own site)' : ''}: not corroborated`, ev.sources.map(s => s.url))
  }

  // event.date_real / event.date_in_window: whole UTC calendar days, the as_of day passes, tomorrow is the future, the window is inclusive.
  const d = ev?.date
  if (!d) { add('event.date_real', 'unknown', 'the event has no date'); add('event.date_in_window', 'unknown', 'the event has no date') }
  else if (!isDay(d)) { add('event.date_real', 'fail', `"${d}" is not a real calendar day`); add('event.date_in_window', 'fail', 'no real date to place in the window') }
  else {
    add('event.date_real', 'pass', 'the date is a real calendar day')
    const age = dayNum(frozen.contract.as_of) - dayNum(d)
    add('event.date_in_window', age < 0 ? 'fail' : age > k.window_days ? 'fail' : 'pass', age < 0 ? `${d} is after as_of ${frozen.contract.as_of}` : age > k.window_days ? `${d} is ${age} days before as_of, outside the ${k.window_days}-day window` : `${d} is ${age} days before as_of, inside the ${k.window_days}-day window`)
  }

  // consent.status: a lead is not validated unless the consent/policy status says it may be contacted, when the contract requires it.
  if (k.require_consent) add('consent.status', e.consent === 'allowed' ? 'pass' : e.consent === 'blocked' ? 'fail' : 'unknown', e.consent === 'allowed' ? 'contacting is allowed' : e.consent === 'blocked' ? 'contacting is blocked' : 'the consent status is not known')

  // contact.usable: a reachable route at the company, not a hiring inbox.
  const em = e.contact?.email?.trim().toLowerCase()
  if (!em) add('contact.usable', 'unknown', e.contact?.phone ? 'only a phone number: not checked' : 'no contact route')
  else if (RECRUITING.test(em)) add('contact.usable', 'fail', 'the email is a hiring inbox, which routes to recruiting and not to a buyer')
  else if (!claimed) add('contact.usable', 'unknown', 'the company domain is not known, so the email domain cannot be matched')
  else add('contact.usable', registrable(em.split('@')[1] ?? '') === claimed ? 'pass' : 'fail', registrable(em.split('@')[1] ?? '') === claimed ? 'the email is at the company\'s domain' : 'the email is not at the company\'s domain')

  const status = v.some(x => x.status === 'fail' || x.status === 'contradicted') ? 'fail' : v.some(x => x.status === 'unknown') ? 'unknown' : 'pass'
  return { contract: frozen.contract.id, contract_hash: frozen.hash, tier: status === 'pass' ? 'validated' : null, status, scorer: { ...SCORER }, verdicts: v }
}

export interface ContractSummary { leads: number; validated: number; failed: number; unknown: number; contradicted: number; validated_rate: number | null; unknown_rate: number | null; contradicted_rate: number | null }
// Denominator = every lead scored: unknown and contradicted leads are NOT validated, and the unknown rate is its own number.
export function summarize(evals: LeadEvaluation[]): ContractSummary {
  const n = evals.length, r = (x: number) => n ? Math.round((x / n) * 1000) / 1000 : null
  const contradicted = evals.filter(x => x.verdicts.some(f => f.status === 'contradicted')).length
  const validated = evals.filter(x => x.status === 'pass').length, unknown = evals.filter(x => x.status === 'unknown').length
  return { leads: n, validated, failed: evals.filter(x => x.status === 'fail').length, unknown, contradicted, validated_rate: r(validated), unknown_rate: r(unknown), contradicted_rate: r(contradicted) }
}
