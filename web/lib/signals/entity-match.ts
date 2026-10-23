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

export type EntityStatus = 'heuristic' | 'unconfirmed'

// Legal-form words that carry no identity. Stripped before comparison.
const CORP_SUFFIX = new Set(['inc', 'incorporated', 'corp', 'corporation', 'co', 'company', 'ltd', 'limited', 'llc', 'llp', 'lp', 'gmbh', 'sarl', 'bv', 'nv', 'plc', 'pty', 'sa', 'ag', 'holdings', 'holding', 'group'])

// Words that mark an investment vehicle rather than an operating company. A startup
// lead must never corroborate against a same-named fund's filings or news.
const FUND_MARKERS = new Set(['fund', 'funds', 'ventures', 'venture', 'capital', 'capitals', 'partners', 'partnership', 'gp', 'ii', 'iii', 'iv'])

export function nameTokens(name: string): string[] {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(' ').filter(t => t && !CORP_SUFFIX.has(t))
}

const hasFundMarker = (tokens: string[]): boolean => tokens.some(t => FUND_MARKERS.has(t))

// 'heuristic' only when the two names are token-identical after suffix stripping - a
// candidate match, NOT confirmed-entity proof. "Vesta" vs "Vesta Ventures Fund II, LP"
// -> unconfirmed; "Vesta" vs "Vesta, Inc." -> heuristic.
export function classifyEntityMatch(company: string, entity: string): EntityStatus {
  const c = nameTokens(company)
  const e = nameTokens(entity)
  if (!c.length || !e.length) return 'unconfirmed'
  if (hasFundMarker(e) && !hasFundMarker(c)) return 'unconfirmed'
  return c.length === e.length && c.every(t => e.includes(t)) ? 'heuristic' : 'unconfirmed'
}

// First domain label as the ATS board slug candidate - mirrors slugCandidates in
// lib/signals/index.ts. A board found under this slug is a domain-derived heuristic
// match (a slug is not proof of board ownership); a bare-name slug is unconfirmed.
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
  return urlSegments(boardUrl).includes(slug) ? 'heuristic' : 'unconfirmed'
}

// A filing/date corroborates a claimed round only when both dates sit inside the same
// window. This is a NEGATIVE filter only: inside the window is not proof of the same
// round, outside the window is proof it does not corroborate the claim. Undated claims
// stay heuristic for recency - a recent Form D is a filing, not a concluded round.
export function withinEventWindow(filingDate: string, eventDate: string | null, days = 45): boolean {
  if (!eventDate) return true
  const a = Date.parse(filingDate), b = Date.parse(eventDate)
  if (Number.isNaN(a) || Number.isNaN(b)) return false
  return Math.abs(a - b) <= days * 86400_000
}

const SEC_HOST = /(^|\.)sec\.gov$/
const BOARD_HOST = /ashbyhq\.com|greenhouse\.io|lever\.co/

const hostOf = (url: string): string => {
  try { return new URL(url).hostname.toLowerCase() } catch { return '' }
}

// Qualifies a stored company event against its lead: SEC filings by entity name (+ the
// claim date window), job-board events by slug provenance, anything else stays a
// heuristic (name-matched press cannot be re-verified, but is not a known collision).
export function qualifyEvent(
  company: string,
  domain: string | null,
  ev: { detail: string | null; source_url: string; source_published_at: string | null },
  claimDate: string | null = null,
): EntityStatus {
  const host = hostOf(ev.source_url)
  if (SEC_HOST.test(host)) {
    const base = classifyEntityMatch(company, ev.detail ?? '')
    if (base === 'heuristic' && claimDate && ev.source_published_at && !withinEventWindow(ev.source_published_at, claimDate)) return 'unconfirmed'
    return base
  }
  if (BOARD_HOST.test(host)) return classifyBoardMatch(domain, ev.source_url)
  return 'heuristic'
}
