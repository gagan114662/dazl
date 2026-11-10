// #1037: the ONE person a lead ROW names (name, title, LinkedIn or source link), shown without opening the lead. The same
// rule decides whether the first-play people search spends a search on a lead (people-search.ts skipNamed), so a row
// reads "No buyer named yet" exactly when no search result or stored person qualifies.
//
// Nothing is invented: the person is a stored 'person' / 'contact' enrichment (company-site crawl, public profile search,
// the tenant's own enrichment provider). Fail closed: anything malformed is skipped, never repaired into a person.
// A row qualifies only with ALL of:
//   - a plausible human name (letters, spaces, . ' - only; no address, URL or digits) and a non-empty title;
//   - not historical (an SEC Form D names officers as of the filing) and a title that does not contradict the role
//     (former, retired, assistant-to: rank.ts roleContradicted);
//   - when the scan has buyer roles, a title sharing at least one of their words (rank.ts tier weak/strong);
//   - provenance a user can open: a public LinkedIn profile URL, or an http(s) source page.
// Order: verified current first (lib/people/currency.ts: dated first-party page / provider record), then search-result
// only, each in rank order. `current` says which, so the row never presents a search result as a verified employee.
import { contactsFromEnrichments, peopleSourceText, roleContradicted, type ContactEnrichment } from './rank.ts'
import type { SiteIdentity } from './currency.ts'

export const NO_BUYER = 'No buyer named yet'
export interface LeadPerson { name: string; title: string; linkedin: string | null; source: string | null; via: string; current: boolean }

const PROFILE = /^https:\/\/([a-z]{2,3}\.)?(www\.)?linkedin\.com\/in\/[A-Za-z0-9\-_%]{3,100}\/?$/
const SOURCE = /^https?:\/\/[^\s<>"'`]{3,500}$/i
const NAME = /^[\p{L}][\p{L}\p{M} .'\u2019-]{1,79}$/u
const MAX_ROWS = 500

const str = (v: unknown, max: number): string | null => typeof v === 'string' && v.length <= max ? v : null
// Only well-formed people rows reach the ranking; anything else (wrong types, huge strings, missing keys) is dropped.
function clean(rows: unknown): ContactEnrichment[] {
  if (!Array.isArray(rows)) return []
  const out: ContactEnrichment[] = []
  for (const r of rows.slice(0, MAX_ROWS)) {
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

export function leadPerson(rows: unknown, icpText: unknown, nowMs: number = Date.now(), site: SiteIdentity | null = null): LeadPerson | null {
  try {
    const icp = typeof icpText === 'string' ? icpText.slice(0, 2000) : ''
    const roles = icp.trim().length > 0
    const people = contactsFromEnrichments(clean(rows), icp, Number.isFinite(nowMs) ? nowMs : Date.now(), site)
    const ordered = [...people.filter(p => p.currency === 'verified_current'), ...people.filter(p => p.currency !== 'verified_current')]
    for (const p of ordered) {
      if (p.historical) continue
      const name = tidy(p.name), title = tidy(p.title ?? '')
      if (!NAME.test(name) || name.split(' ').filter(Boolean).length < 2) continue // a full name, never a bare first name or a handle
      if (!title || title.length > 120 || roleContradicted(title, icp)) continue
      if (roles && p.tier === 'none') continue // a titled person who is not one of the scan's buyer roles is not "the buyer"
      const linkedin = p.linkedin && PROFILE.test(p.linkedin) ? p.linkedin : null
      const src = p.source ?? (p.linkedin && !linkedin ? p.linkedin : null)
      const source = src && SOURCE.test(src) ? src : null
      if (!linkedin && !source) continue // no link the user can check: not shown as the lead's person
      return { name, title, linkedin, source: linkedin ? null : source, via: peopleSourceText(p), current: p.currency === 'verified_current' }
    }
    return null
  } catch { return null }
}

// The row's one line, for places that render text only (and for tests): "Jane Doe · Head of Sales" or NO_BUYER.
export function leadPersonLine(p: LeadPerson | null): string {
  return p ? `${p.name} · ${p.title}` : NO_BUYER
}
