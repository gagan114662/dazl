// Candidate suffixes only. A suffix is never evidence that a business or event is in a country.
// ISO alpha-2 keys: https://www.iso.org/iso-3166-country-codes.html
// Top-level delegations: https://www.iana.org/domains/root/db
// Compound public boundaries: https://publicsuffix.org/list/ (validated against bundled tldts in tests).
// This is a conservative hint list, not a list of permitted registration namespaces or supported markets.
const COUNTRY_SUFFIXES: Readonly<Record<string, readonly string[]>> = {
  AE: ['ae'], AT: ['at'], AU: ['com.au'], BE: ['be'], BR: ['com.br'], CA: ['ca'],
  CH: ['ch'], CZ: ['cz'], DE: ['de'], DK: ['dk'], ES: ['es'], FI: ['fi'],
  FR: ['fr'], GB: ['co.uk', 'uk'], ID: ['co.id'], IE: ['ie'], IN: ['in', 'co.in'],
  IT: ['it'], JP: ['co.jp'], KR: ['co.kr'], MX: ['com.mx'], MY: ['com.my'], NL: ['nl'],
  NO: ['no'], NZ: ['co.nz'], PH: ['com.ph'], PL: ['pl'], PT: ['pt'], SE: ['se'],
  SG: ['com.sg'], VN: ['com.vn'], ZA: ['co.za'],
}

export const MAX_COUNTRY_DOMAIN_HINTS = 2
export const GENERIC_DOMAIN_HINTS = Object.freeze(['com', 'ai', 'io', 'co'] as const)

// Feed only structured country codes from reviewed scope or a uniquely resolved place; never pass prose,
// arbitrary host labels or a TLD into this function. Null means no evidence. Conflicts, including a second
// unsupported code, yield no localized hint. No request-facing fallback should guess a country.
export function countryDomainHints(codes: readonly unknown[] = []): string[] {
  let agreed: string | null = null
  for (const raw of codes) {
    if (raw == null) continue
    if (typeof raw !== 'string' || !/^[a-z]{2}$/i.test(raw.trim())) return []
    const code = raw.trim().toUpperCase()
    if (agreed !== null && agreed !== code) return []
    agreed = code
  }
  if (agreed === null || !Object.hasOwn(COUNTRY_SUFFIXES, agreed)) return []
  return COUNTRY_SUFFIXES[agreed].slice(0, MAX_COUNTRY_DOMAIN_HINTS)
}

export function candidateDomainSuffixes(codes: readonly unknown[] = []): string[] {
  const [first, ...fallback] = GENERIC_DOMAIN_HINTS
  return [...new Set([first, ...countryDomainHints(codes), ...fallback])]
}
