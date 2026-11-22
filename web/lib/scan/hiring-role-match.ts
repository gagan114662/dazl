import { isGtmRole } from '../signals/ats-gtm.ts'
// Requested POSTING titles, never the buyer personas in ICP.who. Deliberately bounded synonyms:
// sales ops <-> sales operations, revops <-> revenue operations, admin <-> administrator.
// CRM administrator is NOT business systems administrator, Salesforce developer or AE.
// #1121: the short and long names of the same sales vacancy are one title. "SDR" asked for is a posting titled "Sales Development
// Representative" (and the reverse); likewise BDR, AE and salesperson / sales representative. Bounded to these four, so no adjacent role
// matches (an SDR is still not an AE, a sales development representative is not a plain sales representative).
const SALES_ABBREV: [RegExp, string][] = [
  [/\bsales\s+development\s+rep(?:resentative)?s?\b|\bsdrs\b/g, 'sdr'],
  [/\bbusiness\s+development\s+rep(?:resentative)?s?\b|\bbdrs\b/g, 'bdr'],
  [/\baccount\s+executives?\b|\baes\b/g, 'ae'],
  [/\bsales\s*persons?\b|\bsales\s+rep(?:resentative)?s?\b/g, 'salesperson'], // not "sales people": broad hiring, not a named title
]
const abbrev = (s: string): string => SALES_ABBREV.reduce((t, [re, to]) => t.replace(re, to), s)
// #1122: a title is matched in the singular on both sides ("receptionists" ~ "Receptionist", "nurses" ~ "Registered Nurse"; "salespeople" is a
// salesperson), never stripping the s of "sales", "ops" or a word ending in ss/us/is; and "VP of Sales" ~ "VP, Sales" (a bare "of" is ignored when
// matching, kept in the normalized title: "head of sales")
const singular = (s: string): string => s.replace(/\bsalespeople\b/g, 'salesperson').replace(/\b([a-z]{3,}?[^su])s\b/g, (w, stem: string) => /^(?:sale|op|new)$/.test(stem) ? w : stem)
const normal = (s: string): string => abbrev(singular(s.toLowerCase().replace(/\bsales[ -]+ops\b/g, 'sales operations').replace(/\brevops\b/g, 'revenue operations').replace(/\badmin\b/g, 'administrator')).replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim())
// The words a title may use for a requested role, for finding WHERE the role sits in a title (sales-hiring-gate.ts titleIsRole):
// the term as asked plus, for the four sales names above, their other written forms.
const SURFACES: Record<string, string[]> = {
  sdr: ['SDR', 'sales development representative', 'sales development rep'],
  bdr: ['BDR', 'business development representative', 'business development rep'],
  ae: ['AE', 'account executive'],
  salesperson: ['salesperson', 'sales person', 'sales representative', 'sales rep'],
}
const roleSurfaceForms = (r: RequestedHiringRole): string[] => [r.term, ...(SURFACES[r.normalized] ?? [])]
// Quest #1534 (M5): where a requested role sits in a title, read by the planner's own normalization (singular(), and a bare "of" ignored), so the
// gate finds every title matchedHiringRole accepts: "VP Sales" for a requested "VP of Sales" (and the reverse), "Sales Manager" for "sales managers".
// Each word is matched in the singular, with or without its plural ending; a bare "of" may stand between any two words or be absent.
const escapeRe = (w: string) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
export const roleSurfacePatterns = (r: RequestedHiringRole): RegExp[] => roleSurfaceForms(r).map(f => {
  const words = f.trim().toLowerCase().split(/[\s-]+/).filter(w => w && w !== 'of').map(w => `${escapeRe(singular(w))}(?:e?s)?`)
  return new RegExp(`\\b${words.join('(?:[\\s-]+of)?[\\s-]+')}\\b`, 'i')
})
export interface RequestedHiringRole { term: string; normalized: string }
// The role words the targeting compiler reads a title by (moved here from targeting.ts so the plan and this reader share one check; #1395's
// typed parse replaces both). #1122: a phrase is a title when its last word - or the rank before "of ..." ("Head of Sales") - is one of these
// (a plural too: "managers", "engineers"), or it opens with a VP rank ("VP Sales"). Anything else after "or" / "/" is not read as a role.
export const ROLE_WORD = /\b(?:vp|vice\s+president|head|director|chief|c[a-z]o|manager|lead|executive|officer|president|engineer|reps?|representatives?|aes?|sdrs?|bdrs?|staff|team|marketer|seller|salespeople|salesperson|account\s+executives?)\b/i
export const endsInTitleNoun = (s: string): boolean => {
  const base = s.trim().replace(/\s+of\s+[A-Za-z &-]+$/i, '')
  const last = base.split(/\s+/).pop() ?? ''
  return ROLE_WORD.test(last) || (!/^leads$/i.test(last) && ROLE_WORD.test(last.replace(/s$/i, ''))) || /^(?:s?vp|evp)\b/i.test(base) || /^vice\s+president\b/i.test(base)
}

// A capture that STARTS with a qualifier names a place or time, never a title: "hiring in Ohio", "hiring within 90 days", "hiring now".
const LEAD_QUALIFIER = /^(?:within|in|at|on|from|with|during|over|across|now|currently|recently|soon|asap|immediately)\b/i
// Quantity / article prefixes on a title: "a receptionist", "their first sales representative", "2-3 receptionists".
const LEAD_WORDS = /^(?:(?:a|an|the|first|new|their|its|our|your|one|two|three|four|five|six|seven|eight|nine|ten|several|multiple|\d+(?:\s*[-\u2013]\s*\d+)?)\s+)+/i
// A bare time phrase is a recency window, not a role: "the last 3 months", "90 days", "past 6 weeks".
const TIME_PHRASE = /^(?:(?:last|past|next|this|coming|recent)\s+)?\d*\s*(?:days?|weeks?|months?|quarters?|years?)(?:\s+ago)?$/i
const ADVERB = /^(?:now|currently|recently|soon|asap|immediately|today|actively|urgently)$/i
const QUANTITY = /^(?:a|an|one|two|three|four|five|six|seven|eight|nine|ten|several|multiple|\d+)$/i
// A single gerund is an activity ("prospecting", "staffing"), not a posting title.
const GERUND = /^[a-z]+ing$/
// Qodo #1509 H2: a slash separates whole titles ("Head of Sales/VP Sales", "SDR/BDR") but can also join two qualifiers of ONE title
// ("sales/marketing manager"). Split only when every side is itself a title: two or more words, or one of the bounded sales abbreviations.
const ABBREV_TITLE = /^(?:sdr|bdr|ae|vp|cro|cmo|ceo|coo|cfo|cto)s?$/i
function splitSlashTitles(phrase: string): string[] {
  if (!phrase.includes('/')) return [phrase]
  const parts = phrase.split(/\s*\/\s*/).map(p => p.trim().replace(LEAD_WORDS, '').trim())
  // Qodo #1512 M6: "SDR/BDR reps" shares its noun: each abbreviation is its own title.
  const last = parts[parts.length - 1].split(/\s+/)
  if (parts.slice(0, -1).every(p => ABBREV_TITLE.test(p)) && ABBREV_TITLE.test(last[0]) && last.slice(1).every(w => /^rep(?:s|resentatives?)?$/i.test(w))) return [...parts.slice(0, -1), last[0]]
  return parts.every(p => p.split(/\s+/).length >= 2 || ABBREV_TITLE.test(p)) ? parts : [phrase]
}
export function requestedHiringRoles(query: string | null | undefined, icp?: string | null): RequestedHiringRole[] {
  let signals: string[] = []
  try { const j = JSON.parse(icp ?? '{}') as { signals?: unknown }; if (Array.isArray(j.signals)) signals = j.signals.filter((x): x is string => typeof x === 'string') } catch { /* missing profile */ }
  const texts = [query ?? '', ...signals]
  const roles = new Map<string, RequestedHiringRole>()
  for (const text of texts) {
    // #533 live: "posted a front desk receptionist job in the past 90 days" names the posting title as plainly as "hiring a ..." does
    for (const m of text.matchAll(/\bpost(?:ed|s|ing)?\s+(?:(?:a|an|the|new|their|its|one|any)\s+)*([^.;!?\n]{2,80}?)\s+(?:job|role|position|opening|vacanc(?:y|ies)|posting|ad|listing)s?\b/gi)) {
      // #1122: "an SDR/BDR or sales rep job" names three titles; "and/or" is one separator
      for (const raw of m[1].replace(/\s+and\s*\/\s*or\s+/gi, ' or ').split(/\s+or\s+|\s+and\s+|,/i).flatMap(splitSlashTitles)) {
        const term = raw.trim().replace(LEAD_WORDS, '').trim(), n = normal(term)
        if (!n || QUANTITY.test(term) || TIME_PHRASE.test(n) || ADVERB.test(n) || GERUND.test(n) || LEAD_QUALIFIER.test(term)) continue
        if (/^(?:sales|gtm|sales gtm|sales staff|sales people|sales team|staff|people|employees?|talent|sales roles?|roles?|positions?|job|new)$/.test(n)) continue
        roles.set(n, { term, normalized: n })
      }
    }
    // Qodo #1510 M6: "posted a job for a front desk receptionist" names the title after "job for"
    for (const m of text.matchAll(/\bpost(?:ed|s|ing)?\s+(?:(?:a|an|the|new|their|its)\s+)*(?:job|role|position|opening|vacancy|ad|listing)s?\s+for\s+([^.;!?\n]{2,80})/gi)) {
      const phrase = m[1].split(/\s+(?:within|in|at|with|on|from|that|who|whose|during|over|across)\b|\(/i)[0].trim()
      for (const raw of phrase.replace(/\s+and\s*\/\s*or\s+/gi, ' or ').split(/\s+or\s+|\s+and\s+|,/i).flatMap(splitSlashTitles)) {
        const term = raw.trim().replace(LEAD_WORDS, '').trim(), n = normal(term)
        if (!n || QUANTITY.test(term) || TIME_PHRASE.test(n) || ADVERB.test(n) || GERUND.test(n) || LEAD_QUALIFIER.test(term)) continue
        if (/^(?:sales|gtm|sales gtm|sales staff|sales people|sales team|staff|people|employees?|talent|sales roles?|roles?|positions?|job|new)$/.test(n)) continue
        roles.set(n, { term, normalized: n })
      }
    }
    for (const m of text.matchAll(/\b(?:hiring|recruiting)(?:\s+for)?\s+([^.;!?\n]+)/gi)) {
      const phrase = m[1].split(/\s+(?:within|in|at|with|on|from|that|who|whose|during|over|across)\b|\(/i)[0].trim()
      if (LEAD_QUALIFIER.test(phrase)) continue
      // #1122: "a new Head of Sales/VP Sales" is two titles; the leading words are stripped after trimming (the split leaves a space).
      // #1122: "SDRs and/or sales reps" is one separator, as in the posted-job form above
      for (const raw of phrase.replace(/\s+and\s*\/\s*or\s+/gi, ' or ').split(/\s+or\s+|\s+and\s+|,/i).flatMap(splitSlashTitles)) {
        const term = raw.trim().replace(LEAD_WORDS, '').trim()
        const n = normal(term)
        if (!n || QUANTITY.test(term) || TIME_PHRASE.test(n) || ADVERB.test(n) || GERUND.test(n)) continue
        // Broad hiring is not a named title. Keep the existing generic-GTM contract for it.
        if (/^(?:sales|gtm|sales gtm|sales staff|sales people|sales team|staff|people|employees?|talent|sales roles?|roles?|positions?)$/.test(n)) continue
        // Do not infer a role from free prose. An unparseable explicit request is not a verified match.
        // Unsupported/long explicit terms stay required and unmatched, never silently generic.
        roles.set(n, { term, normalized: n })
      }
    }
  }
  return [...roles.values()]
}
export function matchedHiringRole(title: string, roles: RequestedHiringRole[]): RequestedHiringRole | null {
  const ofless = (t: string) => t.replace(/ of /g, ' ')
  const n = ofless(` ${normal(title)} `)
  return roles.find(r => n.includes(ofless(` ${r.normalized} `))) ?? null
}
// Only sales/GTM-family requested titles gate drafting: the required proof is the SALES-hiring check. A requested
// non-GTM title (receptionist, payroll, front-desk) is a buying signal - recorded as evidence, never a drafting hold.
// #1122: a sales title by its short name too ("AE", "AEs" read as account executive, like SDR / BDR / salesperson): the generic GTM test
// does not know "AE", so a request naming it took no sales proof path.
export const isSalesTitle = (term: string): boolean => isGtmRole(term) || ['sdr', 'bdr', 'ae', 'salesperson'].includes(normal(term))
export const roleNeedsSourceProof = (r: RequestedHiringRole): boolean => isSalesTitle(r.term) || /\bcrm\b/i.test(r.term)
