// Deterministic checks of the independent evidence verifier (docs/design/evidence-verifier.md). decide() is a pure
// function of the blinded claim, the verifier's OWN fetched source snapshots, the recorded judge samples and as_of, so a
// stored verdict record replays to the same verdict (service.ts replayRecord). Unknown is never pass; a fail is a
// concrete contradiction on the fetched source (a quote that is not there, a different city, a recruiting inbox, a
// future or stale day); a source the verifier could not fetch or read makes the checks that need it unknown, never fail.
import type { LeadClaim } from './claim.ts'
import { datesIn, fold, isStamp, isoDay, normalizeUrl, overlap, registrable, sentenceAt, shingles, tokenPositions } from './text.ts'

export type Status = 'pass' | 'fail' | 'unknown'
export interface CheckResult { check: string; version: number; subject: string; status: Status; reason: string }

// One cited source as the verifier itself fetched it. Text and metadata are extracted at fetch time (service.ts) and stored,
// so replay never re-fetches.
export interface Snapshot {
  url: string
  outcome: 'ok' | 'unauthorized' | 'error' | 'timeout' | 'not_html' | 'budget'
  final_url: string | null
  status: number | null
  text: string            // visible text ('' unless ok)
  truncated: boolean      // text was cut at MAX_TEXT_CHARS: an absence on it is unknown, not fail
  meta_days: string[]     // publication/modification days in the page's metadata
  canonical: string | null
  linked_domains: string[]
  sha256: string | null   // of the fetched body as received
}

export interface JudgeSample { answer: 'yes' | 'no' | 'unclear' | 'timeout' | 'error'; cost_usd: number }
export interface JudgeTrail { predicate: number; judge_id: string | null; refused: string | null; samples: JudgeSample[] }

export interface DecideInput { claim: LeadClaim; problems: string[]; sources: Snapshot[]; judgements: JudgeTrail[]; asOf: string; windowDays: number }

export const CHECK_VERSIONS = {
  claim_well_formed: 1, company_on_source: 1, domain_bound: 1, place_on_source: 1, event_date_on_source: 1,
  sources_agree: 1, independent_confirmation: 1, quote_on_source: 1, person_current: 1, contact_on_source: 1,
  contact_domain: 1, contact_not_recruiting: 1, predicate_judged: 1,
} as const
type CheckId = keyof typeof CHECK_VERSIONS
const r = (check: CheckId, subject: string, status: Status, reason: string): CheckResult => ({ check, version: CHECK_VERSIONS[check], subject, status, reason })

const FORMER = /(?<![\p{L}])(?:(?:former|formerly|previously|departed|left (?:the company|in (?:19|20)\d{2}|to join)|retired|alumn(?:us|a|i)|used to|until (?:19|20)\d{2}|no longer)(?![\p{L}])|ex-(?=\p{L}))/u
const ANNOUNCED = /(?<![\p{L}])(will|plans? to|planning to|is set to|are set to|set to open|upcoming|scheduled|expected to|intends? to|aims? to|later this year|next (?:week|month|year)|coming soon)(?![\p{L}])/u
// Hiring inboxes, matched on the whole mailbox name before any +tag with punctuation removed (careers+toronto@,
// talent.acquisition@ and join-us@ are hiring inboxes; hrishi@ and jobsworth@ are not). The verifier's own list.
const RECRUITING = /^(?:jobs?|careers?|recruit(?:ing|ment|ers?)?|talent(?:acquisition|team)?|hr|humanresources|people(?:ops|team)?|hiring|apply|applications?|applicants?|cvs?|resumes?|joinus|join(?:theteam)?|workwithus|work|vacanc(?:y|ies)|staffing)$/
export const isRecruitingMailbox = (email: string) => RECRUITING.test((email.split('@')[0] ?? '').split('+')[0].replace(/[._-]/g, ''))

const PASSAGE = 250
const near = (a: number[], b: number[], d = PASSAGE) => a.some(x => b.some(y => Math.abs(x - y) <= d))
const sameDomain = (host: string | null, domain: string) => !!host && (registrable(host) === registrable(domain))
const hostOf = (s: Snapshot) => { try { return new URL(s.final_url ?? s.url).hostname } catch { return null } }

// Snapshots that share one origin: the same document (URL or canonical), the same site, or a near-verbatim copy of the
// same text (syndication). Copies in one group are one source, however many URLs they have.
export function provenanceGroups(sources: Snapshot[]): string[][] {
  const ok = sources.filter(s => s.outcome === 'ok')
  const parent = ok.map((_, i) => i)
  const find = (i: number): number => parent[i] === i ? i : (parent[i] = find(parent[i]))
  const sh = ok.map(s => shingles(fold(s.text)))
  const keys = ok.map(s => new Set([normalizeUrl(s.url), normalizeUrl(s.final_url ?? s.url), ...(s.canonical ? [s.canonical] : [])]))
  const site = ok.map(s => registrable(s.final_url ?? s.url))
  for (let i = 0; i < ok.length; i++) for (let j = i + 1; j < ok.length; j++) {
    const shared = [...keys[i]].some(k => keys[j].has(k))
    if (shared || (site[i] && site[i] === site[j]) || overlap(sh[i], sh[j]) >= 0.6) parent[find(j)] = find(i)
  }
  const groups = new Map<number, string[]>()
  ok.forEach((s, i) => { const g = find(i); groups.set(g, [...(groups.get(g) ?? []), s.url]) })
  return [...groups.values()]
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

  // 2. Identity: the company is named on every cited event source, and the source is bound to the company's own domain.
  for (const e of eventReads) {
    if (!isRead(e)) { out.push(e); continue }
    out.push(tokenPositions(e.folded, claim.company).length
      ? r('company_on_source', `source:${e.s.url}`, 'pass', `"${claim.company}" is named on the source`)
      : e.s.truncated ? r('company_on_source', `source:${e.s.url}`, 'unknown', `"${claim.company}" is not in the readable part of the source`)
        : r('company_on_source', `source:${e.s.url}`, 'fail', `the source never names "${claim.company}"`))
  }
  if (isRead(primary)) {
    const domainNamed = tokenPositions(primary.folded, claim.domain).length > 0
    const linked = primary.s.linked_domains.includes(registrable(claim.domain) ?? claim.domain)
    out.push(sameDomain(hostOf(primary.s), claim.domain) ? r('domain_bound', 'company', 'pass', `the event source is on ${claim.domain} itself`)
      : domainNamed || linked ? r('domain_bound', 'company', 'pass', `the event source ${domainNamed ? 'names' : 'links to'} ${claim.domain}`)
        : r('domain_bound', 'company', 'unknown', `the event source neither is on, names nor links to ${claim.domain}: a same-name company cannot be ruled out`))
  } else out.push(r('domain_bound', 'company', 'unknown', 'the event source could not be read'))

  // 3. Geography: the claimed city is on a source that names the company, as a whole word.
  if (!claim.place) out.push(r('place_on_source', 'company', 'unknown', 'no place is claimed'))
  else {
    const reads = eventReads.filter(isRead)
    const hit = reads.find(e => tokenPositions(e.folded, claim.place!.city).length)
    out.push(hit ? r('place_on_source', 'company', 'pass', `${claim.place.city} is on ${hit.s.url}`)
      : reads.length === 0 ? r('place_on_source', 'company', 'unknown', 'no event source could be read')
        : reads.some(e => e.s.truncated) ? r('place_on_source', 'company', 'unknown', `${claim.place.city} is not in the readable part of the sources`)
          : r('place_on_source', 'company', 'fail', `no cited source places the company in ${claim.place.city}`))
  }

  // 4. Event date: stated in the source's own text (not only as its publication stamp or metadata), bound to the company
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
  else {
    const all = datesIn(primary.folded)
    const bound = eventMentions(primary).filter(m => m.iso === dateReal)
    if (bound.length) {
      const sentence = sentenceAt(primary.folded, bound[0].index, bound[0].end)
      out.push(ANNOUNCED.test(sentence)
        ? r('event_date_on_source', 'event', 'unknown', `the source announces ${dateReal} ("${sentence.slice(0, 120)}") but does not say it happened`)
        : r('event_date_on_source', 'event', 'pass', `the source states ${dateReal} next to "${claim.company}"`))
    } else if (all.some(m => m.iso === dateReal && isStamp(primary.folded, m)) || primary.s.meta_days.includes(dateReal)) {
      out.push(r('event_date_on_source', 'event', 'fail', `${dateReal} is only the page's publication/update date, not a date the page gives the event`))
    } else if (all.some(m => m.iso === dateReal)) {
      out.push(r('event_date_on_source', 'event', 'unknown', `${dateReal} is on the source but not in a passage about "${claim.company}"`))
    } else {
      out.push(r('event_date_on_source', 'event', primary.s.truncated ? 'unknown' : 'fail', `the source never states ${dateReal}`))
    }
  }

  // 5. Conflicting sources: a readable event source that dates the company's event, but never on the claimed day.
  const conflicts = dateReal ? eventReads.filter(isRead).filter(e => { const m = eventMentions(e); return m.length > 0 && !m.some(z => z.iso === dateReal) }) : []
  // Unknown, not fail: a deterministic check cannot tell a contradiction from a second, different event of the company.
  out.push(conflicts.length
    ? r('sources_agree', 'event', 'unknown', `${conflicts.map(c => c.s.url).join(', ')} date${conflicts.length > 1 ? '' : 's'} the event differently (${[...new Set(conflicts.flatMap(c => eventMentions(c).map(m => m.iso)))].join(', ')})`)
    : r('sources_agree', 'event', 'pass', 'no cited source dates the event differently'))

  // 6. Independent confirmation: first-party, or two sources of different origin; syndicated copies count once.
  const groups = provenanceGroups(x.sources.filter(s => eventUrls.includes(s.url)))
  const firstParty = eventReads.filter(isRead).some(e => sameDomain(hostOf(e.s), claim.domain))
  const confirming = groups.filter(g => g.some(u => { const e = eventReads.find(z => isRead(z) && z.s.url === u) as Read | undefined; return !!e && !!dateReal && eventMentions(e).some(m => m.iso === dateReal) }))
  out.push(firstParty ? r('independent_confirmation', 'event', 'pass', `the company's own site (${claim.domain}) is a cited source`)
    : confirming.length >= 2 ? r('independent_confirmation', 'event', 'pass', `${confirming.length} sources of different origin state the event date`)
      : r('independent_confirmation', 'event', 'unknown', `${confirming.length} independent origin(s) state the event date (${groups.length} origin(s) among ${eventUrls.length} cited URL(s)); copies of one source are one source`))

  // 7. Quotes: verbatim (case, quote marks, dashes and whitespace aside) on the cited source; "..." splits are in order.
  claim.quotes.forEach((q, i) => {
    const e = need(q.source_url, 'quote_on_source', `quote:${i}`)
    if (!isRead(e)) { out.push(e); return }
    const parts = fold(q.text).replace(/^["']|["']$/g, '').split('...').map(p => p.trim()).filter(Boolean)
    let at = 0
    const found = parts.length > 0 && parts.every(p => { const k = e.folded.indexOf(p, at); if (k < 0) return false; at = k + p.length; return true })
    out.push(found ? r('quote_on_source', `quote:${i}`, 'pass', 'the quote is on the cited source verbatim')
      : r('quote_on_source', `quote:${i}`, e.s.truncated ? 'unknown' : 'fail', `the quote is not on ${q.source_url}`))
  })

  // 8. Person: named on the source, with the claimed title and employer in the same passage, and not as a former holder.
  if (claim.person) {
    const p = claim.person
    const e = need(p.source_url, 'person_current', 'person')
    if (!isRead(e)) out.push(e)
    else {
      const at = tokenPositions(e.folded, p.name)
      const passages = at.map(i => e.folded.slice(Math.max(0, i - 150), i + p.name.length + 150))
      const sentences = at.map(i => sentenceAt(e.folded, i, i + p.name.length))
      if (!at.length) out.push(r('person_current', 'person', e.s.truncated ? 'unknown' : 'fail', `${p.name} is not named on ${p.source_url}`))
      else if (sentences.some(s => FORMER.test(s))) out.push(r('person_current', 'person', 'fail', `the source describes ${p.name} as a former holder ("${sentences.find(s => FORMER.test(s))!.slice(0, 120)}")`))
      else if (!passages.some(s => s.includes(fold(p.title)))) out.push(r('person_current', 'person', 'unknown', `the title "${p.title}" is not next to ${p.name} on the source`))
      else if (!tokenPositions(e.folded, claim.company).length && !sameDomain(hostOf(e.s), claim.domain)) out.push(r('person_current', 'person', 'unknown', `the person's source does not tie them to ${claim.company}`))
      else out.push(r('person_current', 'person', 'pass', `${p.name}, ${p.title}, on the source with no former-role marker`))
    }
  }

  // 9. Contact route: the address is printed on its cited source, on the company's domain, and is not a hiring inbox.
  if (claim.contact) {
    const c = claim.contact
    const mailDomain = c.email.split('@')[1] ?? ''
    out.push(isRecruitingMailbox(c.email) ? r('contact_not_recruiting', 'contact', 'fail', `${c.email.split('@')[0]}@ is a hiring inbox, not a buyer route`)
      : r('contact_not_recruiting', 'contact', 'pass', 'not a hiring inbox'))
    out.push(sameDomain(mailDomain, claim.domain) ? r('contact_domain', 'contact', 'pass', `the address is on ${claim.domain}`)
      : r('contact_domain', 'contact', 'fail', `the address is on ${mailDomain}, not the company's domain ${claim.domain}`))
    const e = need(c.source_url, 'contact_on_source', 'contact')
    if (!isRead(e)) out.push(e)
    else out.push(e.folded.includes(c.email) ? r('contact_on_source', 'contact', 'pass', 'the address is printed on its cited source')
      : r('contact_on_source', 'contact', e.s.truncated ? 'unknown' : 'fail', `${c.source_url} does not show the address`))
  }

  // 10. Requested predicates: semantic, judged by a separately configured model (judge.ts); two agreeing answers or unknown.
  claim.predicates.forEach((_, i) => {
    const t = x.judgements.find(j => j.predicate === i)
    const answered = t?.samples.filter(s => s.answer === 'yes' || s.answer === 'no') ?? []
    if (!t) out.push(r('predicate_judged', `predicate:${i}`, 'unknown', 'not judged'))
    else if (t.refused) out.push(r('predicate_judged', `predicate:${i}`, 'unknown', t.refused))
    else if (answered.length < 2) out.push(r('predicate_judged', `predicate:${i}`, 'unknown', `judge gave ${answered.length} usable answer(s) in ${t.samples.length} attempt(s) (${t.samples.map(s => s.answer).join(', ') || 'none'})`))
    else if (answered.some(s => s.answer !== answered[0].answer)) out.push(r('predicate_judged', `predicate:${i}`, 'unknown', 'the judge disagreed with itself'))
    else out.push(r('predicate_judged', `predicate:${i}`, answered[0].answer === 'yes' ? 'pass' : 'fail', `judge ${t.judge_id} answered ${answered[0].answer} twice`))
  })
  return out
}

export type Verdict = Status
export type Action = 'accept' | 'hold' | 'skip'
// Any fail: the lead is skipped. Otherwise any unknown: held (automatically; no person is asked to check it). Only an all-
// pass record is accepted.
export function overall(checks: CheckResult[]): { verdict: Verdict; action: Action } {
  if (checks.some(c => c.status === 'fail')) return { verdict: 'fail', action: 'skip' }
  if (checks.length === 0 || checks.some(c => c.status === 'unknown')) return { verdict: 'unknown', action: 'hold' }
  return { verdict: 'pass', action: 'accept' }
}
