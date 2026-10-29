// Scoreboard: how many leads a scan returns that a salesperson could act on today. This is the number every change
// is judged by (docs/DECISIONS.md, "review before main"). Pure scoring only; scripts/scoreboard.ts runs the scans.
//
// Rubric qualified-v2 reports each stage separately, then qualifies with the SAME gates the cards and drafting use
// (heldReason / approveState / publishedEmail / the run report's person-role check), so the scoreboard cannot count a
// lead the product would hold:
//   candidate       - saved lead
//   source_checked  - not in review, not rejected, evidence quote verified
//   fit             - the tenant's model graded ICP fit >= 4 of 5
//   current_event   - a VERIFIED event date inside the request's own window (default 90 days); undated or claimed-only never counts
//   right_person    - a person from the company's own pages whose title is founder-level or the requested role
//   reachable_email - a published, sales-usable email (not a generic hiring/support inbox) on the company's confirmed website domain
//   reachable_phone - a published phone, reported apart from email
//   eligible        - the card's approveState says a draft may be made now (needs the email route)
// QUALIFIED = source_checked + fit + current_event + right_person + no held gate (rejected, review, unverified,
// window, timing, domain not confirmed) + an email or phone route. A name alone is not a right person.
import { heldReason, type PreviewLead } from '../journey.ts'
import { approveState } from './lead-card.ts'
import { personMatchesRole } from './person-role.ts'
import { windowStatus } from './window.ts'
import { publishedEmail } from '../outreach/published-email.ts'
import { evidenceStateOf } from '../outreach/evidence-state.ts'

export const RUBRIC_VERSION = 'qualified-v2'
type Enrich = { connector: string; kind: string; value: string; label?: string | null; source_url?: string | null; retrieved_at?: number | null }
export interface ScoredLeadInput {
  name: string
  contact: string | null
  review_reason: string | null
  event_date: string | null
  fit: number | null
  contacts: string[] // values of contact enrichments for this lead
  // Gate inputs. Absent means "not proven": the stage fails rather than passes.
  id?: string; company?: string; signal?: string; source_url?: string
  date_status?: string | null; evidence_excerpt?: string | null; confidence?: number | null; human_confirmed_at?: number | null
  quarantined_at?: number | null; company_domain?: string | null; intent?: number | null
  enrichments?: Enrich[]
}
export interface ScoreOptions { windowDays?: number; who?: string }

export interface LeadScoreCard { verified: boolean; recent: boolean; fit: boolean; named: boolean; reachable: boolean; qualified: boolean; sourceChecked: boolean; currentEvent: boolean; rightPerson: boolean; email: boolean; phone: boolean; eligible: boolean }
export interface SearchScore { leads: number; verified: number; recent: number; fit: number; named: number; reachable: number; qualified: number; sourceChecked: number; currentEvent: number; rightPerson: number; email: number; phone: number; eligible: number }

const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i
const PHONE = /\+?\d[\d\s().-]{6,}\d/
export const RECENT_DAYS = 90
export const FIT_MIN = 4

export const isReachable = (v: string | null | undefined): boolean => !!v && (EMAIL.test(v) || PHONE.test(v))

const asPreview = (l: ScoredLeadInput, windowHeld: boolean): PreviewLead => ({
  id: l.id ?? 'x', company: l.company ?? '', signal: l.signal ?? '', source_url: l.source_url ?? '', evidence_excerpt: l.evidence_excerpt ?? null,
  event_date: l.event_date, date_status: l.date_status ?? null, review_reason: l.review_reason, fit: l.fit, intent: l.intent ?? null, why: null, icp_match: null,
  company_domain: l.company_domain ?? null, contact: l.contact, quarantined_at: l.quarantined_at ?? null, confidence: l.confidence ?? null, human_confirmed_at: l.human_confirmed_at ?? null,
  currentness_held: false, window_held: windowHeld, enrichments: (l.enrichments ?? []).map(e => ({ ...e, label: e.label ?? null, source_url: e.source_url ?? '' })),
})

export function scoreLead(l: ScoredLeadInput, now: Date = new Date(), opts: ScoreOptions = {}): LeadScoreCard {
  const windowDays = opts.windowDays ?? RECENT_DAYS, who = opts.who || 'founder'
  const inside = windowStatus(l.event_date, windowDays, now) === 'inside'
  // Only a verified date counts as current: a date the page merely claims is research, not a reason to act now.
  const currentEvent = inside && l.date_status === 'verified'
  const card = asPreview(l, !inside)
  const held = heldReason(card)   // rejected, in review, source not verified, outside window, timing unknown, no verified date, website not confirmed, not a fit
  const sourceChecked = !l.review_reason && !l.quarantined_at && evidenceStateOf({ evidence_excerpt: card.evidence_excerpt, confidence: card.confidence ?? null, human_confirmed_at: card.human_confirmed_at ?? null }) !== 'unverified'
  const fit = typeof l.fit === 'number' && l.fit >= FIT_MIN
  const rows = l.enrichments ?? []
  const rightPerson = rows.some(r => r.connector === 'sitecrawl' && r.kind === 'person' && personMatchesRole(r.value, who))
  // The route must sit on the company's confirmed website: an address printed on the cited page for some other domain is not this company's route.
  const domain = (l.company_domain ?? '').trim().toLowerCase().replace(/^www\./, '')
  const pe = publishedEmail(card)?.split('@')[1]?.toLowerCase() ?? ''
  const email = !held && !!domain && !!pe && (pe === domain || pe.endsWith('.' + domain))
  const phone = !held && !!domain && (rows.some(r => r.connector === 'sitecrawl' && r.kind === 'phone' && PHONE.test(r.value)) || PHONE.test(l.contact ?? '') && !EMAIL.test(l.contact ?? ''))
  const eligible = approveState(card).ok
  return {
    verified: sourceChecked, sourceChecked, recent: currentEvent, currentEvent, fit, named: l.name.trim().length > 0, rightPerson, email, phone, eligible,
    reachable: email || phone,
    qualified: sourceChecked && !held && currentEvent && fit && rightPerson && (email || phone),
  }
}

export function scoreSearch(leads: ScoredLeadInput[], now: Date = new Date(), opts: ScoreOptions = {}): SearchScore {
  const s: SearchScore = { leads: leads.length, verified: 0, recent: 0, fit: 0, named: 0, reachable: 0, qualified: 0, sourceChecked: 0, currentEvent: 0, rightPerson: 0, email: 0, phone: 0, eligible: 0 }
  for (const l of leads) {
    const c = scoreLead(l, now, opts)
    for (const k of ['verified', 'recent', 'fit', 'named', 'reachable', 'qualified', 'sourceChecked', 'currentEvent', 'rightPerson', 'email', 'phone', 'eligible'] as const) if (c[k]) s[k]++
  }
  return s
}

// What this score does NOT yet measure: buyer need beyond a dated public signal, and consent. Stated wherever it is shown.
export const SCORE_LIMITS = `${RUBRIC_VERSION}: verified dated signal inside the request's window + model-graded ICP fit + a right-role person from the company's own pages + a published sales-usable email or phone, under the same gates as the cards and drafting. It does not yet prove buyer need or consent.`

export function scoreboardMarkdown(rows: { search: string; status: string; error: string | null; complete?: boolean; score: SearchScore }[], meta: { commit: string; date: string; model?: string; rubric?: string; uniqueQualified?: number; budgetUsd?: number }): string {
  const total = rows.reduce((a, r) => a + r.score.qualified, 0)
  const incomplete = rows.filter(r => r.complete === false).length
  const lines = [
    `# Scoreboard ${meta.date} (commit ${meta.commit})`,
    '',
    `**Qualified leads: ${total}** across ${rows.length} searches${meta.uniqueQualified !== undefined ? `, **${meta.uniqueQualified} unique companies**` : ''} (${RUBRIC_VERSION}: source-checked + verified date inside the request's window + fit >= ${FIT_MIN}/5 + right-role person + published email or phone).`,
    ...(incomplete ? ['', `**${incomplete} of ${rows.length} searches INCOMPLETE** (budget, timeout or key): their counts are not zero results, they are unknown.`] : []),
    ...(meta.model || meta.rubric || meta.budgetUsd ? ['', `Grading model ${meta.model ?? '?'}, rubric ${meta.rubric ?? '?'} (sha256 of lib/scan/score.ts), total budget $${meta.budgetUsd ?? '?'}.`] : []),
    '',
    SCORE_LIMITS,
    '',
    '| Search | Status | Candidates | Source-checked | Fit | Current event | Right person | Email | Phone | Eligible to draft | Qualified |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...rows.map(r => `| ${r.search.replace(/\|/g, '/')} | ${r.status}${r.error ? ` (${r.error})` : ''} | ${r.score.leads} | ${r.score.sourceChecked} | ${r.score.fit} | ${r.score.currentEvent} | ${r.score.rightPerson} | ${r.score.email} | ${r.score.phone} | ${r.score.eligible} | **${r.score.qualified}** |`),
  ]
  return lines.join('\n') + '\n'
}
