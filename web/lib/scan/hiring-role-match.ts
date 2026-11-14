import { isGtmRole } from '../signals/ats-gtm.ts'
// Requested POSTING titles, never the buyer personas in ICP.who. Deliberately bounded synonyms:
// sales ops <-> sales operations, revops <-> revenue operations, admin <-> administrator, SDR / BDR / AE <-> the full title.
// CRM administrator is NOT business systems administrator, Salesforce developer or AE.
// #879. Nothing main matched is lost: a title that carries the term as the request wrote it still matches. Added, on both sides:
// "sales rep(s)" reads as sales representative, and "VP of Sales" / "VP, Sales" / "Vice President, Sales" as one title. Added for the
// sales titles requests and boards abbreviate (production's own play asks for "their first SDR"; boards post "Sales Development
// Representative"): a REQUEST's SDR(s) / BDR(s) / AE(s) also read as the full title, and a posting TITLE's SDR / BDR too when the
// title shows they are the sales role (see titleForms: no trade word, and a sales signal or the acronym alone).
const base = (s: string): string => s.toLowerCase().replace(/\bsales[ -]+ops\b/g, 'sales operations').replace(/\brevops\b/g, 'revenue operations').replace(/\badmin\b/g, 'administrator')
  .replace(/\bsales\s+reps?\b/g, 'sales representative').replace(/\bvice[ -]+president\b/g, 'vp').replace(/\bvp\s*(?:,|of\b|-)\s*/g, 'vp ')
  .replace(/\b(?:managers|administrators|executives|engineers|directors|representatives)\b/g, w => w.slice(0, -1))
const squeeze = (s: string): string => s.replace(/[^a-z0-9]+/g, ' ').trim()
// The reading main had before #879, kept beside the new ones so a pair it matched still matches.
const plain = (s: string): string => squeeze(s.toLowerCase().replace(/\bsales[ -]+ops\b/g, 'sales operations').replace(/\brevops\b/g, 'revenue operations').replace(/\badmin\b/g, 'administrator').replace(/\b(?:managers|administrators|executives|engineers|directors)\b/g, w => w.slice(0, -1)))
const expandSdrBdr = (s: string): string => s.replace(/\bsdrs?\b/g, 'sales development representative').replace(/\bbdrs?\b/g, 'business development representative')
const normal = (s: string): string => squeeze(expandSdrBdr(base(s)).replace(/\baes?\b/g, 'account executive'))
// The readings of a posting title: as written, as main read it, and, ONLY when the title itself shows the letters are the sales role,
// with SDR / BDR spelled out. Both must hold: (1) no trade word in the title (engineer, developer, firmware, radio, ... a list, so a word
// nobody listed is not caught by this alone), and (2) a positive sales signal: a sales word ("SDR - Outbound", "SDR, Inbound Sales") or
// the title up to its first separator being the acronym and nothing but seniority / segment / region words ("Senior SDR", "Enterprise
// SDR", "SDR Team Lead", "BDR - EMEA"). Condition (2) is what keeps "SDR Photonics Lead" or "SDR Kernel Contributor" out although no
// list names photonics or kernel. Otherwise the letters stay as written ("RF Engineer, SDR", "SDR Firmware Engineer", "Senior SDR/DSP
// Engineer", "Embedded SDR Developer", "Sales Engineer / SDR"): an abbreviating request ("an SDR") still matches such a title exactly
// as it did before #879, a request that spells the title out ("sales development representatives", or "SDRs", which main never
// matched) does not. A title that spells out the other meaning ("Software Defined Radio", "After Effects") loses the letters
// altogether. A trailing ", <two letters>" is a place code (", AE" for the Emirates), not the role (the price: "Director, AE", which
// main matched for a request for an AE, no longer does).
const OTHER_MEANING = /\bsoftware[ -]+defined[ -]+radio\b|\bafter[ -]+effects\b/
const TRADE = /\b(?:engineer|engineering|developer|firmware|software|hardware|systems|radio|rf|dsp|fpga|embedded|designer|compositor|encryption|technician|architect|programmer|scientist|devops|data)\b/
const SALES_SIGNAL = /\b(?:sales|account|accounts|business development|revenue|growth|outbound|inbound|pipeline|gtm)\b/
const MODIFIER = new Set(['senior', 'sr', 'junior', 'jr', 'lead', 'founding', 'principal', 'staff', 'associate', 'manager', 'head', 'i', 'ii', 'iii', 'iv', 'remote', 'enterprise', 'commercial', 'smb', 'mid', 'market', 'midmarket', 'inside', 'technical', 'emea', 'apac', 'amer', 'americas', 'na', 'latam', 'uk', 'us', 'global', 'team', 'regional', 'named', 'strategic', 'corporate', 'field'])
const PLACE_CODE = /,\s*[a-z]{2}\s*$/i
const acronymOnlyHead = (b: string): boolean => {
  const words = squeeze(b.split(/\s+[-\u2013\u2014]\s+|[,(]/)[0]).split(' ').filter(w => w && !MODIFIER.has(w))
  return words.length > 0 && words.every(w => /^(?:sdrs?|bdrs?)$/.test(w))
}
const titleForms = (rawTitle: string): string[] => {
  const title = rawTitle.replace(PLACE_CODE, ''), b = base(title)
  if (OTHER_MEANING.test(b)) return [` ${squeeze(b.replace(/\b(?:sdrs?|bdrs?|ae)\b/g, ' '))} `]
  const forms = [` ${squeeze(b)} `, ` ${plain(title)} `]
  if (!TRADE.test(b) && (SALES_SIGNAL.test(b) || acronymOnlyHead(b))) forms.push(` ${squeeze(expandSdrBdr(b))} `)
  return forms
}
// literal: the term as written (no abbreviation expanded), kept when it differs, so a title that carries the same letters the
// request used ("Senior AE" for a request for "an AE") still matches as it did before #879.
export interface RequestedHiringRole { term: string; normalized: string; literal?: string }

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
export function requestedHiringRoles(query: string | null | undefined, icp?: string | null): RequestedHiringRole[] {
  let signals: string[] = []
  try { const j = JSON.parse(icp ?? '{}') as { signals?: unknown }; if (Array.isArray(j.signals)) signals = j.signals.filter((x): x is string => typeof x === 'string') } catch { /* missing profile */ }
  const texts = [query ?? '', ...signals]
  const roles = new Map<string, RequestedHiringRole>()
  for (const text of texts) {
    for (const m of text.matchAll(/\b(?:hiring|recruiting)(?:\s+for)?\s+([^.;!?\n]+)/gi)) {
      const phrase = m[1].split(/\s+(?:within|in|at|with|on|from|that|who|whose|during|over|across)\b|\(/i)[0].trim()
      if (LEAD_QUALIFIER.test(phrase)) continue
      for (const raw of phrase.split(/\s+or\s+|\s+and\s+|,/i)) {
        const term = raw.replace(LEAD_WORDS, '').trim()
        const n = normal(term)
        if (!n || QUANTITY.test(term) || TIME_PHRASE.test(n) || ADVERB.test(n) || GERUND.test(n)) continue
        // Broad hiring is not a named title. Keep the existing generic-GTM contract for it.
        if (/^(?:sales|gtm|sales gtm|sales staff|sales people|sales team|staff|people|employees|talent|sales roles|roles|positions)$/.test(n)) continue
        // Do not infer a role from free prose. An unparseable explicit request is not a verified match.
        // Unsupported/long explicit terms stay required and unmatched, never silently generic.
        const lit = plain(term)
        // keyed on both readings: "AE or Account Executive" keeps the AE term's own letters beside the spelled-out title
        roles.set(`${n}|${lit !== n ? lit : ''}`, { term, normalized: n, ...(lit && lit !== n ? { literal: lit } : {}) })
      }
    }
  }
  return [...roles.values()]
}
export function matchedHiringRole(title: string, roles: RequestedHiringRole[]): RequestedHiringRole | null {
  const forms = titleForms(title)
  return roles.find(r => forms.some(f => f.includes(` ${r.normalized} `) || (!!r.literal && f.includes(` ${r.literal} `)))) ?? null
}
// Only sales/GTM-family requested titles gate drafting: the required proof is the SALES-hiring check. A requested
// non-GTM title (receptionist, payroll, front-desk) is a buying signal - recorded as evidence, never a drafting hold.
export const roleNeedsSourceProof = (r: RequestedHiringRole): boolean => isGtmRole(r.term) || /\bcrm\b/i.test(r.term)
