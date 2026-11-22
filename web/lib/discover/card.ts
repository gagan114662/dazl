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
export interface DiscoverContact { person: { name: string; title: string | null; linkedin: string | null; source: string | null } | null; email: { address: string; source: string } | null }
type Row = { kind: string; connector?: string; value?: string; source_url?: string | null }
const EMAIL = /^[a-z0-9._%+-]{1,64}@(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/
export function discoverContact(l: { source_kind?: string | null; name?: string | null; enrichments?: Row[] }): DiscoverContact | null {
  if (!isDiscoverLead(l)) return null
  const rows = (l.enrichments ?? []).filter(r => r.connector === 'discover')
  const p = rows.find(r => r.kind === 'person' && r.value), e = rows.find(r => r.kind === 'email' && r.value && r.source_url && EMAIL.test(r.value.trim().toLowerCase()))
  const li = rows.find(r => r.kind === 'linkedin' && r.value)
  let person: DiscoverContact['person'] = null
  if (p) {
    const i = p.value!.indexOf(', ')
    person = { name: (i < 0 ? p.value! : p.value!.slice(0, i)).trim(), title: i < 0 ? null : p.value!.slice(i + 2).trim() || null, linkedin: li?.value ?? null, source: p.source_url ?? null }
  } else if ((l.name ?? '').trim()) person = { name: l.name!.trim(), title: null, linkedin: li?.value ?? null, source: null }
  return { person, email: e ? { address: e.value!.trim().toLowerCase(), source: e.source_url! } : null }
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
export const signalStale = (eventDate: string | null | undefined, now: Date = new Date()): boolean => {
  const t = Date.parse(`${(eventDate ?? '').slice(0, 10)}T00:00:00Z`)
  return Number.isFinite(t) && now.getTime() - t > SIGNAL_MAX_AGE_DAYS * 86_400_000
}
// Whether a person can approve a discovery lead (a draft email for them to review; nothing is sent), and if not, the one thing to do.
// Same rules as lib/outreach/service.ts discoverDraftChecks. The inbox-purpose and deliverability rules are applied by the caller
// (lib/scan/lead-card.ts), which already has them.
export function discoverApprove(l: { quarantined_at?: number | null; gate_held?: boolean | null; review_reason?: string | null; event_date?: string | null; company_domain?: string | null; fit?: number | null; intent?: number | null; source_kind?: string | null; name?: string | null; enrichments?: Row[]; recipient_refused?: string | null }, now: Date = new Date()): { ok: true } | { ok: false; reason: string } {
  if (l.quarantined_at) return { ok: false, reason: 'Rejected. Undo to use it again.' }
  if (l.gate_held) return { ok: false, reason: 'A required check has not passed. Research only.' }
  if (l.review_reason) return { ok: false, reason: 'dazl could not confirm this lead\'s proof page. Check the source under Needs your review first.' }
  if (!l.event_date) return { ok: false, reason: 'The signal has no date, so its timing is unknown. Open the proof to check it.' }
  if (signalStale(l.event_date, now)) return { ok: false, reason: 'The signal is more than a year old. It stays here as background; it is not a reason to write now.' }
  if (l.fit === 0 && l.intent === null) return { ok: false, reason: 'Graded as not a fit for your profile.' }
  const c = discoverContact(l)
  if (!c?.email) return { ok: false, reason: c?.person?.linkedin ? 'No email address is published for this lead. Reach them through their LinkedIn profile.' : 'No email address is published for this lead yet.' }
  if (!emailOnCompanySite(c.email.address, c.email.source, l.company_domain)) return { ok: false, reason: 'The address was not found on the company\'s own website, only on another site.' }
  // the server's own verdict on the address (lib/outreach/service.ts discoverRecipientRefusal), sent with the lead: a personal mailbox
  // (a free webmail address, even one the company's site prints) or an address on the workspace's do-not-contact list
  if (l.recipient_refused === 'personal_email') return { ok: false, reason: 'The published address is a personal mailbox (free webmail), not a company address.' }
  if (l.recipient_refused) return { ok: false, reason: 'This address is on your do-not-contact list.' }
  return { ok: true }
}
