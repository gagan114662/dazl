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
import { getDomain } from 'tldts'

export const CONTRACT_VERSION = 'dazl.evaluation-contract/1'
// v2 (#781): a former employee and a generic role inbox now fail contact.usable, and an unconfirmed person stays unknown; v1 judged the route alone.
export const SCORER = { id: 'dazl.lead-contract', version: 2 } as const
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
// An impossible day ("2026-13-01", "2026-00-10") must be a plain `false`, never a throw: toISOString() throws RangeError on an Invalid Date, which would
// abort validateContract/evaluateLead instead of listing the problem.
export const isDay = (s: unknown): s is string => {
  if (typeof s !== 'string' || !DAY.test(s)) return false
  const t = Date.parse(`${s}T00:00:00Z`)
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === s
}
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

export interface FrozenContract { readonly contract: Readonly<Contract>; readonly hash: string }
// The canonical frozen contracts of this process. Only an object freezeContract returned is accepted by evaluateLead: a caller-built
// { contract, hash } pair is refused even when the hash matches its (altered) contract. A version is immutable: the same id and version
// always means the same content, so a changed contract must bump its version.
const ISSUED = new WeakSet<object>()
const BY_VERSION = new Map<string, FrozenContract>()
export function freezeContract(raw: unknown): FrozenContract {
  const problems = validateContract(raw)
  if (problems.length) throw new Error(`invalid evaluation contract: ${problems.map(x => `${x.path || 'contract'}: ${x.reason}`).join('; ')}`)
  const contract = deepFreeze(structuredClone(raw as Contract)), hash = contractHash(contract), key = `${contract.id}@${contract.version}`
  const had = BY_VERSION.get(key)
  if (had) { if (had.hash !== hash) throw new Error(`contract ${key} is already frozen with different content (hash ${had.hash.slice(0, 12)}); bump its version to change it`); return had }
  const frozen: FrozenContract = Object.freeze({ contract, hash }); ISSUED.add(frozen); BY_VERSION.set(key, frozen)
  return frozen
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
  // person: what an independent person check (lib/evals/person-verify.ts, #781) found about the named contact at this company. Undefined = no person check was run.
  contact?: { email?: string | null; phone?: string | null; person?: 'current' | 'former' | 'unknown' } | null
}
export interface FieldVerdict { field: string; status: Status; rationale: string; evidence?: string[] }
export interface LeadEvaluation {
  contract: string; contract_hash: string; tier: 'validated' | null; status: 'pass' | 'fail' | 'unknown'
  scorer: { id: string; version: number }; verdicts: FieldVerdict[]
}

const norm = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
const has = (hay: string, needle: string) => ` ${norm(hay)} `.includes(` ${norm(needle)} `)
const host = (u: string) => { try { return new URL(u).hostname.toLowerCase().replace(/^www\./, '') } catch { return null } }
// The registrable domain by the Public Suffix List INCLUDING its private section (tldts, already a dependency), so shared hosts are not one company:
// acme.github.io and other.github.io are different domains, as are foo.vercel.app and bar.vercel.app. A host with no listed suffix (an IP, localhost) is itself.
export const registrable = (h: string) => { const host = h.toLowerCase().replace(/^www\./, ''); return getDomain(host, { allowPrivateDomains: true }) ?? host }
// A hiring inbox is judged on the local part with any +tag stripped and separators folded, so careers+sales@, talent.acquisition@ and job-applications@
// are recruiting too, not only the bare names.
const RECRUITING = /^(careers?|jobs?|hr|recruit(ing|ment|ers?)?|talent(\s?acquisition)?|hiring|people|apply|((job|career)s? )?applications?|work(\s?with\s?us)?|join(\s?us)?|employment|vacancies)(\s(team|dept|department))?$/
const isRecruitingMailbox = (local: string) => RECRUITING.test(local.split('+')[0].replace(/[._-]+/g, ' ').trim())
// A generic role inbox reaches a team or a function, not a named buyer (#781): info@, sales@, support@, no-reply@, webmaster@, reception@, and the same role with a team,
// department or region qualifier (sales-emea@, support.us@, customer.service.team@). The local part is split on . _ - and + tags; it is generic when its first token is a role
// stem and every other token is a qualifier (team, dept, a region word, or a two-letter country code). A name that merely contains a role word (jane.info@) is a person.
const ROLE = new Set(['info', 'information', 'contact', 'contacts', 'hello', 'hi', 'sales', 'support', 'help', 'helpdesk', 'admin', 'administrator', 'office', 'team', 'enquiry', 'enquiries', 'inquiry', 'inquiries', 'mail', 'general', 'press', 'media', 'pr', 'marketing', 'billing', 'accounts', 'account', 'accounting', 'finance', 'service', 'services', 'customer', 'customers', 'noreply', 'donotreply', 'reception', 'webmaster', 'postmaster', 'hostmaster', 'abuse', 'security', 'legal', 'privacy', 'compliance', 'orders', 'order', 'feedback', 'partnerships', 'partners', 'partner', 'newsletter', 'subscribe', 'unsubscribe', 'bounce', 'mailer', 'notifications', 'alerts', 'receptionist', 'frontdesk', 'operations', 'ops', 'it', 'care', 'concierge', 'bookings', 'booking', 'reservations', 'events', 'careers'])
const QUALIFIER = new Set(['team', 'dept', 'department', 'desk', 'global', 'emea', 'apac', 'latam', 'amer', 'americas', 'europe', 'asia', 'africa', 'na', 'eu', 'us', 'uk', 'ca', 'au', 'nz', 'de', 'fr', 'es', 'it', 'nl', 'in', 'sg', 'jp', 'br', 'mx', 'online', 'general', 'service', 'services', 'support', 'care', 'inbox'])
const isGenericMailbox = (local: string) => {
  const parts = local.split('+')[0].toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean).map(x => x.replace(/\d+$/, '') || x)   // info2@, sales1@: a numbered role alias is still the role
  if (parts.length === 0) return false
  const joined = parts.join('')
  if (['noreply', 'donotreply', 'dontreply'].includes(joined)) return true
  return ROLE.has(parts[0]) && parts.slice(1).every(p => QUALIFIER.has(p) || ROLE.has(p) || /^\d+$/.test(p))
}
// One whole address: a single @, a non-empty local part, a dotted domain, no spaces. "@northwind.io" and "jane@northwind.io@other.org" are not usable routes.
const EMAIL = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/
const emailDomain = (em: string) => em.slice(em.indexOf('@') + 1)
const dayNum = (s: string) => Date.parse(`${s}T00:00:00Z`) / 86_400_000

export function evaluateLead(frozen: FrozenContract, e: LeadEvidence): LeadEvaluation {
  if (!ISSUED.has(frozen)) throw new Error('not a contract frozen by freezeContract: a caller-supplied contract or hash is never trusted')
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
    // One source is never corroboration, whatever min_independent_sources says: the floor is two domains (a contract with 1 is valid but cannot lower it).
    const n = doms2.size, ownOnly = own !== null && n === 1 && doms2.has(own), need = Math.max(2, k.min_independent_sources)
    if (n >= need) add('event.predicate', 'pass', `${n} independent source domain(s) evidence the event (needed ${need})`, ev.sources.map(s => s.url))
    else add('event.predicate', 'unknown', `${n} independent source domain(s) evidence the event, ${need} needed${ownOnly ? ' (the only source is the company\'s own site)' : ''}: not corroborated`, ev.sources.map(s => s.url))
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

  // contact.usable: a reachable route at the company, not a hiring or generic inbox, to a person who is still there.
  const em = e.contact?.email?.trim().toLowerCase()
  if (e.contact?.person === 'former') add('contact.usable', 'fail', 'the named contact is a former employee of the company, whatever route is on file')
  else if (!em) add('contact.usable', 'unknown', e.contact?.phone ? 'only a phone number: not checked' : 'no contact route')
  else if (!EMAIL.test(em)) add('contact.usable', 'fail', 'the email is not a well-formed address')
  else if (isRecruitingMailbox(em.slice(0, em.indexOf('@')))) add('contact.usable', 'fail', 'the email is a hiring inbox, which routes to recruiting and not to a buyer')
  else if (isGenericMailbox(em.slice(0, em.indexOf('@')))) add('contact.usable', 'fail', 'the email is a generic role inbox, which reaches a team and not a named person')
  else if (!claimed) add('contact.usable', 'unknown', 'the company domain is not known, so the email domain cannot be matched')
  else if (registrable(emailDomain(em)) !== claimed) add('contact.usable', 'fail', 'the email is not at the company\'s domain')
  else if (e.contact?.person === 'unknown') add('contact.usable', 'unknown', 'the email is at the company\'s domain, but the contact\'s current employment could not be confirmed')
  else add('contact.usable', 'pass', e.contact?.person === 'current' ? 'the email is at the company\'s domain and the contact is independently confirmed as a current employee' : 'the email is at the company\'s domain')

  const status = v.some(x => x.status === 'fail' || x.status === 'contradicted') ? 'fail' : v.some(x => x.status === 'unknown') ? 'unknown' : 'pass'
  return { contract: frozen.contract.id, contract_hash: frozen.hash, tier: status === 'pass' ? 'validated' : null, status, scorer: { ...SCORER }, verdicts: v }
}

// One definition, used by the benchmark scorecard (lib/benchmark/scorecard.ts, runner.ts) and by summarize() below: which contract fields decide each
// scorecard field, the worst verdict wins (contradicted, fail, unknown, pass), a field nothing scored or an unrecognised status is unknown, and a result
// is UNKNOWN when any scorecard field is unknown (whatever else it did).
export const CONTRACT_FIELDS = {
  identity: ['identity.entity', 'source.on_page'],
  constraints: ['place.matches', 'industry.matches', 'event.predicate', 'consent.status'],
  event_date: ['event.date_real', 'event.date_in_window'],
  contact: ['contact.usable'],
} as const
export type ScoreField = keyof typeof CONTRACT_FIELDS
const WORST: Status[] = ['contradicted', 'fail', 'unknown', 'pass']
export function scorecardVerdicts(vs: { field: string; status: string }[]): Record<ScoreField, Status> {
  const by = new Map(vs.map(v => [v.field, (STATUSES as string[]).includes(v.status) ? v.status as Status : 'unknown' as Status]))
  return Object.fromEntries((Object.keys(CONTRACT_FIELDS) as ScoreField[]).map(f => {
    const got = CONTRACT_FIELDS[f].filter(k => by.has(k)).map(k => by.get(k)!)
    return [f, got.length ? WORST.find(w => got.includes(w))! : 'unknown']
  })) as Record<ScoreField, Status>
}
export const anyUnknown = (statuses: readonly string[]) => statuses.some(s => s === 'unknown')
export const isUnknownResult = (e: { verdicts: { field: string; status: string }[] }) => anyUnknown(Object.values(scorecardVerdicts(e.verdicts)))

export interface ContractSummary { leads: number; validated: number; failed: number; unknown: number; contradicted: number; validated_rate: number | null; unknown_rate: number | null; contradicted_rate: number | null }
// Denominator = every lead scored: unknown and contradicted leads are NOT validated. The unknown rate is its own number and counts every lead that
// isUnknownResult says is unknown, including one that also failed elsewhere (so `failed` and `unknown` can overlap).
export function summarize(evals: LeadEvaluation[]): ContractSummary {
  const n = evals.length, r = (x: number) => n ? Math.round((x / n) * 1000) / 1000 : null
  const contradicted = evals.filter(x => x.verdicts.some(f => f.status === 'contradicted')).length
  const validated = evals.filter(x => x.status === 'pass').length, unknown = evals.filter(isUnknownResult).length
  return { leads: n, validated, failed: evals.filter(x => x.status === 'fail').length, unknown, contradicted, validated_rate: r(validated), unknown_rate: r(unknown), contradicted_rate: r(contradicted) }
}
