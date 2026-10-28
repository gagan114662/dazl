import type { Candidate } from './evidence.ts'
import { companyKey, norm } from './evidence.ts'
import type { Page } from './fetch-page.ts'
import { isJobPage } from '../search/page-class.ts'

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

// Job boards and applicant-tracking hosts publish OTHER companies' postings: the host is never the "owner" of the lead's evidence, and a posting's everyday verbs ("joining our team",
// "using our booking system") are not a customer relationship. A receptionist posting on such a page was rejected as "somebody else's customer" for exactly that reason.
const JOB_BOARD_BRANDS = new Set(['indeed', 'glassdoor', 'ziprecruiter', 'monster', 'reed', 'totaljobs', 'cvlibrary', 'workable', 'lever', 'greenhouse', 'ashbyhq', 'smartrecruiters', 'jobvite', 'icims', 'bamboohr', 'recruitee', 'teamtailor', 'jooble', 'jobrapido', 'adzuna', 'simplyhired', 'careerbuilder', 'linkedin', 'workday', 'myworkdayjobs'])

export interface CounterpartyHit { code: string; passage: string }
// The exact passage of the page that triggered the signal (a verbatim slice around the brand mention, <= 250 chars), so the rejection can be shown with what caused it.
function exactPassage(raw: string, brand: string): string {
  const re = new RegExp(brand.split('').map(ch => ch.replace(/[^a-z0-9]/gi, '\\$&')).join('[^a-z0-9]{0,2}'), 'i')
  const m = re.exec(raw); const at = m ? m.index : 0
  const from = Math.max(0, at - 110), to = Math.min(raw.length, at + 140)
  return raw.slice(from, to).replace(/\s+/g, ' ').trim().slice(0, 250)
}
export function counterpartyEvidence(c: Candidate, page: Page, passage: string): CounterpartyHit | null {
  const brand = hostBrand(c.source_url)
  if (!brand) return null
  if (JOB_BOARD_BRANDS.has(brand) || isJobPage(c.source_url)) return null   // a posting is the lead's own hiring claim, not a customer announcement by the host
  const company = companyKey(c.company)
  if (!company || company.includes(brand) || brand.includes(company.split(' ')[0])) return null // source belongs to the lead itself
  const raw = passage || `${page.title} ${page.text.slice(0, 3000)}`
  const hay = norm(raw)
  if (!hay.includes(brand)) return null
  // The lead's company AND the customer-relationship phrase must both sit in the same 200-char window around the brand mention (before: the phrase could be anywhere on the page).
  const at = hay.indexOf(brand)
  const window = hay.slice(Math.max(0, at - 200), at + 200)
  if (!window.includes(company) || !CUSTOMER_PHRASE.test(window)) return null
  return { code: `source_owner:${brand}`, passage: exactPassage(passage || page.text.slice(0, 3000), brand) }   // sliced from the page text itself (not the title prefix): verbatim
}
export function counterpartySignal(c: Candidate, page: Page, passage: string): string | null {
  return counterpartyEvidence(c, page, passage)?.code ?? null
}
