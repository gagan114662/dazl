// Entity confirmation for third-party signal enrichments.
//
// Signal connectors (SEC EDGAR, public job boards, funding press) match leads by
// company NAME, and the search indexes behind them match loosely. A one-token name
// like "Vesta" then collides with any entity containing that token - a VC fund's
// Form D, another company's job board - and the enrichment presents as corroboration
// of the lead. These helpers decide conservatively whether an entity actually IS the
// lead's company: exact token match after corporate-suffix stripping counts as
// confirmed, anything looser is unconfirmed. False negatives are acceptable; a wrong
// corroboration is not.

export type EntityStatus = 'confirmed' | 'unconfirmed'

// Legal-form words that carry no identity. Stripped before comparison.
const CORP_SUFFIX = new Set(['inc', 'incorporated', 'corp', 'corporation', 'co', 'company', 'ltd', 'limited', 'llc', 'llp', 'lp', 'gmbh', 'sarl', 'bv', 'nv', 'plc', 'pty', 'sa', 'ag', 'holdings', 'holding', 'group'])

// Words that mark an investment vehicle rather than an operating company. A startup
// lead must never corroborate against a same-named fund's filings or news.
const FUND_MARKERS = new Set(['fund', 'funds', 'ventures', 'venture', 'capital', 'capitals', 'partners', 'partnership', 'gp', 'ii', 'iii', 'iv'])

export function nameTokens(name: string): string[] {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(' ').filter(t => t && !CORP_SUFFIX.has(t))
}

const hasFundMarker = (tokens: string[]): boolean => tokens.some(t => FUND_MARKERS.has(t))

// Confirmed only when the two names are token-identical after suffix stripping.
// "Vesta" vs "Vesta Ventures Fund II, LP" -> unconfirmed; "Vesta" vs "Vesta, Inc." -> confirmed.
export function classifyEntityMatch(company: string, entity: string): EntityStatus {
  const c = nameTokens(company)
  const e = nameTokens(entity)
  if (!c.length || !e.length) return 'unconfirmed'
  if (hasFundMarker(e) && !hasFundMarker(c)) return 'unconfirmed'
  return c.length === e.length && c.every(t => e.includes(t)) ? 'confirmed' : 'unconfirmed'
}

// First domain label as the ATS board slug candidate - mirrors slugCandidates in
// lib/signals/index.ts. A board found under this slug is entity-confirmed by the
// company's own domain; a board found under the bare name is not.
export function domainSlug(domain: string | null | undefined): string | null {
  const s = (domain ?? '').toLowerCase().split('.')[0]?.replace(/[^a-z0-9]/g, '') ?? ''
  return s.length >= 3 ? s : null
}

const STATIC_SEGMENTS = new Set(['v0', 'v1', 'boards', 'jobs', 'postings', 'job-board'])

export function urlSegments(url: string): string[] {
  try {
    return new URL(url).pathname.split('/').map(s => s.toLowerCase().replace(/[^a-z0-9]/g, '')).filter(s => s && !STATIC_SEGMENTS.has(s))
  } catch { return [] }
}

// A board link corroborates the company only when its slug came from the company's
// domain. Name-derived slugs (or unparseable URLs) stay unconfirmed.
export function classifyBoardMatch(domain: string | null | undefined, boardUrl: string): EntityStatus {
  const slug = domainSlug(domain)
  if (!slug) return 'unconfirmed'
  return urlSegments(boardUrl).includes(slug) ? 'confirmed' : 'unconfirmed'
}
