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
const words = (text: string): Set<string> => new Set(norm(text).replace(/[.@+]+/g, ' ').split(' ').filter(w => w.length >= 4))   // case, accents, punctuation and stray whitespace never change a place name
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
// ---- places are compared as WHOLE normalised phrases (token sequences), never by shared words ----
// East Kensington is not West Kensington, North is not South Shields, Upper is not Lower Manhattan, and a bare "Kensington" is not "East Kensington": a qualifier is part of the name.
const tokensOf = (text: string): string[] => norm(text).replace(/[.@+]+/g, ' ').split(' ').filter(Boolean)
const PLACE_FILLER = new Set(['office', 'offices', 'location', 'branch', 'clinic', 'studio', 'store', 'hub', 'headquarters', 'opening', 'event', 'the', 'new', 'second', 'third', 'at'].filter(w => w !== 'new'))   // "new" is kept: New Cross, New Malden
const stripPlace = (toks: string[], key: string, extra: Set<string> = new Set()): string[] => toks.filter(t => t !== key && !PLACE_FILLER.has(t) && !PLACE_STOP.has(t) && !extra.has(t) && !/^\d/.test(t))
const sameSeq = (a: string[], b: string[]) => a.length === b.length && a.every((t, i) => t === b[i])
const hasSeq = (hay: string[], needle: string[]) => needle.length > 0 && hay.some((_, i) => needle.every((t, j) => hay[i + j] === t))
// What an Event's location states: `city` = each addressLocality as a token phrase, `local` = the place-name phrase(s) (neighbourhood / site) with the city words taken off. Street, region, country and postal code are not place terms.
function eventPlace(location: unknown, key: string): { city: string[][]; local: string[][] } {
  const city: string[][] = [], names: string[][] = []
  const take = (l: unknown, depth = 0) => {
    if (depth > 2 || l == null) return
    if (typeof l === 'string') { names.push(tokensOf(l)); return }
    if (Array.isArray(l)) { for (const x of l.slice(0, 5)) take(x, depth + 1); return }
    if (typeof l === 'object') {
      const o = l as Record<string, unknown>
      if (typeof o.name === 'string') names.push(tokensOf(o.name))
      if (typeof o.addressLocality === 'string') { const t = stripPlace(tokensOf(o.addressLocality), key); if (t.length) city.push(t) }
      take(o.address, depth + 1)
    }
  }
  take(location)
  const cityWords = new Set(city.flat())
  const local = names.map(n => stripPlace(n, key, cityWords)).filter(n => n.length > 0)
  return { city, local }
}
// The place phrases a claim writes after "in / at / near / on" ("in East Kensington, London" -> "East Kensington"). Case-blind. A phrase runs up to 5 words and stops at punctuation or the first
// function word (never at its first word: "in New Cross").
const PHRASE_END = new Set(['for', 'with', 'to', 'and', 'which', 'as', 'its', 'our', 'their', 'from', 'since', 'that', 'where', 'while', 'after', 'before', 'this', 'last', 'next', 'is', 'are', 'was', 'has', 'have', 'will', 'under', 'over', 'by', 'of', 'in', 'at', 'on', 'near'])
const PHRASE_NOT_FIRST = new Set(['the', 'a', 'an', 'its', 'our', 'their', 'this', 'that', 'one', 'another', 'second', 'third', 'first', 'new'].filter(w => w !== 'new'))
function claimPlacePhrases(claim: string): string[][] {
  const out: string[][] = []
  for (const m of claim.matchAll(/\b(?:in|at|near|on)\s+([\p{L}][\p{L}'\u2019-]*(?:[ \t]+[\p{L}][\p{L}'\u2019-]*){0,4})/giu)) {
    const ws = m[1].split(/\s+/).map(w => w.toLowerCase().replace(/['\u2019]s$/, ''))
    if (PHRASE_NOT_FIRST.has(ws[0])) continue
    const kept: string[] = []
    for (const [i, w] of ws.entries()) { if (i > 0 && PHRASE_END.has(w)) break; kept.push(w) }
    if (kept.length) out.push(kept)
  }
  return out
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
  const { city, local } = eventPlace(o.location, key)
  if (city.length + local.length > 0) {
    const whereToks = where.map(tokensOf), claimToks = tokensOf(claim)
    const known = (phrase: string[]) => hasSeq(claimToks, phrase) || whereToks.some(w => hasSeq(w, phrase))
    // 1. the CITY must be the claim's / request's city, as a whole phrase (Manchester is not London, whatever country they share). With no addressLocality the place name has to be that city.
    for (const c of city.length ? city : local) if (!known(c)) return false
    // 2. if the claim names a finer place than the city ("in East Kensington"), the event must name EXACTLY that place - the same words, qualifiers included. West Kensington, a bare Kensington,
    //    Camden, or an event that only says "London", is a different or unconfirmed place -> undated and held. Words the city / request already account for are not "finer".
    const cityWords = new Set([...city.flat(), ...whereToks.flat()])
    const finer = claimPlacePhrases(claim).map(p => stripPlace(p, key, cityWords)).filter(p => p.length > 0)
    if (finer.length > 0 && !finer.some(f => local.some(l => sameSeq(l, f)) || city.some(c => sameSeq(c, f)))) return false
    return true
  }
  return claimTypes.has('webinar') || claimTypes.has('conference')                       // no place at all: only an online / conference claim can be dated by it
}
// Does this JobPosting describe what the claim says is being hired? A shared role word (sales, account, executive ...).
function postingMatches(o: Record<string, unknown>, claim: string, key: string): boolean {
  // The posting's role must be what the claim says is being hired: EVERY meaningful word of the posting's title is in the claim ("Account Executive" is not "Account Manager"; one shared generic
  // word like "account" or "sales" proves nothing). Anything after a dash / comma / pipe / parenthesis in the title is a location or team tag, not the role.
  const title = [typeof o.title === 'string' ? o.title : '', ...namesOf(o.name)][0] ?? ''
  const role = tokensOf(title.split(/\s[-\u2013|]\s|[,|(]/)[0]).filter(t => t !== key && !ROLE_FILLER.has(t) && !/^\d/.test(t))
  if (role.length === 0) return false
  const claimToks = new Set(tokensOf(claim))
  return role.every(t => claimToks.has(t) || claimToks.has(t.replace(/s$/, '')) || claimToks.has(`${t}s`))
}
const ROLE_FILLER = new Set(['a', 'an', 'the', 'of', 'and', 'for', 'in', 'at', 'to', 'with', 'm', 'f', 'd', 'w'])
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
