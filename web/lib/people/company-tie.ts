// #1037 (Hermes-PC review of PR #1164): a public profile search result names an employer, and a company NAME is not a company.
// On staging 5 of 9 stored people were at a different business with the same name ("Garage", "Nautilus", "Syncly"). So a
// search result is kept only when something beyond the name ties it to THIS lead's company:
//   domain   the result's own text names the lead's website (its confirmed domain);
//   source   the lead was found on an organisation's own page about the company (today: a Y Combinator company page), and the
//            result's text names that organisation ("YC W24", "Y Combinator");
//   place    the request names a place and the result's own text names that place (lib/scan/place-agreement.ts).
// Anything else is a name-only match: not stored. Pure (no data layer): the Leads page reads companyTied too.
export type CompanyTie = 'domain' | 'source' | 'place'
// Organisations whose page about a company is a real affiliation the person's profile line also states. A job board, a news
// site or a directory is NOT one: naming it says nothing about which business a person works for.
const AFFILIATIONS: { host: string; named: RegExp }[] = [{ host: 'ycombinator.com', named: /\bY\s?Combinator\b|\bYC\b/ }]
const hostOf = (u: string): string => { try { return new URL(u).hostname.toLowerCase().replace(/^www\./, '') } catch { return '' } }

export function companyTie(resultText: string, lead: { company_domain?: string | null; source_url?: string | null }, placeAgrees: boolean): CompanyTie | null {
  const text = typeof resultText === 'string' ? resultText.replace(/\bwww\./gi, '') : ''
  const domain = typeof lead.company_domain === 'string' ? lead.company_domain.toLowerCase().replace(/^www\./, '').trim() : ''
  // The domain as a whole token ("withgarage.com", not "notwithgarage.com" or "withgarage.community").
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(domain) && new RegExp(`(?<![a-z0-9.-])${domain.replace(/[.-]/g, '\\$&')}(?![a-z0-9-]|\\.[a-z0-9])`, 'i').test(text)) return 'domain'
  const host = typeof lead.source_url === 'string' ? hostOf(lead.source_url) : ''
  if (host && AFFILIATIONS.some(a => (host === a.host || host.endsWith(`.${a.host}`)) && a.named.test(text))) return 'source'
  return placeAgrees ? 'place' : null
}

// The label a stored search result carries. Only a label written by tiedLabel counts as tied: a row stored before this rule
// (the bare label) is a name-only match.
const TIE_TEXT: Record<CompanyTie, string> = { domain: 'the result names its website', source: 'the result names the organisation the lead was found through', place: 'the result names the requested place' }
const MARK = '; company confirmed beyond its name: '
export const tiedLabel = (base: string, tie: CompanyTie): string => `${base}${MARK}${TIE_TEXT[tie]}`
export const companyTied = (label: unknown): boolean => typeof label === 'string' && Object.values(TIE_TEXT).some(t => label.endsWith(`${MARK}${t}`))
export const NAME_ONLY_SOURCE = 'a public LinkedIn search result matched by the company name only - this may be a different business with the same name'
