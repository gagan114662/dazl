// Scoreboard: how many leads a scan returns that a salesperson could act on today. This is the number every change
// is judged by (docs/DECISIONS.md, "review before main"); scripts/scoreboard.mts runs the scans.
//
// QUALIFIED is exactly the product's own "actionable" (lib/scan/actionable.ts classifyLeads - the same function the lead
// card, the run report and drafting read; there is no second definition here, #378):
//   source-checked  the verifier kept it (no review reason, a confidence) and no required gate holds it
//   buyer gates     not quarantined, not excluded by memory, graded fit >= FIT_MIN
//   domain          a company domain the crawl confirmed
//   right person    a named person on the company's own pages whose title matches the requested role (or a founder)
//   reachable       a phone or a role mailbox the company published on its own domain - never support / careers /
//                   recruiting / press inboxes, and never a contact merely attached to the lead
// The stages are reported separately, from the same rows, so a count can be traced to the gate that stopped it. The
// event must be inside the REQUEST's window (the runner holds anything outside it); current_event reports that window,
// not a fixed 90 days. Phone-only and email-ready routes are counted apart.
import type { LeadYield } from './actionable.ts'

export const SCOREBOARD_RUBRIC = 'qualified/2: the product\'s actionable gates (lib/scan/actionable.ts)'
export interface SearchScore {
  leads: number; source_checked: number; fit: number; current_event: number; right_person: number
  reachable: number; email_ready: number; phone_only: number; qualified: number
}
export interface LeadScoreCard { lead_id: string; company: string; source_checked: boolean; fit: boolean; current_event: boolean; right_person: boolean; reachable: boolean; route: 'email' | 'phone' | null; qualified: boolean; missing: string[] }

const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i
const PHONE = /\+?\d[\d\s().-]{6,}\d/
export const RECENT_DAYS = 90       // the default window when a request names none (lib/scan/icp.ts)
export const FIT_MIN = 4
// Shape only (an email or a phone); used by the benchmark. It never makes a lead reachable here: only the actionable route does.
export const isReachable = (v: string | null | undefined): boolean => !!v && (EMAIL.test(v) || PHONE.test(v))

const windowOf = (icp: string | null | undefined): number => { try { const w = icp ? (JSON.parse(icp) as { window_days?: unknown }).window_days : null; return typeof w === 'number' && w > 0 ? w : RECENT_DAYS } catch { return RECENT_DAYS } }

// One scan job's leads, scored from classifyLeads' own rows (actionable.ts scoreboardInputs reads them): pure here.
export function scoreJob(input: { classified: LeadYield[]; leads: { id: string; company: string; event_date: string | null; fit: number | null }[] }, job: { icp?: string | null }, now: Date = new Date()): { score: SearchScore; leads: LeadScoreCard[] } {
  const all = input.leads
  const byId = new Map(all.map(l => [l.id, l]))
  const rows = input.classified
  const window = windowOf(job.icp)
  const leads: LeadScoreCard[] = rows.map(r => {
    const l = byId.get(r.lead_id)!
    const age = l.event_date && /^\d{4}-\d{2}-\d{2}$/.test(l.event_date) ? (now.getTime() - Date.parse(`${l.event_date}T00:00:00Z`)) / 86_400_000 : null
    const gated = r.held || r.missing.some(m => ['quarantined', 'excluded', 'fit_below_threshold', 'not_graded', 'sales_hiring_check_failed'].includes(m))
    const route = r.route ? (r.route.startsWith('phone:') ? 'phone' as const : 'email' as const) : null
    return {
      lead_id: r.lead_id, company: r.company, source_checked: !r.held, fit: typeof l.fit === 'number' && l.fit >= FIT_MIN,
      current_event: age !== null && age >= -1 && age <= window, right_person: !gated && r.person !== null, reachable: !gated && route !== null, route: gated ? null : route,
      qualified: r.actionable, missing: r.missing,
    }
  })
  const score: SearchScore = { leads: all.length, source_checked: 0, fit: 0, current_event: 0, right_person: 0, reachable: 0, email_ready: 0, phone_only: 0, qualified: 0 }
  for (const c of leads) {
    for (const k of ['source_checked', 'fit', 'current_event', 'right_person', 'reachable', 'qualified'] as const) if (c[k]) score[k]++
    if (c.reachable && c.route === 'email') score.email_ready++
    if (c.reachable && c.route === 'phone') score.phone_only++
  }
  return { score, leads }
}

// What this score does NOT yet measure: buyer need beyond a dated public signal and the gates above, and consent.
export const SCORE_LIMITS = 'qualified/2 = the product\'s actionable gates (source-checked, buyer gates, own domain, right person, published route). It does not yet prove buyer need beyond the dated signal, or consent.'

export function scoreboardMarkdown(rows: { search: string; status: string; error: string | null; complete?: boolean; score: SearchScore }[], meta: { commit: string; date: string; model?: string; rubric?: string; uniqueQualified?: number; budgetUsd?: number }): string {
  const total = rows.reduce((a, r) => a + r.score.qualified, 0)
  const incomplete = rows.filter(r => r.complete === false).length
  const lines = [
    `# Scoreboard ${meta.date} (commit ${meta.commit})`,
    '',
    `**Qualified leads: ${total}** across ${rows.length} searches${meta.uniqueQualified !== undefined ? `, **${meta.uniqueQualified} unique companies**` : ''} (rubric ${SCOREBOARD_RUBRIC}).`,
    ...(incomplete ? ['', `**${incomplete} of ${rows.length} searches INCOMPLETE** (budget, timeout or key): their counts are not zero results, they are unknown.`] : []),
    ...(meta.model || meta.rubric || meta.budgetUsd ? ['', `Grading model ${meta.model ?? '?'}, rubric ${meta.rubric ?? '?'} (sha256 of lib/scan/score.ts), total budget $${meta.budgetUsd ?? '?'}.`] : []),
    '',
    SCORE_LIMITS,
    '',
    '| Search | Status | Candidates | Source-checked | Fit | Current event | Right person | Reachable (email / phone) | Qualified |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...rows.map(r => `| ${r.search.replace(/\|/g, '/')} | ${r.status}${r.error ? ` (${r.error})` : ''} | ${r.score.leads} | ${r.score.source_checked} | ${r.score.fit} | ${r.score.current_event} | ${r.score.right_person} | ${r.score.reachable} (${r.score.email_ready} / ${r.score.phone_only}) | **${r.score.qualified}** |`),
  ]
  return lines.join('\n') + '\n'
}
