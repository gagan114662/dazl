// Source quality: a verified quote's confidence is capped by how close the citing page is to
// the company itself. The verifier proves the quote is on the page; this says how much that
// page is worth. A content farm that copy-pastes a funding announcement is not the company's
// own blog, and a jobs board is not a reason to buy.
export type SourceClass = 'first_party' | 'editorial' | 'aggregator' | 'unknown'

// Real editorial control: trade press, established news, community posts written by the company.
const EDITORIAL = [
  'techcrunch.com', 'siliconangle.com', 'techcabal.com', 'venturebeat.com', 'theverge.com',
  'forbes.com', 'bloomberg.com', 'reuters.com', 'ft.com', 'wsj.com', 'wired.com', 'businessinsider.com',
  'news.ycombinator.com', // Who-is-hiring/YC threads are written by the companies themselves
  'globenewswire.com', 'prnewswire.com', 'businesswire.com', // company-authored press releases
]
// Directories, jobs boards, funding roundups, SEO content farms. Quotes there are usually copied
// from elsewhere and carry no independent confirmation.
const AGGREGATOR = [
  'purpose.jobs', 'nocode.mba', 'vcbacked.co', 'af.net', 'newmarketpitch.com', 'dxbstart.com',
  'manilatimes.net', 'wellfound.com', 'crunchbase.com', 'pitchbook.com', 'tracxn.com',
]

const host = (url: string): string => { try { return new URL(url).hostname.replace(/^www\./, '').toLowerCase() } catch { return '' } }
const SUFFIXES = new Set(['inc', 'incorporated', 'ltd', 'limited', 'llc', 'corp', 'corporation', 'co', 'company', 'the', 'plc', 'llp', 'lp'])
const companySlug = (company: string): string =>
  company.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(' ').filter(w => w && !SUFFIXES.has(w)).join('')

const pathOf = (url: string): string => { try { return new URL(url).pathname.toLowerCase() } catch { return '' } }

export function classifySource(url: string, company: string): SourceClass {
  const h = host(url)
  if (!h) return 'unknown'
  const slug = companySlug(company)
  // The company's own site: its name (minus spaces/punct) appears in the hostname.
  if (slug.length >= 3 && h.replace(/[^a-z0-9]+/g, '').includes(slug)) return 'first_party'
  if (AGGREGATOR.some(d => h === d || h.endsWith('.' + d))) return 'aggregator'
  if (EDITORIAL.some(d => h === d || h.endsWith('.' + d))) return 'editorial'
  if (h.includes('jobs')) return 'aggregator'
  // Jobs boards, careers listings and directories on otherwise neutral domains.
  if (/(^|\/)(jobs|careers|directory|industries)(\/|$)/.test(pathOf(url))) return 'aggregator'
  return 'unknown'
}

// The cap applied to a lead's confidence. First-party keeps the full score; editorial and
// company-authored releases cap at 90; unknown third parties at 75; aggregators and content
// farms at 60 - visible, but never mistaken for strong evidence.
export const SOURCE_CAP: Record<SourceClass, number> = { first_party: 100, editorial: 90, unknown: 75, aggregator: 60 }
export function sourceCap(url: string, company: string): number {
  return SOURCE_CAP[classifySource(url, company)]
}
