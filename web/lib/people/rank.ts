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
}

export interface RankedPerson extends PersonContact {
  score: number
  matched: string[]
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

export function rankPeople<T extends PersonContact>(contacts: T[], icpText: string): (T & RankedPerson)[] {
  const icp = new Set(words(icpText))
  return contacts
    .map(c => {
      if (!c.title || icp.size === 0) return { ...c, score: 0, matched: [] }
      const matched = [...new Set(words(c.title).filter(w => icp.has(w)))]
      return { ...c, score: matched.length, matched }
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

export function contactsFromEnrichments(rows: ContactEnrichment[], icpText: string): RankedPerson[] {
  const contacts: PersonContact[] = rows
    .filter(r => r.kind === 'contact')
    .map(r => {
      const i = r.value.indexOf(' - ')
      return {
        name: (i === -1 ? r.value : r.value.slice(0, i)).trim(),
        title: i === -1 ? null : r.value.slice(i + 3).trim(),
        linkedin: r.source_url || null,
        connector: r.connector ?? r.label ?? 'enrichment',
      }
    })
  return rankPeople(contacts, icpText)
}
