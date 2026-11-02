// Contact route (#384): three separate facts about a lead's contact, never merged into one "verified".
//   provenance    - WHERE the address or number was published, the page, and when dazl last read it. A published
//                   address proves only that the company printed it; when it was first published is never known.
//   deliverability - whether mail to it would arrive: not checked / domain invalid / mail server found / catch-all /
//                   mailbox accepted / mailbox rejected. Only a recorded check moves it off "not checked"; a pattern
//                   guess or a catch-all domain is never treated as a confirmed mailbox.
//   personRoute   - whether the route reaches the named person: a shared company inbox, a restricted (recruiting,
//                   support, press...) inbox, an address carrying the person's own name, or unknown. A generic or
//                   restricted inbox never becomes the founder's / buyer's address because a founder is named.
// Plus the channel: email readiness is separate from phone-only reachability.
// Pure: reads the lead's stored fields and enrichment rows only. Nothing here fetches, resolves DNS or guesses.
import { pickCrawledEmail, publishedContact, PUBLISHED_EMAIL_RE } from './published-email.ts'
import type { ContactContext } from './contact-context.ts'

export interface RouteRow { connector: string; kind: string; value: string; label?: string | null; source_url?: string | null; retrieved_at?: number | null }
export interface RouteLead {
  contact: string | null
  source_url: string
  evidence_excerpt?: string | null
  contact_context?: ContactContext | null
  enrichments?: RouteRow[]
}
export interface RoutePerson { name: string; title: string | null; roleRelevant: boolean | null }

export type ProvenanceState = 'cited_page' | 'company_site' | 'none'
export type DeliverabilityState = 'not_checked' | 'domain_invalid' | 'mail_server_found' | 'catch_all' | 'mailbox_accepted' | 'mailbox_rejected'
export type PersonRouteState = 'person_named_address' | 'shared_inbox' | 'restricted_inbox' | 'owner_unknown' | 'phone_only' | 'none'
export type EmailReadiness = 'blocked' | 'uncertain' | 'checked' | 'none'

export interface ContactRoute {
  channel: 'email' | 'phone_only' | 'none'
  email: string | null
  phone: string | null
  provenance: { state: ProvenanceState; url: string | null; lastReadAt: number | null; ageDays: number | null; stale: boolean; text: string }
  deliverability: { state: DeliverabilityState; checkedAt: number | null; text: string }
  personRoute: { state: PersonRouteState; roleRelevant: boolean | null; text: string }
  emailReadiness: EmailReadiness
}

// A contact last read longer ago than this may have changed; it is shown as possibly out of date, never refreshed silently.
export const STALE_CONTACT_DAYS = 180
// The recorded deliverability check format: an enrichment row kind 'deliverability', value `<email>|<verdict>`,
// retrieved_at = when the check ran. Verdicts a checker may record; anything else is ignored (stays not checked).
export const DELIVERABILITY_VERDICTS = ['no_mx', 'mx_found', 'catch_all', 'accepted', 'rejected'] as const
type Verdict = typeof DELIVERABILITY_VERDICTS[number]
const DOMAIN_VERDICTS = new Set<string>(['no_mx', 'mx_found', 'catch_all'])

// Domains that can never receive mail (RFC 2606 / 6761 reserved names, single-label hosts, IP literals).
// '.example' and '.test' are reserved too, but every synthetic fixture in this repo uses them; they stay valid here so
// fixtures exercise the real paths.
const RESERVED_TLD = new Set(['invalid', 'localhost', 'local', 'internal', 'onion'])
export function emailDomainInvalid(email: string): boolean {
  const host = (email.split('@')[1] ?? '').trim().toLowerCase().replace(/\.$/, '')
  if (!host || !host.includes('.') || /^\[|^\d+(\.\d+){3}$/.test(host)) return true
  const labels = host.split('.')
  if (labels.some(l => !l || l.length > 63 || l.startsWith('-') || l.endsWith('-'))) return true
  return RESERVED_TLD.has(labels[labels.length - 1])
}

const PHONE = /\+?\d[\d\s().-]{6,}\d/
const norm = (v: string | null | undefined) => (v ?? '').trim().toLowerCase()
const GENERIC_LOCAL = /^(?:hello|hi|info|information|contact|contactus|enquiries|enquiry|inquiries|inquiry|office|admin|team|sales|mail|general|reception|frontdesk|bookings?|appointments?|studio|clinic|hq|business|partners?|partnerships?|newbusiness)$/

// Does the address's local part carry this person's own name (first, last, first.last, flast, firstl...)? A published
// address shaped like the person's name is the only person binding read here; a shared inbox never is.
function nameBound(local: string, name: string): boolean {
  const parts = name.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').match(/[a-z]+/g) ?? []
  if (parts.length === 0) return false
  const l = local.split('+')[0].replace(/[._-]/g, '')
  const first = parts[0] ?? '', last = parts[parts.length - 1] ?? ''
  const shapes = new Set([first, `${first}${last}`, `${first[0]}${last}`, `${first}${last[0]}`, `${last}${first}`, `${last}${first[0]}`])
  if (parts.length === 1) return l === first && first.length >= 3
  return shapes.has(l) || (l === last && last.length >= 4)
}

function deliverabilityOf(email: string, rows: RouteRow[], now: number): ContactRoute['deliverability'] {
  if (emailDomainInvalid(email)) return { state: 'domain_invalid', checkedAt: null, text: `Deliverability: fails. ${email.split('@')[1]} is not a domain that can receive mail.` }
  const recorded = rows
    .filter(r => r.kind === 'deliverability')
    .map(r => { const [addr, verdict] = r.value.toLowerCase().split('|'); return { addr, verdict: verdict as Verdict, at: r.retrieved_at ?? null } })
    // A domain-level row (`@domain|verdict`) can only say something about the domain, never accept one mailbox.
    .filter(r => (DELIVERABILITY_VERDICTS as readonly string[]).includes(r.verdict) && (r.addr === email || (r.addr === `@${email.split('@')[1]}` && DOMAIN_VERDICTS.has(r.verdict))))
    .sort((a, b) => (b.at ?? 0) - (a.at ?? 0))[0]
  if (!recorded) return { state: 'not_checked', checkedAt: null, text: 'Deliverability: not checked. Being published does not prove the mailbox still works.' }
  const when = recorded.at ? ` (checked ${dayOf(recorded.at)}${daysSince(recorded.at, now) > STALE_CONTACT_DAYS ? ', over 6 months ago' : ''})` : ''
  switch (recorded.verdict) {
    case 'no_mx': return { state: 'domain_invalid', checkedAt: recorded.at, text: `Deliverability: fails. ${email.split('@')[1]} has no mail server${when}.` }
    case 'rejected': return { state: 'mailbox_rejected', checkedAt: recorded.at, text: `Deliverability: fails. The mail server rejected this mailbox${when}.` }
    case 'catch_all': return { state: 'catch_all', checkedAt: recorded.at, text: `Deliverability: uncertain. The domain accepts any address (catch-all), so this mailbox is not confirmed${when}.` }
    case 'mx_found': return { state: 'mail_server_found', checkedAt: recorded.at, text: `Deliverability: uncertain. The domain has a mail server; this mailbox was not checked${when}.` }
    case 'accepted': return { state: 'mailbox_accepted', checkedAt: recorded.at, text: `Deliverability: the mail server accepted this mailbox${when}. That is not proof it reaches the right person.` }
  }
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const dayOf = (sec: number) => { const d = new Date(sec * 1000); return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}` }
const daysSince = (sec: number, now: number) => Math.floor((now - sec * 1000) / 86_400_000)
const hostOf = (u: string | null) => { if (!u) return null; try { return new URL(u).hostname.replace(/^www\./, '') } catch { return u } }

// `person`: the card's recommended person (opportunityCard.who) with whether the title matches the scan's buyer roles
// (null when no buyer roles were given). `now` in ms.
export function contactRoute(l: RouteLead, person: RoutePerson | null, now: number = Date.now()): ContactRoute {
  const rows = l.enrichments ?? []
  const direct = norm(l.contact)
  const crawled = PUBLISHED_EMAIL_RE.test(direct) ? null : pickCrawledEmail(rows)
  const email = PUBLISHED_EMAIL_RE.test(direct) ? direct : crawled && PUBLISHED_EMAIL_RE.test(norm(crawled.value)) ? norm(crawled.value) : null
  const phoneRow = rows.find(r => r.kind === 'phone' && PHONE.test(r.value))
  const phone = !email && PHONE.test(l.contact ?? '') ? (l.contact ?? '').trim() : phoneRow ? phoneRow.value.trim() : null
  const channel = email ? 'email' : phone ? 'phone_only' : 'none'

  // Provenance: the page that printed the route and when dazl last read it. First-published dates are never recorded.
  const fromLead = email ? email === direct : !!phone && PHONE.test(l.contact ?? '')
  const row = fromLead ? null : email ? crawled : phoneRow ?? null
  const url = fromLead ? l.source_url : row?.source_url ?? null
  const lastReadAt = row?.retrieved_at ?? null
  const ageDays = lastReadAt ? daysSince(lastReadAt, now) : null
  const stale = ageDays !== null && ageDays > STALE_CONTACT_DAYS
  const what = email ? 'Address' : 'Number'
  const read = fromLead ? 'read when the scan ran' : lastReadAt ? `last read ${dayOf(lastReadAt)}${stale ? ` (${ageDays} days ago, may be out of date)` : ''}` : 'when it was read is not recorded'
  const provenance: ContactRoute['provenance'] = channel === 'none'
    ? { state: 'none', url: null, lastReadAt: null, ageDays: null, stale: false, text: 'Published contact: none stored.' }
    : { state: fromLead ? 'cited_page' : 'company_site', url, lastReadAt, ageDays, stale, text: `Published: ${what.toLowerCase()} printed on ${fromLead ? 'the cited page' : 'the company website'}${hostOf(url) ? ` (${hostOf(url)})` : ''}, ${read}; when it was first published is unknown.` }

  const deliverability: ContactRoute['deliverability'] = email ? deliverabilityOf(email, rows, now)
    : { state: 'not_checked', checkedAt: null, text: phone ? 'Deliverability: no email address; a phone number is not email readiness.' : 'Deliverability: nothing to check.' }

  // Person route: who the route actually reaches. Restricted purpose first: a careers/support inbox is never a buyer's.
  const who = person ? `${person.name}${person.title ? ` (${person.title})` : ''}` : null
  const roleNote = person?.roleRelevant === false ? ` ${person.name}'s listed title does not match your buyer roles.` : person?.roleRelevant ? '' : person ? ' Whether the title matches your buyer roles is not known.' : ''
  let personRoute: ContactRoute['personRoute']
  if (!email) {
    personRoute = phone
      ? { state: 'phone_only', roleRelevant: null, text: `Person route: phone only, a company number${who ? `, not confirmed as ${who}'s line` : ''}. No email route.` }
      : { state: 'none', roleRelevant: null, text: 'Person route: no route stored.' }
  } else {
    const local = email.split('@')[0]
    // The same purpose rule createDraft applies (published-email.ts), so the card and the gate agree.
    const purpose = publishedContact({ contact: l.contact, source_url: l.source_url, evidence_excerpt: l.evidence_excerpt, contact_context: l.contact_context, enrichments: rows.map(r => ({ ...r, label: r.label ?? null })) })
    if (purpose?.purpose === 'non-sales') personRoute = { state: 'restricted_inbox', roleRelevant: false, text: `Person route: ${local}@ is a restricted inbox (${purpose.purposeHint ?? 'not for sales'}), not a sales route${who ? ` and not ${person!.name}'s address` : ''}.` }
    else if (person && nameBound(local, person.name)) personRoute = { state: 'person_named_address', roleRelevant: person.roleRelevant, text: `Person route: the published address carries ${person.name}'s name; current role not verified.${roleNote}` }
    else if (GENERIC_LOCAL.test(local.split('+')[0].replace(/[._-]/g, ''))) personRoute = { state: 'shared_inbox', roleRelevant: null, text: `Person route: ${local}@ is a shared company inbox${who ? `, not ${who}'s own address` : '; no named person'}.` }
    else personRoute = { state: 'owner_unknown', roleRelevant: null, text: `Person route: whose mailbox ${local}@ is was not established${who ? `; not shown to be ${person!.name}'s` : ''}.` }
  }

  const emailReadiness: EmailReadiness = !email ? 'none'
    : deliverability.state === 'domain_invalid' || deliverability.state === 'mailbox_rejected' || personRoute.state === 'restricted_inbox' ? 'blocked'
    : deliverability.state === 'mailbox_accepted' ? 'checked' : 'uncertain'
  return { channel, email, phone, provenance, deliverability, personRoute, emailReadiness }
}

// The one deliverability refusal shared by the lead card and createDraft: a domain that cannot receive mail or a
// recorded failed check. Unknown, mail-server-found and catch-all do not block (they are shown as uncertain).
export function deliverabilityBlocked(email: string, rows: RouteRow[]): boolean {
  const s = deliverabilityOf(norm(email), rows, Date.now()).state
  return s === 'domain_invalid' || s === 'mailbox_rejected'
}
