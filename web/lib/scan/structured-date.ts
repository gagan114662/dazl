// An event date the SOURCE PAGE itself declares as structured data (schema.org JSON-LD): an Event's startDate, a JobPosting's datePosted. This is the one page-derived date that may
// finish an undated candidate, and only under these rules (the window / stale / future gate then judges it exactly like a date the model read from the quote):
//   - the node must be about THIS company (Event: its organizer / name / location names the company; JobPosting: hiringOrganization names it),
//   - the kind must fit what the lead claims (a JobPosting date never dates a funding round; an Event date never dates a hiring claim),
//   - the dated node must be about THE SAME EVENT as the claim, not merely the same company or page: same event type (an office / location opening is not a webinar, a conference or a launch)
//     and a matching place (an Event with a place must share a word with the claim's own text or the request's place; a place-less online Event can only date a webinar / conference claim);
//     a JobPosting must share a role word with what the claim says is being hired. No match = no date: the candidate stays undated and held, a nearby date is never borrowed,
//   - exactly one distinct date across all qualifying nodes (several = a list of items: none is this lead's),
//   - a real calendar day. datePublished / dateModified / dateCreated are publication or update stamps and are never read here (page-timing.ts keeps them as labels only).
import { companyKey, hasPhrase, norm } from './evidence.ts'

export type DateKind = 'Event' | 'JobPosting'
export interface StructuredDate { date: string; kind: DateKind }

const HIRING = /\b(?:hir(?:e|es|ed|ing)|recruit\w*|jobs?|roles?|positions?|vacanc\w+|openings?)\b/i
const EVENTISH = /\b(?:open(?:s|ed|ing)?|launch(?:es|ed|ing)?|webinar|conference|summit|event|expo|workshop|ceremony|grand opening)\b/i

// What kind of event a piece of text is about. A claim and a dated node must share a type: "opened a new office" is `opening`, "Embedd product webinar" is `webinar`.
export type EventType = 'opening' | 'webinar' | 'conference' | 'launch'
const TYPE_RES: [EventType, RegExp][] = [
  ['webinar', /\b(?:webinars?|online (?:event|session|talk|demo)|livestream(?:ed)?|virtual (?:event|session|summit|conference)|zoom)\b/i],
  ['conference', /\b(?:conference|summit|expo|meetup|workshop|panel|keynote|roundtable|hackathon|trade show)\b/i],
  ['opening', /\b(?:grand opening|(?:office|location|branch|clinic|store|site|studio|hub|headquarters|hq)\s+opening|open(?:s|ed|ing)?\s+(?:its|a|an|the|our|new|second|third|another)?\s*(?:new\s+|second\s+|third\s+)?(?:office|location|branch|clinic|store|site|studio|hub|headquarters|hq|practice)|(?:new|second|third)\s+(?:office|location|branch|clinic|store|studio|hub)|office (?:in|at)\b)/i],
  ['launch', /\b(?:launch(?:es|ed|ing)?|unveil(?:s|ed|ing)?|release[sd]?)\b/i],
]
export const eventTypesOf = (text: string): Set<EventType> => new Set(TYPE_RES.filter(([, re]) => re.test(text)).map(([t]) => t))
const words = (text: string): Set<string> => new Set(norm(text).split(' ').filter(w => w.length >= 4))
const GENERIC_WORDS = new Set(['office', 'offices', 'location', 'locations', 'opening', 'opened', 'opens', 'second', 'third', 'with', 'from', 'that', 'this', 'team', 'company', 'hiring', 'role', 'roles', 'position', 'join', 'joins', 'new', 'event'])
const stringValuesOf = (v: unknown, out: string[] = [], depth = 0): string[] => { if (depth > 3 || v == null) return out; if (typeof v === 'string') out.push(v); else if (Array.isArray(v)) for (const x of v.slice(0, 10)) stringValuesOf(x, out, depth + 1); else if (typeof v === 'object') for (const x of Object.values(v as object).slice(0, 20)) stringValuesOf(x, out, depth + 1); return out }
const overlap = (a: Set<string>, b: Set<string>, ignore: Set<string> = GENERIC_WORDS) => [...a].some(w => b.has(w) && !ignore.has(w))

export function kindsFor(claim: string): DateKind[] {
  const k: DateKind[] = []
  if (HIRING.test(claim)) k.push('JobPosting')
  if (EVENTISH.test(claim)) k.push('Event')
  return k
}

const day = (v: unknown): string | null => {
  if (typeof v !== 'string') return null
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:$|[T\s])/.exec(v.trim()); if (!m) return null
  const y = +m[1], mo = +m[2], d = +m[3], t = new Date(Date.UTC(y, mo - 1, d))
  return y >= 2000 && y <= 2100 && t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d ? t.toISOString().slice(0, 10) : null
}
const namesOf = (v: unknown, out: string[] = [], depth = 0): string[] => {
  if (depth > 3 || v == null) return out
  if (typeof v === 'string') out.push(v)
  else if (Array.isArray(v)) for (const x of v.slice(0, 10)) namesOf(x, out, depth + 1)
  else if (typeof v === 'object') { const o = v as Record<string, unknown>; if (typeof o.name === 'string') out.push(o.name) }
  return out
}
function* nodes(v: unknown, depth = 0, budget = { n: 400 }): Generator<Record<string, unknown>> {
  if (depth > 5 || budget.n-- <= 0 || v == null || typeof v !== 'object') return
  if (Array.isArray(v)) { for (const x of v) yield* nodes(x, depth + 1, budget); return }
  const o = v as Record<string, unknown>
  yield o
  for (const k of ['@graph', 'mainEntity', 'mainEntityOfPage', 'itemListElement', 'item']) if (o[k] !== undefined) yield* nodes(o[k], depth + 1, budget)
}
const typesOf = (o: Record<string, unknown>): string[] => (Array.isArray(o['@type']) ? o['@type'] : [o['@type']]).filter((x): x is string => typeof x === 'string')

// Words that name a country / region / address furniture, never a city or neighbourhood: a shared "United Kingdom" is not a shared place.
const PLACE_STOP = new Set(['united', 'kingdom', 'states', 'america', 'england', 'scotland', 'wales', 'britain', 'great', 'northern', 'ireland', 'street', 'road', 'floor', 'suite', 'avenue', 'lane', 'place', 'square', 'building', 'house', 'postaladdress', 'virtuallocation', 'office', 'offices', 'headquarters', 'branch', 'clinic', 'studio', 'store'])
// What an Event's location states: `city` = its addressLocality words, `local` = its place-name words (neighbourhood / site). Street, region, country and postal code are not place terms.
function eventPlaceTerms(location: unknown, key: string): { city: Set<string>; local: Set<string> } {
  const city = new Set<string>(), local = new Set<string>()
  const add = (v: unknown, into: Set<string>) => { if (typeof v === 'string') for (const w of words(v)) if (w !== key && !PLACE_STOP.has(w) && !GENERIC_WORDS.has(w) && !/^\d/.test(w)) into.add(w) }
  const take = (l: unknown, depth = 0) => {
    if (depth > 2 || l == null) return
    if (typeof l === 'string') { add(l, local); return }
    if (Array.isArray(l)) { for (const x of l.slice(0, 5)) take(x, depth + 1); return }
    if (typeof l === 'object') { const o = l as Record<string, unknown>; add(o.name, local); add(o.addressLocality, city); take(o.address, depth + 1) }
  }
  take(location)
  return { city, local }
}
// The place phrases a claim writes after "in / at / near" ("in Shoreditch, London" -> "Shoreditch").
function claimPlacePhrases(claim: string): string[] {
  return [...claim.matchAll(/\b(?:in|at|near|on)\s+((?:[A-Z][\p{L}'-]+)(?:\s+[A-Z][\p{L}'-]+)*)/gu)].map(m => m[1])
}
// Does this Event node describe the SAME event the claim is about? Type and place, not just the company.
function eventMatches(o: Record<string, unknown>, claim: string, where: string[], key: string): boolean {
  const attendanceOnline = typeof o.eventAttendanceMode === 'string' && /Online/.test(o.eventAttendanceMode) && !/Mixed|Offline/.test(o.eventAttendanceMode)
  const nodeText = [...namesOf(o.name), typeof o.description === 'string' ? o.description : '', ...typesOf(o)].join(' ')
  const nodeTypes = eventTypesOf(nodeText); if (attendanceOnline) nodeTypes.add('webinar')
  const claimTypes = eventTypesOf(claim)
  if (![...claimTypes].some(t => nodeTypes.has(t))) return false                       // a webinar is not an office opening
  if (nodeTypes.has('webinar') && !claimTypes.has('webinar')) return false              // an online event never dates an in-person claim, even one that also says "opening"
  const locVals = stringValuesOf(o.location)
  const virtual = locVals.some(v => /^VirtualLocation$/i.test(v))
  if (virtual && !claimTypes.has('webinar')) return false
  // The event's OWN place has to agree with the claim's place - same city / neighbourhood (or the request's place), never merely a shared country, region or the word "London".
  const { city, local } = eventPlaceTerms(o.location, key)
  if (city.size + local.size > 0) {
    const wh = new Set(where.flatMap(w => [...words(w)]))
    const claimWords = new Set([...words(claim), ...wh])
    // 1. the CITY must be the claim's / request's city (Manchester is not London, whatever country they share). With no addressLocality the place name has to be that city.
    for (const t of city.size ? city : local) if (!claimWords.has(t)) return false
    // 2. if the claim names a finer place than the city ("in Shoreditch"), the event must name that same place: a Camden office, or an event that only says "London", is a different / unconfirmed place -> undated and held.
    const finer = claimPlacePhrases(claim).flatMap(p => [...words(p)]).filter(w => !wh.has(w) && w !== key && !PLACE_STOP.has(w) && !GENERIC_WORDS.has(w))
    if (finer.length > 0 && !finer.some(w => local.has(w) || city.has(w))) return false
    return true
  }
  return claimTypes.has('webinar') || claimTypes.has('conference')                       // no place at all: only an online / conference claim can be dated by it
}
// Does this JobPosting describe what the claim says is being hired? A shared role word (sales, account, executive ...).
function postingMatches(o: Record<string, unknown>, claim: string, key: string): boolean {
  const title = [typeof o.title === 'string' ? o.title : '', ...namesOf(o.name)].join(' ')
  const claimWords = words(claim); claimWords.delete(key)
  return overlap(words(title), claimWords, new Set([...GENERIC_WORDS, 'staff', 'senior', 'junior', 'manager']))
}
export function resolveStructuredDate(blocks: string[] | undefined, company: string, claim: string, where: string[] = []): StructuredDate | null {
  const kinds = kindsFor(claim), key = companyKey(company)
  if (!blocks?.length || kinds.length === 0 || key.length < 2) return null
  const found = new Map<string, StructuredDate>()
  for (const raw of blocks) {
    let j: unknown
    try { j = JSON.parse(raw) } catch { continue }
    for (const o of nodes(j)) {
      const types = typesOf(o)
      if (kinds.includes('JobPosting') && types.includes('JobPosting')) {
        const d = day(o.datePosted)
        if (d && namesOf(o.hiringOrganization).some(n => hasPhrase(norm(n), key)) && postingMatches(o, claim, key)) found.set(`JobPosting|${d}`, { date: d, kind: 'JobPosting' })
      }
      if (kinds.includes('Event') && types.some(t => /Event$/.test(t))) {
        const d = day(o.startDate)
        const organizers = namesOf(o.organizer)
        if (organizers.length > 0 && !organizers.some(n => hasPhrase(norm(n), key))) continue   // the page says someone ELSE organises it
        if (d && [...namesOf(o.organizer), ...namesOf(o.name), ...namesOf(o.location), ...namesOf(o.performer)].some(n => hasPhrase(norm(n), key)) && eventMatches(o, claim, where, key)) found.set(`Event|${d}`, { date: d, kind: 'Event' })
      }
    }
  }
  const dates = new Set([...found.values()].map(f => f.date))
  return dates.size === 1 ? [...found.values()][0] : null   // two different dates = a list of items: none is this lead's
}

// Bounded finishing pass for undated candidates: at most `max` of them, one fetch each (the verifier's cached page, so normally none). Mutates the candidate: event_date and a timing_note
// that says where the date came from. It decides nothing about the window - the caller's window gate judges the new date like any other.
export async function finishUndatedLeads<T extends { company: string; signal: string; excerpt: string; source_url: string; event_date: string | null; timing_note?: string | null }>(
  leads: T[], fetchPage: (url: string) => Promise<{ structured?: string[] } | { fail: string } | null>, max = 6, where: string[] = [],
): Promise<{ company: string; date: string; kind: DateKind; url: string }[]> {
  const done: { company: string; date: string; kind: DateKind; url: string }[] = []
  let tried = 0
  for (const l of leads) {
    if (l.event_date || tried >= max) continue
    tried++
    let page: Awaited<ReturnType<typeof fetchPage>> = null
    try { page = await fetchPage(l.source_url) } catch { page = null }
    if (!page || 'fail' in page) continue
    const r = resolveStructuredDate(page.structured, l.company, `${l.signal} ${l.excerpt}`, where)
    if (!r) continue
    l.event_date = r.date
    l.timing_note = `event date ${r.date} read from the page's own structured data (schema.org ${r.kind}), not from the quote`
    done.push({ company: l.company, date: r.date, kind: r.kind, url: l.source_url })
  }
  return done
}
