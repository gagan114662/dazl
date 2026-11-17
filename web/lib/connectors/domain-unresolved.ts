// #1122: why a lead has no company website. The crawl (lib/connectors/sitecrawl.ts) stores one row per unresolved lead: kind
// DOMAIN_UNRESOLVED_KIND, label = DOMAIN_UNRESOLVED_TOKEN + a reason code. The words live here, with no imports, so the lead card (a client
// component) and the server say the same thing. Each sentence says only what the crawl knows happened (review at 01140156: a reason that
// claimed "the search returned only listing pages" was shown when every hit was the company's own, already-refused site).
export const DOMAIN_UNRESOLVED_KIND = 'domain_unresolved'
export const DOMAIN_UNRESOLVED_TOKEN = 'domain-unresolved-v1:'
const UNRESOLVED_WORDS: Record<string, string> = {
  no_site_linked: 'the source page links no company website and none could be built from the company name',
  linked_site_not_confirmed: 'the website linked from the source page could not be confirmed as this company',
  not_confirmed: 'no website found for the company name was confirmed as this company in this place',
  own_site_refused_reading: 'the company\'s own website did not allow automated reading',
  own_site_needs_javascript: 'the company\'s own website can only be read with JavaScript, which this check does not run',
  probe_limit_reached: 'this scan checks the websites of its top leads only and did not reach this company',
  time_budget: 'the website check ran out of time before a site could be read',
  site_not_readable: 'a website that may be the company\'s does not allow automated reading (its robots rules), so it could not be checked',
  site_not_read: 'a website that may be the company\'s could not be read',
  not_checked: 'the website check does not run for a lead held for this reason',
}
export const domainUnresolvedWords = (code: string) => (Object.hasOwn(UNRESOLVED_WORDS, code) ? UNRESOLVED_WORDS[code] : 'the company website could not be confirmed')   // own keys only: 'constructor' is unknown, not Object's constructor
// The words for a stored label (token + code); a label without the token (never written) reads as the general sentence.
export const domainUnresolvedText = (label: string | null | undefined) => domainUnresolvedWords((label ?? '').startsWith(DOMAIN_UNRESOLVED_TOKEN) ? (label ?? '').slice(DOMAIN_UNRESOLVED_TOKEN.length) : '')
