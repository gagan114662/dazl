import { isGenericInbox, nameBound } from '../outreach/generic-inbox.ts'
// What a lead from the Claude discovery lane says about itself on its card: how sure dazl is, and plainly what is missing
// (launch brief, Step 3: a missing date, person or website lowers confidence and is said; it never hides the lead).
export interface DiscoverCardLead {
  source_kind?: string | null; confidence: number | null; event_date: string | null; date_status?: string | null; timing_note?: string | null
  name: string; company_domain: string | null; enrichments?: { kind: string; connector?: string }[]
}
export const isDiscoverLead = (l: { source_kind?: string | null }): boolean => l.source_kind === 'discover'
export function discoverConfidence(l: Pick<DiscoverCardLead, 'confidence'>): 'high' | 'medium' | 'low' {
  const c = l.confidence ?? 0
  return c >= 80 ? 'high' : c >= 60 ? 'medium' : 'low'
}
export function discoverMissing(l: DiscoverCardLead): string[] {
  const missing: string[] = []
  if (!l.event_date) missing.push('a date for the signal')
  else if (l.date_status !== 'verified') missing.push(l.timing_note ? 'a date printed on the page (the date shown is when the page was published)' : 'the date confirmed on the page')
  if (!l.name.trim() && !(l.enrichments ?? []).some(e => e.kind === 'person')) missing.push('a named person')
  if (!l.company_domain) missing.push('the company website')
  return missing
}
export function discoverLine(l: DiscoverCardLead): string {
  const missing = discoverMissing(l)
  return `Confidence: ${discoverConfidence(l)}. ${missing.length ? `Missing: ${missing.join('; ')}.` : 'Dated signal, proof page, person and website all found.'}`
}

// Where each fact on a discovery lead came from (#1401): the page that proves the signal, the page that names the person, the page
// that prints the email. Only links the run stored; nothing is inferred.
export interface FieldSource { field: 'signal' | 'person' | 'email' | 'linkedin'; label: string; url: string }
export function discoverSources(l: { source_url?: string | null; enrichments?: { kind: string; connector?: string; value?: string; source_url?: string | null }[] }): FieldSource[] {
  const out: FieldSource[] = []
  if (l.source_url) out.push({ field: 'signal', label: 'Signal', url: l.source_url })
  const from = (kind: string) => (l.enrichments ?? []).find(e => e.kind === kind && e.connector === 'discover' && e.source_url)
  const person = from('person'), email = from('email'), linkedin = from('linkedin')
  if (person) out.push({ field: 'person', label: 'Person', url: person.source_url! })
  if (email) out.push({ field: 'email', label: 'Email', url: email.source_url! })
  if (linkedin?.value) out.push({ field: 'linkedin', label: 'LinkedIn', url: linkedin.value })
  return out
}

// The person and the published email a discovery lead carries, with the pages they came from. These are the rows the run stored
// (connector 'discover'); nothing is matched, ranked or inferred here. The person was chosen by the run for this seller's offer.
// email: the person's or company's own published address. A shared inbox (info@, sales@ ...) is never one (#1250); sharedInbox says one was published.
export interface DiscoverContact { person: { name: string; title: string | null; linkedin: string | null; source: string | null } | null; email: { address: string; source: string } | null; sharedInbox: boolean; otherAddress: boolean }
type Row = { kind: string; connector?: string; value?: string; source_url?: string | null }
const EMAIL = /^[a-z0-9._%+-]{1,64}@(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/
export function discoverContact(l: { source_kind?: string | null; name?: string | null; enrichments?: Row[] }): DiscoverContact | null {
  if (!isDiscoverLead(l)) return null
  const rows = (l.enrichments ?? []).filter(r => r.connector === 'discover')
  const mails = rows.filter(r => r.kind === 'email' && r.value && r.source_url && EMAIL.test(r.value.trim().toLowerCase()))
  const p = rows.find(r => r.kind === 'person' && r.value)
  const li = rows.find(r => r.kind === 'linkedin' && r.value)
  let person: DiscoverContact['person'] = null
  if (p) {
    const i = p.value!.indexOf(', ')
    person = { name: (i < 0 ? p.value! : p.value!.slice(0, i)).trim(), title: i < 0 ? null : p.value!.slice(i + 2).trim() || null, linkedin: li?.value ?? null, source: p.source_url ?? null }
  } else if ((l.name ?? '').trim()) person = { name: l.name!.trim(), title: null, linkedin: li?.value ?? null, source: null }
  // The contact is the named person's OWN address: not a shared inbox, and carrying their name (dana@, dana.ruiz@, druiz@ ...). Another
  // employee's address stored beside it is not this person's (review of #1596); otherAddress says one was published.
  const own = (r: Row) => !isGenericInbox(r.value) && !!person && nameBound(r.value!.trim().toLowerCase().split('@')[0], person.name)
  const e = mails.find(own)
  return { person, email: e ? { address: e.value!.trim().toLowerCase(), source: e.source_url! } : null, sharedInbox: mails.some(r => isGenericInbox(r.value)), otherAddress: mails.some(r => !isGenericInbox(r.value) && !own(r)) }
}
// The address is PUBLISHED BY THE COMPANY: the page that prints it is on the lead's own website (the site or a subdomain of it).
// A mailbox on the company's domain is not enough: the same address copied onto a directory or a data site is someone else's
// publication, and nothing shows the company put it there (review of #1574).
const bare = (h: string) => h.toLowerCase().replace(/^www\./, '')
export function emailOnCompanySite(email: string, sourceUrl: string | null | undefined, companyDomain: string | null | undefined): boolean {
  const site = bare((companyDomain ?? '').trim())
  if (!site) return false
  const under = (h: string) => h === site || h.endsWith(`.${site}`)
  if (!email.includes('@')) return false
  try { const u = new URL(sourceUrl ?? ''); return (u.protocol === 'https:' || u.protocol === 'http:') && under(bare(u.hostname)) } catch { return false }
}
// What holds a discovery lead whatever its contact: rejected, a required check, an unconfirmed proof page, no date, not graded a fit.
// One list, read by Approve (email) and by the LinkedIn route below.
type ProofLead = { quarantined_at?: number | null; gate_held?: boolean | null; review_reason?: string | null; event_date?: string | null; fit?: number | null; intent?: number | null }
export function discoverProofHold(l: ProofLead): string | null {
  if (l.quarantined_at) return 'Rejected. Undo to use it again.'
  if (l.gate_held) return 'A required check has not passed. Research only.'
  if (l.review_reason) return 'dazl could not confirm this lead\'s proof page. Check the source under Needs your review first.'
  if (!l.event_date) return 'The signal has no date, so its timing is unknown. Open the proof to check it.'
  if (l.fit === 0 && l.intent === null) return 'Graded as not a fit for your profile.'
  return null
}
// Owner decision 2026-11-23: a lead counts with dated proof, a named person and that person's own LinkedIn profile when no personal
// email is published. The user sends the first message on LinkedIn themselves; dazl opens the profile and automates nothing.
// Null unless every proof rule passes, a person is named, and the stored link is a person's profile (/in/<name>), never a company page.
const PROFILE = /^https?:\/\/(?:[a-z0-9-]+\.)?linkedin\.com\/in\/[^/?#]{2,}\/?(?:[?#].*)?$/i
export function discoverLinkedIn(l: ProofLead & { source_kind?: string | null; name?: string | null; enrichments?: Row[] }): { name: string; profile: string } | null {
  if (!isDiscoverLead(l) || discoverProofHold(l)) return null
  const p = discoverContact(l)?.person
  return p?.name && p.linkedin && PROFILE.test(p.linkedin.trim()) ? { name: p.name, profile: p.linkedin.trim() } : null
}
// Whether a person can approve a discovery lead (a draft email for them to review; nothing is sent), and if not, the one thing to do.
// Same rules as lib/outreach/service.ts discoverDraftChecks. The inbox-purpose and deliverability rules are applied by the caller
// (lib/scan/lead-card.ts), which already has them.
export function discoverApprove(l: { quarantined_at?: number | null; gate_held?: boolean | null; review_reason?: string | null; event_date?: string | null; company_domain?: string | null; fit?: number | null; intent?: number | null; source_kind?: string | null; name?: string | null; enrichments?: Row[] }): { ok: true } | { ok: false; reason: string } {
  const held = discoverProofHold(l)
  if (held) return { ok: false, reason: held }
  const c = discoverContact(l)
  if (!c?.email && c?.otherAddress) return { ok: false, reason: `The published address does not carry this person's name, so it is not known to be theirs.${c.person?.linkedin ? ' Reach them through their LinkedIn profile.' : ''}` }
  if (!c?.email && c?.sharedInbox) return { ok: false, reason: `Only a shared inbox (such as info@ or sales@) is published for this lead, and that is not a contact.${c.person?.linkedin ? ' Reach them through their LinkedIn profile.' : ''}` }
  if (!c?.email) return { ok: false, reason: c?.person?.linkedin ? 'No email address is published for this lead. Reach them through their LinkedIn profile.' : 'No email address is published for this lead yet.' }
  if (!emailOnCompanySite(c.email.address, c.email.source, l.company_domain)) return { ok: false, reason: 'The address was not found on the company\'s own website, only on another site.' }
  return { ok: true }
}

// The ONE state of a discovery lead (#1238, #684, #1062): every page that counts or labels leads (Home, the Leads header and past scans,
// Campaigns and a campaign's page, the checked list) asks this, so the same lead is called the same thing everywhere. Built from the four
// functions above and nothing else:
//   rejected        the user rejected it
//   review          its proof page is not confirmed: the user can check it under Needs your review
//   research        something no check by the user can lift holds it (no date, not graded a fit, a required check)
//   ready_email     Approve is on: a draft email to the named person's own published address
//   ready_linkedin  the named person's own LinkedIn profile is known (no own address)
//   no_contact      the proof is fine, but nobody can be reached yet
// "Ready" and "with a contact" mean ready_email or ready_linkedin and nothing else (discoverReady).
// stored_intent: the grade as saved. GET /api/leads replaces `intent` with a display value and keeps the saved one here; the saved one
// is what the draft check reads (lib/outreach/service.ts), so it is the one used when both are present.
export type DiscoverState = 'rejected' | 'review' | 'research' | 'ready_email' | 'ready_linkedin' | 'no_contact'
export type DiscoverStateLead = Parameters<typeof discoverApprove>[0] & { stored_intent?: number | null }
const asSaved = (l: DiscoverStateLead): DiscoverStateLead => l.stored_intent !== undefined ? { ...l, intent: l.stored_intent } : l
export function discoverState(lead: DiscoverStateLead): DiscoverState {
  const l = asSaved(lead)
  if (l.quarantined_at) return 'rejected'
  const held = discoverProofHold(l)
  // Would the hold go away, or change, if the user confirmed the proof page? Then it is theirs to check. Otherwise no check lifts it.
  if (held) return discoverProofHold({ ...l, review_reason: null }) !== held ? 'review' : 'research'
  if (discoverApprove(l).ok) return 'ready_email'
  if (discoverLinkedIn(l)) return 'ready_linkedin'
  return 'no_contact'
}
// The words for one lead's state, the same on every page that labels a lead.
export const DISCOVER_STATE_LABEL: Record<DiscoverState, string> = { rejected: 'Rejected', review: 'Needs your review', research: 'Research only - checking the source cannot make it ready',
  ready_email: 'Ready - approve it to draft an email', ready_linkedin: 'Ready - message them on LinkedIn', no_contact: 'No contact found yet' }
export const discoverReady = (s: DiscoverState): boolean => s === 'ready_email' || s === 'ready_linkedin'
// Why a lead that is not ready is not, in the short words the Home tile and the checked list group by; null when it is ready.
export function discoverNotReady(lead: DiscoverStateLead): string | null {
  const s = discoverState(lead)
  if (discoverReady(s)) return null
  if (s === 'rejected') return 'rejected'
  if (s === 'review') return 'needs your review'
  if (s === 'no_contact') return 'no contact found yet'
  const first = (discoverProofHold(asSaved(lead)) ?? '').split('. ')[0].replace(/\.$/, '')
  return first.charAt(0).toLowerCase() + first.slice(1)
}
// The counts every page shows for a search's discovery leads, and the one sentence that says them.
export interface DiscoverCounts { found: number; ready: number; ready_email: number; ready_linkedin: number; no_contact: number; review: number; research: number; rejected: number }
export function discoverCounts(states: Iterable<DiscoverState>): DiscoverCounts {
  const c: DiscoverCounts = { found: 0, ready: 0, ready_email: 0, ready_linkedin: 0, no_contact: 0, review: 0, research: 0, rejected: 0 }
  for (const s of states) { c.found++; c[s]++; if (discoverReady(s)) c.ready++ }
  return c
}
export function discoverCountParts(c: DiscoverCounts): string[] {
  return [`${c.ready} ready (${c.ready_email} by email, ${c.ready_linkedin} on LinkedIn)`, `${c.no_contact} with no contact yet`,
    `${c.review} need${c.review === 1 ? 's' : ''} your review`, `${c.research} research only`, `${c.rejected} rejected`]
}
export const discoverCountsLine = (c: DiscoverCounts): string => `${c.found} lead${c.found === 1 ? '' : 's'} found: ${discoverCountParts(c).join(', ')}`
