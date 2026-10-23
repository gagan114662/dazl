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

// Common two-part public suffixes. A naive last-two-labels registrable guess treats
// acme.co.uk as sld 'co', so the usual second-level country suffixes are listed here.
const TWO_PART_SUFFIX = new Set(['co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'com.au', 'net.au', 'org.au', 'co.in', 'firm.in', 'com.br', 'com.mx', 'co.nz', 'co.jp', 'ne.jp', 'or.jp', 'co.kr', 'com.sg', 'com.hk', 'co.za', 'com.cn', 'com.tw', 'co.il', 'com.tr', 'com.ar', 'com.co', 'com.ph', 'com.vn', 'co.id', 'com.my', 'com.pk', 'com.ng', 'com.eg', 'com.sa', 'com.ae'])
// The registrable second-level name: the single label directly left of the public suffix.
// careers.acme.com -> acme; blog.acme.co.uk -> acme; acme.com.evil-example.com -> evil-example.
const registrableSld = (h: string): string => {
  const labels = h.split('.').filter(Boolean)
  const suffixLen = labels.length >= 3 && TWO_PART_SUFFIX.has(labels.slice(-2).join('.')) ? 2 : 1
  return labels.length > suffixLen ? labels[labels.length - suffixLen - 1] : ''
}

export function classifySource(url: string, company: string): SourceClass {
  const h = host(url)
  if (!h) return 'unknown'
  const slug = companySlug(company)
  // The company's own site: the REGISTRABLE domain name is its name (minus spaces/punct).
  // A whole-host substring match is spoofable - notacme.com and acme.com.evil-example.com
  // both contain the slug without being the company's domain - so the match is anchored
  // to the registrable name, equal or slug-prefixed (acmeinc.com for "Acme Inc").
  // Residual: a lookalike registrable that still starts with the slug (acme-careers.io)
  // cannot be ruled out by host shape alone and is accepted.
  const sld = registrableSld(h).replace(/[^a-z0-9]+/g, '')
  if (slug.length >= 3 && sld.length >= 3 && (sld === slug || sld.startsWith(slug))) return 'first_party'
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
