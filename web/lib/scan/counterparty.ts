import type { Candidate } from './evidence.ts'
import { companyKey, norm } from './evidence.ts'
import type { Page } from './fetch-page.ts'

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

export function hostBrand(sourceUrl: string): string | null {
  let host: string
  try { host = new URL(sourceUrl).hostname.toLowerCase() } catch { return null }
  const labels = host.split('.').filter(l => l && l !== 'www')
  if (labels.length < 2) return null
  const brand = labels[0].replace(/[^a-z0-9]/g, '')
  return brand.length >= 3 ? brand : null
}

export function counterpartySignal(c: Candidate, page: Page, passage: string): string | null {
  const brand = hostBrand(c.source_url)
  if (!brand) return null
  const company = companyKey(c.company)
  if (!company || company.includes(brand) || brand.includes(company.split(' ')[0])) return null // source belongs to the lead itself
  const hay = norm(passage || `${page.title} ${page.text.slice(0, 3000)}`)
  if (!hay.includes(brand)) return null
  if (!CUSTOMER_PHRASE.test(hay)) return null
  // The lead's company must appear near the brand mention (same 200-char window).
  const at = hay.indexOf(brand)
  const window = hay.slice(Math.max(0, at - 200), at + 200)
  return window.includes(company) ? `source_owner:${brand}` : null
}
