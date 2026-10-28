// Three one-sentence plays for the Leads entry box, written from the workspace's saved business details (the buyer
// profile first, then what it sells). Pure templating on the client: no model call, nothing is saved or run until the
// user submits. Suggestions built from saved details and static examples are kept apart, so the page labels each group
// truthfully: a sparse profile gets its own suggestions plus examples to make three, never examples passed off as its own.

export interface PlayProfile {
  sells?: string
  buyer?: { who?: string[]; where?: string[]; signals?: string[]; industries?: string[] } | null
}
export interface PlaySuggestions { business: string[]; examples: string[] }

export const EXAMPLE_PLAYS = [
  'Dental practice owners in Ohio - opened a new location',
  'B2B SaaS founders in the US - hiring their first sales rep',
  'Restaurant owners in Austin - started taking online orders',
]
const SELLS_SIGNALS = ['opened a new location', 'hiring for a role this helps with', 'complaining publicly about their current tool']
const MAX = 600 // the scan request cap (lib/scan/icp.ts MAX_QUERY)

const tidy = (s: unknown) => typeof s === 'string' ? s.replace(/\s+/g, ' ').trim() : ''
// "Online booking" -> "online booking", but keep acronyms and names ("CRM", "HubSpot add-ons").
const lower = (s: string) => /^[A-Z][a-z]/.test(s) ? s[0].toLowerCase() + s.slice(1) : s

export function playSuggestions(p: PlayProfile | null): PlaySuggestions {
  const out: string[] = []
  const add = (s: string) => { const t = s.slice(0, MAX); if (t && !out.some(x => x.toLowerCase() === t.toLowerCase())) out.push(t) }
  const b = p?.buyer
  const who = (b?.who ?? []).map(tidy).filter(Boolean)
  const where = tidy(b?.where?.[0])
  const signals = (b?.signals ?? []).map(tidy).filter(Boolean)
  const industry = tidy(b?.industries?.[0])
  if (who.length > 0) {
    // Walk the signals against the roles so the three differ in who or in what happened.
    const n = Math.max(who.length, signals.length, 1)
    for (let i = 0; i < n && out.length < 3; i++) {
      const w = who[i % who.length], s = signals[i % Math.max(signals.length, 1)]
      add(`${w}${where ? ` in ${where}` : ''}${s ? ` - ${s}` : ''}`)
    }
  }
  const sells = tidy(p?.sells)
  if (sells) for (const s of SELLS_SIGNALS) { if (out.length >= 3) break; add(`${industry ? `${industry} businesses` : 'Businesses'} that could use ${lower(sells)}${where ? ` in ${where}` : ''} - ${s}`) }
  const examples = EXAMPLE_PLAYS.filter(e => !out.some(x => x.toLowerCase() === e.toLowerCase())).slice(0, 3 - out.length)
  return { business: out, examples }
}
