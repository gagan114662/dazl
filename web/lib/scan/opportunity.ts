// Opportunity card (owner direction, issue #204): every lead reads as one decision, not a list of fields.
//   why this business - which profile criteria the grading matched
//   why now           - the dated event, its date status and the actual source
//   who               - the person to approach first, with how the company site was identified
//   angle             - the grading's own "why"
//   facts / assumptions / missing - certainty split, so an opening is never presented as proof of buyer intent
//   next              - one recommended next action
// Pure: built only from what the lead already stores. Nothing here is fetched, guessed or invented; anything unknown
// is listed under missing.
import { rankPeople, type PersonContact } from '../people/rank.ts'

export interface CardLead {
  company: string; signal: string; source_url: string; evidence_excerpt: string | null
  event_date: string | null; date_status: string | null; review_reason: string | null
  fit: number | null; intent: number | null; why: string | null; icp_match: string | null
  company_domain: string | null; contact: string | null; quarantined_at?: number | null
  enrichments?: { connector: string; kind: string; value: string; label: string | null; source_url: string }[]
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
const EMAIL_OR_PHONE = /[^\s@]+@[^\s@]+\.[a-z]{2,}|\+?\d[\d\s().-]{6,}\d/i

function identityOf(rows: NonNullable<CardLead['enrichments']>): { text: string; confirmed: boolean } | null {
  const d = rows.find(r => r.kind === 'domain' && r.connector === 'sitecrawl')
  if (!d) return null
  const [site, basis] = d.value.split('|')
  if (basis === 'own_domain') return { text: `${site}: the cited page is on this site`, confirmed: true }
  if (basis === 'evidence_link_domain_label') return { text: `${site}: linked from the cited page`, confirmed: true }
  if (basis === 'evidence_link_text') return { text: `${site}: linked from the cited page by link text only`, confirmed: false }
  return { text: `${site}: found by name search (name and location matched), not linked from the source`, confirmed: false }
}

export function opportunityCard(l: CardLead, buyerRoles = '', now: Date = new Date()): OpportunityCard {
  const rows = l.enrichments ?? []
  const match = parseMatch(l.icp_match)
  const matched = match ? CRITERIA.filter(([k]) => match[k] === 'match').map(([, n]) => n) : []
  const unknown = match ? CRITERIA.filter(([k]) => match[k] === 'unknown').map(([, n]) => n) : CRITERIA.map(([, n]) => n)
  const whyThisBusiness = l.fit == null ? 'Not graded against your profile yet.'
    : matched.length ? `Fits your profile (${l.fit}/5): matches ${matched.join(', ')}.` : `Graded ${l.fit}/5 against your profile; no single criterion confirmed.`

  const ageDays = l.event_date ? Math.floor((now.getTime() - Date.parse(`${l.event_date}T00:00:00Z`)) / 86_400_000) : null
  const dateNote = !l.event_date ? 'event date unknown' : l.date_status === 'verified' ? `dated ${l.event_date} (${ageDays} days ago), date confirmed on the page` : `dated ${l.event_date} (${ageDays} days ago), date not confirmed on the page`

  const people: PersonContact[] = rows.filter(r => r.kind === 'contact' || r.kind === 'person').map(r => {
    const sep = r.kind === 'person' ? ', ' : ' - '; const i = r.value.indexOf(sep)
    return { name: (i < 0 ? r.value : r.value.slice(0, i)).trim(), title: i < 0 ? null : r.value.slice(i + sep.length).trim(), linkedin: r.source_url || null, connector: r.connector }
  })
  const top = rankPeople(people, buyerRoles)[0]
  const ident = identityOf(rows)
  const who = top ? { name: top.name, title: top.title, link: top.linkedin, identity: ident ? ident.text : 'company site not identified' } : null

  const facts: string[] = []; const assumptions: string[] = []; const missing: string[] = []
  if (!l.review_reason && l.evidence_excerpt) facts.push('The quoted text is on the cited page (checked when the scan ran).')
  if (l.event_date && l.date_status === 'verified') facts.push(`The event date ${l.event_date} appears on the page.`)
  if (ident?.confirmed) facts.push(`Company site ${ident.text}.`)
  if (l.fit != null) assumptions.push('Fit is the model\'s grade of the evidence, not something the company confirmed.')
  assumptions.push('The event is a reason to look closer, not proof they want to buy.')
  if (l.intent === 0) assumptions.push('No live buying trigger was confirmed.')
  if (top) assumptions.push(`${top.name} is listed with this title; current role not verified.`)
  if (ident && !ident.confirmed) assumptions.push(`Company site ${ident.text}.`)
  if (!l.event_date) missing.push('event date')
  if (!top) missing.push('a named person to approach')
  const reachable = EMAIL_OR_PHONE.test(l.contact ?? '') || rows.some(r => (r.kind === 'email' || r.kind === 'phone') && r.value)
  if (!reachable) missing.push('an email or phone')
  for (const u of unknown) missing.push(`${u} (not shown in the evidence)`)

  const next = l.quarantined_at ? 'None: quarantined.'
    : l.review_reason ? 'Check the source yourself before using this lead.'
    : !top ? 'Find the decision-maker before reaching out.'
    : !reachable ? `Find a way to reach ${top.name}.`
    : ident && !ident.confirmed ? `Confirm ${ident.text.split(':')[0]} is their site, then draft a first message about: ${l.signal}`
    : `Draft a first message to ${top.name} about: ${l.signal}`

  return { whyThisBusiness, whyNow: { claim: l.signal, date: l.event_date, dateNote, source: l.source_url, quote: l.evidence_excerpt }, who, angle: l.why, facts, assumptions, missing, next }
}
