// Requested POSTING titles, never the buyer personas in ICP.who. Deliberately bounded synonyms:
// sales ops <-> sales operations, revops <-> revenue operations, admin <-> administrator.
// CRM administrator is NOT business systems administrator, Salesforce developer or AE.
const normal = (s: string): string => s.toLowerCase().replace(/\bsales[ -]+ops\b/g, 'sales operations').replace(/\brevops\b/g, 'revenue operations').replace(/\badmin\b/g, 'administrator').replace(/\b(?:managers|administrators|executives|engineers|directors)\b/g, w => w.slice(0, -1)).replace(/[^a-z0-9]+/g, ' ').trim()
export interface RequestedHiringRole { term: string; normalized: string }
export function requestedHiringRoles(query: string | null | undefined, icp?: string | null): RequestedHiringRole[] {
  let signals: string[] = []
  try { const j = JSON.parse(icp ?? '{}') as { signals?: unknown }; if (Array.isArray(j.signals)) signals = j.signals.filter((x): x is string => typeof x === 'string') } catch { /* missing profile */ }
  const texts = [query ?? '', ...signals]
  const roles = new Map<string, RequestedHiringRole>()
  for (const text of texts) {
    for (const m of text.matchAll(/\b(?:hiring|recruiting)(?:\s+for)?\s+([^.;!?\n]+)/gi)) {
      const phrase = m[1].split(/\s+(?:within|in|at|with|on|from|that|who|whose|during|over|across)\b|\(/i)[0]
      for (const raw of phrase.split(/\s+or\s+|\s+and\s+|,/i)) {
        const term = raw.replace(/^(?:(?:a|an|the|first|new|their|two|three|\d+)\s+)+/i, '').trim()
        const n = normal(term)
        // Broad hiring is not a named title. Keep the existing generic-GTM contract for it.
        if (!n || /^(?:sales|gtm|sales gtm|sales staff|sales people|sales team|staff|people|employees|talent|sales roles|roles|positions)$/.test(n)) continue
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
