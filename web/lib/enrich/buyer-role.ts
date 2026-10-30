// Buyer-role aware people retrieval (#383): the reviewed persona (the profile's "who") goes INTO the provider query (titles and seniority) before any paging cap, so a
// buyer who sits beyond the first five employees is returned instead of being cut off; and every returned person is classified against the persona afterwards.
// A title match is NOT decision authority: it is labelled as a title match. A former employee, an assistant-to-the-buyer, a person with no name (a generic inbox)
// is never attached as the buyer. "Current" is only what the provider itself reports; a search result is never described as verified-current.
import { roleContradicted, titleMatches } from '../people/rank.ts'

const SENIORITY: [RegExp, string][] = [[/\bowner|proprietor\b/i, 'owner'], [/\bfounder\b/i, 'founder'], [/\bc[eftom]o\b|\bchief\b|\bpresident\b/i, 'c_suite'], [/\bpartner\b/i, 'partner'], [/\bvp\b|vice president/i, 'vp'], [/\bhead of\b/i, 'head'], [/\bdirector\b/i, 'director'], [/\bmanager\b|\blead\b/i, 'manager']]
const clean = (s: string) => s.replace(/\s+/g, ' ').replace(/[\u0000-\u001f]/g, '').trim()

// Titles and seniority values to send to the provider, from the reviewed persona list. Bounded; deduplicated; never invented text.
export function buyerRoleQuery(who: string[]): { titles: string[]; seniorities: string[]; text: string } {
  const titles = [...new Set(who.map(clean).filter(w => w.length >= 3 && w.length <= 80))].slice(0, 8)
  const seniorities = [...new Set(titles.flatMap(t => SENIORITY.filter(([re]) => re.test(t)).map(([, s]) => s)))]
  return { titles, seniorities, text: titles.join('; ') }
}

export type RoleMatch = 'buyer' | 'alternate' | 'rejected'
export interface RoleVerdict { match: RoleMatch; reason: string; authority: 'title_match'; currentness: 'provider_reports_current' | 'search_result_only' }
// buyer: the title shares the persona's role words. alternate: an owner / founder / chief of the company when no persona word matches (the budget owner of a small
// company). rejected: no usable name, a title that is past/retired/negated/assistant-to, or nothing that relates to the persona.
export function classifyPerson(p: { name: string; title: string | null; organization?: { name: string | null; domain: string | null } | null }, who: string[]): RoleVerdict {
  const base = { authority: 'title_match' as const, currentness: p.organization ? 'provider_reports_current' as const : 'search_result_only' as const }
  const text = who.join(' ')
  if (!p.name.trim() || /@|^info$|^contact$|^team$|^office$/i.test(p.name.trim())) return { ...base, match: 'rejected', reason: 'no named person (a generic inbox or team name is never turned into a person)' }
  const title = p.title ?? ''
  if (title && roleContradicted(title, text)) return { ...base, match: 'rejected', reason: `title "${title.slice(0, 60)}" is a former, retired, negated or assistant-to role` }
  if (title && titleMatches(title, text).length > 0) return { ...base, match: 'buyer', reason: `title matches the buyer role (${titleMatches(title, text).join(', ')}); decision authority is not verified` }
  if (/\b(?:owner|founder|co-?founder|ceo|chief executive|managing director|president|proprietor)\b/i.test(title)) return { ...base, match: 'alternate', reason: 'owner / founder-level alternate; decision authority is not verified' }
  return { ...base, match: 'rejected', reason: title ? `title "${title.slice(0, 60)}" does not relate to the buyer role` : 'no title to judge the role by' }
}
export const roleLabel = (provider: string, v: RoleVerdict) => `${provider} - ${v.match === 'buyer' ? 'buyer-role match' : 'alternate contact'} (title match, not verified decision authority); ${v.currentness === 'provider_reports_current' ? 'employer reported current by the provider' : 'search result only, not verified current'}`
