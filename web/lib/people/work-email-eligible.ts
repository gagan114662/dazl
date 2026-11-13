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

// The stable key a target is addressed by: its full stored name and title, never truncated (a cut key could merge two
// people). A person whose key would not fit the lookups table (TARGET_KEY_MAX) is not a target at all.
export const TARGET_KEY_MAX = 200
export const targetKey = (p: { name: string; title: string | null }) => `${p.name}|${p.title ?? ''}`

// The profile handle of a LinkedIn URL ("https://www.linkedin.com/in/Dana-Lee/?x" -> "dana-lee"), or null.
export function linkedinHandle(u: string | null | undefined): string | null {
  if (typeof u !== 'string') return null
  const m = /(?:^|[/.])linkedin\.com\/in\/([^/?#\s]+)/i.exec(u)
  if (!m) return null
  let h: string
  try { h = decodeURIComponent(m[1]) } catch { h = m[1] }
  h = h.toLowerCase().trim()
  return h && h.length <= 100 ? h : null
}

export function isWorkEmailTarget(p: RankedPerson, icpText: string): boolean {
  if (p.historical || !p.title || roleContradicted(p.title, icpText)) return false
  if (!queryName(p.name)) return false
  if (targetKey(p).length > TARGET_KEY_MAX) return false
  return icpText.trim() ? p.tier !== 'none' : DECISION_MAKER.test(p.title)
}

// One entry per name+title. When the same name+title is stored with two DIFFERENT LinkedIn profiles, they are two people
// dazl cannot tell apart, so neither is a target (an address found for one could be shown for the other).
export function workEmailTargets(rows: ContactEnrichment[], icpText: string, nowMs: number = Date.now(), site: SiteIdentity | null = null): RankedPerson[] {
  const byKey = new Map<string, RankedPerson>()
  const handles = new Map<string, Set<string>>()
  for (const p of contactsFromEnrichments(rows, icpText, nowMs, site)) {
    if (!isWorkEmailTarget(p, icpText)) continue
    const k = targetKey(p)
    const h = linkedinHandle(p.linkedin)
    if (h) { const s = handles.get(k) ?? new Set<string>(); s.add(h); handles.set(k, s) }
    const had = byKey.get(k)
    if (!had) byKey.set(k, p)
    else if (!linkedinHandle(had.linkedin) && h) byKey.set(k, p) // keep the copy that carries a profile to check against
  }
  return [...byKey.entries()].filter(([k]) => (handles.get(k)?.size ?? 0) <= 1).map(([, p]) => p)
}

// Words of a job title that say what the role is (accents, punctuation and filler dropped; common short forms spelled
// out). "Co-Founder & CEO" -> founder, chief, executive, officer.
const TITLE_FILL = new Set(['of', 'and', 'the', 'to', 'for', 'at', 'in', 'a', 'an', 'sr', 'senior', 'jr', 'junior', 'co', 'interim', 'acting'])
const TITLE_SHORT: Record<string, string[]> = {
  ceo: ['chief', 'executive', 'officer'], cto: ['chief', 'technology', 'officer'], cfo: ['chief', 'financial', 'officer'],
  coo: ['chief', 'operating', 'officer'], cmo: ['chief', 'marketing', 'officer'], cro: ['chief', 'revenue', 'officer'],
  vp: ['vice', 'president'], svp: ['vice', 'president'], evp: ['vice', 'president'], gm: ['general', 'manager'], md: ['managing', 'director'],
  mgr: ['manager'], dir: ['director'], ops: ['operations'], cofounder: ['founder'],
}
export function titleWords(t: string | null | undefined): Set<string> {
  const out = new Set<string>()
  if (typeof t !== 'string') return out
  for (const w of t.slice(0, 200).normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().split(/[^a-z]+/)) {
    if (!w || TITLE_FILL.has(w)) continue
    for (const x of TITLE_SHORT[w] ?? [w]) out.add(x)
  }
  return out
}
// Same role: every role word of the shorter title is in the longer one ("Owner" ~ "Owner & Dentist", "CEO" ~ "Chief
// Executive Officer"); "Practice Manager" vs "Office Manager" or "Owner" vs "Director" is not the same role.
export function sameRole(a: string | null | undefined, b: string | null | undefined): boolean {
  const A = titleWords(a), B = titleWords(b)
  if (!A.size || !B.size) return false
  const [small, big] = A.size <= B.size ? [A, B] : [B, A]
  for (const w of small) if (!big.has(w)) return false
  return true
}

// How long the page keeps re-reading a lookup another tab or request has in flight, and how often (it stops as soon as
// the row is finished or retryable; past PENDING_STALE_S the server itself reports 'uncertain').
export const PENDING_POLL_MS = 4000
export const PENDING_POLL_MAX = 45

// Merge rows read from the server into what the page shows: a row only replaces the shown one when it is newer
// (updated_at), or equally new while the shown one is still open (pending / error / uncertain: a quick retry in the same
// second as a failure) and the new one is not pending. An older answer (a slow GET that started before a POST finished)
// never erases a newer result, and a row missing from a read is kept as shown. `own`: the answer to this page's own
// click (POST), which is the server's state after that attempt and replaces the row for its person, except that an
// unfinished answer (pending / error / uncertain) never hides a finished result already shown unless it is strictly
// newer (another tab's retry succeeded and a GET showed it before this page's older failed POST came back).
export type ShownLookup = WorkEmailView & { target: string; updated_at?: number | null }
const OPEN = new Set(['pending', 'error', 'uncertain'])
export function mergeLookups(shown: Record<string, ShownLookup>, incoming: unknown, own = false): Record<string, ShownLookup> {
  if (!Array.isArray(incoming)) return shown
  let next: Record<string, ShownLookup> | null = null
  for (const r of incoming) {
    if (!r || typeof r !== 'object' || typeof (r as ShownLookup).target !== 'string' || typeof (r as ShownLookup).status !== 'string') continue
    const row = r as ShownLookup
    const cur = (next ?? shown)[row.target]
    const t = (x: ShownLookup | undefined) => typeof x?.updated_at === 'number' && Number.isFinite(x.updated_at) ? x.updated_at : -Infinity
    const newer = !cur || t(row) > t(cur) || (own && (OPEN.has(cur.status) || !OPEN.has(row.status))) ||
      (t(row) === t(cur) && OPEN.has(cur.status) && row.status !== 'pending')
    if (!newer) continue
    next = { ...(next ?? shown), [row.target]: row }
  }
  return next ?? shown
}

export const siteSettled = (id: { state: string; site: string | null } | null | undefined): id is { state: 'fact' | 'user_confirmed'; site: string } =>
  !!id && !!id.site && (id.state === 'fact' || id.state === 'user_confirmed')

// What the lead panel says for one lookup (shared by the UI and tests). Only 'verified', 'published' and a provider address whose
// mailbox the free-tier check answered 'valid' (#1036) read as checked;
// every other state says plainly that it is not, or why nothing is shown.
export interface WorkEmailView { status: string; provider: string | null; address: string | null; detail: string | null; source_url: string | null; checked_at: number | null; mailbox_check?: string | null; mailbox_verifier?: string | null; mailbox_checked_at?: number | null }
const VERIFIER_NAME: Record<string, string> = { zerobounce: 'ZeroBounce', 'zerobounce-staging-fake': 'the STAGING TEST verifier (not a real mailbox check)' }
export type WorkEmailTone = 'checked' | 'unchecked' | 'none'
const PROVIDER_NAME: Record<string, string> = { apollo: 'Apollo', pdl: 'People Data Labs', site: 'the company website' }
const day = (s: number | null) => s ? new Date(s * 1000).toISOString().slice(0, 10) : 'an unrecorded date'
export function workEmailCopy(v: WorkEmailView): { tone: WorkEmailTone; headline: string; note: string; showAddress: boolean; checked: boolean } {
  const why = v.detail ? ` (${v.detail})` : ''
  switch (v.status) {
    case 'verified': return { tone: 'checked', checked: true, showAddress: !!v.address, headline: 'Checked work email', note: `Verified by ${PROVIDER_NAME[v.provider ?? ''] ?? 'the provider'} on ${day(v.checked_at)}, from your own key.` }
    case 'published': return { tone: 'checked', checked: true, showAddress: !!v.address && !!v.source_url, headline: 'Published work email', note: 'Printed on the company website (see the page). Published is not a mailbox check.' }
    case 'unverified': {
      const from = PROVIDER_NAME[v.provider ?? ''] ?? 'The provider', by = VERIFIER_NAME[v.mailbox_verifier ?? ''] ?? 'a mailbox check'
      // #1036: only the verifier's explicit "valid" makes it checked; a catch-all domain accepts every address, so it proves nothing.
      if (v.mailbox_check === 'valid') return { tone: 'checked', checked: true, showAddress: !!v.address, headline: 'Checked work email', note: `Found by ${from}; ${by} confirmed the mailbox accepts mail on ${day(v.mailbox_checked_at ?? null)}.` }
      if (v.mailbox_check === 'refused') return { tone: 'none', checked: false, showAddress: false, headline: 'Not shown: flagged as do-not-mail', note: `${from} had an address, but ${by} flagged it as one not to email (a spam trap, abuse or do-not-mail address).` }
      if (v.mailbox_check === 'undeliverable') return { tone: 'none', checked: false, showAddress: false, headline: 'Not shown: mailbox does not exist', note: `${from} had an address, but ${by} found no such mailbox.` }
      const after = v.mailbox_check === 'catch_all' ? ` ${by}: the domain accepts every address (catch-all), so the mailbox is not confirmed.` : v.mailbox_check === 'uncertain' || v.mailbox_check === 'pending' ? ` ${by} could not confirm the mailbox.` : ''
      return { tone: 'unchecked', checked: false, showAddress: !!v.address, headline: 'Found, not checked', note: `${from} has this address but nothing confirmed the mailbox.${after} Check it before you send; dazl does not treat it as checked.` }
    }
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
