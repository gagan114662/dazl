import { discoverContact, discoverSite, emailOnCompanySite } from '../../../lib/discover/card.ts'
import { peopleSearchable } from '../../../lib/people/searchable-holds.ts'
import { domainBasisFor, publishedContact, type PublishedEmailLead } from '../../../lib/outreach/published-email.ts'

function webUrl(raw: string | null | undefined): URL | null {
  if (!raw) return null
  try {
    const url = new URL(raw)
    return (url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password ? url : null
  } catch {
    return null
  }
}

export function FieldSource({ field, source, testId }: { field: string; source?: string | null; testId?: string }) {
  const url = webUrl(source)
  return url
    ? <a className="underline underline-offset-2" href={url.href} target="_blank" rel="noopener noreferrer nofollow" data-testid={testId}>{field} source</a>
    : <span>{field} source unavailable</span>
}

type DisplayEmail = { address: string; source_url: string; display_only: true }
type WebsiteLead = Pick<PublishedEmailLead, 'enrichments'> & {
  company_domain: string | null
  company_first_published_email?: DisplayEmail | null
}

export function WebsiteProvenance({ lead }: { lead: WebsiteLead }) {
  const domain = discoverSite(lead.company_domain)
  if (!domain) return <span className="text-[var(--ink-2)]">Company website unavailable</span>

  const basis = domainBasisFor(`website@${domain}`, lead.enrichments)
  const page = webUrl(basis.url)
  const pageHost = discoverSite(page?.hostname)
  const sameSite = pageHost === domain || pageHost?.endsWith(`.${domain}`)
  const stored = lead.enrichments?.find(row =>
    row.connector === 'discover' && row.kind === 'domain' && discoverSite(row.value) === domain)
  // Legacy crawl rows can cite a page on the saved site without an ownership classification.
  const basisSource = basis.domain === domain
    && (sameSite || basis.kind === 'linked' || basis.kind === 'link_text_only') ? page?.href : null

  // Discovery rows can have a saved contact page without a crawler domain-basis row.
  // Only a recorded page on the displayed site can support that website.
  const contactPages = [
    lead.company_first_published_email?.source_url,
    ...(lead.enrichments ?? []).filter(row =>
      row.connector === 'discover' && (row.kind === 'person' || row.kind === 'email')).map(row => row.source_url),
  ]
  const contactSource = contactPages.map(webUrl).find(url => {
    const host = url && discoverSite(url.hostname)
    return host === domain || host?.endsWith(`.${domain}`)
  })

  return <span className="inline-flex flex-wrap items-center gap-x-2 text-[var(--ink-2)]">
    <a className="pill pill-plain hover:border-[var(--ink-3)] min-h-11" href={`https://${domain}`} target="_blank" rel="noopener noreferrer nofollow" data-testid="lead-website">Website: {domain}</a>
    <FieldSource field="Website" source={webUrl(stored?.source_url)?.href ?? basisSource ?? contactSource?.href} />
  </span>
}

type EmailLead = PublishedEmailLead & {
  company_domain: string | null
  name?: string | null
  source_kind?: string | null
  company_first_published_email?: DisplayEmail | null
}

function emailEvidence(lead: EmailLead): { address: string; source: string | null | undefined } | null {
  const published = lead.company_first_published_email
  if (published?.display_only === true) return { address: published.address, source: published.source_url }

  if (lead.source_kind === 'discover') {
    const email = discoverContact(lead)?.email
    return email && emailOnCompanySite(email.address, email.source, lead.company_domain) ? email : null
  }

  const contact = publishedContact(lead)
  if (!contact || contact.purpose === 'non-sales') return null
  const matchingRows = (lead.enrichments ?? []).filter(row =>
    row.connector === 'sitecrawl' && row.kind === 'email' && row.value.trim().toLowerCase() === contact.email)
  const crawl = matchingRows.reduce<(typeof matchingRows)[number] | undefined>((latest, row) =>
    !latest || (row.retrieved_at ?? 0) > (latest.retrieved_at ?? 0) ? row : latest, undefined)
  if (crawl) return { address: contact.email, source: crawl.source_url }

  const context = lead.contact_context
  const citesAddress = (excerpt?: string | null) => {
    const addresses = excerpt?.match(/(?<![a-z0-9._%+@-])[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}(?![a-z0-9_@-]|\.[a-z0-9-])/gi)
    return addresses?.some(address => address.toLowerCase() === contact.email)
  }
  const contactSource = context && citesAddress(context.excerpt) ? webUrl(context.source_url)?.href : null
  const signalSource = citesAddress(lead.evidence_excerpt) ? lead.source_url : null
  return { address: contact.email, source: contactSource ?? signalSource }
}

function EmailProvenance({ email, displayOnly }: { email: NonNullable<ReturnType<typeof emailEvidence>>; displayOnly: boolean }) {
  return <div className="text-xs text-[var(--ink-2)] break-words" data-testid={displayOnly ? 'company-first-published-email' : 'published-work-email'}>
    Published work email{displayOnly ? ' (display only)' : ''}: {email.address}{' '}
    <FieldSource field="Email" source={email.source} />
  </div>
}

export function PublishedEmailProvenance({ lead }: { lead: EmailLead }) {
  const email = emailEvidence(lead)
  if (!email) return <div className="text-xs text-[var(--ink-2)]">Published work email unavailable</div>
  return <EmailProvenance email={email} displayOnly={lead.company_first_published_email?.display_only === true} />
}

export function ResearchPublishedEmail({ lead }: { lead: EmailLead & { review_reason?: string | null } }) {
  if (lead.company_first_published_email?.display_only !== true && !peopleSearchable(lead.review_reason)) return null
  const email = emailEvidence(lead)
  if (!email || !webUrl(email.source)) return null
  return <EmailProvenance email={email} displayOnly />
}
