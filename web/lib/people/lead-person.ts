// #1037: the ONE person a lead ROW names (name, title, LinkedIn or source link), shown without opening the lead. The same
// rule decides whether the first-play people search spends a search on a lead (people-search.ts skipNamed), so a row
// reads "No buyer named yet" exactly when no search result or stored person qualifies.
//
// Nothing is invented, and only the company's OWN website names a buyer: the person is a stored company-site crawl 'person' row
// (connector 'sitecrawl') read on a first-party page of the lead's confirmed site, current (lib/people/currency.ts verified_current:
// the site identity is fact or user-confirmed, the page is on that site and was read within 180 days). Its LinkedIn is the profile
// that company page itself links for that person (lib/people/site-profile.ts), never one found by search. A public profile search
// result, a provider record, a filing or a research page never names the lead's buyer, and never adds a LinkedIn link to one.
// The same rule makes a lead READY (lib/journey.ts heldReason): no such buyer, no ready lead.
// Fail closed: anything malformed is skipped, never repaired into a person.
// A row qualifies only with ALL of:
//   - a plausible human name (letters, spaces, . ' - only; no address, URL or digits) and a non-empty title;
//   - not historical (an SEC Form D names officers as of the filing) and a title that does not contradict the role
//     (former, retired, assistant-to: rank.ts roleContradicted);
//   - the company page it was read on (an http(s) source page) AND the LinkedIn profile URL that page links for this person.
// Collection already keeps only buyer-role titles (the crawl and the profile search filter on rank.ts titleMatches; a
// provider is searched by role), so no extra role match is required here (a 'Co-founder' for a 'Founder' search is kept):
// the best title match is simply ranked first, as the opportunity card's recommendedPerson does.
// Order: rank order among the qualifying company-site people (the best title match first).
import { contactsFromEnrichments, peopleSourceText, roleContradicted, type ContactEnrichment } from './rank.ts'
import type { SiteIdentity } from './currency.ts'

export const NO_BUYER = 'No buyer named yet'
const DISCOVER_VIA = 'named on a public page'
export interface LeadPerson { name: string; title: string; linkedin: string | null; source: string | null; via: string; current: boolean }

const PROFILE = /^https:\/\/([a-z]{2,3}\.)?(www\.)?linkedin\.com\/in\/[A-Za-z0-9\-_%]{3,100}\/?$/
const SOURCE = /^https?:\/\/[^\s<>"'`]{3,500}$/i
const NAME = /^[\p{L}][\p{L}\p{M} .'\u2019-]{1,79}$/u
// Scripts that write a full name without spaces (王伟, 김민준, 山田太郎): two or more of their characters is a full name.
const NO_SPACE_NAME = /^[\p{Script=Han}\p{Script=Hangul}\p{Script=Hiragana}\p{Script=Katakana}\u30FC\u30FB]{2,20}$/u
const MAX_ROWS = 500

const str = (v: unknown, max: number): string | null => typeof v === 'string' && v.length <= max ? v : null
// Only well-formed people rows reach the ranking; anything else (wrong types, huge strings, missing keys) is dropped.
function clean(rows: unknown): ContactEnrichment[] {
  if (!Array.isArray(rows)) return []
  const out: ContactEnrichment[] = []
  // the bound is on the PEOPLE rows read (a lead's other rows - signals, domains, tech scans - grow without a cap and never hide its buyer)
  for (const r of rows) {
    if (out.length >= MAX_ROWS) break
    if (!r || typeof r !== 'object' || Array.isArray(r)) continue
    const o = r as Record<string, unknown>
    const kind = str(o.kind, 40), value = str(o.value, 300)
    if (kind !== 'person' && kind !== 'contact') continue
    if (!value) continue
    const source_url = str(o.source_url, 600) ?? ''
    const label = str(o.label, 600)
    const connector = str(o.connector, 80)
    out.push({ kind, value, label, source_url, ...(connector !== null ? { connector } : {}), ...(o.retrieved_at !== undefined ? { retrieved_at: o.retrieved_at } : {}) })
  }
  return out
}
const tidy = (s: string) => s.replace(/\s+/g, ' ').trim()
function discoverPerson(rows: unknown): LeadPerson | null {
  if (!Array.isArray(rows)) return null
  const mine = rows.filter((r): r is Record<string, unknown> => !!r && typeof r === 'object' && (r as Record<string, unknown>).connector === 'discover')
  const p = mine.find(r => r.kind === 'person' && typeof r.value === 'string')
  if (!p) return null
  const value = str(p.value, 300) ?? '', i = value.indexOf(', ')
  const name = tidy(i < 0 ? value : value.slice(0, i)), title = tidy(i < 0 ? '' : value.slice(i + 2)).slice(0, 120)
  if (!NAME.test(name) || (name.split(' ').filter(Boolean).length < 2 && !NO_SPACE_NAME.test(name))) return null
  const li = mine.find(r => r.kind === 'linkedin' && typeof r.value === 'string' && PROFILE.test(r.value as string))
  const source = typeof p.source_url === 'string' && SOURCE.test(p.source_url) ? p.source_url : null
  return { name, title, linkedin: li ? li.value as string : null, source, via: DISCOVER_VIA, current: false }
}

export function leadPerson(rows: unknown, icpText: unknown, nowMs: number = Date.now(), site: SiteIdentity | null = null): LeadPerson | null {
  try {
    // A lead from the Claude discovery lane (rows with connector 'discover', written only by lib/scan/runner.ts runDiscoverLane) names the
    // person its run found for this seller, with the page that names them. The own-site rule below is the older engine's.
    const found = discoverPerson(rows)
    if (found) return found
    const icp = typeof icpText === 'string' ? icpText.slice(0, 2000) : ''
    const people = contactsFromEnrichments(clean(rows), icp, Number.isFinite(nowMs) ? nowMs : Date.now(), site)
    for (const p of people) {
      // only a person the company's own website lists, read on its confirmed site and current (#1037)
      if (p.connector !== 'sitecrawl' || p.currency !== 'verified_current' || p.historical || p.nameOnly) continue
      const name = tidy(p.name), title = tidy(p.title ?? '')
      if (!NAME.test(name) || (name.split(' ').filter(Boolean).length < 2 && !NO_SPACE_NAME.test(name))) continue // a full name, never a bare first name or a handle
      if (!title || title.length > 120 || roleContradicted(title, icp)) continue
      const linkedin = p.linkedin && PROFILE.test(p.linkedin) ? p.linkedin : null   // for a sitecrawl row: only the profile its own page links (rank.ts)
      const source = p.source && SOURCE.test(p.source) ? p.source : null
      // the company page and the LinkedIn it links (#1037). PM #1540: on a site known only by the homepage identity check (no email or route can
      // come from it, so the lead stays held) the person is shown with the LinkedIn only when the page links one.
      if (!source || (!linkedin && !(site?.state === 'unconfirmed' && site.identityChecked))) continue
      return { name, title, linkedin, source, via: peopleSourceText(p), current: true }
    }
    return null
  } catch { return null }
}

// The row's one line, for places that render text only (and for tests): "Jane Doe · Head of Sales" or NO_BUYER.
export function leadPersonLine(p: LeadPerson | null): string {
  return p ? `${p.name} · ${p.title}` : NO_BUYER
}

// The words in brackets after the person on a lead row (#1579). "verified current" only for a person read on the company's own confirmed
// website within the currency window (lib/people/currency.ts). A person the discovery lane found is named on a public page: nothing
// checked that they hold the role today, so the row says so, as Details does ("None verified as current").
export const personBasis = (p: LeadPerson): string => p.current ? 'verified current' : p.via === DISCOVER_VIA ? `${DISCOVER_VIA}, not verified as current` : 'search result, not verified as current'
