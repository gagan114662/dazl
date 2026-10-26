// Scoreboard: how many leads a scan returns that a salesperson could act on today. This is the number every change
// is judged by (docs/DECISIONS.md, "review before main"). Pure scoring only; scripts/scoreboard.ts runs the scans.
//
// A lead is QUALIFIED when all hold:
//   verified   - the verifier kept it (cited page fetched, quote on page, company named), not a needs-review row
//   recent     - the event is dated within the last 90 days (undated does not count)
//   fit        - the tenant's model graded ICP fit >= 4 of 5
//   reachable  - a contact route exists: a contact on the lead or a contact enrichment holding an email or phone
// "named" (a person's name) is reported but not required: a reachable company inbox is still actionable.

export interface ScoredLeadInput {
  name: string
  contact: string | null
  review_reason: string | null
  event_date: string | null
  fit: number | null
  contacts: string[] // values of contact enrichments for this lead
}

export interface LeadScoreCard { verified: boolean; recent: boolean; fit: boolean; named: boolean; reachable: boolean; qualified: boolean }
export interface SearchScore { leads: number; verified: number; recent: number; fit: number; named: number; reachable: number; qualified: number }

const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i
const PHONE = /\+?\d[\d\s().-]{6,}\d/
export const RECENT_DAYS = 90
export const FIT_MIN = 4

export const isReachable = (v: string | null | undefined): boolean => !!v && (EMAIL.test(v) || PHONE.test(v))

export function scoreLead(l: ScoredLeadInput, now: Date = new Date()): LeadScoreCard {
  const verified = !l.review_reason
  const age = l.event_date && /^\d{4}-\d{2}-\d{2}$/.test(l.event_date) ? (now.getTime() - Date.parse(`${l.event_date}T00:00:00Z`)) / 86_400_000 : null
  const recent = age !== null && age >= -1 && age <= RECENT_DAYS
  const fit = typeof l.fit === 'number' && l.fit >= FIT_MIN
  const named = l.name.trim().length > 0
  const reachable = isReachable(l.contact) || l.contacts.some(isReachable)
  return { verified, recent, fit, named, reachable, qualified: verified && recent && fit && reachable }
}

export function scoreSearch(leads: ScoredLeadInput[], now: Date = new Date()): SearchScore {
  const s: SearchScore = { leads: leads.length, verified: 0, recent: 0, fit: 0, named: 0, reachable: 0, qualified: 0 }
  for (const l of leads) {
    const c = scoreLead(l, now)
    for (const k of ['verified', 'recent', 'fit', 'named', 'reachable', 'qualified'] as const) if (c[k]) s[k]++
  }
  return s
}

// What this score does NOT yet measure (Instinct review): buyer need beyond a dated public signal, whether the contact
// is the right decision-maker, and consent. It is "qualified v1", stated as such wherever it is shown.
export const SCORE_LIMITS = 'v1 score: verified dated signal + model-graded ICP fit + any email/phone. It does not yet prove buyer need, that the contact is the right decision-maker, or consent.'

export function scoreboardMarkdown(rows: { search: string; status: string; error: string | null; complete?: boolean; score: SearchScore }[], meta: { commit: string; date: string; model?: string; rubric?: string; uniqueQualified?: number; budgetUsd?: number }): string {
  const total = rows.reduce((a, r) => a + r.score.qualified, 0)
  const incomplete = rows.filter(r => r.complete === false).length
  const lines = [
    `# Scoreboard ${meta.date} (commit ${meta.commit})`,
    '',
    `**Qualified leads: ${total}** across ${rows.length} searches${meta.uniqueQualified !== undefined ? `, **${meta.uniqueQualified} unique companies**` : ''} (verified + dated within ${RECENT_DAYS} days + fit >= ${FIT_MIN}/5 + email or phone).`,
    ...(incomplete ? ['', `**${incomplete} of ${rows.length} searches INCOMPLETE** (budget, timeout or key): their counts are not zero results, they are unknown.`] : []),
    ...(meta.model || meta.rubric || meta.budgetUsd ? ['', `Grading model ${meta.model ?? '?'}, rubric ${meta.rubric ?? '?'} (sha256 of lib/scan/score.ts), total budget $${meta.budgetUsd ?? '?'}.`] : []),
    '',
    SCORE_LIMITS,
    '',
    '| Search | Status | Leads | Verified | Recent | Fit | Named | Reachable | Qualified |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...rows.map(r => `| ${r.search.replace(/\|/g, '/')} | ${r.status}${r.error ? ` (${r.error})` : ''} | ${r.score.leads} | ${r.score.verified} | ${r.score.recent} | ${r.score.fit} | ${r.score.named} | ${r.score.reachable} | **${r.score.qualified}** |`),
  ]
  return lines.join('\n') + '\n'
}
