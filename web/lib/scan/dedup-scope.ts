// In-scan identity scope for same-name candidates (#391, owner decisions on the issue 2026-11-03/04).
// The de-duplication key of a lead is its company key (companyKey, else the person's name). Two DIFFERENT businesses that
// share a name ("Acme" in Tokyo and "Acme" in Dubai) used to collapse into one lead. The rule now:
//   - a candidate's domain counts only when its SOURCE states it: the model may report the company's website, and the
//     domain is kept only when the fetched page itself names that host near the company (never inferred from the name);
//   - two candidates with different stated domains stay separate; the same domain is the same company;
//   - when either side has no stated domain, the name rule of today applies, except that two candidates from different
//     known countries (the market a multi-market search tagged the result with) are never merged;
//   - when a same-name group has to be split, a member that has neither a domain nor a country cannot be assigned to
//     any side: it goes to review as ambiguous_same_name and is never merged into one of them.
// A group that needs no split keeps today's key exactly (no suffix), so nothing changes for ordinary scans.
import { dedupBaseKey, hasPhrase, companyKey, norm } from './evidence.ts'

export const AMBIGUOUS_SAME_NAME = 'ambiguous_same_name'
export const AMBIGUOUS_SCOPE = '?'

const BARE_HOST = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/

// A stated website as a bare lowercase host ("https://www.Acme.io/about" -> "acme.io"). Anything else (wrong type, a
// path-only value, a non-ASCII or over-long host, an IP, a port) is no domain: fail closed to the name rule.
export function cleanDomain(v: unknown): string | null {
  if (typeof v !== 'string' || v.length > 300) return null
  let d = v.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '')
  d = d.split(/[/?#]/)[0].replace(/\.$/, '')
  if (!d || d.length > 253 || !BARE_HOST.test(d) || /^\d+(?:\.\d+)+$/.test(d)) return null
  return d
}

// ISO 3166 alpha-2 market country as tagged by the search plan; anything else is "unknown".
export function cleanCountry(v: unknown): string | null {
  return typeof v === 'string' && /^[A-Za-z]{2}$/.test(v.trim()) ? v.trim().toUpperCase() : null
}

const escapeRe = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// The page states this host for this company: the host appears as a whole host token (optionally after "www." or a
// scheme) within 300 characters of a mention of the company. A host that only appears far from the company (another
// company's link in a list) does not count.
export function domainStated(domain: string | null | undefined, pageText: unknown, company: string): boolean {
  const d = cleanDomain(domain)
  if (!d || typeof pageText !== 'string' || !pageText) return false
  const key = companyKey(company)
  if (key.length < 2) return false
  const text = pageText.slice(0, 400_000).toLowerCase()
  const re = new RegExp(`(?:^|[^a-z0-9.@-]|www\\.)${escapeRe(d)}(?![a-z0-9-]|\\.[a-z0-9])`, 'g')
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    const near = norm(text.slice(Math.max(0, m.index - 300), m.index + d.length + 300))
    if (hasPhrase(near, key)) return true
  }
  return false
}

export interface ScopeFacts { company: string; name: string; dedup_scope?: string | null; dedup_domain?: string | null; dedup_country?: string | null }
const domainOf = (c: ScopeFacts) => cleanDomain(c.dedup_domain)
const countryOf = (c: ScopeFacts) => cleanCountry(c.dedup_country)
function compatible(a: ScopeFacts, b: ScopeFacts): boolean {
  const da = domainOf(a), db = domainOf(b)
  if (da && db) return da === db
  const ka = countryOf(a), kb = countryOf(b)
  return !(ka && kb && ka !== kb)
}

// Sets dedup_scope on each of `cands` (in place). `prior`: rows of the same scan already decided (their scope is kept);
// a new candidate that conflicts with any of them is scoped apart instead of being merged into them.
export function scopeDedup(cands: ScopeFacts[], prior: readonly ScopeFacts[] = []): void {
  const groups = new Map<string, { prior: ScopeFacts[]; fresh: ScopeFacts[] }>()
  const at = (c: ScopeFacts) => { const k = dedupBaseKey(c); let g = groups.get(k); if (!g) { g = { prior: [], fresh: [] }; groups.set(k, g) }; return g }
  for (const p of prior) at(p).prior.push(p)
  for (const c of cands) at(c).fresh.push(c)
  for (const g of groups.values()) {
    if (g.fresh.length === 0) continue
    const all = [...g.prior, ...g.fresh]
    const split = g.prior.some(p => !!p.dedup_scope) || all.some((a, i) => all.some((b, j) => j > i && !compatible(a, b)))
    for (const c of g.fresh) {
      if (!split) { delete c.dedup_scope; continue }
      const d = domainOf(c), k = countryOf(c)
      c.dedup_scope = d ? `@${d}` : k ? `#${k}` : AMBIGUOUS_SCOPE
    }
  }
}
