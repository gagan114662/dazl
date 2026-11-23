'use client'
// The contact part of a lead's Details: the contact line, the website check, the contact-search note, and Details' own draft button.
// In its own file so that what a person reads there can be rendered, in a test, from a real lead-list row (third review of #1578: the
// page's side of the fix was pinned by one declaration line, and a page that printed the crawled address again passed every test).
// Markup moved from the Leads page unchanged; the page passes in its handlers and this lead's messages.
// What it shows as the contact and whether it offers a draft come from one tested function (lib/scan/lead-card.ts detailsContact). On a
// discovery lead neither is the older engine's address; `site` keeps that address only for the website check, which still holds a draft
// at the server.
import { detailsContact } from '../../../lib/scan/lead-card.ts'
import { publishedContact, contactSearchNote, domainBasisNote } from '../../../lib/outreach/published-email.ts'
import { domainReviewFor } from '../../../lib/outreach/domain-review.ts'
import { companySearchEligible } from '../../../lib/scan/find-contact-eligible.ts'

export type DetailsContactLead = Parameters<typeof detailsContact>[0] & Parameters<typeof domainReviewFor>[0] & Parameters<typeof companySearchEligible>[0] & Parameters<typeof contactSearchNote>[0]
  & { id: string; enrichments?: Parameters<typeof domainReviewFor>[1]; confidence: number | null; human_confirmed_at?: number | null; fit?: number | null; intent?: number | null; currentness_held?: boolean }

export function DetailsContact({ l, reviewMsg, contactMsg, drafted, onDomainReview, onFindContact, onConfirmReview, onApprove }: {
  l: DetailsContactLead; reviewMsg?: string; contactMsg?: string; drafted?: string
  onDomainReview: (leadId: string, action: 'confirm' | 'withdraw', binding?: string | null) => unknown
  onFindContact: (leadId: string) => unknown; onConfirmReview: (leadId: string) => unknown; onApprove: (leadId: string) => unknown
}) {
  const dc = detailsContact(l), pc = dc.contact, draftTo = dc.draftTo, site = publishedContact(l)
  return <>
    {pc && pc.purpose !== 'non-sales' && <span className="text-gray-500 text-xs ml-3">{pc.email}{pc.purpose==='unknown'?' - published address; purpose and buyer relevance unknown':' - business inquiry context, not consent'}</span>}
    {site && (() => { const pc = site; const rv = domainReviewFor(l, l.enrichments)
      // A contact email that is also the address the crawl recorded is reviewed like a crawled address: equality does not show a cited-page origin.
      const lc = pc.source === 'lead' && rv.state !== 'not_required'
      if (pc.source !== 'sitecrawl' && !lc) return null
      const bpc = lc ? { ...pc, source: 'sitecrawl' as const, domainBasis: rv.basis ?? 'unrecorded' as const, domainBasisSourceUrl: rv.basisSourceUrl } : pc
      const note = domainBasisNote(bpc) ?? (rv.state === 'not_required' ? null : lc ? 'This address is also the one found by the website crawl.' : 'More than one website is recorded for this company.'); if (!note && rv.state !== 'confirmed') return null
      const cv = rv.covered
      return <span className="text-xs ml-3 block mt-1 border border-black px-2 py-1 text-[#111]">
        {note}{bpc.domainBasisSourceUrl && bpc.domainBasis !== 'unrecorded' ? <> <a className="underline" href={bpc.domainBasisSourceUrl} target="_blank" rel="noopener noreferrer nofollow">{bpc.domainBasis === 'name_probe' ? 'homepage read' : 'page with the link'}</a>.</> : null}
        {rv.multi && cv && rv.state !== 'not_required' && <span className="block mt-1">One check covers all of these, not only the first: {cv.domains.length} {cv.domains.length === 1 ? 'website' : 'websites'} ({cv.domains.map((d, i) => <span key={'d' + i}>{i ? ', ' : ''}{d.domain}{d.source_url ? <> (<a className="underline" href={d.source_url} target="_blank" rel="noopener noreferrer nofollow">page</a>)</> : null}</span>)}) and {cv.addresses.length} {cv.addresses.length === 1 ? 'address' : 'addresses'} ({cv.addresses.map((a, i) => <span key={'a' + i}>{i ? ', ' : ''}{a.email}{a.source_url ? <> (<a className="underline" href={a.source_url} target="_blank" rel="noopener noreferrer nofollow">page</a>)</> : null}</span>)}).</span>}
        {rv.state === 'required' && <> A draft needs your check first. <button onClick={() => onDomainReview(l.id, 'confirm', rv.binding)} className="underline">{rv.multi ? 'These websites are the right company' : 'This website is the right company'}</button> <span className="text-gray-500">(not need, consent or a send approval)</span></>}
        {rv.state === 'confirmed' && <> You checked that {rv.multi && cv ? `these ${cv.domains.length} websites and ${cv.addresses.length} addresses are` : `${rv.domain} is`} the right company. <button onClick={() => onDomainReview(l.id, 'withdraw')} className="underline">withdraw</button></>}
        {reviewMsg ? <span className="text-gray-500 ml-2">{reviewMsg}</span> : null}
      </span> })()}
    {pc && pc.purpose === 'non-sales' && <span className="text-gray-500 text-xs ml-3">{pc.email} - published {pc.purposeHint} inbox, not a sales contact</span>}
    {(() => { const n = companySearchEligible(l) ? contactSearchNote(l) : (publishedContact(l) || l.contact ? null : 'No contact stored. This row does not identify a verified company website for contact search.'); return n ? <span className="text-gray-500 text-xs ml-3 block mt-1">{n}</span> : null })()}
    {dc.crawledNote && <span className="text-gray-500 text-xs ml-3 block mt-1" data-testid="also-crawled">{dc.crawledNote}</span>}
    {!pc && !dc.alsoCrawled && !l.contact && l.human_confirmed_at !== null && l.human_confirmed_at !== undefined && companySearchEligible(l) && (
      <span className="text-xs ml-3 block mt-1"><button onClick={() => onFindContact(l.id)} className="underline text-[#111]">Look for a published contact on the company website</button>{contactMsg ? <span className="text-gray-500 ml-2">{contactMsg}</span> : null}</span>
    )}
    {!pc && l.contact && <span className="text-gray-500 text-xs ml-3">{l.contact}</span>}
    {draftTo && domainReviewFor(l, l.enrichments).state !== 'required' && (l.confidence !== null || l.human_confirmed_at !== null) && !(l.fit === 0 && l.intent === null) && (
      drafted
        ? <span className="text-gray-400 text-xs ml-3">{drafted}</span>
        : l.currentness_held ? <button onClick={()=>onConfirmReview(l.id)} className="font-mono text-xs border border-black px-2 py-1">I reviewed the source - use for drafting (not consent)</button> : <button onClick={() => onApprove(l.id)} className="font-mono text-xs uppercase border border-black px-2 py-1 ml-3 hover:bg-black hover:text-white">Draft email</button>)}
  </>
}
