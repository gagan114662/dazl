// What a request asks for beyond the event itself, and whether a lead's proof page supports it.
// A production search for "SaaS startups hiring their first salesperson" (2026-11-24) listed six leads as confirmed and one met the
// request: the others' pages did not say it was a first sales hire, were for another role, or printed no date. The search engine is
// told that every qualifier is a requirement (lib/discover/agent.ts), but dazl's own check of the proof page (lib/discover/check.ts)
// compared only the engine's signal line with the page, so the engine's word was all that stood behind a qualifier.
// Four qualifiers a proof page can state are read from the person's own words and checked here, by words only:
//   role    the role the request says the company is hiring;
//   first   that it is the company's first (or founding) hire of that kind;
//   stage   the funding stage the request names;
//   window  the time window the request names.
// Words that do not settle role or first leave it OPEN: lib/discover/check.ts then puts one question to the small model for the
// lead (lib/discover/entail.ts askQualifiers). Stage and window are never asked: a page states the stage or it does not, and a date
// is inside the window or it is not. A lead whose page does not support a qualifier goes to the person's review with a reason that
// names it (QUALIFIER_REASON); it is never dropped and never shown as confirmed.
// Pure: no store, no network.
import { requestedHiringRoles, matchedHiringRole, isSalesTitle, endsInTitleNoun, type RequestedHiringRole } from '../scan/hiring-role-match.ts'
import { isGtmRole } from '../signals/ats-gtm.ts'
import { requestedStage, stageOk, type Stage } from '../scan/funding-stage.ts'
import { parseWindowDays, windowStatus } from '../scan/window.ts'

export type QualifierKind = 'role' | 'first' | 'stage' | 'window'
type OpenQualifier = 'role' | 'first'
export interface RequestQualifiers { roles: RequestedHiringRole[]; first: boolean; stage: Stage; windowDays: number | null }
// The order a lead's unsupported qualifiers are listed in, and so which one names the review (the lead row stores one reason).
const ORDER: QualifierKind[] = ['role', 'first', 'stage', 'window']
export const QUALIFIER_REASON: Record<QualifierKind, string> = { role: 'request_role_unconfirmed', first: 'request_first_unconfirmed', stage: 'request_stage_unconfirmed', window: 'request_window_unconfirmed' }
export const inQualifierOrder = (kinds: QualifierKind[]): QualifierKind[] => ORDER.filter(k => kinds.includes(k))

// requestedHiringRoles reads whatever follows "hiring" as a title ("hiring right now" gives "right now"). The older engine only ever
// used such a term to look for postings; here an unreadable one would send every lead to review for a role nobody asked for. So a
// term counts as a role only when it reads as a title: it ends in a title noun, it is a sales title, or it is plain nouns
// ("receptionist", "front desk receptionist") with no word that belongs to a sentence instead.
const NOT_TITLE = /^(?:after|before|for|to|as|by|a|an|the|and|or|but|more|most|fast|faster|again|soon|now|right|here|there|abroad|remote|big|like|crazy|mode|spree|plans?|freeze|surge|push|too|also|well|up|out|back|many|lots|lot|is|are|was|were|be|has|have|had|new|they|them|it|who|that|which|while|when|because|since|still|yet|just|ever|never|not|no|all|any|some|this|these|those|every|each|year|month|week|quarter|today|talent|help|growth|roles?|positions?|jobs?|people|staff|workers?|employees?|teams?)$/i
const titleLike = (term: string): boolean => {
  const words = term.trim().split(/\s+/)
  if (isSalesTitle(term)) return words.length <= 6
  if (endsInTitleNoun(term)) return words.length <= 6 && !/^(?:teams?|staff)$/i.test(words[words.length - 1])   // "a second team" is not a title
  return words.length <= 3 && words.every(w => /^[a-z][a-z-]{2,}$/i.test(w) && !NOT_TITLE.test(w) && !/ly$/i.test(w)) && !/ing$/i.test(words[words.length - 1])
}
// "hiring their first salesperson", "recruiting a founding AE", "making their first sales hire". Not "first-time founders hiring an SDR".
const FIRST_ASKED = /\b(?:hir(?:e|es|ed|ing)|recruit(?:s|ed|ing)?)\s+(?:for\s+)?(?:(?:a|an|the|their|its|our|his|her|your)\s+)*(?:very\s+)?(?:first|founding)\b(?![\s-]+time\b)|\b(?:first|founding)\s+(?!time\b)(?:[a-z][\w-]*\s+){0,3}?hires?\b/i
// A bare "seed" is also a plant: the stage counts only where the request speaks of funding or of companies at that stage.
const SEED_ASKED = /\b(?:pre-?)?seed[\s-]*(?:stage|round|funded|funding|backed|financing|investment|rais\w+|capital|startups?|compan(?:y|ies)|saas|founders?|firms?|business(?:es)?)\b|\b(?:rais\w+|clos\w+|secur\w+|announc\w+|fund\w+|round)\b[^.;!?\n]{0,40}\bseed\b/i
// One stage, named exactly, is a requirement a page can be held to. Two stages ("seed or Series A") or a range ("Series A or later",
// "post-Series A", "Series B+") is not one stage: requestedStage would pick one of them, and a page stating the other would be held
// wrongly. Such a request is left to the search engine, as before this check existed.
const STAGE_RANGE = /\b(?:post|pre)[-\s]+series\b|\bseries\s+[a-e]\s*\+|\bseries\s+[a-e]\s+(?:or|and)\s+(?:later|above|beyond|earlier|up|onwards?)\b|\b(?:at\s+least|beyond|up\s+to|no\s+later\s+than)\s+(?:a\s+)?(?:series|seed)\b/i
function oneStage(t: string): Stage {
  const letters = new Set([...t.matchAll(/\bseries\s+([a-e])\b/gi)].map(m => m[1].toLowerCase())), seed = /\bseed\b/i.test(t)
  if (letters.size > 1 || (seed && letters.size > 0) || STAGE_RANGE.test(t)) return null
  const stage = requestedStage(t)
  return stage === 'seed' && !SEED_ASKED.test(t) ? null : stage
}
export function requestQualifiers(query: string | null | undefined): RequestQualifiers {
  const t = query ?? ''
  return { roles: requestedHiringRoles(t).filter(r => titleLike(r.term)), first: FIRST_ASKED.test(t), stage: oneStage(t), windowDays: parseWindowDays(t) }
}
export const hasQualifiers = (q: RequestQualifiers): boolean => q.roles.length > 0 || q.first || !!q.stage || !!q.windowDays

// A sales request is answered by any selling role: "salesperson" asked, "Account Executive" posted. Narrower than the general
// go-to-market test (isGtmRole), which also takes customer success, marketing and partnerships.
const SELLING = /\b(?:sales|account\s+executives?|aes?|sdrs?|bdrs?|business\s+development|revenue|go[-\s]to[-\s]market|gtm)\b/i
const SELLER = /\b(?:sellers?|salespeople|salespersons?)\b/i
const namesRole = (q: RequestQualifiers, text: string): boolean =>
  !!matchedHiringRole(text, q.roles) || (q.roles.some(r => isSalesTitle(r.term)) && ((isGtmRole(text) && SELLING.test(text)) || SELLER.test(text)))

// "first" or "founding" directly before a person: "our first Account Executive", "founding AE", "first sales hire", "first hire".
// The words after it are read up to the first noun that names a person; with a requested role that phrase must be that role (or just
// "hire"). So "your first 90 days", "first sales call", "first-class sales team" and "customer-first" state nothing, and "our first
// engineering hire" does not answer a request for a first salesperson. A denial or a past hire just before it ("not our first",
// "since we hired our first") is not settled by words either.
const FIRST_SAID = /(?<![\w-])(?:first|founding)\b((?:[\s-]+(?:ever|dedicated|full[\s-]?time|official|true|real|in[\s-]house|senior|junior|enterprise|commercial|outbound|inbound))*)[\s-]+([^,.;:!?()\n]{2,80})/gi
const PERSON = /\b(?:hires?|salespersons?|salespeople|sellers?|reps?|representatives?|executives?|aes?|sdrs?|bdrs?|managers?|leaders?|heads?|directors?|vps?|officers?|recruiters?|engineers?|marketers?|employees?)$/i
const NOT_NOW = /\b(?:not|never|no\s+longer|hired|made|since|after|was|were|former|previous)\b|n['’]t\b/i
function saysFirst(q: RequestQualifiers, statement: string): boolean {
  for (const m of statement.matchAll(FIRST_SAID)) {
    const at = m.index ?? 0
    if (NOT_NOW.test(statement.slice(Math.max(0, at - 40), at))) continue
    const words = m[2].trim().split(/\s+/).slice(0, 4)
    for (let k = 1; k <= words.length; k++) {
      const phrase = words.slice(0, k).join(' ')
      if (q.roles.length && matchedHiringRole(phrase, q.roles)) return true
      if (!PERSON.test(phrase)) continue
      if (!q.roles.length || /^hires?$/i.test(phrase) || namesRole(q, phrase)) return true
      break   // a first hire of some other kind
    }
  }
  return false
}

// What the proof page settles by words. `page`: every statement of the page; `quoted`: the statements that hold the quoted evidence
// (lib/discover/check.ts quoteStatements). unsupported: the page does not support it and no question could change that. open: the
// words did not find it, and the small model may be asked.
//   window  the lead's date is the page's own (not the search index's day) and falls inside the window. A day the engine gave
//           counts only when dazl also found it in the page text.
//   stage   some statement of the page states that stage.
//   role    the signal line names the requested role (or, for a sales request, a selling role) and so does a quoted statement.
//   first   a quoted statement, or a short line of the page (a heading, a job title), says first or founding of that role.
interface QualifierFacts { signal: string; signal_date: string | null; date: string | null; date_source: 'page' | 'index' | null; date_on_page: boolean }
export function pageQualifiers(q: RequestQualifiers, lead: QualifierFacts, page: string[], quoted: string[], now: Date = new Date()): { unsupported: QualifierKind[]; open: OpenQualifier[] } {
  const unsupported: QualifierKind[] = [], open: OpenQualifier[] = []
  if (q.roles.length && !(namesRole(q, lead.signal) && quoted.some(s => namesRole(q, s)))) open.push('role')
  if (q.first && !(quoted.some(s => saysFirst(q, s)) || page.some(s => s.length <= 90 && saysFirst(q, s)))) open.push('first')
  if (q.stage && !page.some(s => stageOk(s, q.stage))) unsupported.push('stage')
  if (q.windowDays && !(lead.date_source === 'page' && (!lead.signal_date || lead.date_on_page) && windowStatus(lead.date, q.windowDays, now) === 'inside')) unsupported.push('window')
  return { unsupported, open }
}

// The question put to the small model for a qualifier the words left open (one call a lead, both questions in it).
export function qualifierRequirement(kind: OpenQualifier, q: RequestQualifiers): string {
  const roles = q.roles.map(r => r.term).join(' or ')
  if (kind === 'role') return `The company is hiring for this role, or for a role that is plainly the same kind of job: ${roles}.`
  return `The TEXT says this is the company's FIRST hire ${roles ? `for that kind of role (${roles})` : 'of this kind'}, in words such as "our first", "founding" or "first hire". Joining a team that already does this work means NO.`
}
// The page statements worth sending with that question besides the quoted ones: those that speak of a first or founding hire, of the
// requested role, or of the team.
export const qualifierEvidence = (q: RequestQualifiers, page: string[], quoted: string[], maxChars = 2400): string[] => {
  const out = quoted.slice(0, 4).map(s => s.slice(0, 600))
  let room = maxChars
  for (const s of page) {
    if (room <= 0 || out.length >= 16) break
    if (quoted.includes(s) || !(/\b(?:first|founding|hir(?:e|es|ing)|team|join)\b/i.test(s) || namesRole(q, s))) continue
    const cut = s.slice(0, Math.min(300, room))
    out.push(cut); room -= cut.length
  }
  return out
}
