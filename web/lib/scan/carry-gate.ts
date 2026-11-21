// Server-only gate for reviewed exclusions carried into a different-offer play (lib/scan/carry-exclusions.ts).
// Used by classifyLeads (lib/scan/actionable.ts) and every outreach hold (lib/outreach/service.ts leadCarryExcluded).
import { listOf } from './carry-exclusions.ts'

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
const host = (s: string) => s.toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '').trim()
const sameOrSub = (d: string, h: string) => !!d && (d === h || d.endsWith(`.${h}`))

// A lead matches when its domain or contact email domain is an excluded domain (exact or a subdomain), or by name:
// the lead's name contains a whole excluded name ("Acme Dental" in "Acme Dental Group"), or the lead's name (3+
// characters) is one of the capitalised names written in an exclusion ("Pipedrive" in "Competitors like Pipedrive").
// A one- or two-letter name or an ordinary lower-case word inside the text never matches.
export function carriedExcluded(icpJson: string | null | undefined, lead: { company: string; company_domain?: string | null; contact?: string | null }): boolean {
  const xs = listOf(icpJson)
  if (!xs.length) return false
  const domain = host(lead.company_domain ?? ''), email = host((lead.contact ?? '').split('@')[1] ?? '')
  const company = norm(lead.company ?? '')
  for (const raw of xs) {
    const v = raw.replace(/^[a-z ]{3,20}:\s*/i, '')
    const m = /^(.*?)\s*\(([^()]+\.[a-z]{2,})\)\s*$/i.exec(v)
    const name = (m ? m[1] : v).trim(), dom = m ? host(m[2]) : (/^[^\s]+\.[a-z]{2,}$/i.test(v.trim()) ? host(v) : '')
    if (dom && (sameOrSub(domain, dom) || sameOrSub(email, dom))) return true
    if (company.length < 3) continue
    const n = norm(name)
    if (n.length >= 3 && ` ${company} `.includes(` ${n} `)) return true
    const proper = (name.match(/\b[A-Z][\w&'-]*(?:\s+[A-Z][\w&'-]*)*/g) ?? []).map(norm).filter(p => p.length >= 3)
    if (proper.some(p => p === company)) return true
  }
  return false
}
