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
// - a customer relationship must tie the lead's company to that brand ON THE PAGE: in the headline itself, in one sentence of the text,
//   or as a customer list beside the brand (vendorStory below). Merely being published on someone's site is not that: a news article
//   about a company is not its publisher's customer story (#878).
// The host brand is the first label of the hostname ("linear" in linear.app). This is
// a heuristic: www/acme's own subdomains are excluded; nothing about buyer intent is inferred.


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

// Is this page the brand's own story about the lead's company as its customer? (#878, matrix berlin-fintech and chicago-law, 2026-11-14.)
// The rule used to be: the brand is in the text, a customer word ("use", "joins", "is now" ...) is ANYWHERE in the first 3,000 characters,
// and the company is within 200 characters of the brand. Every news article passed it: the publisher's name sits beside the headline
// ("mika Raises EUR 6M in Seed Funding ... By FinSMEs") and "the company intends to use the funds" is in any funding story. Six real pages
// (FinSMEs twice, Lawdragon, startbase, fintech.garden, an investor's news page) were all held as their publisher's customer story.
// Now the relationship itself has to be written, in one of four ways:
//  1. the HEADLINE proper names both ("How Acme scaled support with Zendesk", "Customer story: Orbitly runs on AcmeCRM"). A site name after a
//     separator ("McGuireWoods Bolsters Insurance Recovery Practice | Lawdragon") is not part of the headline;
//  2. one sentence says the company uses the brand: the company, a use verb, then the brand at most three words later ("Brightloop uses
//     Zapier", "Acme switched to Shopify", "Acme cut onboarding time by 40% with Notion", "Acme is a Linear customer"). "mika uses AI to raise
//     EUR 6M ... FinSMEs" and "with participation from Activant and Heliad" are not that; neither is "joins" (a portfolio, a list, an office);
//  3. one sentence says the brand serves the company ("Intercom helps Acme ...", "Gong customer Acme ...", "Workday was chosen by Acme");
//  4. a customer LIST beside the brand names the company ("Linear grew fast. Salesforce and Figma, which both became customers").
// Sentences are cut on the original text (a legal suffix's or an initial's period does not end one), then compared in the normalised form.
const flat = (x: string) => norm(x)
const reEsc = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const edge = (x: string) => `(?<![\\p{L}\\p{N}])${reEsc(x)}(?![\\p{L}\\p{N}])`
const USE_VERB = 'use|uses|using|used|chose|chooses|chosen|picked|picks|selected|selects|switched to|switches to|moved to|moves to|migrated to|migrates to|runs on|run on|running on|adopted|adopts|adopting|standardi[sz]ed on|relies on|rely on|relied on|trusts|trusted|deployed|deploys|rolled out|rolls out|partnered with|partners with|powered by|built on|builds on|built with|with'
const SERVE_VERB = 'helps|helped|powers|powered|enables|enabled|supports|supported|customer|customers|client|clients|was chosen by|is chosen by|chosen by|was selected by|selected by|is trusted by|trusted by'
const sentencesOfPage = (t: string): string[] => t
  .replace(/\b(Inc|Ltd|Corp|Co|LLC|LLP|PLC|GmbH|U\.S|U\.K|St|Mr|Mrs|Ms|Dr|Jr|Sr|No|vs|e\.g|i\.e|approx)\.(?=\s|,|$)/g, (_m, w: string) => w.replace(/\./g, ''))
  .replace(/\b([A-Z])\.(?=\s+[A-Z])/g, '$1')
  .split(/(?<=[.!?])\s+|\n+/).map(flat).filter(Boolean)
function vendorStory(company: string, brand: string, title: string, text: string): boolean {
  const co = edge(company), br = edge(brand)
  const both = new RegExp(`${co}[^]*${br}|${br}[^]*${co}`, 'u')
  // 1. the headline proper: the parts of the title between separators; a part naming both is the story's own headline
  if (title.split(/\s+[|–—·-]\s+|:\s+/).map(flat).some(part => both.test(part))) return true
  // ... or the title labels itself a customer story and names both ("Acme | Customer story | Stripe")
  if (/(?<![\p{L}\p{N}])(?:customer stor(?:y|ies)|case stud(?:y|ies)|success stor(?:y|ies)|customer spotlight)(?![\p{L}\p{N}])/u.test(flat(title)) && both.test(flat(title))) return true
  const uses = new RegExp(`${co}[^]{0,80}?(?<![\\p{L}\\p{N}])(?:${USE_VERB})\\s+(?:[\\p{L}\\p{N}'-]+\\s+){0,3}?${br}|${co}[^]{0,40}?(?<![\\p{L}\\p{N}])(?:moved|moves|migrated|migrates|switched|switches|builds?|built|building|runs?|running|ships?|shipping|scaled|scales)\\s+(?:[\\p{L}\\p{N}'-]+\\s+){0,4}?(?:to|on|onto|with)\\s+(?:[\\p{L}\\p{N}'-]+\\s+){0,1}?${br}|${co}\\s+(?:is|are|was|became|becomes|is now|are now|has been|have been)\\s+(?:an?\\s+|the\\s+)?(?:[\\p{L}\\p{N}-]+\\s+){0,2}?${br}\\s+(?:[\\p{L}\\p{N}-]+\\s+)?(?:customers?|clients?|users?)(?![\\p{L}\\p{N}])`, 'u')
  const serves = new RegExp(`${br}\\s+(?:[\\p{L}\\p{N}'-]+\\s+){0,2}?(?:${SERVE_VERB})\\s+(?:[\\p{L}\\p{N}'-]+\\s+){0,3}?${co}`, 'u')
  const list = /(?<![\p{L}\p{N}])(?:became|becomes|becoming|is now|are now|joined as|as)\s+(?:an?\s+|[\p{L}\p{N}-]+\s+)?customers?(?![\p{L}\p{N}])(?!\s+(?:support|service|success|demand|experience|engagement|data|relationships?|facing|centric|acquisition|retention|satisfaction|journeys?|feedback|base|care|needs|growth|wins?|stories)\b)/u
  const sentences = sentencesOfPage(text)
  // 2. and 3. inside one sentence
  if (sentences.some(k => uses.test(k) || serves.test(k))) return true
  // 4. a customer list: the list sentence names the company, and the brand is in that sentence or the one before it
  const hasBrand = new RegExp(br, 'u'), hasCo = new RegExp(co, 'u')
  return sentences.some((k, i) => list.test(k) && hasCo.test(k) && (hasBrand.test(k) || (i > 0 && hasBrand.test(sentences[i - 1]))))
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
  return vendorStory(company, brand, passage ? '' : page.title, passage || page.text.slice(0, 3000)) ? `source_owner:${brand}` : null
}
