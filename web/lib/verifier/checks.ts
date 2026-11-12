// Deterministic checks of the independent evidence verifier (#780/#781, part of #395). decide() is a pure function of
// the claim and the verifier's OWN source snapshots (how those snapshots get fetched is a separate PR's concern -
// here they are passed in directly, so tests use bounded, injected fixtures and no PR in this scope makes a network
// or paid call). No model judge is involved: every check here is a deterministic read of text already in hand.
// Unknown is never pass; a fail is a concrete contradiction on the source (a different city, a future or stale day,
// a former employee, a hiring inbox); a source the verifier could not read makes the checks that need it unknown,
// never fail.
//
// Scope (#780+#781 only): claim well-formedness, company identity, domain binding, place, event date, cross-source
// date conflicts, and quote corroboration (verbatim text matching, no model judge - quotes are deterministic exactly
// like company/place/date, so they belong here, not #782) (#780); person (current employer/title, former-role
// rejected) and contact-route (on its own cited source, on the company's domain, not a generic/hiring inbox) (#781).
// Independent-confirmation/provenance-dependency tracking and semantic-predicate judging are #782's - left out so
// this PR's diff matches its own title.
import type { LeadClaim } from './claim.ts'
import { datesIn, fold, isoDay, isStamp, registrable, sentenceAt, tokenPositions } from './text.ts'

export type Status = 'pass' | 'fail' | 'unknown'
export interface CheckResult { check: string; version: number; subject: string; status: Status; reason: string }

// One cited source as the verifier itself read it.
export interface Snapshot {
  url: string
  outcome: 'ok' | 'error'
  final_url: string | null
  text: string            // visible text ('' unless ok)
  truncated: boolean      // text was cut at a length limit: an absence on it is unknown, not fail
  meta_days: string[]     // publication/modification days in the page's metadata
  linked_domains: string[]
}

export interface DecideInput { claim: LeadClaim; problems: string[]; sources: Snapshot[]; asOf: string; windowDays: number }

export const CHECK_VERSIONS = {
  claim_well_formed: 1, company_on_source: 1, domain_bound: 1, place_on_source: 1, event_date_on_source: 1, sources_agree: 1,
  quote_on_source: 1, person_current: 3, contact_on_source: 1, contact_domain: 1, contact_not_recruiting: 1,
} as const
type CheckId = keyof typeof CHECK_VERSIONS
const r = (check: CheckId, subject: string, status: Status, reason: string): CheckResult => ({ check, version: CHECK_VERSIONS[check], subject, status, reason })

const ANNOUNCED = /(?<![\p{L}])(will|plans? to|planning to|is set to|are set to|set to open|upcoming|scheduled|expected to|intends? to|aims? to|later this year|next (?:week|month|year)|coming soon|announc\w*|opening for)(?![\p{L}])/u
const FORMER = /(?<![\p{L}])(?:(?:former|formerly|previously|departed|left (?:the company|in (?:19|20)\d{2}|to join)|retired|alumn(?:us|a|i)|used to|until (?:19|20)\d{2}|no longer)(?![\p{L}])|ex-(?=\p{L}))/u
// A bare "was <title>" copula states a past, ended role; "was named/appointed/promoted/elected/made <title>" announces
// a CURRENT appointment (common recent-hire phrasing) and must not be read as historical.
const PAST_STATE = /(?<![\p{L}])was(?![\p{L}])(?!\s+(?:named|appointed|promoted|elected|hired|made)\b)/u
// Hiring inboxes, matched on the mailbox name before any +tag: the whole name, or a recruiting base word followed by
// a "._-"-delimited qualifier (careers-emea@, jobs-uk@, recruitment-team@, talent.acquisition@ and join-us@ are all
// hiring inboxes; hrishi@ and jobsworth@, which merely start with "hr"/"jobs" with no delimiter after, are not).
const RECRUITING = /^(?:jobs?|careers?|recruit(?:ing|ment|ers?)?|talent(?:acquisition|team)?|hr|humanresources|people(?:ops|team)?|hiring|apply|applications?|applicants?|cvs?|resumes?|joinus|join(?:theteam)?|workwithus|work|vacanc(?:y|ies)|staffing)(?:[._-].*)?$/
export const isRecruitingMailbox = (email: string) => RECRUITING.test((email.split('@')[0] ?? '').split('+')[0].toLowerCase())

// Complete email tokens in folded text, boundary-aware: "joann@harborledger.example" must never satisfy a claimed
// "ann@harborledger.example" (a raw substring check would accept it as a prefix match, and would equally accept
// "ann@harborledger.example.evil" as a suffix match) - each match is the FULL contiguous address, compared for exact
// equality, never containment.
const EMAIL_TOKEN = /(?<![\p{L}\p{N}._%+-])[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)*\.[\p{L}]{2,}(?![\p{L}\p{N}-])/gu
const emailsIn = (folded: string): string[] => [...folded.matchAll(EMAIL_TOKEN)].map(m => m[0])

const PASSAGE = 250
const near = (a: number[], b: number[], d = PASSAGE) => a.some(x => b.some(y => Math.abs(x - y) <= d))
// The comma/semicolon/sentence-delimited clause around position i: "Priya Raman, formerly VP at OldCo, is now CRO at
// Harbor Ledger Analytics" is three clauses - a former-role marker in one clause must not taint a current-role claim
// bound to a different clause of the same sentence.
const clauseAt = (folded: string, i: number): string => {
  const start = Math.max(folded.lastIndexOf(',', i), folded.lastIndexOf(';', i), folded.lastIndexOf('. ', i), folded.lastIndexOf('\n', i), -1)
  const stops = [folded.indexOf(',', i), folded.indexOf(';', i), folded.indexOf('. ', i), folded.indexOf('\n', i)].filter(x => x >= 0)
  return folded.slice(start + 1, stops.length ? Math.min(...stops) : folded.length).trim()
}

// The sentence span around position i in folded text, with the same boundaries as sentenceAt.
const sentenceSpan = (folded: string, i: number): [number, number] => {
  const start = Math.max(folded.lastIndexOf('. ', i), folded.lastIndexOf('\n', i), folded.lastIndexOf('! ', i), folded.lastIndexOf('? ', i))
  const ends = ['. ', '\n', '! ', '? '].map(t => folded.indexOf(t, i)).filter(x => x >= 0)
  return [start + 1, ends.length ? Math.min(...ends) : folded.length]
}
// The employer a source explicitly attaches to a title occurrence [ts, te) inside its sentence [ss, se): "<title> at
// <Employer>" right after it, or "<Employer>'s <title>" right before it. null when none is attached. Only these two
// unambiguous forms are read; "of"/"for"/"with" are not ("VP of Sales", "Head of Sales for EMEA" name no employer).
const attachedEmployer = (folded: string, ts: number, te: number, ss: number, se: number, personName: string): string | null => {
  const after = /^\s*,?\s*at\s+(?:the\s+)?([^,.;:()\n"]{1,80}?)(?=\s*(?:[,;:()\n"]|\.(?:\s|$)|$)|\s+(?:and|who|which|since|where|when|until|in|on|from|for|to)\s)/u.exec(folded.slice(te, Math.min(se, te + PASSAGE)))
  if (after) return after[1].trim()
  const poss = /((?:[\p{L}\p{N}&.\-]+ ){0,3}[\p{L}\p{N}&.\-]+)'s?\s+$/u.exec(folded.slice(Math.max(ss, ts - PASSAGE), ts))
  if (poss && tokenPositions(poss[1], personName).length === 0) return poss[1].trim()
  return null
}

// Positive role binding (#781, audit 9379b162 follow-up). A title counts for the claim only when the source itself ties
// it to BOTH the claimed person and the claimed company, in one of a few explicit shapes; merely sharing a sentence is
// not enough ("Pat Example (Sales Director, Rival Corp) thanked Harbor Ledger Analytics", "Pat Example, Sales Director
// of Rival Corp, met Harbor Ledger Analytics", "Jane Doe, Sales Director at Harbor Ledger Analytics, introduced Pat
// Example" all name the three in one sentence and none of them says Pat is Harbor's Sales Director). Any other
// phrasing is unknown (held), never a pass: a missed valid phrasing costs a hold, a missed rival phrasing a false lead.
const escRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const NOT_WORD = '(?![\\p{L}\\p{N}])'
// Words that may sit between a name and its own title: "Pat Example is now the Sales Director", "Pat Example, formerly
// Sales Director", "Harbor Ledger Analytics named Pat Example its new Sales Director", "promoted Pat Example to ...".
const LINK = '(?:is|was|are|is now|now|has been|had been|became|becomes|remains|serves as|served as|currently|also|' +
  'formerly|previously|former|named|appointed|promoted|elected|made|hired as|as|to|the|our|its|their|a|an|new|current|interim|acting|incoming)'
const JOIN = '(?:joined|joins|has joined|works at|works for|works with|is with|serves at)'
const APPOINT = '(?:has |have )?(?:named|names|appointed|appoints|hired|hires|promoted|promotes|elected|made|welcomed|welcomes|announced|added)'
// The name occurrence [ns, ne) is tied to the title occurrence starting at ts / ending at te.
export function nameTiedToTitle(folded: string, ns: number, ne: number, ts: number, te: number, company: string): boolean {
  const co = escRe(fold(company))
  if (ne <= ts) {
    if (ts - ne > PASSAGE) return false
    const between = folded.slice(ne, ts)
    return new RegExp(`^(?:\\s*[,(:-]\\s*|\\s+)(?:(?:formerly|previously)(?![\\p{L}])[^,;()]{0,80},\\s*)?(?:${LINK}\\s+)*` +
      `(?:${JOIN}\\s+(?:the\\s+)?${co}\\s+as\\s+(?:(?:its|the|our|a|an|new)\\s+)*)?(?:(?:the\\s+)?${co}(?:'s?)?\\s+)?$`, 'u').test(between)
  }
  if (te <= ns) return ns - te <= 3 && /^\s*,?\s*$/u.test(folded.slice(te, ns))   // "Sales Director Pat Example", "Harbor's Sales Director, Pat Example"
  return false
}
// The title occurrence [ts, te) inside its sentence [ss, se) is explicitly the claimed company's.
export function titleOfCompany(folded: string, ts: number, te: number, ss: number, ns: number, ne: number, name: string, company: string): boolean {
  const co = escRe(fold(company)), nm = escRe(fold(name))
  // bounded windows: every shape below is a short phrase next to the title, so a huge sentence costs nothing extra
  const after = folded.slice(te, te + PASSAGE), before = folded.slice(Math.max(ss, ts - PASSAGE), ts)
  const coEnd = `${co}${NOT_WORD}(?!'s?\\s)`   // "at Harbor Ledger Analytics' booth" names Harbor's booth, not Pat's employer
  // "<title> at|of|for|with <Company>"
  if (new RegExp(`^\\s*,?\\s+(?:at|of|for|with)\\s+(?:the\\s+)?${coEnd}`, 'u').test(after)) return true
  // appositive "<Name>, <title>, <Company>" / "<Name> (<title>, <Company>)": the company closes the apposition
  if (ne <= ts && /^\s*[,(:-]\s*$/u.test(folded.slice(ne, ts)) &&
    new RegExp(`^\\s*,\\s*(?:the\\s+)?${co}\\s*(?:[,;)\\n]|\\.(?:\\s|$)|$)`, 'u').test(after)) return true
  // "<Company>'s <title>", "<Company> <title>", "Ex-<Company> <title>"
  if (new RegExp(`(?<![\\p{L}\\p{N}])${co}(?:'s?)?\\s+(?:(?:new|current|interim|acting|incoming)\\s+)?$`, 'u').test(before)) return true
  // "<Company> named|appointed|hired|promoted <Name> (as|to|its) <title>"
  if (new RegExp(`(?<![\\p{L}\\p{N}])${co}\\s+${APPOINT}\\s+${nm}\\s*,?\\s*(?:(?:as|to|its|our|the|new|a|an)\\s+)*$`, 'u').test(before)) return true
  // "<Name> joined|works at <Company> as <title>"
  if (new RegExp(`${JOIN}\\s+(?:the\\s+)?${co}\\s+as\\s+(?:(?:its|the|our|a|an|new)\\s+)*$`, 'u').test(before)) return true
  return false
}

interface Read { s: Snapshot; folded: string }
export function decide(x: DecideInput): CheckResult[] {
  const { claim } = x
  const out: CheckResult[] = []
  const byUrl = new Map(x.sources.map(s => [s.url, s]))
  const need = (url: string, check: CheckId, subject: string): Read | CheckResult => {
    const s = byUrl.get(url)
    if (!s) return r(check, subject, 'unknown', `source ${url} was not fetched`)
    if (s.outcome !== 'ok') return r(check, subject, 'unknown', `source ${url} could not be read by the verifier (${s.outcome})`)
    return { s, folded: fold(s.text) }
  }
  const isRead = (v: Read | CheckResult): v is Read => 's' in v

  // 1. The claim itself.
  const asOfMs = Date.parse(x.asOf)
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(claim.event.date)
  const dateReal = d ? isoDay(+d[1], +d[2], +d[3]) : null
  if (claim.event.date && !dateReal) out.push(r('claim_well_formed', 'claim', 'fail', `event date ${claim.event.date} is not a real calendar day`))
  else if (!Number.isFinite(asOfMs)) out.push(r('claim_well_formed', 'claim', 'unknown', 'as_of is not a valid time'))
  else if (x.problems.length) out.push(r('claim_well_formed', 'claim', 'unknown', x.problems.join('; ')))
  else out.push(r('claim_well_formed', 'claim', 'pass', 'every required part is present'))
  if (!claim.company || !claim.domain || !claim.event.source_url) return out

  const eventUrls = [claim.event.source_url, ...claim.event.corroborating_urls]
  const eventReads = eventUrls.map(u => need(u, 'company_on_source', `source:${u}`))
  const primary = eventReads[0]

  // 2. Identity: the company is named on every cited event source.
  for (const e of eventReads) {
    if (!isRead(e)) { out.push(e); continue }
    out.push(tokenPositions(e.folded, claim.company).length
      ? r('company_on_source', `source:${e.s.url}`, 'pass', `"${claim.company}" is named on the source`)
      : e.s.truncated ? r('company_on_source', `source:${e.s.url}`, 'unknown', `"${claim.company}" is not in the readable part of the source`)
        : r('company_on_source', `source:${e.s.url}`, 'fail', `the source never names "${claim.company}"`))
  }

  // 3. Domain binding: the event source is on the claimed domain, or names it in the same passage as the company
  // itself (not merely anywhere on the page - an unrelated footer, ad or disclaimer naming or linking the domain
  // must not bind a same-name company to it). A registrable domain that cannot be determined for either side (an IP,
  // a bare TLD, a malformed host) is never treated as a match. Otherwise a same-name company on a different domain
  // cannot be ruled out, so this is unknown, never a false pass.
  const hostOf = (s: Snapshot) => { try { return new URL(s.final_url ?? s.url).hostname } catch { return null } }
  const sameDomain = (host: string | null) => { const a = host && registrable(host), b = registrable(claim.domain); return !!a && !!b && a === b }
  if (isRead(primary)) {
    const companyAt = tokenPositions(primary.folded, claim.company)
    const domainNamedNear = near(tokenPositions(primary.folded, claim.domain), companyAt)
    out.push(sameDomain(hostOf(primary.s)) ? r('domain_bound', 'company', 'pass', `the event source is on ${claim.domain} itself`)
      : domainNamedNear ? r('domain_bound', 'company', 'pass', `the event source names ${claim.domain} next to "${claim.company}"`)
        : r('domain_bound', 'company', 'unknown', `the event source neither is on ${claim.domain} nor names it next to "${claim.company}": a same-name company cannot be ruled out`))
  } else out.push(r('domain_bound', 'company', 'unknown', 'the event source could not be read'))

  // 4. Geography: the claimed city is named next to the company (not merely anywhere on the page - a page can
  // mention an unrelated city in some other passage, e.g. a different office, without that being where this event
  // happened). When a country is also claimed, the same source must independently state it too, otherwise an
  // identically-named city elsewhere (London, Ontario vs London, United Kingdom) cannot be ruled out and this stays
  // unknown rather than a false pass.
  if (!claim.place) out.push(r('place_on_source', 'company', 'unknown', 'no place is claimed'))
  else {
    const place = claim.place
    const reads = eventReads.filter(isRead)
    const cityNear = reads.find(e => near(tokenPositions(e.folded, place.city), tokenPositions(e.folded, claim.company)))
    const countryConfirmed = !place.country || (!!cityNear && tokenPositions(cityNear.folded, place.country).length > 0)
    out.push(cityNear && countryConfirmed ? r('place_on_source', 'company', 'pass', `${place.city} is named next to "${claim.company}" on ${cityNear.s.url}`)
      : cityNear ? r('place_on_source', 'company', 'unknown', `${place.city} is named next to "${claim.company}" on ${cityNear.s.url}, but it never confirms ${place.country}: an identically-named city elsewhere cannot be ruled out`)
      : reads.length === 0 ? r('place_on_source', 'company', 'unknown', 'no event source could be read')
        : reads.some(e => e.s.truncated) ? r('place_on_source', 'company', 'unknown', `${place.city} is not next to "${claim.company}" in the readable part of the sources`)
          : r('place_on_source', 'company', 'fail', `no cited source names ${place.city} next to "${claim.company}"`))
  }

  // 5. Event date: stated in the source's own text (not only as its publication stamp or metadata), bound to the company
  // (same passage), not in the future, not announced-only, inside the window.
  const asOfDay = Number.isFinite(asOfMs) ? new Date(asOfMs).toISOString().slice(0, 10) : ''
  const age = dateReal && asOfDay ? Math.round((Date.parse(asOfDay) - Date.parse(dateReal)) / 86_400_000) : NaN
  const eventMentions = (e: Read) => {
    const co = tokenPositions(e.folded, claim.company)
    return datesIn(e.folded).filter(m => !isStamp(e.folded, m) && near([m.index], co))
  }
  if (!dateReal) out.push(r('event_date_on_source', 'event', 'unknown', 'no valid event date is claimed'))
  else if (age < 0) out.push(r('event_date_on_source', 'event', 'fail', `event date ${dateReal} is after as_of ${asOfDay}: it has not happened`))
  else if (age > x.windowDays) out.push(r('event_date_on_source', 'event', 'fail', `event date ${dateReal} is ${age} days before as_of, outside the ${x.windowDays}-day window`))
  else if (!isRead(primary)) out.push(r('event_date_on_source', 'event', 'unknown', 'the event source could not be read'))
  else if (primary.s.meta_days.includes(dateReal)) {
    // A publication/modification day the page itself declares (a pubdate-flagged <time>, a <meta> tag, JSON-LD) always
    // wins over any visible-text mention of the same calendar day: a byline date next to the company by pure
    // proximity ("By Staff Writer Oct 20 ... Harbor Ledger Analytics opened its office in 2019") must not be read as
    // confirming the event, however near the company name it happens to sit.
    out.push(r('event_date_on_source', 'event', 'fail', `${dateReal} is only the page's publication/update date, not a date the page gives the event`))
  } else {
    const all = datesIn(primary.folded)
    const bound = eventMentions(primary).filter(m => m.iso === dateReal)
    if (bound.length) {
      const sentence = sentenceAt(primary.folded, bound[0].index, bound[0].end)
      out.push(ANNOUNCED.test(sentence)
        ? r('event_date_on_source', 'event', 'unknown', `the source announces ${dateReal} ("${sentence.slice(0, 120)}") but does not say it happened`)
        : r('event_date_on_source', 'event', 'pass', `the source states ${dateReal} next to "${claim.company}"`))
    } else if (all.some(m => m.iso === dateReal && isStamp(primary.folded, m))) {
      out.push(r('event_date_on_source', 'event', 'fail', `${dateReal} is only the page's publication/update date, not a date the page gives the event`))
    } else if (all.some(m => m.iso === dateReal)) {
      out.push(r('event_date_on_source', 'event', 'unknown', `${dateReal} is on the source but not in a passage about "${claim.company}"`))
    } else {
      out.push(r('event_date_on_source', 'event', primary.s.truncated ? 'unknown' : 'fail', `the source never states ${dateReal}`))
    }
  }

  // 6. Conflicting sources: a readable event source that dates the company's event, but never on the claimed day.
  // Unknown, not fail: a deterministic check cannot tell a contradiction from a second, different event of the company.
  const conflicts = dateReal ? eventReads.filter(isRead).filter(e => { const m = eventMentions(e); return m.length > 0 && !m.some(z => z.iso === dateReal) }) : []
  out.push(conflicts.length
    ? r('sources_agree', 'event', 'unknown', `${conflicts.map(c => c.s.url).join(', ')} date${conflicts.length > 1 ? '' : 's'} the event differently (${[...new Set(conflicts.flatMap(c => eventMentions(c).map(m => m.iso)))].join(', ')})`)
    : r('sources_agree', 'event', 'pass', 'no cited source dates the event differently'))

  // 7. Quotes: verbatim (case, quote marks, dashes and whitespace aside) on their own cited source, never trusted
  // from the producer's own excerpt. A "..." split inside the claimed text must occur in order, so a quote cannot be
  // assembled from two unrelated fragments - a fabricated or stitched-together quote fails, never passes.
  claim.quotes.forEach((q, i) => {
    const e = need(q.source_url, 'quote_on_source', `quote:${i}`)
    if (!isRead(e)) { out.push(e); return }
    const parts = fold(q.text).replace(/^["']|["']$/g, '').split('...').map(part => part.trim()).filter(Boolean)
    let at = 0
    const found = parts.length > 0 && parts.every(part => { const k = e.folded.indexOf(part, at); if (k < 0) return false; at = k + part.length; return true })
    out.push(found ? r('quote_on_source', `quote:${i}`, 'pass', 'the quote is on the cited source verbatim')
      : r('quote_on_source', `quote:${i}`, e.s.truncated ? 'unknown' : 'fail', `the quote is not on ${q.source_url}`))
  })

  // 8. Person: named on the source, with the claimed title AND the claimed company both bound to that SAME name
  // occurrence's SENTENCE (not title anywhere near the name and company anywhere within a character window,
  // independently - that lets an unrelated company mention in the next sentence, or someone else's title at a
  // different employer, satisfy this), and not described as a former holder of the role - a "formerly"/"until
  // 20xx"/"ex-" marker or a bare past-tense "was <title>" copula fails, never passes. Former-role wording is scoped to
  // the title's OWN clause, so "formerly VP at OldCo, is now CRO at Harbor Ledger Analytics" does not taint the
  // current, separately-clausal claim. An employer the source explicitly attaches to the title ("Sales Director at
  // Rival Corp", "Rival Corp's Sales Director") that is not the claimed company never counts for the claim; when it is
  // the only employer the source gives that title, the check is unknown with that employer named - never a pass (#781,
  // audit 9379b162 cross-employer proximity false pass). Beyond that, the title must be tied POSITIVELY to both the name
  // and the claimed company in an explicit shape (nameTiedToTitle/titleOfCompany above); sharing a sentence is not a
  // relation. Unknown, not fail: one person can hold roles at two firms.
  if (claim.person) {
    const p = claim.person
    const e = need(p.source_url, 'person_current', 'person')
    if (!isRead(e)) out.push(e)
    else {
      const nameAt = tokenPositions(e.folded, p.name)
      const titleAt = tokenPositions(e.folded, p.title)
      const companyAt = tokenPositions(e.folded, claim.company)
      const titleLen = fold(p.title).length
      if (!nameAt.length) out.push(r('person_current', 'person', e.s.truncated ? 'unknown' : 'fail', `${p.name} is not named on ${p.source_url}`))
      else {
        // Per name occurrence: the titles and company mentions inside its own sentence.
        const reads = nameAt.map(i => {
          const [ss, se] = sentenceSpan(e.folded, i)
          const inS = (x: number) => x >= ss && x < se
          // only titles within one passage of the name can be its own (this also bounds the work on a huge sentence)
          return { i, ss, se, titles: titleAt.filter(t => inS(t) && Math.abs(t - i) <= PASSAGE), companies: companyAt.filter(inS) }
        })
        const employerOf = (t: number, ss: number, se: number) => attachedEmployer(e.folded, t, t + titleLen, ss, se, p.name)
        const ofCompany = (phrase: string) => tokenPositions(phrase, claim.company).length > 0 || fold(claim.company).startsWith(`${phrase} `)   // a name cut at its own "and" ("Smith and Sons")
        // A title occurrence counts for the claim unless the source attaches it to some other employer.
        const forClaim = (rd: typeof reads[number]) => rd.titles.filter(t => { const emp = employerOf(t, rd.ss, rd.se); return emp === null || ofCompany(emp) })
        const nameLen = fold(p.name).length
        // A title counts only when tied to THIS name occurrence and explicitly to the claimed company (positive binding).
        const tied = (rd: typeof reads[number]) => forClaim(rd).filter(t => nameTiedToTitle(e.folded, rd.i, rd.i + nameLen, t, t + titleLen, claim.company) &&
          titleOfCompany(e.folded, t, t + titleLen, rd.ss, rd.i, rd.i + nameLen, p.name, claim.company))
        const bound = reads.find(rd => rd.companies.length > 0 && tied(rd).length > 0)
        const rival = reads.map(rd => ({ rd, emps: rd.titles.map(t => employerOf(t, rd.ss, rd.se)) })).find(x => x.emps.length > 0 && x.emps.every(emp => emp !== null && !ofCompany(emp)))
        if (bound === undefined) {
          const together = reads.some(rd => rd.companies.length > 0 && rd.titles.length > 0)
          out.push(rival ? r('person_current', 'person', 'unknown', `the source gives ${p.name}'s "${p.title}" role at ${rival.emps[0]}, not at "${claim.company}"`)
            : together ? r('person_current', 'person', 'unknown', `the source names ${p.name}, "${p.title}" and "${claim.company}" in one sentence but never states that ${p.name} is "${claim.company}"'s ${p.title}`)
              : r('person_current', 'person', 'unknown', `the title "${p.title}" and "${claim.company}" are not both in the same sentence as ${p.name} on the source`))
        } else {
          const titleClauses = tied(bound).map(t => clauseAt(e.folded, t))
          const formerClause = titleClauses.find(c => FORMER.test(c) || PAST_STATE.test(c))
          out.push(formerClause ? r('person_current', 'person', 'fail', `the source describes ${p.name}'s "${p.title}" as a past role ("${formerClause.slice(0, 120)}")`)
            : r('person_current', 'person', 'pass', `${p.name}, ${p.title}, at ${claim.company}, in one sentence on the source with no former-role marker`))
        }
      }
    }
  }

  // 9. Contact route: the address is printed on its cited source, on the company's own domain, and is not a generic
  // hiring/recruiting inbox (a buyer route, not a job application address).
  if (claim.contact) {
    const c = claim.contact
    const mailDomain = c.email.split('@')[1] ?? ''
    out.push(isRecruitingMailbox(c.email) ? r('contact_not_recruiting', 'contact', 'fail', `${c.email.split('@')[0]}@ is a hiring inbox, not a buyer route`)
      : r('contact_not_recruiting', 'contact', 'pass', 'not a hiring inbox'))
    out.push(sameDomain(mailDomain) ? r('contact_domain', 'contact', 'pass', `the address is on ${claim.domain}`)
      : r('contact_domain', 'contact', 'fail', `the address is on ${mailDomain}, not the company's domain ${claim.domain}`))
    const e = need(c.source_url, 'contact_on_source', 'contact')
    if (!isRead(e)) out.push(e)
    else out.push(emailsIn(e.folded).includes(fold(c.email)) ? r('contact_on_source', 'contact', 'pass', 'the address is printed on its cited source')
      : r('contact_on_source', 'contact', e.s.truncated ? 'unknown' : 'fail', `${c.source_url} does not show the address`))
  }

  return out
}

export type Verdict = Status
export type Action = 'accept' | 'hold' | 'skip'
// Any fail: the lead is skipped. Otherwise any unknown: held (automatically; no person is asked to check it). Only an
// all-pass record is accepted.
export function overall(checks: CheckResult[]): { verdict: Verdict; action: Action } {
  if (checks.some(c => c.status === 'fail')) return { verdict: 'fail', action: 'skip' }
  if (checks.length === 0 || checks.some(c => c.status === 'unknown')) return { verdict: 'unknown', action: 'hold' }
  return { verdict: 'pass', action: 'accept' }
}
