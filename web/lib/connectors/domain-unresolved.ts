// #1122: why a lead has no company website. The crawl (lib/connectors/sitecrawl.ts) stores one row per unresolved lead: kind
// DOMAIN_UNRESOLVED_KIND, label = DOMAIN_UNRESOLVED_TOKEN + a reason code. The words live here, with no imports, so the lead card (a client
// component) and the server say the same thing.
export const DOMAIN_UNRESOLVED_KIND = 'domain_unresolved'
export const DOMAIN_UNRESOLVED_TOKEN = 'domain-unresolved-v1:'
const UNRESOLVED_WORDS: Record<string, string> = {
  no_site_linked: 'the source page links no company website and none could be built from the name',
  linked_site_not_confirmed: 'the website linked from the source page could not be confirmed as this company',
  name_guess_not_confirmed: 'no website built from the company name was confirmed as this company in this place',
  probe_limit_reached: 'this scan had used its website guesses before reaching this company',
  search_limit_reached: 'this scan had used its website searches before reaching this company',
  search_found_no_candidate: 'a web search for the company returned only listing and social pages',
  search_result_not_confirmed: 'no website from a web search was confirmed as this company in this place',
  time_budget: 'the website check ran out of time before a site could be read',
  site_not_readable: 'the likely website does not allow automated reading (its robots rules), so it was not read',
  site_not_read: 'the likely website could not be read',
}
export const domainUnresolvedWords = (code: string) => UNRESOLVED_WORDS[code] ?? (code.startsWith('search_') ? 'the web search for the company website could not run' : 'the company website could not be confirmed')
// The words for a stored label (token + code); a label without the token (never written) reads as the general sentence.
export const domainUnresolvedText = (label: string | null | undefined) => domainUnresolvedWords((label ?? '').startsWith(DOMAIN_UNRESOLVED_TOKEN) ? (label ?? '').slice(DOMAIN_UNRESOLVED_TOKEN.length) : '')
