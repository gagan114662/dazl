// Right people: order a lead's already-enriched contacts by how well their title
// matches the tenant's ICP text. Pure word-overlap heuristic - no model call, no new
// data collection, nothing invented: contacts pass through untouched, only the order
// and the matched-word list are added. A contact with no title or no overlap keeps its
// data and sorts after matches; contacts are never hidden.

export interface PersonContact {
  name: string
  title: string | null
  linkedin: string | null
  connector: string
  source?: string // page the person was found on, when it is not a profile
}

export type MatchTier = 'strong' | 'weak' | 'none'

export interface RankedPerson extends PersonContact {
  score: number
  matched: string[]
  // strong: 2+ ICP words matched - a real title signal. weak: exactly 1 word - a single
  // generic word like "sales" or "manager" is weak evidence and must be labelled as such.
  // none: no overlap - shown unordered after matches, never hidden, never implied a fit.
  tier: MatchTier
}

const STOP = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'has', 'have', 'in',
  'into', 'is', 'it', 'its', 'of', 'on', 'or', 'our', 'that', 'the', 'their', 'them',
  'they', 'to', 'who', 'with', 'currently', 'actively', 'looking', 'seeking', 'role',
  'roles', 'companies', 'company', 'team', 'teams',
])

function words(text: string): string[] {
  return (text.toLowerCase().match(/[a-z][a-z0-9+-]{1,}/g) ?? []).filter(w => !STOP.has(w))
}

// ICP words a title shares (same word rules as rankPeople). Used by the crawl to choose WHICH listed people to keep.
export function titleMatches(title: string, icpText: string): string[] {
  const icp = new Set(words(icpText))
  return [...new Set(words(title).filter(w => icp.has(w)))]
}

export function rankPeople<T extends PersonContact>(contacts: T[], icpText: string): (T & RankedPerson)[] {
  const icp = new Set(words(icpText))
  return contacts
    .map(c => {
      if (!c.title || icp.size === 0) return { ...c, score: 0, matched: [], tier: 'none' as MatchTier }
      const matched = [...new Set(words(c.title).filter(w => icp.has(w)))]
      const tier: MatchTier = matched.length >= 2 ? 'strong' : matched.length === 1 ? 'weak' : 'none'
      return { ...c, score: matched.length, matched, tier }
    })
    .sort((a, b) => b.score - a.score)
}

// Stored enrichment rows carry a contact as value "Name - Title" (title optional),
// connector = source connector, source_url = profile link. Split on the FIRST " - " only.
export interface ContactEnrichment {
  kind: string
  value: string
  label: string | null
  source_url: string
  connector?: string
}

// Where a listed person came from, in words (leads page and CSV export). Unknown connectors show their id.
export const PEOPLE_SOURCE: Record<string, string> = { sitecrawl: 'the company website (listed with this title)', 'search:people': 'a public LinkedIn search result (not verified as current)', 'adv:linkedin': 'LinkedIn, through your session', 'enrich:apollo': 'Apollo', 'enrich:pdl': 'People Data Labs' }

// People dazl finds itself are 'person' rows valued "Name, Title" (company-site crawl, public profile search). They
// belong in the same "right people" list as paid-enrichment contacts, not in the generic enrichment list. Their
// profile link is source_url only when it IS a public profile; a company page stays a plain source link.
const PROFILE_URL = /^https:\/\/([a-z]{2,3}\.)?(www\.)?linkedin\.com\/in\//
export function contactsFromEnrichments(rows: ContactEnrichment[], icpText: string): RankedPerson[] {
  const contacts: PersonContact[] = rows
    .filter(r => r.kind === 'contact' || r.kind === 'person')
    .map(r => {
      const sep = r.kind === 'person' ? ', ' : ' - '
      const i = r.value.indexOf(sep)
      return {
        name: (i === -1 ? r.value : r.value.slice(0, i)).trim(),
        title: i === -1 ? null : r.value.slice(i + sep.length).trim(),
        linkedin: r.kind === 'contact' ? r.source_url || null : PROFILE_URL.test(r.source_url) ? r.source_url : null,
        connector: r.connector ?? r.label ?? 'enrichment',
        ...(r.kind === 'person' && !PROFILE_URL.test(r.source_url) ? { source: r.source_url } : {}),
      }
    })
  return rankPeople(contacts, icpText)
}
