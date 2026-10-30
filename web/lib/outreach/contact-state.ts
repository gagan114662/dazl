// #384: explicit contact states. A published address proves PROVENANCE (it literally appears on a page); it does not prove the mailbox works, nor that it belongs to
// the recommended decision-maker. These are separate facts, each three-valued, and none is ever inferred from another. Pattern guesses and catch-all domains are never
// "verified". The published-only policy is unchanged: this module adds states, it never adds a source of addresses. The DNS/MX check is injected (no network here).
import { classifyPurpose, PUBLISHED_EMAIL_RE } from './published-email.ts'

export type Tri = 'yes' | 'no' | 'unknown'
export type Deliverability = 'valid' | 'invalid' | 'catch_all' | 'unknown'   // 'valid' needs a positive mailbox-level check; MX alone is not that
export type Reach = 'email_ready' | 'email_uncertain' | 'phone_only' | 'none'

export interface DomainCheck { checkedAt: number; mx: 'has_mx' | 'no_mx' | 'no_domain' | 'error'; mailbox?: 'accepted' | 'rejected' | 'catch_all' | 'unknown' }
export interface ContactInput {
  email: string | null
  phone?: string | null
  person?: { name: string } | null          // the recommended decision-maker, if one is named
  published?: { sourceUrl: string; excerpt?: string | null; publishedAt?: number | null; fetchedAt?: number | null } | null   // where the address literally appears
  guessed?: boolean                          // a pattern guess (first.last@domain): never published, never verified
  check?: DomainCheck | null
}
export interface ContactState {
  email: string | null
  sourcePublished: Tri
  personBound: Tri
  roleRelevant: Tri
  domain: 'valid' | 'invalid' | 'unchecked'
  deliverability: Deliverability
  lastCheckedAt: number | null
  ageDays: number | null                     // age of the publication, when known; unknown age stays null (never treated as fresh)
  stale: boolean
  reach: Reach
  notes: string[]
}
export const STALE_PUBLICATION_DAYS = 365
export const RECHECK_AFTER_DAYS = 30
const DAY = 86400
const norm = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^a-z]/g, '')

// The local part belongs to the person only when it spells their name (first.last, flast, first, f.last); a role inbox never does.
export function localPartMatchesPerson(email: string, name: string): boolean {
  const local = norm(email.split('@')[0]); const parts = name.trim().split(/\s+/).map(norm).filter(Boolean)
  if (!local || !parts.length) return false
  const first = parts[0], last = parts[parts.length - 1]
  if (parts.length === 1) return local === first && first.length >= 3
  return [first + last, last + first, first[0] + last, first + last[0], first, last].some(c => c === local && c.length >= 3 && (c !== first && c !== last || c.length >= 4))
}

export function contactState(i: ContactInput, now: number): ContactState {
  const notes: string[] = []
  const email = i.email && PUBLISHED_EMAIL_RE.test(i.email.trim()) ? i.email.trim().toLowerCase() : null
  const sourcePublished: Tri = !email ? 'no' : i.guessed ? 'no' : i.published?.sourceUrl ? 'yes' : 'unknown'
  if (i.guessed) notes.push('pattern guess: never published, never verified')
  // person-bound: the address spells the person's name, or the page text next to it names them. A generic or role inbox is never a person's route.
  const purpose = email ? classifyPurpose(email, null).purpose : 'unknown'
  const role: Tri = !email ? 'unknown' : purpose === 'non-sales' ? 'no' : purpose === 'sales' ? 'yes' : 'unknown'
  if (role === 'no') notes.push('support / recruiting / press style inbox: not a sales or founder route')
  const onPage = !!(email && i.person && i.published?.excerpt && norm(i.published.excerpt).includes(norm(i.person.name)))
  const personBound: Tri = !email || !i.person ? 'unknown' : role === 'no' ? 'no' : localPartMatchesPerson(email, i.person.name) || onPage ? 'yes' : 'unknown'
  if (email && i.person && personBound === 'unknown') notes.push('address is not tied to the named person')
  // age: a publication date older than a year keeps its age; no date stays unknown (not fresh)
  const pub = i.published?.publishedAt ?? null
  const ageDays = pub ? Math.max(0, Math.floor((now - pub) / DAY)) : null
  const stale = ageDays !== null && ageDays > STALE_PUBLICATION_DAYS
  if (stale) notes.push(`published ${Math.floor(ageDays! / 365)}+ year(s) ago: may no longer work`)
  if (email && ageDays === null) notes.push('publication date unknown')
  // domain / deliverability ladder
  const c = i.check ?? null
  const domain: ContactState['domain'] = !c ? 'unchecked' : c.mx === 'has_mx' ? 'valid' : c.mx === 'error' ? 'unchecked' : 'invalid'
  let deliverability: Deliverability = 'unknown'
  if (domain === 'invalid') deliverability = 'invalid'
  else if (domain === 'valid' && c?.mailbox === 'catch_all') { deliverability = 'catch_all'; notes.push('catch-all domain: acceptance proves nothing about this mailbox') }
  else if (domain === 'valid' && c?.mailbox === 'rejected') deliverability = 'invalid'
  else if (domain === 'valid' && c?.mailbox === 'accepted' && !i.guessed) deliverability = 'valid'
  else if (domain === 'valid') notes.push('domain accepts mail; the mailbox itself is unchecked')
  if (i.guessed && deliverability === 'valid') deliverability = 'unknown'
  const phone = !!i.phone?.replace(/\D/g, '').match(/^\d{7,15}$/)
  const emailOk = !!email && deliverability !== 'invalid' && role !== 'no' && sourcePublished === 'yes'
  const reach: Reach = emailOk ? (deliverability === 'valid' && !stale ? 'email_ready' : 'email_uncertain') : phone ? 'phone_only' : email && deliverability !== 'invalid' && role !== 'no' ? 'email_uncertain' : 'none'
  return { email, sourcePublished, personBound, roleRelevant: role, domain, deliverability, lastCheckedAt: c?.checkedAt ?? null, ageDays, stale, reach, notes }
}

// A contact is due for a recheck when it was never checked, the last check is old, or the publication itself is stale. Catch-all and unknown never graduate on their own.
export function refreshDue(s: ContactState, now: number): boolean {
  if (!s.email || s.reach === 'none') return false
  return s.lastCheckedAt === null || now - s.lastCheckedAt > RECHECK_AFTER_DAYS * DAY || s.stale
}

// The ladder (policy-consistent): published page text -> syntax -> MX (injected) -> mailbox probe (injected, optional). Never a guess generator.
export async function verifyContact(i: ContactInput, deps: { resolveMx: (domain: string) => Promise<'has_mx' | 'no_mx' | 'no_domain'>; probeMailbox?: (email: string) => Promise<'accepted' | 'rejected' | 'catch_all' | 'unknown'>; now: number }): Promise<ContactState> {
  const email = i.email && PUBLISHED_EMAIL_RE.test(i.email.trim()) ? i.email.trim().toLowerCase() : null
  if (!email || i.guessed) return contactState({ ...i, check: null }, deps.now)
  let mx: DomainCheck['mx']
  try { mx = await deps.resolveMx(email.split('@')[1]) } catch { mx = 'error' }
  let mailbox: DomainCheck['mailbox']
  if (mx === 'has_mx' && deps.probeMailbox) { try { mailbox = await deps.probeMailbox(email) } catch { mailbox = 'unknown' } }
  return contactState({ ...i, check: { checkedAt: deps.now, mx, mailbox } }, deps.now)
}
