// The compact lead card on Leads: company, contact, one line on why it fits, source + date, Approve / Reject.
// Reads stored fields only; nothing is inferred. Everything else stays in the card's Details.
// "Approve" creates a draft for review (POST /api/outreach), which never sends; createDraft re-checks every gate on the
// server. approveState mirrors the conditions under which the existing "Draft email" button appears, plus the window
// and timing holds, so the card never offers an action the server would refuse for those reasons.
import { contactIdentity, opportunityCard, type CardLead } from './opportunity.ts'
import { publishedContact, publishedEmail } from '../outreach/published-email.ts'
import { domainReviewFor } from '../outreach/domain-review.ts'

export type ApproveState = { ok: true } | { ok: false; reason: string }

export interface LeadCardSummary {
  company: string
  contact: string | null
  // Shown beside the contact, never only in Details: how far it is established. `confirmed` is true only for the cited
  // page, the company's own page, or the user's own website check, with no restricted inbox or quarantine.
  contactStatus: { confirmed: boolean; text: string } | null
  why: string
  sourceUrl: string
  sourceHost: string
  date: string
  approve: ApproveState
}

const firstSentence = (s: string) => {
  const t = s.replace(/\s+/g, ' ').trim()
  const m = /^(.{20,}?[.!?])(\s|$)/.exec(t)
  return (m ? m[1] : t).slice(0, 220)
}

export function approveState(l: CardLead): ApproveState {
  if (l.quarantined_at) return { ok: false, reason: 'Rejected. Undo to use it again.' }
  if (l.review_reason) return { ok: false, reason: 'dazl could not confirm this lead. Check the source under Needs your review first.' }
  if (l.window_held) return { ok: false, reason: 'Outside the time window you asked for, or its date is unknown. Research only.' }
  if (l.confidence == null && l.human_confirmed_at == null) return { ok: false, reason: 'Not verified. Check the source first.' }
  if (l.fit === 0 && l.intent === null) return { ok: false, reason: 'Graded as not a fit for your profile.' }
  if (!publishedEmail(l)) return { ok: false, reason: 'No published email address to draft to yet. See Details to look for one.' }
  if (domainReviewFor({ id: l.id ?? '', contact: l.contact }, l.enrichments ?? []).state === 'required') return { ok: false, reason: 'Confirm the company website in Details first.' }
  if (l.currentness_held) return { ok: false, reason: 'Event timing is unknown. Review the source in Details first.' }
  return { ok: true }
}

export function leadCardSummary(l: CardLead & { name?: string }, buyerRoles = ''): LeadCardSummary {
  const card = opportunityCard(l, buyerRoles)
  const email = publishedEmail(l)
  const contact = card.who ? `${card.who.name}${card.who.title ? `, ${card.who.title}` : ''}${email ? ` - ${email}` : ''}` : email ?? (l.contact?.trim() || null)
  const contactStatus = contact ? statusOf(l, !!card.who) : null
  let sourceHost = l.source_url
  try { sourceHost = new URL(l.source_url).hostname.replace(/^www\./, '') } catch { /* keep the raw value */ }
  return {
    company: l.company || l.name || 'Unnamed company',
    contact,
    contactStatus,
    // The research rationale when there is one, else the saved signal claim itself. One line, never invented.
    why: firstSentence(l.why?.trim() || l.signal),
    sourceUrl: l.source_url,
    sourceHost,
    date: l.event_date ? `claimed event date ${l.event_date}` : 'event date unknown',
    approve: approveState(l),
  }
}

function statusOf(l: CardLead, personShown: boolean): { confirmed: boolean; text: string } {
  if (l.quarantined_at) return { confirmed: false, text: 'Quarantined or rejected: do not contact.' }
  const rows = l.enrichments ?? []
  const notes: string[] = []
  const pc = publishedContact({ contact: l.contact, source_url: l.source_url, evidence_excerpt: l.evidence_excerpt, enrichments: rows })
  if (pc?.purpose === 'non-sales') notes.push(`Restricted inbox (${pc.purposeHint ?? 'not for sales'}): not a sales contact.`)
  const id = contactIdentity(l)
  const established = id.state === 'cited' || id.state === 'fact' || id.state === 'user_confirmed'
  if (!established) notes.unshift(`Unconfirmed - ${id.state === 'none' ? id.text : `name match only: ${id.text}`}.`)
  if (personShown) notes.push('Role as listed; current role not verified.')
  else if (rows.some(r => r.kind === 'contact' || r.kind === 'person')) notes.push('Listed people have past, negated or assistant titles; no current buyer named.')
  const confirmed = established && pc?.purpose !== 'non-sales'
  return { confirmed, text: confirmed ? [`Confirmed: ${id.text}.`, ...notes].join(' ') : notes.join(' ') }
}
