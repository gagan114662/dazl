// #1036 / #383: WHO on a lead may get a "Find work email" lookup. Pure (no db, network or node imports) so the Leads page
// shows the button for exactly the people the server will look up. The server re-derives the target from the lead's own
// stored rows; nothing the browser sends is trusted as a name, title or domain.
//
// A target is a stored person on this lead (company-site crawl, public profile search, provider search) who:
//   - is not historical (an SEC filing names officers as of the filing, never a current contact);
//   - has a title, and that title does not contradict the buyer role (former, retired, negated, assistant-to);
//   - matches the buyer role: with reviewed/entered buyer roles (the play's ICP "who"), a title that shares at least one
//     of their words (rank.ts tier strong or weak); with no buyer roles, a decision-maker title (DECISION_MAKER);
//   - has a first AND a last name (a provider match needs both; a single word is never looked up).
// The lead itself must sit on a settled company website (identityOf state 'fact' = the cited page is on that domain, or
// 'user_confirmed'): the address a provider returns must be on that domain, so an unsettled site means no lookup.
import { contactsFromEnrichments, roleContradicted, type ContactEnrichment, type RankedPerson } from './rank.ts'
import type { SiteIdentity } from './currency.ts'

export const DECISION_MAKER = /\b(?:founder|co-?founder|owner|ceo|cto|cfo|coo|cmo|cro|chief|president|vp|vice president|head|director|partner|principal|general manager|managing director|gm)\b/i

// "Dr. Ana María López-Pérez" -> { first: 'Ana', last: 'López-Pérez' } as typed for the provider query. Same word rule as
// email-pattern.ts splitName (honorific dropped, first and last word, both 2+ letters once accents are stripped).
export function queryName(full: string): { first: string; last: string } | null {
  if (typeof full !== 'string') return null
  const words = full.replace(/^(dr|mr|ms|mrs|prof)\.?\s+/i, '').split(/\s+/).filter(Boolean)
  if (words.length < 2) return null
  const letters = (s: string) => s.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^A-Za-z]/g, '')
  const first = words[0], last = words[words.length - 1]
  if (letters(first).length < 2 || letters(last).length < 2) return null
  return { first: first.slice(0, 60), last: last.slice(0, 60) }
}

// Comparable form of a name (accents stripped, letters only, lower case) for "is the provider's person the one we asked for".
export const nameKey = (s: string | null | undefined) => (s ?? '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z]/g, '')

// The stable key a target is addressed by: its stored name and title. Bounded so it fits the lookups table.
export const targetKey = (p: { name: string; title: string | null }) => `${p.name}|${p.title ?? ''}`.slice(0, 200)

export function isWorkEmailTarget(p: RankedPerson, icpText: string): boolean {
  if (p.historical || !p.title || roleContradicted(p.title, icpText)) return false
  if (!queryName(p.name)) return false
  return icpText.trim() ? p.tier !== 'none' : DECISION_MAKER.test(p.title)
}

export function workEmailTargets(rows: ContactEnrichment[], icpText: string, nowMs: number = Date.now(), site: SiteIdentity | null = null): RankedPerson[] {
  const seen = new Set<string>()
  return contactsFromEnrichments(rows, icpText, nowMs, site).filter(p => {
    if (!isWorkEmailTarget(p, icpText)) return false
    const k = targetKey(p)
    if (seen.has(k)) return false
    seen.add(k); return true
  })
}

export const siteSettled = (id: { state: string; site: string | null } | null | undefined): id is { state: 'fact' | 'user_confirmed'; site: string } =>
  !!id && !!id.site && (id.state === 'fact' || id.state === 'user_confirmed')

// What the lead panel says for one lookup (shared by the UI and tests). Only 'verified' and 'published' read as checked;
// every other state says plainly that it is not, or why nothing is shown.
export interface WorkEmailView { status: string; provider: string | null; address: string | null; detail: string | null; source_url: string | null; checked_at: number | null }
export type WorkEmailTone = 'checked' | 'unchecked' | 'none'
const PROVIDER_NAME: Record<string, string> = { apollo: 'Apollo', pdl: 'People Data Labs', site: 'the company website' }
const day = (s: number | null) => s ? new Date(s * 1000).toISOString().slice(0, 10) : 'an unrecorded date'
export function workEmailCopy(v: WorkEmailView): { tone: WorkEmailTone; headline: string; note: string; showAddress: boolean; checked: boolean } {
  const why = v.detail ? ` (${v.detail})` : ''
  switch (v.status) {
    case 'verified': return { tone: 'checked', checked: true, showAddress: !!v.address, headline: 'Checked work email', note: `Verified by ${PROVIDER_NAME[v.provider ?? ''] ?? 'the provider'} on ${day(v.checked_at)}, from your own key.` }
    case 'published': return { tone: 'checked', checked: true, showAddress: !!v.address && !!v.source_url, headline: 'Published work email', note: 'Printed on the company website (see the page). Published is not a mailbox check.' }
    case 'unverified': return { tone: 'unchecked', checked: false, showAddress: !!v.address, headline: 'Found, not checked', note: `${PROVIDER_NAME[v.provider ?? ''] ?? 'The provider'} has this address but nothing confirmed the mailbox. Check it before you send; dazl does not treat it as checked.` }
    case 'not_found': return { tone: 'none', checked: false, showAddress: false, headline: 'No work email found', note: `Nothing usable came back${why}. This does not prove none exists.` }
    case 'not_us': return { tone: 'none', checked: false, showAddress: false, headline: 'Not shown: outside the US', note: `Outside the US dazl only uses addresses the person or company published${why}.` }
    case 'rejected': return { tone: 'none', checked: false, showAddress: false, headline: 'Not shown: did not match', note: `The answer did not match this person at this company${why}.` }
    case 'error': return { tone: 'none', checked: false, showAddress: false, headline: 'Lookup failed', note: `${v.detail ?? 'The provider did not answer'}. You can try again.` }
    case 'uncertain': return { tone: 'none', checked: false, showAddress: false, headline: 'Lookup did not finish', note: 'It may have used a credit on your key. You can try again.' }
    case 'pending': return { tone: 'none', checked: false, showAddress: false, headline: 'Looking...', note: '' }
    default: return { tone: 'none', checked: false, showAddress: false, headline: 'Unknown state', note: 'Not shown.' }
  }
}
export function workEmailCostNote(p: { apollo: boolean; pdl: boolean; pdlNeedsOptIn: boolean }): string {
  if (!p.apollo && !p.pdl) return 'No Apollo or People Data Labs key set. Add your own key in Settings > Enrichment to look up work emails.'
  const parts = [p.apollo ? 'up to 1 credit on your Apollo key' : null, p.pdl ? `${p.apollo ? 'then, only if Apollo has none, ' : ''}1 People Data Labs credit, only on a match` : null].filter(Boolean)
  return `Free if the company website prints it; otherwise ${parts.join(', ')}. US contacts only.${p.pdlNeedsOptIn ? ' People Data Labs fallback is off (Settings > Enrichment).' : ''}`
}
