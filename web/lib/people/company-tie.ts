// #1037 (Hermes-PC review of PR #1164): a public profile search result names an employer, and a company NAME is not a company.
// On staging 5 of 9 stored people were at a different business with the same name ("Garage", "Nautilus", "Syncly"). So a
// search result is kept only when something beyond the name ties it to THIS lead's company, and there is exactly ONE such tie:
//   domain   the result's own text names the lead's CONFIRMED website (the caller passes a domain only when
//            lib/signals/domain-basis.ts domainConfirmed holds; a guessed domain may be the other business's), as a whole token.
// Hermes decision (2026-11-13, on #1164): the earlier free-text ties (a Y Combinator batch after the company's name; the requested
// city) were dropped. Three council rounds kept finding wordings that leaked a same-name business through them ("London, Ontario"
// read as London UK, "Web3 Garage (YC W24)", "Nautilus and Garage (YC S20)"), and a wrong name is worse than no name. dazl names
// FEWER people here on purpose; the grounded lookup of #1102 is the path to naming more.
// Anything else is a name-only match: not stored. Pure (no data layer).
export type CompanyTie = 'domain'
export interface TieLead { company: string; confirmed_domain?: string | null }
const esc = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

export function companyTie(resultText: string, lead: TieLead): CompanyTie | null {
  const text = typeof resultText === 'string' ? resultText.replace(/\bwww\./gi, '') : ''
  const domain = typeof lead.confirmed_domain === 'string' ? lead.confirmed_domain.toLowerCase().replace(/^www\./, '').trim() : ''
  // The domain as a whole token ("withgarage.com", not "notwithgarage.com" or "withgarage.community").
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(domain) && new RegExp(`(?<![a-z0-9.-])${esc(domain)}(?![a-z0-9-]|\\.[a-z0-9])`, 'i').test(text)) return 'domain'
  return null
}

// The label a stored search result carries. Only a label written by tiedLabel counts as tied: a row stored before this rule
// (the bare label) is a name-only match. lib/people/rank.ts reads it (nameOnly) for every surface that lists or picks a person.
const TIE_TEXT: Record<CompanyTie, string> = { domain: 'the result names its website' }
const MARK = '; company confirmed beyond its name: '
export const tiedLabel = (base: string, tie: CompanyTie): string => `${base}${MARK}${TIE_TEXT[tie]}`
export const companyTied = (label: unknown): boolean => typeof label === 'string' && Object.values(TIE_TEXT).some(t => label.endsWith(`${MARK}${t}`))
export const NAME_ONLY_SOURCE = 'a public LinkedIn search result matched by the company name only - this may be a different business with the same name'
// What a row says when a search found people but none could be tied to this lead's company (the reason, not a guess).
export const NAME_ONLY_REASON = 'No buyer named: a search found people at a company with this name, but nothing confirms it is this company, so none is shown'
