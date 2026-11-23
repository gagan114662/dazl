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
  if (signalDay(l.event_date) === null) missing.push('a date for the signal')   // the same reading Approve uses: a value that is not a day is no date
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
  const person = from('person'), email = shownRecipient(l.enrichments ?? []), linkedin = from('linkedin')
  if (person) out.push({ field: 'person', label: 'Person', url: person.source_url! })
  if (email) out.push({ field: 'email', label: 'Email', url: email.source })   // the page of the address the card shows and the draft uses
  if (linkedin?.value) out.push({ field: 'linkedin', label: 'LinkedIn', url: linkedin.value })
  return out
}

// The person and the published email a discovery lead carries, with the pages they came from. These are the rows the run stored
// (connector 'discover'); nothing is matched, ranked or inferred here. The person was chosen by the run for this seller's offer.
export interface DiscoverContact { person: { name: string; title: string | null; linkedin: string | null; source: string | null } | null; email: { address: string; source: string } | null }
type Row = { kind: string; connector?: string; value?: string; source_url?: string | null; retrieved_at?: number | null }
const EMAIL = /^[a-z0-9._%+-]{1,64}@(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/
export function discoverContact(l: { source_kind?: string | null; name?: string | null; enrichments?: Row[] }): DiscoverContact | null {
  if (!isDiscoverLead(l)) return null
  const rows = (l.enrichments ?? []).filter(r => r.connector === 'discover')
  const p = rows.find(r => r.kind === 'person' && r.value), e = shownRecipient(rows)
  const li = rows.find(r => r.kind === 'linkedin' && r.value)
  let person: DiscoverContact['person'] = null
  if (p) {
    const i = p.value!.indexOf(', ')
    person = { name: (i < 0 ? p.value! : p.value!.slice(0, i)).trim(), title: i < 0 ? null : p.value!.slice(i + 2).trim() || null, linkedin: li?.value ?? null, source: p.source_url ?? null }
  } else if ((l.name ?? '').trim()) person = { name: l.name!.trim(), title: null, linkedin: li?.value ?? null, source: null }
  return { person, email: e }
}
// The ONE published address of a discovery lead. Every reader uses this and nothing else: the card, the card's recipient hold and the
// draft the server writes (lib/outreach/service.ts), so the address shown is the address written to. (Review of #1578: the card took
// the first row it was handed and the server the earliest stored; with two addresses they could differ.)
// Which one: among the run's own email rows that are an address and name the page that prints it, the earliest stored; stored at the
// same instant, the address first in order. A row that is not an address, or names no page, is not a published address.
// "An address" is read loosely here on purpose (something@something.tld): a row that only nearly is one is still the chosen row, and
// the stricter checks of the card and of the server then hold the lead. Reading it strictly would pass over such a row and move on to
// the next address, which is exactly how a held address is escaped.
// The choice never asks whether the address may be written to. A chosen address that is suppressed, personal or off the company's
// site holds the lead; it is never passed over for the next one.
const ADDRESS_LIKE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
// What the card shows and links for it: the chosen address, when it is a well-formed one. Otherwise nothing is shown, never another row.
const shownRecipient = (rows: Row[]): { address: string; source: string } | null => { const c = discoverRecipient(rows); return c && EMAIL.test(c.address) ? c : null }
export function discoverRecipient(rows: Row[]): { address: string; source: string } | null {
  const order = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)
  const c = rows.filter(r => r.connector === 'discover' && r.kind === 'email' && !!r.source_url)
    .map(r => ({ address: (r.value ?? '').trim().toLowerCase(), source: r.source_url!, at: r.retrieved_at ?? Number.MAX_SAFE_INTEGER }))
    .filter(r => ADDRESS_LIKE.test(r.address))
    .sort((a, b) => a.at - b.at || order(a.address, b.address) || order(a.source, b.source))
  return c.length ? { address: c[0].address, source: c[0].source } : null
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
// A signal older than this is history, not a reason to write now: the lead keeps its card and its proof, and Approve stays off.
export const SIGNAL_MAX_AGE_DAYS = 365
// The day a stored signal date names (its first ten characters, YYYY-MM-DD), as a time, or null when that is not a real calendar day:
// "soon", "2026", "2026-10" and "2026-02-30" are not days.
export const signalDay = (eventDate: string | null | undefined): number | null => {
  const d = (eventDate ?? '').slice(0, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return null
  const t = Date.parse(`${d}T00:00:00Z`)
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === d ? t : null
}
export const signalStale = (eventDate: string | null | undefined, now: Date = new Date()): boolean => {
  const t = signalDay(eventDate)
  return t !== null && now.getTime() - t > SIGNAL_MAX_AGE_DAYS * 86_400_000
}
// Why a discovery lead's signal cannot carry outreach right now, or null: the ONE timing rule of the card, of draft creation and of the
// shared gate approve and send re-read (lib/outreach/currentness.ts). 'undated': no date, or a stored value that does not read as a
// day (it was "has a date" to the gate before; review of #1578). 'stale': more than a year old. Exactly a year old is still in.
export const signalHeld = (eventDate: string | null | undefined, now: Date = new Date()): 'undated' | 'stale' | null => {
  if (signalDay(eventDate) === null) return 'undated'
  return signalStale(eventDate, now) ? 'stale' : null
}
// Whether a person can approve a discovery lead (a draft email for them to review; nothing is sent), and if not, the one thing to do.
// Same rules as lib/outreach/service.ts discoverDraftChecks. The inbox-purpose and deliverability rules are applied by the caller
// (lib/scan/lead-card.ts), which already has them.
export function discoverApprove(l: { quarantined_at?: number | null; gate_held?: boolean | null; review_reason?: string | null; event_date?: string | null; company_domain?: string | null; fit?: number | null; intent?: number | null; source_kind?: string | null; name?: string | null; enrichments?: Row[]; recipient_refused?: string | null }, now: Date = new Date()): { ok: true } | { ok: false; reason: string } {
  if (l.quarantined_at) return { ok: false, reason: 'Rejected. Undo to use it again.' }
  if (l.gate_held) return { ok: false, reason: 'A required check has not passed. Research only.' }
  if (l.review_reason) return { ok: false, reason: 'dazl could not confirm this lead\'s proof page. Check the source under Needs your review first.' }
  const timing = signalHeld(l.event_date, now)
  if (timing === 'undated') return { ok: false, reason: 'The signal has no date, so its timing is unknown. Open the proof to check it.' }
  if (timing === 'stale') return { ok: false, reason: 'The signal is more than a year old. It stays here as background; it is not a reason to write now.' }
  if (l.fit === 0 && l.intent === null) return { ok: false, reason: 'Graded as not a fit for your profile.' }
  const c = discoverContact(l)
  if (!c?.email) return { ok: false, reason: c?.person?.linkedin ? 'No email address is published for this lead. Reach them through their LinkedIn profile.' : 'No email address is published for this lead yet.' }
  if (!emailOnCompanySite(c.email.address, c.email.source, l.company_domain)) return { ok: false, reason: 'The address was not found on the company\'s own website, only on another site.' }
  // the server's own verdict on the address (lib/outreach/service.ts discoverRecipientRefusal), sent with the lead: a personal mailbox
  // (a free webmail address, even one the company's site prints) or an address on the workspace's do-not-contact list
  if (l.recipient_refused === 'personal_email') return { ok: false, reason: 'The published address is a personal mailbox (free webmail), not a company address.' }
  // the check itself could not be read: not a refusal of the address, and not a pass
  if (l.recipient_refused === 'unreadable') return { ok: false, reason: 'dazl could not check this address just now, so Approve stays off. Reload the page to try again.' }
  if (l.recipient_refused) return { ok: false, reason: 'This address is on your do-not-contact list.' }
  return { ok: true }
}
