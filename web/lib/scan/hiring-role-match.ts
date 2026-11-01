import { isGtmRole } from '../signals/ats-gtm.ts'
// Requested POSTING titles, never the buyer personas in ICP.who. Deliberately bounded synonyms:
// sales ops <-> sales operations, revops <-> revenue operations, admin <-> administrator.
// CRM administrator is NOT business systems administrator, Salesforce developer or AE.
const normal = (s: string): string => s.toLowerCase().replace(/\bsales[ -]+ops\b/g, 'sales operations').replace(/\brevops\b/g, 'revenue operations').replace(/\badmin\b/g, 'administrator').replace(/\b(?:managers|administrators|executives|engineers|directors)\b/g, w => w.slice(0, -1)).replace(/[^a-z0-9]+/g, ' ').trim()
export interface RequestedHiringRole { term: string; normalized: string }

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
        roles.set(n, { term, normalized: n })
      }
    }
  }
  return [...roles.values()]
}
export function matchedHiringRole(title: string, roles: RequestedHiringRole[]): RequestedHiringRole | null {
  const n = ` ${normal(title)} `
  return roles.find(r => n.includes(` ${r.normalized} `)) ?? null
}
// Only sales/GTM-family requested titles gate drafting: the required proof is the SALES-hiring check. A requested
// non-GTM title (receptionist, payroll, front-desk) is a buying signal - recorded as evidence, never a drafting hold.
export const roleNeedsSourceProof = (r: RequestedHiringRole): boolean => isGtmRole(r.term) || /\bcrm\b/i.test(r.term)
