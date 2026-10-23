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

const pathOf = (url: string): string => { try { return new URL(url).pathname.toLowerCase() } catch { return '' } }

// First-party is grounded ONLY in a source-of-truth domain for the company (today the
// CSV-import job's own domain). An exact host or a subdomain of that domain qualifies.
// Name resemblance never qualifies: notacme.com, acmefraud.com, acme-sucks.com and
// acme.com.evil-example.com are not the company's domain, however close they look.
// Without a known domain the company's own pages classify like any other third party -
// conservative by design: the cap they lose is a label, not evidence.
export function classifySource(url: string, company: string, knownDomain?: string | null): SourceClass {
  void company // retained for call-site compatibility; identity comes from knownDomain only
  const h = host(url)
  if (!h) return 'unknown'
  const d = (knownDomain ?? '').toLowerCase().replace(/^www\./, '').trim()
  if (d.length >= 4 && (h === d || h.endsWith('.' + d))) return 'first_party'
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
export function sourceCap(url: string, company: string, knownDomain?: string | null): number {
  return SOURCE_CAP[classifySource(url, company, knownDomain)]
}
