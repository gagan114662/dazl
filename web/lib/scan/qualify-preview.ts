// Free, read-only preview of what a saved-lead qualification would send. No model call, no spend.
// It reads the lead's own source page and, when the company site is confirmed, its home page,
// through the same guarded fetch the rest of the app uses.
import type Database from 'better-sqlite3'
import { fetchPageDetailed, isFail, type FetchFail, type Page } from './fetch-page.ts'
import { preparePrompt, estimateCost, DEFAULT_LIMITS, FIELD_CAPS, type ContextField, type QualifyInput, type EvidenceScope } from './lead-qualify.ts'
import { packRequest, type RequestPacking } from './qualification-packing.ts'
import { effectiveOffer } from './play-offer-text.ts'
import { readPlayOffer } from './play-offer.ts'

export type PageFetcher = (url: string) => Promise<Page | FetchFail>
export interface PreviewPage { url: string; role: 'posting' | 'company_home'; status: 'fetched' | 'failed'; chars: number; fail?: string; used: boolean; not_used_reason?: string }
export interface QualifyPreview {
  lead_id: string; company: string; vendor: string | null; model: string | null; seller_offer_present: boolean; prompt_sha256: string | null
  pages: PreviewPage[]
  cost: ReturnType<typeof estimateCost> | null; scope: EvidenceScope | null
  packing: RequestPacking | null; context_fields: ContextField[]; ready: boolean; notes: string[]
}
export type QualifyPreviewFull = QualifyPreview & { input: QualifyInput | null }

export async function qualifyPreview(db: Database.Database, userId: string, leadId: string, sellerText: string, fetchPage: PageFetcher = fetchPageDetailed, vendor: string | null = null, model: string | null = null): Promise<QualifyPreviewFull | null> {
  const lead = db.prepare(`SELECT l.id, l.scan_job_id, l.company, l.signal, l.source_url, l.company_domain, j.icp, j.query, j.offer, j.seller
    FROM leads l JOIN scan_jobs j ON j.id = l.scan_job_id WHERE l.id = ? AND j.user_id = ?`).get(leadId, userId) as
    { id: string; scan_job_id: string; company: string; signal: string; source_url: string; company_domain: string | null; icp: string | null; query: string | null; offer: string | null; seller: string | null } | undefined
  if (!lead) return null
  const packing = packRequest(lead.query ?? '', lead.icp, FIELD_CAPS.seller_icp)
  const resolved = await readPlayOffer(db, userId, lead.scan_job_id)
  const offer = resolved?.source === 'none' ? effectiveOffer(lead, sellerText) : resolved
  if (!offer) return null
  const blocked = (note: string): QualifyPreviewFull => ({ lead_id: lead.id, company: lead.company, vendor, model, seller_offer_present: false, pages: [], cost: null, scope: null, packing, context_fields: [], ready: false, notes: [note], prompt_sha256: null, input: null })
  if (offer.conflict) return blocked('Choose what this play sells before checking fit; the saved profile and play request conflict.')
  const sellerOffer = offer.offer ?? ''
  const notes: string[] = []
  const targets: { url: string; role: PreviewPage['role'] }[] = []
  if (/^https:\/\//.test(lead.source_url)) targets.push({ url: lead.source_url, role: 'posting' })
  if (lead.company_domain && /^[a-z0-9.-]+$/i.test(lead.company_domain)) targets.push({ url: `https://${lead.company_domain}/`, role: 'company_home' })
  else notes.push('No confirmed company site on this lead, so only the posting page can be used as evidence.')
  const got = await Promise.all(targets.map(async t => ({ t, r: await fetchPage(t.url).catch(() => ({ fail: 'error' }) as FetchFail) })))
  // Page reads await external state. Never price/approve the old offer after a concurrent choice.
  const current = db.prepare('SELECT offer, seller, query, icp FROM scan_jobs WHERE id = ? AND user_id = ?').get(lead.scan_job_id, userId) as { offer: string | null; seller: string | null; query: string | null; icp: string | null } | undefined
  const latest = current ? await readPlayOffer(db, userId, lead.scan_job_id) : null
  const currentOffer = latest?.source === 'none' && current ? effectiveOffer(current, sellerText) : latest
  if (!currentOffer || JSON.stringify(currentOffer) !== JSON.stringify(offer)) return blocked('The play offer changed while reading sources. Reload the preview before approving any check.')
  if (!current || current.query !== lead.query || current.icp !== lead.icp) return blocked('The saved request or profile changed while reading sources. Reload the preview before approving any check.')
  // Provenance: the posting page is only evidence about this company if it names the company. The company home
  // page is used only when the lead already has a confirmed site. Anything else is fetched for display but not used.
  const nameOk = (t: string) => { const c = lead.company.toLowerCase().replace(/\s+/g, ' ').trim(); return c.length >= 2 && t.toLowerCase().replace(/\s+/g, ' ').includes(c) }
  const pages: PreviewPage[] = got.map(({ t, r }) => {
    if (isFail(r) || !r) return { url: t.url, role: t.role, status: 'failed', chars: 0, fail: (r as FetchFail)?.fail, used: false, not_used_reason: 'fetch failed' }
    if (t.role === 'posting' && !nameOk(r.text)) return { url: t.url, role: t.role, status: 'fetched', chars: r.text.length, used: false, not_used_reason: 'the posting page does not name the company' }
    return { url: t.url, role: t.role, status: 'fetched', chars: r.text.length, used: true }
  })
  const ok = got.flatMap(({ t, r }) => isFail(r) || !r || (t.role === 'posting' && !nameOk(r.text)) ? [] : [{ url: t.url, text: r.text, role: t.role }])
  for (const p of pages) if (p.not_used_reason && p.status === 'fetched') notes.push(`${p.url}: not used - ${p.not_used_reason}.`)
  const sellerOk = sellerOffer.trim().length > 0
  if (!sellerOk) notes.push('No seller profile saved, so there is nothing to judge fit against.')
  if (ok.length === 0) notes.push('No evidence page could be read.')
  const input: QualifyInput = { seller_offer: sellerOffer, seller_icp: packing.derived_criteria, company: lead.company, signal: lead.signal, pages: ok }
  const prep = ok.length ? preparePrompt(input, DEFAULT_LIMITS) : null
  if (!packing.complete) notes.push(...packing.issues)
  if (prep && !prep.context_complete) notes.push('The question context would be shortened by existing field caps. This check cannot run with incomplete context.')
  const cost = prep ? estimateCost(prep.prompt, vendor, model, DEFAULT_LIMITS) : null
  if (!vendor) notes.push('No AI key is saved for this account, so no check can run and no price applies.')
  else if (cost && !cost.priced) notes.push(`No verified price for ${vendor}${model ? ':' + model : ''}, so no dollar estimate is given and this is not ready for a spending request.`)
  return { lead_id: lead.id, company: lead.company, seller_offer_present: sellerOk, pages, cost, packing, context_fields: prep?.context_fields ?? [], ready: packing.complete && !!prep?.context_complete && sellerOk && ok.length > 0 && !!cost?.priced, notes, scope: prep?.scope ?? null, vendor, model, prompt_sha256: prep?.prompt_sha256 ?? null, input: ok.length ? input : null }
}
