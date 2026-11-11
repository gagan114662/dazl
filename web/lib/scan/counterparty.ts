import type { Candidate } from './evidence.ts'
import { companyKey, norm } from './evidence.ts'
import type { Page } from './fetch-page.ts'
import { isJobPostingClaim } from './hold-fit.ts'

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

// #684: the hold reason must apply to the saved claim. A job posting is the employer's own statement wherever it is posted (a job
// board or ATS names itself all over the page: "Apply using DentalPost"), so a job-posting claim is never "someone else's customer".
// And the customer relationship must be stated about the lead's company: a customer word in a sentence that does not name the
// company ("Thousands of practices use DentalPost") says nothing about it.
export function counterpartySignal(c: Candidate & { signal_kind?: unknown; source_kind?: unknown }, page: Page, passage: string): string | null {
  if (isJobPostingClaim(c)) return null
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
  if (!window.includes(company)) return null
  // ...and one sentence must name the company together with the customer phrase.
  // The title is its own sentence. A text with no sentence ends at all reads as one sentence (as before #684).
  const sentences = passage ? splitSentences(passage) : [page.title ?? '', ...splitSentences(page.text.slice(0, 3000))]
  const tied = sentences.some(s => { const n = norm(s); return n.includes(company) && CUSTOMER_PHRASE.test(n) })
  return tied ? `source_owner:${brand}` : null
}
// A sentence ends at . ! ? followed by whitespace (so "linear.app" or "3.5" do not split), or at a line break. A period after a
// single letter or a common abbreviation ("Dr.", "Inc.", "U.S.") does not end one, so a company name is never cut in two.
const ABBREV = new Set(['dr', 'mr', 'mrs', 'ms', 'st', 'inc', 'co', 'corp', 'ltd', 'llc', 'jr', 'sr', 'no', 'vs', 'dds', 'dmd', 'pc', 'pllc', 'bros', 'ave', 'mt'])
export function splitSentences(text: string): string[] {
  const out: string[] = []
  let start = 0
  for (const m of text.matchAll(/[.!?]+(?=\s)|\n/g)) {
    const word = /([A-Za-z]+)$/.exec(text.slice(start, m.index))?.[1]
    if (m[0] === '.' && word && (word.length === 1 || ABBREV.has(word.toLowerCase()))) continue
    out.push(text.slice(start, m.index)); start = m.index + m[0].length
  }
  out.push(text.slice(start))
  return out
}
