// #380: per-condition proof for a compiled targeting plan (targeting.ts), read from what the scan already VERIFIED for the lead: its own
// source quote and that quote's date, dated enrichment rows (job-board postings), the sales-hiring gate's durable pass record, and the
// tenant's saved competitor list. Nothing here fetches, asks a model or guesses: a condition no verified fact shows stays 'unknown',
// and 'fail' is returned only for a fact that rules the condition out (a named company that is not this lead, a competitor list it is not on).
import type { Condition, QueryPlan, ClauseProof } from './targeting.ts'
import { planConditions, eventMatches, eventMatchIndex } from './targeting.ts'
import { quoteShowsEvent, affirmativeSalesHiring, requestAsksFunding, requestedStage, subjectIsOther, type Stage } from './sales-hiring-gate.ts'
import { salesHiringRequired, salesGateOr } from './sales-hiring-required.ts'
import { needsEventBeyondHiring } from '../search/page-class.ts'
import { isGtmRole } from '../signals/ats-gtm.ts'
import { parseWindowDays } from './window.ts'
import { TECH_SCAN_KIND, TECH_CHANGE_KIND, TECH_SCOPE, decodeScan, parseChangeRow, day, type TechScan } from '../signals/tech-observations.ts'

export interface ProofLead { company: string; company_domain: string | null; evidence_excerpt: string | null; signal: string | null; source_url: string; event_date: string | null }
export interface ProofRow { connector: string; kind: string; value: string; source_url: string; source_date: string; label?: string | null }
// `graded`: the lead already passed the ICP grade, which judges the profile's `exclude` list (classifyLeads evaluates the plan only after the fit gate).
export interface ProofContext { query: string | null | undefined; icp: string | null | undefined; salesGatePassed: boolean; competitors: string[] | null; graded?: boolean; now?: number }
export type Proof = Omit<ClauseProof, 'id' | 'text' | 'negated'>

const DAY = 86_400_000
const isDate = (d: string | null | undefined): d is string => !!d && /^\d{4}-\d{2}-\d{2}$/.test(d) && Number.isFinite(Date.parse(`${d}T00:00:00Z`))
// The condition's OWN clock, counted from today (whole UTC days). No window stated: the clock does not limit the proof (the run's window is enforced elsewhere).
function onClock(date: string | null | undefined, days: number | null, now: number): 'in' | 'out' | 'undated' {
  if (days === null) return 'in'
  if (!isDate(date)) return 'undated'
  const today = Date.parse(`${new Date(now).toISOString().slice(0, 10)}T00:00:00Z`)
  const age = Math.round((today - Date.parse(`${date}T00:00:00Z`)) / DAY)
  return age >= 0 && age <= days ? 'in' : 'out'
}
const norm = (s: string) => s.toLowerCase().replace(/&/g, ' and ').replace(/\b(?:inc|ltd|llc|limited|plc|corp|co|group|the)\b/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim()
const sameCompany = (a: string, b: string, domain: string | null) => {
  const x = norm(a), y = norm(b)
  if (x.length >= 3 && y.length >= 3 && (x === y || ` ${x} `.includes(` ${y} `) || ` ${y} `.includes(` ${x} `))) return true
  const label = (domain ?? '').replace(/^www\./, '').split('.')[0]
  return !!label && label.length >= 3 && y.replace(/\s+/g, '') === label
}
const excludesOf = (icp: string | null | undefined): string[] => { try { const j = JSON.parse(icp ?? '{}') as { exclude?: unknown }; return Array.isArray(j.exclude) ? j.exclude.filter((x): x is string => typeof x === 'string') : [] } catch { return [] } }
const stageOf = (s: string | undefined): Stage => !s ? null : s === 'pre-seed' || s === 'seed' ? 'seed' : s as Stage
// #876: a source reporting "made its first sales hire" (or a headline's "makes first sales hire") states the completed hire in other words.
// "making" / "to make" do not: NOT_DONE still rules out planned, hoped-for and open-role wording in the same clause.
const HIRE_DONE = /\b(?:hired|appointed|named|joined|joins|welcomed|brought\s+on|onboarded)\b|\b(?:made|makes)\s+(?:(?:a|an|its|their|the)\s+)?(?:(?:first|founding|inaugural|new)\s+)?[a-z][a-z-]*\s+hires?\b/i
const NOT_DONE = /\b(?:not|no|never|yet\s+to|plans?\s+to|planning|will|would|could|may|might|seeking|looking\s+for|hiring|search(?:ing)?\s+for|reportedly|rumou?r\w*)\b/i
const clauses = (t: string) => t.split(/[.;!?\n]+|\s(?:but|however|while|although|though|yet)\s/i).map(x => x.trim()).filter(Boolean)
// Event families the sales-hiring gate's event reader does not cover (it reads open / launch / expand). For these a CLAUSE of the lead's own
// quote must state the event plainly: done, by this company (no other company in front of the verb), not denied, planned, conditional or hearsay.
const GATE_EVENTS = new Set(['open', 'launch', 'expand'])
const EVENT_NOT = /\b(?:not|no|never|didn'?t|doesn'?t|hasn'?t|haven'?t|wasn'?t|won'?t|without|failed\s+to|lost|losing|den(?:y|ies|ied)|reject\w*|revok\w+|withdr\w+|cancel\w*|denied|plans?\s+to|planning|intends?|aims?\s+to|hopes?\s+to|seeks?\s+to|seeking|bid(?:s|ding)?\s+for|in\s+talks|will|would|could|may|might|if|unless|once|pending|expected|reportedly|rumou?r\w*|allegedly)\b/i
function eventShown(event: string | undefined, object: string | undefined, quote: string, company: string): boolean {
  return clauses(quote).some(k => { const i = eventMatchIndex(event, object, k); return i >= 0 && !EVENT_NOT.test(k) && !subjectIsOther(k.slice(0, i), company) })
}
const roleWords = (r: string) => r.toLowerCase().split(/[^a-z]+/).filter(w => w.length >= 2 && !['of', 'the', 'and', 'for', 'an'].includes(w))

function dated(ok: boolean, date: string | null, days: number | null, now: number, url: string, shown: string): Proof {
  if (!ok) return { truth: 'unknown', reason: `no verified source shows ${shown}` }
  const c = onClock(date, days, now)
  if (c === 'in') return { truth: 'pass', reason: `the verified source quote shows ${shown}${date ? `, dated ${date}` : ''}${days !== null ? ` (within ${days} days)` : ''}`, source_url: url, ...(date ? { date } : {}) }
  if (c === 'undated') return { truth: 'unknown', reason: `the source shows ${shown} but carries no date, so its ${days}-day clock cannot be checked`, source_url: url }
  return { truth: 'unknown', reason: `the dated source (${date}) is outside this condition's ${days}-day window`, source_url: url, ...(date ? { date } : {}) }
}

// The sales-hiring gate's durable pass proves only what that gate checked, with ITS window and stage: a condition with a narrower clock,
// another stage or a clock relative to another event is not proven by it. Under an OR request (salesGateOr) the gate passes a lead on ONE
// branch, so its pass record proves neither branch in particular: each condition then needs its own verified fact.
function gateCovers(c: Condition, ctx: ProofContext): boolean {
  if (!ctx.salesGatePassed || !salesHiringRequired(ctx.query, ctx.icp) || c.relative_to || salesGateOr(ctx.query, ctx.icp)) return false
  const gateDays = parseWindowDays(ctx.query ?? '') ?? 90
  const clockOk = c.within_days === null || c.within_days >= gateDays
  let signals: string[] = []
  try { const j = JSON.parse(ctx.icp ?? '{}') as { signals?: unknown }; if (Array.isArray(j.signals)) signals = j.signals.filter((x): x is string => typeof x === 'string') } catch { /* no profile */ }
  if (c.kind === 'hiring') return clockOk && (!c.role || isGtmRole(c.role))
  if (c.kind === 'funding') return clockOk && c.stage !== 'pre-seed' && needsEventBeyondHiring(signals, ctx.query ?? '') && requestAsksFunding(ctx.query, ctx.icp) && stageOf(c.stage) === requestedStage(ctx.query, ctx.icp)
  return false
}

// #389: a technology condition, proven only on this lead's own dated website observations (sitecrawl tech_scan / tech_change rows, written
// after the homepage named the company). Presence passes; a removal confirmed on comparable pages rules current use out; a signature that
// was simply not seen is NEVER 'fail' (unknown: a missing script is not proof of non-use). Technology fit is not a buying reason: the lead's
// separately verified source signal stays the reason, and every other gate still applies.
function techProof(c: Condition, rows: ProofRow[], now: number): Proof {
  const tech = c.tech ?? ''
  const scans = rows.filter(r => r.connector === 'sitecrawl' && r.kind === TECH_SCAN_KIND).map(r => decodeScan(r.value, r.label, r.source_url)).filter((s): s is TechScan => !!s).sort((a, b) => b.at - a.at)
  const changes = rows.filter(r => r.connector === 'sitecrawl' && r.kind === TECH_CHANGE_KIND).map(r => ({ r, p: parseChangeRow(r.value) })).filter(x => x.p?.tech === tech).sort((a, b) => b.r.source_date.localeCompare(a.r.source_date))
  const latest = scans[0]
  const seen = (s: TechScan | undefined) => !!s && s.present.includes(tech)
  // A change row stands unless a LATER check on this lead contradicts it: an adoption by a later readable page without the signature, a
  // removal by any later page with it. An unreadable later page contradicts nothing.
  const change = (kind: 'adopted' | 'removed') => changes.find(x => x.p?.kind === kind && !scans.some(s => day(s.at) > x.r.source_date && (kind === 'adopted' ? s.obs === 'ok' && !seen(s) : seen(s))))?.r
  const clock = (date: string, url: string, reason: string): Proof => {
    const k = onClock(date, c.within_days, now)
    if (k === 'in') return { truth: 'pass', reason, source_url: url, date }
    return { truth: 'unknown', reason: `${reason}, but ${date} is outside this condition's ${c.within_days}-day window`, source_url: url, date }
  }
  if (!latest) return { truth: 'unknown', reason: `no website check for this lead (the crawl did not confirm the company's homepage), so ${tech} is unknown` }
  const removed = change('removed'), adopted = change('adopted')
  if (c.change === 'uses') {
    if (seen(latest)) return clock(day(latest.at), latest.url, `${tech} signature seen on ${latest.url} on ${day(latest.at)} (${TECH_SCOPE}, detector v${latest.version})`)
    if (removed) return { truth: 'fail', reason: `${tech} removal confirmed on comparable checks: ${removed.label ?? ''}`.slice(0, 300), source_url: removed.source_url, date: removed.source_date }
    if (latest.obs !== 'ok') return { truth: 'unknown', reason: `the homepage could not be read in full on ${day(latest.at)} (${latest.obs.replace('_', ' ')}), so a missing ${tech} signature says nothing`, source_url: latest.url }
    return { truth: 'unknown', reason: `${tech} not seen on ${latest.url} on ${day(latest.at)}; a missing signature is not proof the company does not use it (${TECH_SCOPE})`, source_url: latest.url }
  }
  if (c.change === 'adopted') {
    if (adopted) return clock(adopted.source_date, adopted.source_url, `${tech} added: ${adopted.label ?? ''}`.slice(0, 300))
    if (seen(latest)) return { truth: 'unknown', reason: `${tech} is seen now (${day(latest.at)}) but no earlier comparable check shows it absent, so an adoption is not dated`, source_url: latest.url }
    return { truth: 'unknown', reason: `no comparable dated checks show ${tech} being added` }
  }
  if (removed) return clock(removed.source_date, removed.source_url, `${tech} removed: ${removed.label ?? ''}`.slice(0, 300))
  if (seen(latest)) return { truth: 'fail', reason: `${tech} is still seen on ${latest.url} on ${day(latest.at)}`, source_url: latest.url, date: day(latest.at) }
  return { truth: 'unknown', reason: `a removal needs a check showing ${tech}, then two later comparable full-page checks without it; these checks do not show that` }
}

export function conditionProof(c: Condition, lead: ProofLead, rows: ProofRow[], ctx: ProofContext, dates: Record<string, string | undefined> = {}): Proof {
  const now = ctx.now ?? Date.now()
  const quote = lead.evidence_excerpt ?? ''
  switch (c.kind) {
    case 'tech': return techProof(c, rows, now)
    case 'company_named': {
      const hit = (c.names ?? []).find(n => sameCompany(lead.company, n, lead.company_domain))
      return hit ? { truth: 'pass', reason: `this lead is ${hit}, the company the request names` } : { truth: 'fail', reason: `this lead (${lead.company}) is not ${(c.names ?? []).join(', ')}` }
    }
    case 'competitor': {
      if (!ctx.competitors || ctx.competitors.length === 0) return { truth: 'unknown', reason: 'no saved competitor list to check this lead against, so it cannot be ruled out' }
      const hit = ctx.competitors.find(n => sameCompany(lead.company, n, lead.company_domain))
      return hit ? { truth: 'pass', reason: `${lead.company} is on your saved competitor list (${hit})` } : { truth: 'fail', reason: `not on your saved competitor list (${ctx.competitors.length} name${ctx.competitors.length === 1 ? '' : 's'})` }
    }
    case 'category': {
      const w = (c.names?.[0] ?? '').toLowerCase().replace(/[^a-z0-9 -]/g, ''), stem = w.slice(0, Math.max(4, w.length - 3))
      const re = new RegExp(`\\b${stem}`, 'i')
      if (stem && (re.test(lead.company) || re.test(quote))) return { truth: 'pass', reason: `the company name or its source quote says ${w}`, source_url: lead.source_url }
      // The category exclusion's owning gate is the ICP grade (targeting.ts: categories, like industry and size, are judged there). It rules the category out
      // only when the profile it graded against carries this exclusion; otherwise nothing has checked it and it stays unknown (the lead is held).
      const graded = ctx.graded && stem && excludesOf(ctx.icp).find(x => re.test(x))
      if (graded) return { truth: 'fail', reason: `neither the company name nor its source quote says ${w}, and the ICP grade checked the profile's exclusion "${graded}" before grading this lead a fit` }
      return { truth: 'unknown', reason: `no verified source says whether this company is one of the ${w} the request excludes` }
    }
    case 'funding': {
      const shows = quoteShowsEvent(quote, lead.signal, true, lead.company, stageOf(c.stage)) && (c.stage !== 'pre-seed' || /\bpre-?seed\b/i.test(quote))
      const what = `a completed ${c.stage ? `${c.stage} ` : ''}raise by this company`
      if (shows) return dated(true, lead.event_date, c.within_days, now, lead.source_url, what)
      if (gateCovers(c, ctx)) return { truth: 'pass', reason: 'the sales-hiring gate verified the funding half on a source for this company (its durable pass record)' }
      return { truth: 'unknown', reason: `no verified source shows ${what}` }
    }
    case 'event': {
      const shows = GATE_EVENTS.has(c.event ?? '') ? quoteShowsEvent(quote, lead.signal, false, lead.company) && eventMatches(c.event, c.object, quote) : eventShown(c.event, c.object, quote, lead.company)
      return dated(shows, lead.event_date, c.within_days, now, lead.source_url, `this company's ${c.event}${c.object ? ` (${c.object})` : ''} event`)
    }
    case 'hiring': {
      const gtm = !c.role || isGtmRole(c.role)
      for (const r of rows) {
        if (!(r.kind === 'hiring-role' || (r.kind === 'hiring' && gtm))) continue
        if (onClock(r.source_date, c.within_days, now) === 'in') return { truth: 'pass', reason: `a dated posting on this company's job board (${r.value}), ${r.source_date}`, source_url: r.source_url, date: r.source_date }
      }
      if (gtm && affirmativeSalesHiring(quote, lead.company)) return dated(true, lead.event_date, c.within_days, now, lead.source_url, 'this company hiring for the role')
      if (gateCovers(c, ctx)) return { truth: 'pass', reason: 'the sales-hiring gate verified an open sales role for this company (its durable pass record)' }
      return { truth: 'unknown', reason: `no dated posting or verified quote shows this company hiring${c.role ? ` ${c.role}` : ''}` }
    }
    case 'hire_made': {
      const want = roleWords(c.role ?? '')
      const shows = clauses(quote).some(k => HIRE_DONE.test(k) && !NOT_DONE.test(k) && want.every(w => new RegExp(`\\b${w}`, 'i').test(k)) && (!c.first || /\b(?:first|founding|inaugural)\b/i.test(k)))
      const p = dated(shows, lead.event_date, c.within_days, now, lead.source_url, `this company ${c.first ? 'made its first' : 'made a'} ${c.role || 'role'} hire`)
      if (p.truth !== 'pass' || !c.relative_to) return p
      // A clock counted from another condition's event needs BOTH events dated on their own sources: one quote's date cannot be both.
      const anchor = dates[c.relative_to]
      if (!anchor || !p.date || anchor === p.date) return { truth: 'unknown', reason: `the hire and ${c.relative_to} are not dated on separate sources, so "within ${c.within_days} days of" it cannot be checked`, source_url: lead.source_url }
      const gap = Math.round((Date.parse(`${p.date}T00:00:00Z`) - Date.parse(`${anchor}T00:00:00Z`)) / DAY)
      return gap >= 0 && gap <= (c.within_days ?? 0) ? { ...p, reason: `${p.reason}; ${gap} days after ${c.relative_to} (${anchor})` } : { truth: 'unknown', reason: `the hire (${p.date}) is not within ${c.within_days} days after ${c.relative_to} (${anchor})`, source_url: lead.source_url }
    }
  }
}

// Proofs for every condition of a plan (anchors first, so a relative clock can read its anchor's date).
export function planProofs(plan: QueryPlan, lead: ProofLead, rows: ProofRow[], ctx: ProofContext): Record<string, Proof> {
  const out: Record<string, Proof> = {}, dates: Record<string, string | undefined> = {}
  const conds = planConditions(plan.root).map(x => x.cond).sort((a, b) => Number(!!a.relative_to) - Number(!!b.relative_to))
  for (const c of conds) { const p = conditionProof(c, lead, rows, ctx, dates); out[c.id] = p; if (p.truth === 'pass') dates[c.id] = p.date }
  return out
}
