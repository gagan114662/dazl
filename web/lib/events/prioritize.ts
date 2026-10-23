import type Database from 'better-sqlite3'
import { eventsForLeads, effectiveEventType, eventTimingFresh, FRESHNESS_DAYS, type CompanyEventRow, type EventType } from './store.ts'
import { qualifyEvent } from '../signals/entity-match.ts'

// Account prioritization from the company event store: "why this company, why now".
// Every number here is an EXPLAINABLE PRODUCT HEURISTIC chosen for ranking convenience.
// None of these weights is a verified prediction of conversion, intent, or revenue.
// The grouping rule (same event type + same source-stated date = one underlying event)
// is a heuristic: two outlets can share a date while reporting different facts, and
// multiple sources can be one syndicated wire - source COUNT does not prove source
// INDEPENDENCE, so corroboration points are small and capped by design.
// Evidence is never hidden: anything present but not scored is listed in `uncounted`.
// Evidence is TIMING context, never fit: a wrong-ICP company with a funding round is
// still wrong-ICP, so event evidence can re-order leads within a fit lane but never
// rescue a low-fit or ungraded lead above a better-fitting one.

export const EVENT_WEIGHT: Record<EventType, number> = {
  funding_round: 15,
  sec_filing: 8,
  hiring_surge: 10,
  tech_stack: 5,
  competitor_mention: 5,
}
const MAX_DATED_UNITS_PER_TYPE = 2 // two genuinely distinct dated events of one type can both count
const CORROBORATION_POINT = 2      // per independent source reporting the SAME underlying event
const MAX_CORROBORATION_PER_UNIT = 2
export const EVIDENCE_CAP = 40

export interface EventSourceRef {
  url: string
  summary: string
  source_published_at: string | null
  first_seen_at: number
  last_seen_at: number
 firstParty?: boolean }

export interface UnderlyingEvent {
  event_type: EventType
  // The source-stated date identifying this underlying event. NULL when no source states a
  // date - undated rows never merge, because identity cannot be established from nothing.
  date: string | null
  sources: EventSourceRef[] // distinct source rows reporting THIS SAME underlying event
  fresh: boolean
}

// Groups raw rows into underlying events.
// Identity rule: rows merge only when they share event_type AND the same non-null
// source-stated date - two outlets reporting the same dated funding round are ONE event
// with two sources (corroboration), not two events. Undated rows stay separate groups;
// the scoring cap below, not a false merge, keeps them from inflating the score.
// Rows for the same (event_type, source_url) observed under different company keys
// (lead:<id> before the domain was known, domain after) are the same observation and
// collapse to one source.
export function groupUnderlyingEvents(rows: CompanyEventRow[], now: number = Math.floor(Date.now() / 1000), domain: string | null = null): UnderlyingEvent[] {
  const dom = (domain ?? '').toLowerCase().replace(/^www\./, '').trim()
  const firstParty = (url: string): boolean => {
    if (!dom) return false
    try { const h = new URL(url).hostname.toLowerCase(); return h === dom || h.endsWith('.' + dom) } catch { return false }
  }
  const seenObs = new Set<string>()
  const dated = new Map<string, UnderlyingEvent>()
  const undated: UnderlyingEvent[] = []
  for (const r of rows) {
    const type = effectiveEventType(r.event_type, r.source_url)
    const obsKey = `${type}|${r.source_url}`
    if (seenObs.has(obsKey)) continue
    seenObs.add(obsKey)
    const ref: EventSourceRef = { url: r.source_url, summary: r.summary, source_published_at: r.source_published_at, first_seen_at: r.first_seen_at, last_seen_at: r.last_seen_at, firstParty: firstParty(r.source_url) }
    if (r.source_published_at) {
      const gk = `${type}|${r.source_published_at}`
      const g = dated.get(gk)
      if (g) { g.sources.push(ref); continue }
      dated.set(gk, { event_type: type, date: r.source_published_at, sources: [ref], fresh: false })
    } else {
      undated.push({ event_type: type, date: null, sources: [ref], fresh: false })
    }
  }
  const all = [...dated.values(), ...undated]
  for (const g of all) {
    g.fresh = g.sources.some(sr => eventTimingFresh({event_type:g.event_type,source_url:sr.url,source_published_at:sr.source_published_at,last_seen_at:sr.last_seen_at}, now))
  }
  return all
}

export interface EvidenceScore {
  evidence_score: number
  reasons: string[]   // what was scored, with dates and source counts
  uncounted: string[] // what exists but was not scored, and why
}

// Scores grouped evidence. A source-stated date makes an event countable on its own;
// undated reports of one type score as a single unit (multiplicity from outlets
// re-reporting the same undated fact is not evidence of multiple events).
export function scoreEvidence(groups: UnderlyingEvent[]): EvidenceScore {
  let pts = 0
  const reasons: string[] = []
  const uncounted: string[] = []
  const byType = new Map<EventType, UnderlyingEvent[]>()
  for (const g of groups) {
    const arr = byType.get(g.event_type) ?? []
    arr.push(g)
    byType.set(g.event_type, arr)
  }
  // Press + SEC filing of the same dated claim are not independent evidence of it.
  const roundDates = new Set((byType.get('funding_round') ?? []).filter(g => g.date && g.fresh).map(g => g.date))
  const filings = byType.get('sec_filing') ?? []
  const stacked = filings.filter(g => g.date && roundDates.has(g.date))
  if (stacked.length) {
    byType.set('sec_filing', filings.filter(g => !stacked.includes(g)))
    for (const g of stacked) uncounted.push(`sec_filing dated ${g.date}: same dated claim as a reported round - not independent evidence`)
  }
  // Funding family: a filed Form D and a reported round are the same claim family for
  // caps and undated pooling (weights stay per-group, so filings score as filings).
  const famOf = (t: EventType): EventType => (t === 'sec_filing' ? 'funding_round' : t)
  const byFam = new Map<EventType, UnderlyingEvent[]>()
  for (const [type, gs] of byType) {
    const arr = byFam.get(famOf(type)) ?? []
    arr.push(...gs)
    byFam.set(famOf(type), arr)
  }
  for (const [fam, gs] of byFam) {
    const fresh = gs.filter(g => g.fresh)
    const stale = gs.length - fresh.length
    if (stale > 0) uncounted.push(`${stale} ${fam} report(s) without confirmed event timing or older than the ${FRESHNESS_DAYS[fam]}-day freshness window`)
    const datedFresh = fresh.filter(g => g.date).sort((a, b) => (b.date! < a.date! ? -1 : 1))
    const undatedFresh = fresh.filter(g => !g.date)
    let units = datedFresh.slice(0, MAX_DATED_UNITS_PER_TYPE)
    let countedUndatedOnce = false
    if (units.length === 0 && undatedFresh.length > 0) {
      // One scoring unit for ALL undated reports of this type; their sources pool as
      // corroboration of what is treated as a single fact for ranking purposes.
      units = [{ event_type: fam, date: null, sources: undatedFresh.flatMap(g => g.sources), fresh: true }]
      countedUndatedOnce = true
    }
    for (const extra of datedFresh.slice(MAX_DATED_UNITS_PER_TYPE)) {
      uncounted.push(`${fam} dated ${extra.date}: beyond the ${MAX_DATED_UNITS_PER_TYPE}-event per-type scoring cap`)
    }
    if (!countedUndatedOnce) {
      for (const u of undatedFresh) {
        uncounted.push(`${fam} without a source-stated date (${u.sources.length} report(s)): not scored separately - a dated ${fam} event already counts and distinct identity cannot be established`)
      }
    }
    for (const u of units) {
      const w = EVENT_WEIGHT[u.event_type]
      pts += w
      // Corroboration means INDEPENDENT first-party confirmation. Name-matched heuristic
      // sources (SEC name search, board slugs, press mentions) never earn the bonus, and
      // press + an SEC filing of the same claim never stack as independent proof.
      const fpSources = u.sources.filter(sr => sr.firstParty).length
      const extraSources = Math.min(Math.max(fpSources - 1, 0), MAX_CORROBORATION_PER_UNIT)
      pts += extraSources * CORROBORATION_POINT
      const datePart = u.date ? ` dated ${u.date}` : ' (no source-stated date, counted once)'
      const srcPart = u.sources.length > 1 ? `, ${u.sources.length} sources` : ''
      const fpPart = extraSources > 0 ? `, ${fpSources} first-party` : ''
      reasons.push(`${u.event_type}${datePart}${srcPart}${fpPart}: +${w + extraSources * CORROBORATION_POINT}`)
      if (u.sources.length > 1 && extraSources === 0) uncounted.push(`${u.event_type}${u.date ? ` dated ${u.date}` : ''}: ${u.sources.length} heuristic name-matched sources - not independent corroboration, no bonus`)
    }
  }
  if (pts > EVIDENCE_CAP) {
    uncounted.push(`evidence points ${pts} exceed the ${EVIDENCE_CAP}-point cap`)
    pts = EVIDENCE_CAP
  }
  return { evidence_score: pts, reasons, uncounted }
}

export interface LeadPriority extends EvidenceScore {
  graded: boolean               // false when the ICP grader never graded this lead
  fit: number | null            // model-graded ICP axes, 0-5 each (null = ungraded)
  intent: number | null
  action: number | null
  // No composite "priority" number on purpose: ranking is fit-lane-first with evidence as
  // a tiebreak, so any single summed number would contradict the actual order (a lower-fit
  // lead can sum higher yet sort below a better fit). Components are shown, sums are not.
}

// Per-lead prioritization. The ICP grade (fit/intent/action, 0-5 each, written by the
// seller-ICP grading call in scan/score.ts) is the base; event evidence adds timing points.
export function leadPriorities(
  db: Database.Database,
  tenantId: string,
  leads: { id: string; company?: string; company_domain: string | null; event_date?: string | null; fit: number | null; intent: number | null; action: number | null }[],
  opts: { now?: number } = {},
): Record<string, LeadPriority> {
  const now = opts.now ?? Math.floor(Date.now() / 1000)
  const events = eventsForLeads(db, tenantId, leads, { now })
  const out: Record<string, LeadPriority> = {}
  for (const l of leads) {
    // Entity-unconfirmed signal events (name collisions, off-window filings) never score.
    const rows = (events[l.id] ?? []).filter(r => qualifyEvent(l.company ?? r.company_name ?? '', l.company_domain, r, l.event_date ?? null) !== 'unconfirmed')
    const scored = scoreEvidence(groupUnderlyingEvents(rows, now, l.company_domain))
    out[l.id] = {
      graded: l.fit !== null && l.intent !== null && l.action !== null,
      fit: l.fit, intent: l.intent, action: l.action,
      ...scored,
    }
  }
  return out
}

export interface RankableLead {
  id: string
  score: number
  fit: number | null
  intent: number | null
  action: number | null
}

// Actual account ordering: graded ICP fit lane first (ungraded last), then event
// evidence, then intent, action, and the raw candidate score as the final tiebreak.
// Evidence never outranks fit. Hidden-lane filtering (fit <= 1) stays in listLeads;
// this orders whatever a view already chose to show.
export function rankLeads<T extends RankableLead>(leads: T[], pri: Record<string, LeadPriority>): T[] {
  return [...leads].sort((a, b) => {
    const fa = a.fit ?? -1, fb = b.fit ?? -1
    if (fa !== fb) return fb - fa
    const ea = pri[a.id]?.evidence_score ?? 0, eb = pri[b.id]?.evidence_score ?? 0
    if (ea !== eb) return eb - ea
    const ia = a.intent ?? -1, ib = b.intent ?? -1
    if (ia !== ib) return ib - ia
    const aa = a.action ?? -1, ab = b.action ?? -1
    if (aa !== ab) return ab - aa
    return b.score - a.score
  })
}
