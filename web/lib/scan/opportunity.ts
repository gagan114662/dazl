// Opportunity card (owner direction, issue #204): every lead reads as one decision, not a list of fields.
//   why this business - which profile criteria the grading matched
//   why now           - the dated event, its date status and the actual source
//   who               - the person to approach first, with how the company site was identified
//   angle             - the grading's own "why"
//   facts / assumptions / missing - certainty split, so an opening is never presented as proof of buyer intent
//   next              - one recommended next action, never ahead of the outreach gates
// Pure: built only from what the lead already stores. Nothing here is fetched, guessed or invented; anything unknown
// is listed under missing. Identity reuses the outreach provenance rules (weakest recorded basis governs, the user's
// own website review, several websites = conflict), so the card never claims more than the send gate accepts.
import { leadContactFacts } from '../outreach/lead-contact.ts'
import { recommendedPerson, type PersonContact } from '../people/rank.ts'
import { domainBasisFor, publishedContact, PUBLISHED_EMAIL_RE, type DomainBasisKind } from '../outreach/published-email.ts'
import { eventDateCopy } from './date-copy.ts'
import { domainReviewFor } from '../outreach/domain-review.ts'

export interface CardLead {
  id?: string
  company: string; signal: string; source_url: string; evidence_excerpt: string | null
  event_date: string | null; date_status: string | null; review_reason: string | null
  fit: number | null; intent: number | null; why: string | null; icp_match: string | null
  company_domain: string | null; contact: string | null; quarantined_at?: number | null
  confidence?: number | null; human_confirmed_at?: number | null
  currentness_held?: boolean; window_held?: boolean
  enrichments?: { connector: string; kind: string; value: string; label: string | null; source_url: string; retrieved_at?: number | null }[]
}
export interface OpportunityCard {
  whyThisBusiness: string
  whyNow: { claim: string; date: string | null; dateNote: string; source: string; quote: string | null }
  who: { name: string; title: string | null; link: string | null; identity: string } | null
  angle: string | null
  facts: string[]
  assumptions: string[]
  missing: string[]
  next: string
}

const CRITERIA: [keyof Match, string][] = [['role', 'buyer role'], ['industry', 'industry'], ['size', 'company size'], ['location', 'location']]
type Match = { role: string; industry: string; size: string; location: string; note?: string }
const parseMatch = (s: string | null): Match | null => { try { const m = s ? JSON.parse(s) : null; return m && typeof m === 'object' ? m as Match : null } catch { return null } }
const PHONE = /\+?\d[\d\s().-]{6,}\d/

const BASIS_TEXT: Record<DomainBasisKind, string> = {
  own_domain: 'the cited page is on this site',
  linked: 'linked from the cited page and the name matches; not proof the site is theirs',
  link_text_only: 'linked from the cited page by link text only',
  name_probe: 'found by name search, not linked from the source',
  unrecorded: 'how this site was chosen was not recorded',
  cited_page: 'the cited page',
}
type Identity = { text: string; state: 'fact' | 'user_confirmed' | 'unconfirmed' | 'conflict'; site: string | null }
function identityOf(l: CardLead, rows: NonNullable<CardLead['enrichments']>): Identity | null {
  const sites = [...new Set(rows.filter(r => r.connector === 'sitecrawl' && r.kind === 'domain').map(r => r.value.toLowerCase().split('|')[0]).filter(Boolean))]
  if (sites.length === 0) return null
  if (sites.length > 1) return { text: `several websites recorded (${sites.join(', ')}); which one is theirs is not settled`, state: 'conflict', site: null }
  const site = sites[0]
  const b = domainBasisFor(`x@${site}`, rows)
  const reviewed = l.id ? domainReviewFor({ id: l.id, contact: l.contact }, rows).state === 'confirmed' : false
  if (b.kind === 'own_domain') return { text: `${site}: ${BASIS_TEXT.own_domain}`, state: 'fact', site }
  if (reviewed) return { text: `${site}: you confirmed this is their site (${BASIS_TEXT[b.kind]})`, state: 'user_confirmed', site }
  return { text: `${site}: ${BASIS_TEXT[b.kind]}`, state: 'unconfirmed', site }
}

// How far the card's contact is established, for the compact lead card: the same identity facts the opportunity card
// uses (identityOf, the cited-email rule, domainReviewFor), reduced to a state and one plain line. Nothing is upgraded:
// anything short of the cited page, the site's own page, or the user's own website check reads as unconfirmed.
export type ContactIdentity = { state: 'cited' | 'fact' | 'user_confirmed' | 'unconfirmed' | 'conflict' | 'none'; text: string }
export function contactIdentity(l: CardLead): ContactIdentity {
  const rows = l.enrichments ?? []
  const ident = identityOf(l, rows)
  const pc = publishedContact({ contact: l.contact, source_url: l.source_url, evidence_excerpt: l.evidence_excerpt, enrichments: rows })
  const review = domainReviewFor({ id: l.id ?? '', contact: l.contact }, rows)
  if (PUBLISHED_EMAIL_RE.test((l.contact ?? '').trim().toLowerCase()) && pc?.source === 'lead' && review.state !== 'required') return { state: 'cited', text: 'address printed on the cited page' }
  if (ident?.state === 'conflict') return { state: 'conflict', text: ident.text }
  if (!ident) return { state: 'none', text: "the company's own website was not identified" }
  if (ident.state === 'user_confirmed') return { state: 'user_confirmed', text: ident.text }
  if (ident.state === 'fact' && review.state !== 'required') return { state: 'fact', text: ident.text }
  return { state: 'unconfirmed', text: review.state === 'required' && ident.state === 'fact' ? `${ident.site}: you have not confirmed this website` : ident.text }
}

export function opportunityCard(l: CardLead, buyerRoles = '', now: Date = new Date()): OpportunityCard {
  const rows = l.enrichments ?? []
  const match = parseMatch(l.icp_match)
  const matched = match ? CRITERIA.filter(([k]) => match[k] === 'match').map(([, n]) => n) : []
  const unknown = match ? CRITERIA.filter(([k]) => match[k] === 'unknown').map(([, n]) => n) : CRITERIA.map(([, n]) => n)
  const whyThisBusiness = l.fit == null ? 'Not graded against your profile yet.'
    : matched.length ? `Fits your profile (${l.fit}/5): matches ${matched.join(', ')}.` : `Graded ${l.fit}/5 against your profile; no single criterion confirmed.`

  const ageDays = l.event_date ? Math.floor((now.getTime() - Date.parse(`${l.event_date}T00:00:00Z`)) / 86_400_000) : null
  // date_status 'verified' is a legacy nearby-year verdict, not proof the page dates the EVENT; same wording as the lead
  // list and CSV (date-copy.ts). Never "confirmed on the page" (#198 live acceptance finding).
  const dateNote = !l.event_date ? 'event date unknown' : `${eventDateCopy(l.event_date, l.date_status)}, ${ageDays} days ago`

  const people: PersonContact[] = rows.filter(r => r.kind === 'contact' || r.kind === 'person').map(r => {
    const sep = r.kind === 'person' ? ', ' : ' - '; const i = r.value.indexOf(sep)
    return { name: (i < 0 ? r.value : r.value.slice(0, i)).trim(), title: i < 0 ? null : r.value.slice(i + sep.length).trim(), linkedin: r.source_url || null, connector: r.connector }
  })
  const top = recommendedPerson(people, buyerRoles) ?? undefined
  const ident = identityOf(l, rows)
  // The SAME two rules createDraft enforces, not email syntax: publishedContact picks the address and classifies its
  // purpose from its own context label (support/privacy usage is rejected even when the local part is "hello");
  // domainReviewFor says whether the address's origin needs the user's website review. A contact that equals the address
  // the crawler recorded is NOT proof the cited page printed it, so "printed on the cited page" needs both: the contact
  // is an email and no review is required for it.
  const pc = publishedContact({ contact: l.contact, source_url: l.source_url, evidence_excerpt: l.evidence_excerpt, enrichments: rows })
  const review = domainReviewFor({ id: l.id ?? '', contact: l.contact }, rows)
  const citedEmail = PUBLISHED_EMAIL_RE.test((l.contact ?? '').trim().toLowerCase()) && pc?.source === 'lead' && review.state !== 'required'
  const who = top ? { name: top.name, title: top.title, link: top.linkedin, identity: citedEmail ? 'address printed on the cited page' : ident ? ident.text : 'company site not identified' } : null

  // Channels, only as far as the contact evidence supports them: what createDraft would accept (a press/support/careers
  // style inbox or context label cannot be drafted to); a phone number is a phone number, not an email draft.
  const draftable = !!pc && pc.purpose !== 'non-sales'
  const phone = PHONE.test(l.contact ?? '') || rows.some(r => r.kind === 'phone' && r.value)

  const machineQuote = !l.review_reason && !!l.evidence_excerpt && l.confidence != null
  const humanQuote = !machineQuote && !!l.evidence_excerpt && l.human_confirmed_at != null
  const facts: string[] = []; const assumptions: string[] = []; const missing: string[] = []
  if (machineQuote) facts.push('The quoted text was found on the cited page when the scan ran.')
  if (ident?.state === 'fact') facts.push(`Company site ${ident.text}.`)
  if (humanQuote) assumptions.push('You reviewed the quote yourself; dazl did not confirm it on the page.')
  if (l.fit != null) assumptions.push('Fit is the model\'s grade of the evidence, not something the company confirmed.')
  assumptions.push('The event is a reason to look closer, not proof they want to buy.')
  if (l.intent === 0) assumptions.push('No live buying trigger was confirmed.')
  if (top) assumptions.push(`${top.name} is listed with this title; current role not verified.`)
  if (ident && ident.state !== 'fact') assumptions.push(`Company site ${ident.text}.`)
  if (!l.event_date) missing.push('event date')
  else assumptions.push(`The date ${l.event_date} is the event day as claimed; the page was not shown to date the event itself.`)
  if (!top) missing.push(people.length ? 'a current buyer (every listed person has a past, negated or assistant-to title)' : 'a named person to approach')
  if (!ident && !citedEmail) missing.push('the company\'s own website')
  if (!draftable && !phone) missing.push('an email or phone')
  for (const u of unknown) missing.push(`${u} (not shown in the evidence)`)

  // Next action never runs ahead of the gates: quarantine, the user's time window, unconfirmed timing, source review,
  // identity, then the channel the evidence actually supports. A research event is context, not a confirmed need.
  const identityOpen = !citedEmail && (review.state === 'required' || !ident || ident.state === 'unconfirmed' || ident.state === 'conflict')
  const next = l.quarantined_at ? 'None: quarantined.'
    : l.window_held ? 'None: outside the time window you asked for, or undated. Research only.'
    : l.review_reason ? 'Check the source yourself before using this lead.'
    : l.currentness_held ? 'Review the source to confirm the timing before any outreach.'
    : !top ? 'Find the decision-maker before reaching out.'
    : identityOpen ? (ident?.state === 'conflict' ? 'Settle which website is theirs before reaching out.' : ident ? `Confirm ${ident.site} is their site before reaching out.` : 'Identify the company\'s own website before reaching out.')
    : draftable ? (leadContactFacts({ contact: l.contact, source_url: l.source_url, evidence_excerpt: l.evidence_excerpt, enrichments: rows }, { name: top.name })?.route === 'person' ? `Draft a first message to ${top.name} introducing your offer; mention the event only as context.` : `Draft a first message to the company inbox (${pc!.email}), which is not tied to ${top.name}: ask for them by name and mention the event only as context.`)
    : phone ? `Call using the published number; there is no usable email to draft to.`
    : `Find a way to reach ${top.name}.`

  return { whyThisBusiness, whyNow: { claim: l.signal, date: l.event_date, dateNote, source: l.source_url, quote: l.evidence_excerpt }, who, angle: l.why, facts, assumptions, missing, next }
}
