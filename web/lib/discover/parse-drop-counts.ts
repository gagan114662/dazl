export interface ParseDropCounts {
  raw: number
  accepted: number
  missing_company: number
  missing_signal: number
  invalid_source: number
  duplicate: number
}

export function parseDropCounts(raw: number): ParseDropCounts {
  return { raw, accepted: 0, missing_company: 0, missing_signal: 0, invalid_source: 0, duplicate: 0 }
}

export function missingParserField(company: string, signal: string) {
  if (!company) return 'missing_company'
  if (!signal) return 'missing_signal'
  return 'invalid_source'
}

export function combineParseDropCounts(first: ParseDropCounts | undefined, second: ParseDropCounts | undefined): ParseDropCounts | undefined {
  if (!first || !second) return first ?? second
  return {
    raw: first.raw + second.raw,
    accepted: first.accepted + second.accepted,
    missing_company: first.missing_company + second.missing_company,
    missing_signal: first.missing_signal + second.missing_signal,
    invalid_source: first.invalid_source + second.invalid_source,
    duplicate: first.duplicate + second.duplicate,
  }
}
