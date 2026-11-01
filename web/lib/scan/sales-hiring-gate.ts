import { requestedHiringRoles, matchedHiringRole, roleNeedsSourceProof } from './hiring-role-match.ts'
// "Seed funding AND hiring sales": a request whose play needs an event beyond hiring plus sales / GTM hiring is not answered by the
// funding quote alone. After the contact crawl has bound each lead to its company domain, a verified lead keeps its place only when
//   (a) its own saved quote already names a sales / GTM hiring (the source says it), or
//   (b) a dated (inside the window, default 90 days) sales / GTM posting sits on a public Greenhouse / Lever / Ashby board bound to the
//       lead's own domain (lib/signals/ats-gtm.ts).
// Otherwise it moves to review with the distinct reason `no_sales_hiring_evidence` and says so on its card. This only ADDS a requirement:
// the quote, date, identity and place gates that put the lead there are not touched, and nothing here promotes a review row.
import type Database from 'better-sqlite3'
import { randomBytes } from 'node:crypto'
import { addEnrichment, audit } from '../connectors/store.ts'
import { atsGtmBoard, isGtmRole, postingEvidence, boardTitleAudit, boardCoverageRow, checkedAuditRows, checkedCoverageRow, fullListingAuditRows, fullListingCoverageRow, withRepostHistory, BOARD_LABEL } from '../signals/ats-gtm.ts'
import { careersSalesVacancy } from '../signals/careers-page.ts'
import { placeAgreement, eventPlaceOk } from './place-agreement.ts'
import { releaseHeld } from './held-state.ts'
import { salesHiringRequired } from './sales-hiring-required.ts'
export { salesHiringRequired }
import { norm } from './evidence.ts'
import type { Get } from '../connectors/sitecrawl.ts'
import { domainRelationship } from '../signals/domain-basis.ts'
import { needsEventBeyondHiring, showsEventBeyondHiring, mentionsFunding } from '../search/page-class.ts'
import { parseWindowDays } from './window.ts'
import { WHY_MAX } from './score.ts'

export const NO_SALES_HIRING = 'no_sales_hiring_evidence'
export const NO_EVENT = 'no_event_evidence'
export const SALES_GATE_FAILED = 'sales_hiring_check_failed'
const MAX_BOARD_LOOKUPS = 20 // network lookups per run; a lead beyond it is NOT passed, it is held as unchecked

interface JobLike { id: string; user_id: string; query?: string | null; icp?: string | null }

// The source quote itself says the company is hiring for a sales / GTM role.
// The saved quote / claim itself shows the event half (funding, an opening ...): a job ad alone does not show that a company raised money.
// When the request asks for FUNDING, only a funding mention counts (an office opening is not a raise); otherwise any event beyond hiring does.
// Event half. The sentence must be about THIS company (case-insensitive subject check), must affirm the event (not "did not raise", "plans to raise", "in talks"),
// and, when the request names a funding STAGE, must be that stage ("Series A" never answers a seed request, "seed" never a Series A request).
export type Stage = 'seed' | `series ${string}` | null
export function requestedStage(query: string | null | undefined, icp: string | null | undefined): Stage {
  let sig = ''; try { const j = icp ? JSON.parse(icp) as { signals?: unknown } : null; if (Array.isArray(j?.signals)) sig = j!.signals.filter((x): x is string => typeof x === 'string').join(' . ') } catch { /* none */ }
  const t = `${sig} . ${query ?? ''}`
  const series = /\bseries\s+([a-e])\b/i.exec(t)
  if (/\bseed\b/i.test(t) && !series) return 'seed'
  return series ? `series ${series[1].toLowerCase()}` : /\bseed\b/i.test(t) ? 'seed' : null
}
const RAISE_VERB = /\b(?:rais(?:ed|es)|clos(?:ed|es)|secur(?:ed|es)|announc(?:ed|es)|land(?:ed|s)|complet(?:ed|es)|bagg?(?:ed|s)|receiv(?:ed|es)|won|gets|got|backed|funded|seed-funded|unveil(?:ed|s))\b/i
const FUNDING_NEG = /\b(?:not|no|never|didn'?t|hasn'?t|haven'?t|wasn'?t|without|failed\s+to|unable\s+to|yet\s+to|den(?:y|ies|ied)|reject\w*|refut\w+|cancel\w*|withdr\w+|collaps\w+|fell\s+through|ruled?\s+out|untrue|false)\b/i
const FUNDING_HYPO = /\b(?:(?:plans?|planned|planning|intends?|intending|intentions?|aims?|aiming|proposes?|proposed|considering|exploring|mulling|weighing|preparing|prepares?|prepared)\s+(?:for\s+|to\s+|of\s+|on\s+)?(?:(?:a|an|its|the|new|first|another|additional)\s+)*(?:\S+\s+){0,4}?(?:raise|raising|close|closing|secure|securing|round|seed|series|funding|financing|fundrais\w+|investment)|(?:to|will|shall|would|set\s+to|about\s+to|poised\s+to|slated\s+to|due\s+to|preparing\s+to|expected\s+to|likely\s+to|ready\s+to|going\s+to)\s+(?:raise|close|secure|announce|complete|finali[sz]e|land)|raising|closing|securing|finali[sz]\w+|negotiat\w+|pursuing|targeting|nearing|ongoing|in\s+the\s+process|open\s+round|if|unless|would|could|may|might|plans?\s+to|planning\s+to|hopes?\s+to|aims?\s+to|intends?\s+to|looking\s+to|seeking\s+to|in\s+talks|expects?\s+to|expected\s+to|reportedly|rumou?r\w*|allegedly)\b/i
export function stageOk(clause: string, stage: Stage): boolean {
  if (!stage) return true
  const series = /\bseries\s+([a-z])\b|\b(?:growth|bridge)\s+(?:round|equity)\b/i.exec(clause)
  if (stage === 'seed') return /\b(?:pre-?)?seed\b/i.test(clause) && !series
  const letter = stage.slice(7)
  return new RegExp(`\\bseries\\s+${letter}\\b`, 'i').test(clause) && !/\bseed\b/i.test(clause)
}
export const quoteShowsEvent = (excerpt: string | null, signal: string | null, fundingAsked = false, company?: string | null, stage: Stage = null): boolean => { void signal
  return clauses(excerpt ?? '').some(c => {
    if (!fundingAsked) { const i = c.search(/\b(?:open|launch|expan|announc)/i); return showsEventBeyondHiring(c) && !subjectIsOther(c.slice(0, Math.max(0, i)), company) }
    if (!mentionsFunding(c) || FUNDING_NEG.test(c) || FUNDING_HYPO.test(c)) return false
    const v = RAISE_VERB.exec(c); if (!v) return false
    return stageOk(c, stage) && !subjectIsOther(c.slice(0, v.index), company)
  }) }
export const requestAsksFunding = (query: string | null | undefined, icp: string | null | undefined): boolean => { let sig = ''; try { const j = icp ? JSON.parse(icp) as { signals?: unknown } : null; if (Array.isArray(j?.signals)) sig = j!.signals.filter((x): x is string => typeof x === 'string').join(' . ') } catch { /* none */ } return mentionsFunding(`${sig} . ${query ?? ''}`) }
// Affirmative hiring proof, not keyword co-occurrence. A CLAUSE (split on sentence ends and but / however / while / although / yet) must say the lead's OWN
// company is hiring, now, for a sales / GTM role:
//   - not negated or denied ("not hiring", "no plans to hire", "hiring freeze", "denies hiring", "rules out", "rejects reports of");
//   - not conditional, hypothetical, planned or hearsay ("only if", "once", "would", "may", "plans to", "will", "reportedly");
//   - not past ("was hiring", "previously", "hired");
//   - the sales noun must be the HEAD of the object ("hiring sales tax accountants" and "a sales operations accountant" are not sales roles);
//   - the subject must be the lead's company: another named company in front of the verb ("Separately, Othercorp is hiring sales staff") is not it.
// Anything this cannot read as plainly affirmative fails closed.
const NEGATED = /\b(?:not|no|never|none|nor|without|isn'?t|aren'?t|wasn'?t|won'?t|doesn'?t|don'?t|didn'?t|hasn'?t|haven'?t|can'?t|cannot|zero|freeze|frozen|paused?|halt(?:ed|s)?|suspend(?:ed|s)?|cancel(?:l?ed|s)?|rescind(?:ed|s)?|scrapp(?:ed|ing)|shelv(?:ed|ing)|delay(?:ed|ing)?|postpon(?:ed|ing)|abandon(?:ed|ing)|ruled?\s+out|rules?\s+out|stopped|stops?|layoffs?|laid\s+off|cut(?:ting|s)?|den(?:y|ies|ied|ying)|refut\w+|reject\w*|dismiss\w*|debunk\w*|disput\w+|disclaim\w*|untrue|false|incorrect|wrong|rumou?r\w*|reportedly|allegedly|supposedly|reports?\s+(?:of|that|say)|unconfirmed)\b/i
const HYPOTHETICAL = /\b(?:if|only\s+if|once|when|whenever|unless|until|provided|assuming|should|would|could|may|might|will|shall|plans?\s+to|planning\s+to|plan\s+is|intends?|intending|aims?\s+to|hopes?\s+to|expects?\s+to|expected\s+to|later\s+this|next\s+(?:year|quarter|month)|eventually|potentially|possibly|pending|depends?|subject\s+to|after\s+(?:the\s+)?(?:close|funding)|in\s+the\s+future)\b/i
const PAST = /\b(?:was|were|had|used\s+to|previously|formerly|last\s+(?:year|quarter|month)|no\s+longer|stopped|hired|recruited|added)\b/i
const HIRE_VERB = '(?:hir(?:e|es|ing)|recruit(?:s|ing)?|seek(?:s|ing)?|look(?:s|ing)\\s+(?:to\\s+hire|for)|add(?:s|ing)|building\\s+out)'
const FILLER = '(?:(?:a|an|our|its|their|the|first|new|senior|junior|founding|key|two|three|four|five|six|\\d+|more|several|some|additional|dedicated|experienced|full[-\\s]?time|remote|enterprise|inbound|outbound|lead|for|in|across|into|within|to\\s+the|to\\s+our|to\\s+build\\s+(?:out\\s+)?(?:our|its|the))\\s+){0,6}'
const GTM_OBJECT = '(?:head\\s+of\\s+(?:sales|growth|revenue)|account\\s+(?:executive|manager|director)s?|aes?|sdrs?|bdrs?|sales(?:\\s+(?:reps?|representatives?|people|persons?|staff|team|leaders?|managers?|directors?|engineers?|development\\s+reps?|hires?|professionals?|executives?|talent|roles?|positions?))?|business\\s+development(?:\\s+(?:reps?|representatives?|managers?|leads?))?|go[-\\s]to[-\\s]market|gtm|revenue\\s+(?:leaders?|team|roles?)|growth\\s+(?:leaders?|team|marketers?)|customer\\s+success(?:\\s+(?:managers?|reps?|team))?|solutions?\\s+(?:engineer|consultant)s?|vp\\s+(?:of\\s+)?sales|demand\\s+gen\\w*)'
// The object must END there (end of clause, punctuation, or a function word): "sales" followed by "tax accountants" / "operations accountant" is a modifier of another role.
const OBJECT_END = '(?=\\s*(?:$|[,:()-]|\\s(?:and|or|to|for|in|across|at|this|next|now|as|with|from|who|that|ahead|so|because|following|based|located|remote|globally|worldwide|today|currently)\\b))'
const HIRING_VERB_OBJECT = new RegExp(`\\b${HIRE_VERB}\\s+${FILLER}${GTM_OBJECT}${OBJECT_END}`, 'i')
const OPEN_ROLE = /\b(?:open|new|several|two|three|\d+)\s+(?:[a-z-]+\s+){0,3}(?:roles?|positions?|openings?|vacanc(?:y|ies))\b/i
const FIRST_HIRE = /\b(?:first|new|key)\s+(?:sales|ae|sdr|bdr|gtm|account\s+executive)\s+hire\b|\bjoin(?:ing)?\s+(?:our|the)\s+(?:sales|gtm)\s+team\b/i
const clauses = (t: string) => t.split(/[.;!?\n]+|\s(?:but|however|while|although|though|yet)\s/i).map(x => x.trim()).filter(Boolean)
// The subject in front of a hiring / raising verb must be the lead (case-insensitive: "othercorp is hiring" is another company just like "Othercorp").
// The prefix is cut into segments at commas / "and" / "which" / "who" / "while" / "as"; the nearest segment that says anything is the subject segment. It is the
// lead's when it names the company (not as the object of a preposition: "Acme, which works with Brightloop, is hiring" is Acme) or says nothing but generic words
// (it, the startup, the London company, raised a seed round ...). Any other word in it is another company.
const NOT_ENTITY = new Set(['the', 'it', 'its', 'we', 'our', 'they', 'their', 'now', 'also', 'still', 'currently', 'and', 'then', 'today', 'london', 'uk', 'nyc', 'new', 'york', 'us', 'saas', 'b2b', 'seed', 'series', 'startup', 'company', 'team', 'founder', 'founders', 'ceo', 'cto', 'cofounder', 'inc', 'ltd', 'llc', 'limited', 'plc', 'a', 'an', 'in', 'at', 'to', 'of', 'for', 'is', 'are', 'has', 'have', 'recently', 'just', 'actively', 'already', 'additionally', 'meanwhile', 'following', 'was', 'were', 'been', 'being', 'will', 'which', 'who', 'that', 'raised', 'raises', 'raising', 'announced', 'closed', 'secured', 'round', 'funding', 'million', 'pre', 'based', 'london-based', 'early-stage', 'young', 'growing', 'fast-growing', 'british', 'uk-based', 'this', 'month', 'week', 'year', 'separately', 'elsewhere', 'furthermore', 'however', 'but', 'sales', 'gtm', 'platform', 'software', 'firm', 'business', 'brand'])
const PREPOSITION = new Set(['with', 'from', 'by', 'at', 'for', 'of', 'to', 'via', 'behind', 'near', 'like', 'including', 'about', 'on', 'over', 'under', 'against'])
const wordsOf = (x: string) => x.toLowerCase().replace(/&/g, ' and ').replace(/['’]s\b/g, '').split(/[^a-z0-9]+/).filter(Boolean)
export function subjectIsOther(prefix: string, company: string | null | undefined): boolean {
  if (!company) return false
  const own = new Set(wordsOf(company).filter(w => !['inc', 'ltd', 'llc', 'limited', 'plc', 'the', 'co', 'corp', 'group'].includes(w)))
  if (own.size === 0) return false
  // alternating [segment, delimiter, segment, ...]; a relative pronoun (which / who / that) makes the nearest noun in front of it the subject ("partners with othercorp, which is hiring")
  const parts = prefix.split(/(,|;|\band\b|\bwhile\b|\bwhich\b|\bwho\b|\bas\b|\bthat\b)/i)
  const AUX = ['is', 'are', 'was', 'were', 'has', 'have', 'been', 'now', 'also', 'still', 'currently', 'actively', 'recently', 'just', 'already']
  for (let i = parts.length - 1; i >= 0; i -= 2) {
    const seg = wordsOf(parts[i])
    const sayings = seg.filter(w => !AUX.includes(w))
    if (sayings.length === 0) {
      const delim = (parts[i - 1] ?? '').trim().toLowerCase()
      if (delim === 'which' || delim === 'who' || delim === 'that') {
        const before = parts.slice(0, Math.max(0, i - 1)).filter((_, k) => k % 2 === 0).map(wordsOf).reverse().find(w => w.length > 0)
        const ante = before ? before[before.length - 1] : undefined
        if (ante === undefined) return false
        return !own.has(ante) && !NOT_ENTITY.has(ante) && !/^\d/.test(ante)
      }
      continue // only auxiliaries after and / a comma: the subject is carried from the earlier segment
    }
    // A segment with no subject of its own carries the earlier one: it starts with a past-tense verb ("... and raised a seed round") or is an appositive after a comma
    // ("Brightloop, a London B2B SaaS startup with 24 employees, raised ..."). Unless it names the company itself, the walk goes on to the segment in front of it.
    const carries = !seg.some(w => own.has(w)) && ((/^[a-z]+ed$/.test(seg[0])) || (['a', 'an', 'the'].includes(seg[0]) && (parts[i - 1] ?? '').trim() === ','))
    if (carries) continue
    if (seg.some((w, k) => own.has(w) && !(k > 0 && PREPOSITION.has(seg[k - 1])))) return false
    return seg.filter(w => !(NOT_ENTITY.has(w) && !own.has(w)) && !/^\d/.test(w)).length > 0
  }
  return false
}
export const affirmativeSalesHiring = (text: string | null, company?: string | null): boolean => clauses(text ?? '').some(c => {
  if (NEGATED.test(c) || HYPOTHETICAL.test(c) || PAST.test(c)) return false
  const m = HIRING_VERB_OBJECT.exec(c)
  if (m) return !/\bsalesforce\b|\bsales\s*tax\b/i.test(m[0]) && !subjectIsOther(c.slice(0, m.index), company)
  const o = OPEN_ROLE.exec(c) ?? FIRST_HIRE.exec(c)
  return !!o && isGtmRole(c) && !subjectIsOther(c.slice(0, o.index), company)
})
export const quoteNamesSalesHiring = (excerpt: string | null, signal: string | null, company?: string | null): boolean => { void signal; return affirmativeSalesHiring(excerpt, company) } // the VERIFIED quote only: the model's claim is not evidence

const whereOf = (icp: string | null | undefined): string[] => { try { const j = icp ? JSON.parse(icp) as { where?: unknown } : null; return Array.isArray(j?.where) ? j!.where.filter((x): x is string => typeof x === 'string' && !!x.trim()) : [] } catch { return [] } }
export interface QuoteEvidence { url: string; excerpt: string; date: string | null }
const labelOf = (host: string) => { const l = host.replace(/^www\./, '').split('.'); return (l.length >= 3 && /^(?:co|com|org|ac)$/.test(l[l.length - 2]) ? l[l.length - 3] : l[l.length - 2] ?? '').replace(/[^a-z0-9]/g, '') }
const registrable = (host: string) => { const l = host.replace(/^www\./, '').split('.'); return l.length >= 3 && /^(?:co|com|org|ac)$/.test(l[l.length - 2]) ? l.slice(-3).join('.') : l.slice(-2).join('.') }
// Evidence from ANOTHER candidate that shares only the lead's NAME is usable only when it is identity-compatible: a third-party page (news, a directory) can be
// about the company, but a page on a company-looking site of a DIFFERENT domain (brightloop.com for the brightloop.io lead, or any such site when the lead has no
// domain) is some other business with the same name.
export function evidenceCompatible(url: string, company: string, leadDomain: string | null): boolean {
  let host = ''; try { host = new URL(url).hostname.toLowerCase() } catch { return false }
  const lab = labelOf(host), key = company.toLowerCase().replace(/&/g, 'and').replace(/\b(inc|ltd|llc|limited|plc|corp|co|the)\b/g, '').replace(/[^a-z0-9]/g, '')
  const looksOwn = lab.length >= 4 && key.length >= 3 && (lab.includes(key) || key.includes(lab))
  if (!looksOwn) return true
  return !!leadDomain && registrable(host) === registrable(leadDomain.toLowerCase().replace(/^https?:\/\//, '').replace(/[/?#].*$/, ''))
}

// Place and (for evidence from another candidate) date of the event quote. The lead's own row was window-checked on its own date already; a joined quote is only usable with its own known date inside the window.
function eventQuoteUsable(q: QuoteEvidence, date: string | null, company: string, where: string[], windowDays: number, nowS: number, own: boolean): boolean {
  if (!eventPlaceOk(q.excerpt, where, company)) return false
  if (own) return true
  const t = date ? Date.parse(date) : NaN
  return Number.isFinite(t) && t <= (nowS + 86_400) * 1000 && nowS * 1000 - t <= windowDays * 86_400_000
}
export async function applySalesHiringGate(db: Database.Database, job: JobLike, fetchImpl: typeof fetch = fetch, opts: { now?: number; quotes?: Map<string, QuoteEvidence[]>; careersGet?: Get } = {}): Promise<{ required: boolean; checked: number; passed: number; demoted: number; demotions: { company: string; url: string; reason: string }[] }> {
  const none = { required: false, checked: 0, passed: 0, demoted: 0, demotions: [] as { company: string; url: string; reason: string }[] }
  if (!salesHiringRequired(job.query, job.icp)) return none
  const demotions = none.demotions
  const roles = requestedHiringRoles(job.query, job.icp).filter(roleNeedsSourceProof)
  let signalTerms: string[] = []
  try { signalTerms = JSON.parse(job.icp ?? '{}').signals ?? [] } catch { /* no profile */ }
  const eventRequired = needsEventBeyondHiring(signalTerms, job.query ?? '')
  const stage = requestedStage(job.query, job.icp)
  const windowDays = parseWindowDays(job.query ?? '') ?? 90
  const fundingAsked = requestAsksFunding(job.query, job.icp)
  const where = whereOf(job.icp)
  const now = Math.floor((opts.now ?? Date.now()) / 1000)
  const leads = db.prepare(
    `SELECT id, company, company_domain, evidence_excerpt, signal, why, dedup_key, source_url, event_date FROM leads
     WHERE scan_job_id = ? AND review_reason IS NULL AND confidence IS NOT NULL AND human_confirmed_at IS NULL AND company <> '' ORDER BY score DESC`,
  ).all(job.id) as { id: string; company: string; company_domain: string | null; evidence_excerpt: string | null; signal: string; why: string | null; dedup_key: string | null; source_url: string; event_date: string | null }[]
  const setWhy = db.prepare('UPDATE leads SET why = ? WHERE id = ?')
  const demote = db.prepare('UPDATE leads SET review_reason = ?, confidence = NULL, why = ? WHERE id = ? AND review_reason IS NULL')
  const counts = db.prepare('UPDATE scan_jobs SET verified = MAX(COALESCE(verified, 0) - 1, 0), needs_review = COALESCE(needs_review, 0) + 1 WHERE id = ?')
  let passed = 0, demoted = 0, lookups = 0
  const passedIds: string[] = []
  for (const l of leads) {
    try {
    // Evidence for THIS lead: its own saved quote, plus other verified candidates' quotes for the same company that are identity-compatible (see evidenceCompatible).
      const others = (l.dedup_key ? opts.quotes?.get(l.dedup_key) ?? [] : []).filter(q => evidenceCompatible(q.url, l.company, l.company_domain))
      const quotes: QuoteEvidence[] = [{ url: l.source_url, excerpt: l.evidence_excerpt ?? '', date: null }, ...others]
      // The EVENT half must stand on its own: the quote that shows the event agrees with the requested place, and (when it came from another candidate) carries its OWN date inside the window.
      // A current job in the right city never validates a funding quote from another place, and its date is never the funding event's date.
      const eventQuotes = quotes.filter((q, i) => eventQuoteUsable(q, i === 0 ? l.event_date : q.date, l.company, where, windowDays, now, i === 0))
      const demoteFor = (reason: string, why: string) => { if (demote.run(reason, (why + (l.why ?? '')).trim().slice(0, WHY_MAX), l.id).changes) { counts.run(job.id); demoted++; demotions.push({ company: l.company, url: l.source_url, reason }) } }
      // The event half first: a hiring page alone (a job ad) does not show seed funding / an opening, whatever it says about the company.
      if (eventRequired && !eventQuotes.some(q => quoteShowsEvent(q.excerpt, l.signal, fundingAsked, l.company, stage))) {
        demoteFor(NO_EVENT, stage && fundingAsked ? `No event evidence: no source quote affirms this company raised a ${stage} round (a different stage, a negated or planned raise, or another company's raise does not count). ` : `No event evidence: the source quote shows hiring but not the funding or event the request asks for. `)
        continue
      }
      if (!roles.length && quotes.some(q => quoteNamesSalesHiring(q.excerpt, l.signal, l.company))) {
        const o = others.find(q => quoteNamesSalesHiring(q.excerpt, l.signal, l.company))
        if (!quoteNamesSalesHiring(l.evidence_excerpt, l.signal, l.company) && o) {
          let host = ''; try { host = new URL(o.url).hostname.replace(/^www\./, '') } catch { /* keep blank */ }
          setWhy.run((`Hiring sales: named in a verified source${host ? ` (${host})` : ''}${o.date ? `, dated ${o.date}` : ''}. ${l.why ?? ''}`).trim().slice(0, WHY_MAX), l.id)
        }
        passed++; passedIds.push(l.id); continue
      }
      if (l.company_domain && lookups >= MAX_BOARD_LOOKUPS) {
        // A processing limit never lets a lead through unproven: it is held, and the card says it was not checked (unknown, not absent).
        demoteFor(NO_SALES_HIRING, `No sales-hiring evidence: not checked - this scan had more leads than the job-board lookup limit (${MAX_BOARD_LOOKUPS}). `)
        continue
      }
      if (l.company_domain) lookups++
      const gbz = l.company_domain ? await atsGtmBoard(l.company, l.company_domain, fetchImpl, { windowDays, now: (opts.now ?? Date.now()), ...(roles.length ? { roleMatch: (title: string) => !!matchedHiringRole(title, roles) } : {}) }).catch(() => null) : null
      const g = gbz?.hiring ?? null
      // The board must be the lead's OWN: under a domain the cited page is hosted on (or the user confirmed). A board found through a domain matched only
      // by company name (a probe, a link label) could belong to a larger same-name company: its roles are not this lead's hiring.
      // The board is bound to the lead's domain when the cited page is hosted on it / the user confirmed it, or when the board's OWN postings name that same
      // domain (a company-site address or link inside the posting text).
      const heuristic = !!g && g.via === 'domain' && domainRelationship(db, job.user_id, l.id, l.company_domain) !== 'established' && !(g.domain && l.company_domain && g.domain.replace(/^www\./, '') === l.company_domain.replace(/^www\./, ''))
      if (g && g.via === 'domain' && !heuristic) {
        const p = g.postings[0]
        const match = matchedHiringRole(p.title, roles)
        const line = roles.length ? `Hiring for ${p.title} (requested: ${match!.term}), posted ${p.date}. This may relate to your offer; buying need isn't verified. ` : `Hiring sales: ${p.title} posted ${p.date} on its ${BOARD_LABEL[g.board]} job board (${l.company_domain}). `
        setWhy.run((line + (l.why ?? '')).trim().slice(0, WHY_MAX), l.id)
        addEnrichment(db, job.user_id, l.id, { connector: `signals:${g.board}-gtm`, kind: 'hiring', value: `${g.postings.length} sales/GTM role${g.postings.length === 1 ? '' : 's'} posted, newest ${g.newest}`, label: g.postings.map(x => x.title).slice(0, 3).join('; ').slice(0, 200) || null, confidence: 70, source_url: g.url, source_date: g.newest, retrieved_at: now })
        const existingEvidence = db.prepare("SELECT kind, connector, value, source_date, retrieved_at FROM lead_enrichments WHERE lead_id = ? AND kind IN ('hiring', 'hiring-role')").all(l.id) as import('../signals/ats-gtm.ts').ExistingEvidenceRow[]
        for (const e of withRepostHistory(postingEvidence(g, now, null), g.board, existingEvidence)) addEnrichment(db, job.user_id, l.id, { ...e, label: roles.length ? `Requested role: ${matchedHiringRole(e.value.split(' - posted ')[0], roles)!.term}; ${e.label}`.slice(0, 200) : e.label })
        { const checkedDay = new Date(now * 1000).toISOString().slice(0, 10)
          const auditRows = withRepostHistory(boardTitleAudit(g, now, checkedDay, null), g.board, existingEvidence)
          for (const e of auditRows) addEnrichment(db, job.user_id, l.id, e) // #533: board-title audit sample
          addEnrichment(db, job.user_id, l.id, boardCoverageRow(g, auditRows.length, Math.min(g.postings.length, 3), now, checkedDay)) }
        { const checkedDay2 = new Date(now * 1000).toISOString().slice(0, 10)
          const covered = new Set(g.postings.slice(0, 3).map(x => x.title.trim().toLowerCase()))
          const full = withRepostHistory(fullListingAuditRows(g.board, g.boardUrl, g.allListed, covered, now, checkedDay2, null), g.board, existingEvidence)
          for (const e of full) addEnrichment(db, job.user_id, l.id, e) // #533 breadth: the whole listing, so requested-role absence is auditable
          addEnrichment(db, job.user_id, l.id, fullListingCoverageRow(g.board, g.boardUrl, g.listedCountAll, g.allListed, Math.min(g.postings.length, 3), full.length, now, checkedDay2)) }
        passed++; passedIds.push(l.id); continue
      }
      if (!g && gbz?.checked && !gbz.contradictory) {
        const c = gbz.checked
        const heuristicC = c.via === 'domain' && domainRelationship(db, job.user_id, l.id, l.company_domain) !== 'established' && !(c.domain && l.company_domain && c.domain.replace(/^www\./, '') === l.company_domain.replace(/^www\./, ''))
        if (c.via === 'domain' && !heuristicC) {
          const checkedDay = new Date(now * 1000).toISOString().slice(0, 10)
          const existingEvidence = db.prepare("SELECT kind, connector, value, source_date, retrieved_at FROM lead_enrichments WHERE lead_id = ? AND kind IN ('hiring', 'hiring-role')").all(l.id) as import('../signals/ats-gtm.ts').ExistingEvidenceRow[]
          for (const e of withRepostHistory(checkedAuditRows(c, windowDays, now, checkedDay, null), c.board, existingEvidence)) addEnrichment(db, job.user_id, l.id, e) // #533 F-B: zero-match audit trail
          addEnrichment(db, job.user_id, l.id, checkedCoverageRow(c, windowDays, now, checkedDay))
          { const full = withRepostHistory(fullListingAuditRows(c.board, c.boardUrl, c.allListed, new Set(), now, checkedDay, null), c.board, existingEvidence)
            for (const e of full) addEnrichment(db, job.user_id, l.id, e) // #533 breadth: the whole listing - the actual absence evidence
            addEnrichment(db, job.user_id, l.id, fullListingCoverageRow(c.board, c.boardUrl, c.listedCountAll, c.allListed, 0, full.length, now, checkedDay)) }
        }
      }
      // No usable job board: the company's OWN careers page (https, robots.txt obeyed, same domain) may list an open sales role. The domain must be established, or the careers
      // page itself must name the company and agree on the requested place (a same-name company elsewhere does not). Saved: URL, quote, retrieval time (not a posting date).
      let careersNote = ''
      if (!roles.length && l.company_domain && opts.careersGet) {
        const c = await careersSalesVacancy(l.company_domain, opts.careersGet, { now: opts.now, company: l.company }).catch(() => null)
        if (c?.vacancy) {
          const v = c.vacancy
          const established = domainRelationship(db, job.user_id, l.id, l.company_domain) === 'established'
          const namesCompany = norm(v.pageText).includes(norm(l.company).replace(/\s/g, '')) || norm(v.pageText).replace(/\s/g, '').includes(norm(l.company).replace(/\s/g, ''))
          const place = whereOf(job.icp).length ? placeAgreement(v.pageText, whereOf(job.icp), l.company) : 'no_geography'
          if (established || (namesCompany && (place === 'agrees' || place === 'no_geography'))) {
            const day = new Date(v.retrievedAt * 1000).toISOString().slice(0, 10)
            setWhy.run((`Hiring sales: ${v.title} listed on its careers page (${l.company_domain}), checked ${day}. ` + (l.why ?? '')).trim().slice(0, WHY_MAX), l.id)
            addEnrichment(db, job.user_id, l.id, { connector: 'signals:careers-gtm', kind: 'hiring', value: `Open sales role on its careers page: ${v.title}`.slice(0, 254), label: v.quote.slice(0, 200), confidence: 60, source_url: v.url, source_date: day, retrieved_at: v.retrievedAt })
            passed++; passedIds.push(l.id); continue
          }
          careersNote = `its careers page lists ${v.title} but the page is not established as this company's (${namesCompany ? 'place not confirmed' : 'company not named'}). `
        } else if (c) careersNote = `its careers page was checked: ${c.reason.replace(/_/g, ' ')}. `
      }
      const line = heuristic
        ? `No sales-hiring evidence: a job board was found only through ${l.company_domain}, a domain matched by company name, so it is not established as this company's board. `
        : `No sales-hiring evidence: no ${roles.length ? `source-matched requested role (${roles.map(r => r.term).join(' or ')})` : 'sales or GTM posting'} dated in the last ${windowDays} days was found on a public job board tied to ${l.company_domain ?? 'a confirmed company domain (none found)'} (a board that could not be reached looks the same as none, so this is unconfirmed, not proof the company is not hiring). `
      demoteFor(NO_SALES_HIRING, line + careersNote)
    } catch (e) {
      // A required gate that errors on a lead is a FAIL, never a pass: the lead is held with the failure as its reason.
      if (demote.run(SALES_GATE_FAILED, `Sales-hiring check failed (${(e instanceof Error ? e.message : 'error').slice(0, 80)}): not verified. ${l.why ?? ''}`.trim().slice(0, WHY_MAX), l.id).changes) { counts.run(job.id); demoted++; demotions.push({ company: l.company, url: l.source_url, reason: SALES_GATE_FAILED }) }
    }
  }
  // The gate ran again and PASSED these leads: a failed-gate marker from an earlier run no longer holds them.
  releaseHeld(db, job.user_id, job.id, passedIds)
  // The DURABLE pass record. A lead the gate passed but whose record could not be written is held by default (held-state.ts), never assumed passed.
  for (const id of passedIds) {
    try { addEnrichment(db, job.user_id, id, { connector: 'scan:gate', kind: 'gate_passed', value: roles.length ? 'requested_role_v1' : 'sales_hiring', label: 'The required sales-hiring check passed', confidence: null, source_url: 'https://invalid.example/', source_date: new Date().toISOString().slice(0, 10), retrieved_at: Math.floor(Date.now() / 1000) }) } catch { /* no record: the lead stays held */ }
  }
  audit(db, { tenantId: job.user_id, connector: 'scan:sales-hiring-gate', jobId: job.id, lookup: `${leads.length} leads, window ${windowDays}d`.slice(0, 200), status: demoted ? 'demoted' : 'ok', results: passed })
  return { required: true, checked: leads.length, passed, demoted, demotions }
}

// The required gate itself failed (it threw before or between leads): every lead still verified is held. Never a pass. The held set is returned IN MEMORY whether or not the
// database write landed: "the row still says verified" is not proof the gate passed, so callers (the actionable classification, the run report) use this set, not the row.
export interface HeldLead { id: string; company: string; url: string; reason: string; written: boolean }
export function failClosedSalesHiring(db: Database.Database, job: JobLike, message: string): HeldLead[] {
  if (!salesHiringRequired(job.query, job.icp)) return []
  let rows: { id: string; company: string; source_url: string; why: string | null }[] = []
  try { rows = db.prepare("SELECT id, company, source_url, why FROM leads WHERE scan_job_id = ? AND review_reason IS NULL AND confidence IS NOT NULL AND human_confirmed_at IS NULL AND company <> ''").all(job.id) as typeof rows } catch { return [] }
  const out: HeldLead[] = []
  for (const l of rows) {
    let written = false
    try {
      const ch = db.prepare('UPDATE leads SET review_reason = ?, confidence = NULL, why = ? WHERE id = ? AND review_reason IS NULL').run(SALES_GATE_FAILED, `Sales-hiring check failed (${message.slice(0, 80)}): not verified. ${l.why ?? ''}`.trim().slice(0, WHY_MAX), l.id).changes
      if (ch) { db.prepare('UPDATE scan_jobs SET verified = MAX(COALESCE(verified, 0) - 1, 0), needs_review = COALESCE(needs_review, 0) + 1 WHERE id = ?').run(job.id); written = true }
    } catch { /* the write was rejected: the lead is still held in memory */ }
    out.push({ id: l.id, company: l.company, url: l.source_url, reason: SALES_GATE_FAILED, written })
  }
  return out
}

// Persist the held state so every surface that reads the lead row agrees with the in-memory set. Two best-effort writes, each independent of the other:
//   - the marker beside the lead (read by listLeads / exportLeads, which then show the lead as held, not verified),
//   - the job's verified / needs-review counts, adjusted once per newly marked lead (campaign counts follow the same truth).
// A retry of the review write is also made. Returns how many leads were marked. Never throws.
export function persistHeldState(db: Database.Database, job: JobLike, held: HeldLead[], message: string): number {
  let marked = 0
  for (const h of held) {
    try {
      const ch = db.prepare("INSERT INTO lead_enrichments (id, lead_id, tenant_id, connector, kind, value, label, confidence, source_url, source_date, retrieved_at) VALUES (?, ?, ?, 'scan:gate', 'gate_failed', ?, ?, NULL, 'https://invalid.example/', ?, ?) ON CONFLICT (lead_id, connector, kind, value) DO NOTHING")
        .run(randomBytes(12).toString('hex'), h.id, job.user_id, SALES_GATE_FAILED, `Sales-hiring check failed: ${message}`.slice(0, 200), new Date().toISOString().slice(0, 10), Math.floor(Date.now() / 1000)).changes
      if (ch) {
        marked++
        if (!h.written) { try { db.prepare('UPDATE scan_jobs SET verified = MAX(COALESCE(verified, 0) - 1, 0), needs_review = COALESCE(needs_review, 0) + 1 WHERE id = ?').run(job.id) } catch { /* the count write was rejected too: the marker still holds */ } }
      }
    } catch { /* no marker: the in-memory set still holds this run's report, trace and classification */ }
  }
  return marked
}
