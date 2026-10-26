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

// A title that CONTRADICTS being the buyer of that role, even though it contains the role's words (#191 review:
// buyerTitle("Former HR Manager", "HR Manager") was true). Explicitly past or retired ("Former", "Ex-", "Retired",
// "Previous", "Emeritus"), negated ("Not HR Manager", "no longer"), or an assistant TO the role ("Assistant to the HR
// Manager", "HR Manager's assistant"). A bare "Assistant ..." counts too unless the scan's own roles ask for an
// assistant. Conservative on purpose: an uncertain title is not promoted into a buyer slot; ordinary current-role
// listings keep their "not verified as current" label.
const PAST = /\b(?:former|formerly|ex|previous|previously|past|retired|retiree|emeritus|late|outgoing|ehemalig\w*|ancien\w*|antigu\w*|anterior)\b/i
const NEGATED = /\b(?:not|no longer|never|isn't|was not)\b/i
const ASSISTANT_OF = /\b(?:assistant|secretary|aide|pa|ea)\s+(?:to|of|for)\b|['\u2019]s\s+(?:assistant|secretary|aide)\b/i
const ASSISTANT = /\b(?:assistant|secretary|aide)\b/i
export function roleContradicted(title: string, icpText = ''): boolean {
  if (PAST.test(title) || NEGATED.test(title) || ASSISTANT_OF.test(title)) return true
  return ASSISTANT.test(title) && !ASSISTANT.test(icpText)
}

// ICP words a title shares (same word rules as rankPeople). Used by the crawl to choose WHICH listed people to keep.
// A contradicted title shares nothing: it cannot take a buyer slot.
export function titleMatches(title: string, icpText: string): string[] {
  if (roleContradicted(title, icpText)) return []
  const icp = new Set(words(icpText))
  return [...new Set(words(title).filter(w => icp.has(w)))]
}

export function rankPeople<T extends PersonContact>(contacts: T[], icpText: string): (T & RankedPerson)[] {
  const icp = new Set(words(icpText))
  return contacts
    .map(c => {
      if (!c.title || icp.size === 0 || roleContradicted(c.title, icpText)) return { ...c, score: 0, matched: [], tier: 'none' as MatchTier }
      const matched = [...new Set(words(c.title).filter(w => icp.has(w)))]
      const tier: MatchTier = matched.length >= 2 ? 'strong' : matched.length === 1 ? 'weak' : 'none'
      return { ...c, score: matched.length, matched, tier }
    })
    .sort((a, b) => b.score - a.score)
}

// The ONE place a person is RECOMMENDED (opportunity card "who", CSV Best Person). A stored person whose title explicitly
// contradicts the buyer role (past/retired/negated/assistant-to) is never recommended, however it scores, and when every
// stored person is contradicted nobody is recommended (null). Raw rows stay visible in the people list; only the
// recommendation refuses them. Same rule whichever connector stored the row and with or without an ICP: explicit
// contradiction is not a matter of ICP fit. A row with no title is not contradicted (it ranks last, as before).
export function recommendedPerson<T extends PersonContact>(contacts: T[], icpText: string): (T & RankedPerson) | null {
  return rankPeople(contacts, icpText).find(c => !c.title || !roleContradicted(c.title, icpText)) ?? null
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
