// The compact lead card on Leads: company, contact, one line on why it fits, source + date, Approve / Reject.
// Reads stored fields only; nothing is inferred. Everything else stays in the card's Details.
// "Approve" creates a draft for review (POST /api/outreach), which never sends; createDraft re-checks every gate on the
// server. approveState mirrors the conditions under which the existing "Draft email" button appears, plus the window
// and timing holds, so the card never offers an action the server would refuse for those reasons.
import { contactIdentity, opportunityCard, type CardLead } from './opportunity.ts'
import { publishedContact, publishedEmail } from '../outreach/published-email.ts'
import { domainReviewFor } from '../outreach/domain-review.ts'
import { evidenceStateOf } from '../outreach/evidence-state.ts'

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
  if (evidenceStateOf({ evidence_excerpt: l.evidence_excerpt, confidence: l.confidence ?? null, human_confirmed_at: l.human_confirmed_at ?? null }) === 'unverified') return { ok: false, reason: 'Not verified. Check the source first.' }
  if (l.fit === 0 && l.intent === null) return { ok: false, reason: 'Graded as not a fit for your profile.' }
  if (!publishedEmail(l)) return { ok: false, reason: 'No published email address to draft to yet. See Details to look for one.' }
  if (domainReviewFor({ id: l.id ?? '', contact: l.contact }, l.enrichments ?? []).state === 'required') return { ok: false, reason: 'Confirm the company website in Details first.' }
  if (l.currentness_held) return { ok: false, reason: 'Event timing is unknown. Review the source in Details first.' }
  return { ok: true }
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
// '2026-10-01' -> '1 Oct 2026'. Anything that is not a full date is shown as stored (never guessed into one).
const dayMonth = (d: string) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(d); return m && +m[2] >= 1 && +m[2] <= 12 ? `${+m[3]} ${MONTHS[+m[2] - 1]} ${m[1]}` : d }
// The card's date line: the claimed event date when there is one; else the page's published date, saying the event
// date is unknown; else "No dated source". A date is never invented for an undated lead.
export function cardDate(eventDate: string | null, publishedAt?: string | null, opts: { dayVerified?: boolean } = {}): string {
  // A proven event day is verified, not "claimed" (#498 chip coherence); anything unproven stays claimed.
  if (eventDate) return opts.dayVerified ? `event date ${dayMonth(eventDate)} (verified on the cited source)` : `claimed event date ${dayMonth(eventDate)}`
  if (publishedAt) return `published ${dayMonth(publishedAt)}, event date unknown`
  return 'No dated source'
}

// The count bar over the cards. Rejected = rejected cards; Approved = cards with a draft made from them (from this scan's
// Outreach emails, plus Approve clicks this session) - a draft is never sent by approving; To review = the rest.
// When this scan's emails could not be read, Approved is unknown (null) rather than guessed from clicks alone.
export function cardCounts(leads: { id: string; quarantined_at?: number | null }[], drafted: Set<string> | null, approvedNow: Record<string, boolean>): { approved: number | null; rejected: number; toReview: number | null } {
  const rejected = leads.filter(l => l.quarantined_at).length
  if (!drafted) return { approved: null, rejected, toReview: null }
  const approved = leads.filter(l => !l.quarantined_at && (drafted.has(l.id) || approvedNow[l.id])).length
  return { approved, rejected, toReview: leads.length - rejected - approved }
}

export function leadCardSummary(l: CardLead & { name?: string; published_at?: string | null }, buyerRoles = ''): LeadCardSummary {
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
    date: cardDate(l.event_date, l.published_at, { dayVerified: l.day_verified === true }),
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
