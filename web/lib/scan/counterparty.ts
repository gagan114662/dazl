import type { Candidate } from './evidence.ts'
import { companyKey, norm } from './evidence.ts'
import type { Page } from './fetch-page.ts'
import { isJobPostingClaim } from './hold-fit.ts'
import { atsPostingRef } from '../sources/ats-posting.ts'

// Subject mismatch: the lead is named Company A, but the source is Company B's own
// marketing page and the evidence is B celebrating A as its customer. That is a fact
// about B, not evidence of A's buying intent. Route to review; never drop silently
// and never call it A's signal. Narrow and deterministic:
// - source host's brand token must differ from the lead's company,
// - the brand token must appear in the verified passage,
// - a customer relationship must tie the lead's company to that brand: on a page the brand files under its customers (/customers/,
//   /case-studies/ ...) the proximity rule below; on any other page the relationship has to be WRITTEN (writtenRelationship). Merely being
//   published on someone's site is not that: a news article about a company is not its publisher's customer story (#878).
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

// #878 (matrix berlin-fintech and chicago-law, 2026-11-14). The proximity rule (the brand in the text, a customer word ANYWHERE in the first
// 3,000 characters, the company within 200 characters of the brand) is true of every news article: the publisher's name sits beside the
// headline ("mika Raises EUR 6M in Seed Funding ... By FinSMEs") and "the company intends to use the funds" is in any funding story. Six real
// pages (FinSMEs twice, Lawdragon, startbase, fintech.garden, an investor's news page) were all held as their publisher's customer story.
// So the proximity rule now applies only where the source itself files the page under its customers (CUSTOMER_PATH: the URL path). On every
// other page the relationship must be written, in one of four ways:
//  1. the HEADLINE proper says it ("How Acme scaled support with Zendesk", "Customer story: Orbitly runs on AcmeCRM", "Why Acme moved to
//     Vercel"). A site name after a separator ("McGuireWoods Bolsters Insurance Recovery Practice | Lawdragon") is not part of the headline,
//     and a headline that merely names both ("Earlybird leads Kontist Series B", "Acme joins the Sifted 100 list") says no such thing;
//  2. one sentence says the company uses the brand: the company, a use verb, then the brand at most three words later ("Brightloop uses
//     Zapier", "Acme switched to Shopify", "Acme moved its payments to Stripe", "Acme is a Linear customer"). Not "mika uses AI to raise
//     EUR 6M ... FinSMEs", not "an interview with TechCrunch" or "with participation from Heliad", not "joins" (a portfolio, a list);
//  3. one sentence says the brand serves the company ("Intercom helps Acme ...", "Gong customer Acme ...", "Workday was chosen by Acme");
//  4. a customer LIST beside the brand names the company ("Linear grew fast. Salesforce and Figma, which both became customers").
// Sentences are cut on the original text (a legal suffix's or an initial's period does not end one; a passage already lower-cased by the
// verifier is handled the same), then compared in the normalised form.
// What this gives up, knowingly: a vendor's story that is NOT under a customer path and words the relationship some other way ("With Notion,
// Northwind replaced six tools") is no longer held. What it keeps from main, knowingly: a brand that is a common word ("ramp up hiring" on
// ramp.com) is not told apart from the brand.
const CUSTOMER_PATH = /(?:^|\/)(?:customers?|clients?|customer-stor(?:y|ies)|customer-success|case-stud(?:y|ies)|success-stor(?:y|ies)|testimonials?)(?:\/|$)/i
const pathOf = (url: string): string => { try { return new URL(url).pathname } catch { return '' } }
const reEsc = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const edge = (x: string) => `(?<![\\p{L}\\p{N}])${reEsc(x)}(?![\\p{L}\\p{N}])`
const WORDS = (max: number) => `(?:[\\p{L}\\p{N}'-]+\\s+){0,${max}}?`
const USE_VERB = 'use|uses|using|used|chose|chooses|chosen|picked|picks|selected|selects|switched to|switches to|moved to|moves to|migrated to|migrates to|runs on|run on|running on|adopted|adopts|adopting|standardi[sz]ed on|standardi[sz]es on|relies on|rely on|relied on|trusts|trusted|deployed|deploys|implemented|implements|rolled out|rolls out|partnered with|partners with|powered by|built on|builds on|built with|turned to|turns to|went live on'
// a verb, a few words, then "to / on / onto / with <brand>": "moved its global payments to Stripe", "builds faster on Atlassian", "scaled support with Zendesk"
const MOVE_VERB = 'moved|moves|migrated|migrates|switched|switches|builds?|built|building|runs?|running|ships?|shipping|scaled|scales|automated|automates|cut|cuts|saved|saves|reduced|reduces|replaced|replaces|manages|managed|modernized|modernizes'
const SERVE_VERB = 'helps|helped|powers|powered|enables|enabled|supports|supported|gave|gives|was chosen by|is chosen by|chosen by|was selected by|selected by|is trusted by|trusted by'
const sentencesOfPage = (t: string): string[] => t
  .replace(/\b(inc|ltd|corp|co|llc|llp|plc|gmbh|u\.s|u\.k|st|mr|mrs|ms|dr|jr|sr|no|vs|e\.g|i\.e|approx)\.(?=\s|,|$)/gi, (_m, w: string) => w.replace(/\./g, ''))
  .replace(/\b([A-Z])\.(?=\s+[A-Z])/g, '$1')
  .split(/(?<=[.!?])\s+|\n+/).map(norm).filter(Boolean)
function writtenRelationship(company: string, brand: string, title: string, text: string): boolean {
  const co = edge(company), br = edge(brand)
  const uses = new RegExp(`${co}[^]{0,80}?(?<![\\p{L}\\p{N}])(?:${USE_VERB})\\s+${WORDS(3)}${br}`
    + `|${co}[^]{0,40}?(?<![\\p{L}\\p{N}])(?:${MOVE_VERB})\\s+${WORDS(5)}(?:to|on|onto|with)\\s+${WORDS(1)}${br}`
    + `|${co}\\s+(?:is|are|was|became|becomes|is now|are now|has been|have been)\\s+(?:an?\\s+|the\\s+)?${WORDS(2)}${br}\\s+${WORDS(1)}(?:customers?|clients?|users?)(?![\\p{L}\\p{N}])`, 'u')
  const serves = new RegExp(`${br}\\s+${WORDS(2)}(?:${SERVE_VERB})\\s+${WORDS(3)}${co}|${br}\\s+(?:customers?|clients?)\\s+${WORDS(1)}${co}`, 'u')
  const list = /(?<![\p{L}\p{N}])(?:became|becomes|becoming|is now|are now|joined as|as)\s+(?:an?\s+|[\p{L}\p{N}-]+\s+)?customers?(?![\p{L}\p{N}])(?!\s+(?:support|service|success|demand|experience|engagement|data|relationships?|facing|centric|acquisition|retention|satisfaction|journeys?|feedback|base|care|needs|growth|wins?|stories)\b)/u
  // 1. the headline proper: a part of the title (between separators) that says the relationship itself
  if (title.split(/\s+[|–—·-]\s+|:\s+/).map(norm).some(part => uses.test(part) || serves.test(part))) return true
  const sentences = sentencesOfPage(text)
  // 2. and 3. inside one sentence
  if (sentences.some(k => uses.test(k) || serves.test(k))) return true
  // 4. a customer list: the list sentence names the company, and the brand is in that sentence or the one before it
  const hasBrand = new RegExp(br, 'u'), hasCo = new RegExp(co, 'u')
  return sentences.some((k, i) => list.test(k) && hasCo.test(k) && (hasBrand.test(k) || (i > 0 && hasBrand.test(sentences[i - 1]))))
}

const ATS_ORG_SUFFIX = new Set(['hq', 'inc', 'labs', 'io', 'app', 'team', 'careers', 'jobs'])
// #684: the hold reason must apply to the saved claim. On a job BOARD the host brand is the board itself, which names itself all over
// the page ("Apply using DentalPost", "practices use DentalPost"), so a job-posting claim there is never "someone else's customer". On
// a public ATS posting the brand is the employer's own org, so another company named there is still a counterparty (#767) - not exempt.
export function counterpartySignal(c: Candidate & { signal_kind?: unknown; source_kind?: unknown }, page: Page, passage: string): string | null {
  const src = sourceBrand(c.source_url)
  if (!src) return null
  if (!src.ats && isJobPostingClaim(c)) return null
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
  if (CUSTOMER_PATH.test(pathOf(c.source_url))) {
    // The brand's own customer pages: the rule as it always was (the brand in the text, a customer word, the company beside the brand).
    const hay = norm(passage || `${page.title} ${page.text.slice(0, 3000)}`)
    if (!hay.includes(brand)) return null
    if (!CUSTOMER_PHRASE.test(hay)) return null
    // The lead's company must appear near the brand mention (same 200-char window).
    const at = hay.indexOf(brand)
    const window = hay.slice(Math.max(0, at - 200), at + 200)
    return window.includes(company) ? `source_owner:${brand}` : null
  }
  return writtenRelationship(company, brand, passage ? '' : page.title, passage || page.text.slice(0, 3000)) ? `source_owner:${brand}` : null
}
