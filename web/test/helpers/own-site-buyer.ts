// #1037 test helper: the enrichment rows the REAL company-site crawl stores when a lead's own website confirms the company and lists its buyer
// with a title and the LinkedIn profile the company page links (captured from crawlJob in test/helpers/ready-buyer-1037-runtime.mts, the
// 'linked' case). Unit fixtures that test OTHER gates add these so the lead names its buyer, as lib/journey.ts heldReason now requires.
// Test-only data: an invented .example site and person.
export interface BuyerRow { connector: string; kind: string; value: string; label: string; source_url: string; confidence: null; source_date: string; retrieved_at: number }
export function ownSiteBuyerRows(host: string, o: { name?: string; title?: string; linkedin?: string; at?: number } = {}): BuyerRow[] {
  const at = o.at ?? Math.floor(Date.now() / 1000), origin = 'https://' + host
  const name = o.name ?? 'Dana Reyes', title = o.title ?? 'Head of Sales', slug = name.toLowerCase().replace(/[^a-z]+/g, '-')
  const linkedin = o.linkedin ?? `https://www.linkedin.com/in/${slug}-example`
  const day = new Date(at * 1000).toISOString().slice(0, 10)   // the day the crawl read the page
  const row = (kind: string, value: string, label: string, source_url: string): BuyerRow => ({ connector: 'sitecrawl', kind, value, label, source_url, confidence: null, source_date: day, retrieved_at: at })
  return [
    row('domain', `${host}|evidence_own_domain`, 'domain-basis-v1:evidence_own_domain', `${origin}/careers/account-executive`),
    row('domain_check', `${host}|identity_checked`, 'identity-check-v2: homepage names the company and the place or address agrees', `${origin}/`),
    row('person', `${name}, ${title}`, `sitecrawl-profile-v1: ${linkedin}`, `${origin}/team/${slug}`),
  ]
}
