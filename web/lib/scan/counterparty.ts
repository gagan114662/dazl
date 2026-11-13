import type { Candidate } from './evidence.ts'
import { companyKey, norm } from './evidence.ts'
import type { Page } from './fetch-page.ts'
import { atsPostingRef } from '../sources/ats-posting.ts'

// Subject mismatch: the lead is named Company A, but the source is Company B's own
// marketing page and the evidence is B celebrating A as its customer. That is a fact
// about B, not evidence of A's buying intent. Route to review; never drop silently
// and never call it A's signal. Narrow and deterministic:
// - source host's brand token must differ from the lead's company,
// - the brand token must appear in the verified passage,
// - a customer-relationship phrase must tie the lead's company to that brand.
// The host brand is the first label of the hostname ("linear" in linear.app). This is
// a heuristic: www/acme's own subdomains are excluded; nothing about buyer intent is inferred.

const CUSTOMER_PHRASE = /\b(became|becomes|becoming|is now|are now|joined|joins|joining|chose|chooses|chosen|switched to|runs on|run on|running on|use|uses|using|adopted|adopts|adopting|standardized on|is a customer of|are customers of|as customers?)\b/i

// A public ATS posting (jobs.ashbyhq.com/{org}/..., jobs.lever.co/{org}/..., boards.greenhouse.io/{org}/jobs/...) belongs to the board's org, not to the board
// host (#767: "jobs" from jobs.ashbyhq.com matched a link like zapier.com/l/jobs/... next to "using AI tools" in Zapier's own posting and held it as a counterparty).
export function hostBrand(sourceUrl: string): string | null {
  return sourceBrand(sourceUrl)?.brand ?? null
}
// ats: the brand is a board org slug ("retail", "brightloophq"), so it is compared with the WHOLE company key, never its first word (#767 review: "AI Corp"
// cited to jobs.ashbyhq.com/retail/... is not "retail"'s own posting).
function sourceBrand(sourceUrl: string): { brand: string; ats: boolean } | null {
  const ats = atsPostingRef(sourceUrl)
  if (ats) { const org = ats.org.toLowerCase().replace(/[^a-z0-9]/g, ''); return org.length >= 3 ? { brand: org, ats: true } : null }
  let host: string
  try { host = new URL(sourceUrl).hostname.toLowerCase() } catch { return null }
  const labels = host.split('.').filter(l => l && l !== 'www')
  if (labels.length < 2) return null
  const brand = labels[0].replace(/[^a-z0-9]/g, '')
  return brand.length >= 3 ? { brand, ats: false } : null
}

const ATS_ORG_SUFFIX = new Set(['hq', 'inc', 'labs', 'io', 'app', 'team', 'careers', 'jobs'])
export function counterpartySignal(c: Candidate, page: Page, passage: string): string | null {
  const src = sourceBrand(c.source_url)
  if (!src) return null
  const { brand } = src
  const company = companyKey(c.company)
  if (!company) return null
  if (src.ats) {
    // a board org is the lead's own when it IS the company's whole key (spaces dropped), or that key plus a known board-slug suffix ("brightloophq",
    // "acmelabs"); a short key inside a longer slug ("ai" in "retail") or a mere prefix ("ramp" / "rampart") is not the same company
    const whole = company.replace(/ /g, '')
    const suffixed = (long: string, short: string) => short.length >= 3 && long.startsWith(short) && ATS_ORG_SUFFIX.has(long.slice(short.length))
    if (whole === brand || suffixed(brand, whole) || suffixed(whole, brand)) return null
  } else if (company.includes(brand) || brand.includes(company.split(' ')[0])) return null // source belongs to the lead itself
  const hay = norm(passage || `${page.title} ${page.text.slice(0, 3000)}`)
  if (!hay.includes(brand)) return null
  if (!CUSTOMER_PHRASE.test(hay)) return null
  // The lead's company must appear near the brand mention (same 200-char window).
  const at = hay.indexOf(brand)
  const window = hay.slice(Math.max(0, at - 200), at + 200)
  return window.includes(company) ? `source_owner:${brand}` : null
}
