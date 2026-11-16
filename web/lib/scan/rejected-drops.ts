// #754 (part of #385): a later run leaves out companies the tenant rejected (lib/scan/runner.ts feedbackGate records each
// as `dropped:previously_rejected:<reason>:<feedback id>` in the run report). This turns that into what the user sees:
// each company once, the reason in plain words, and the lead whose feedback reset undoes it. Pure: no store access.

export const REJECT_LABEL: Record<string, string> = {
  wrong_industry: 'wrong industry', wrong_location: 'wrong location', competitor: 'a competitor',
  existing_relationship: 'already a customer or contact', not_useful: 'not useful', wrong_person: 'wrong person', wrong_timing: 'wrong timing',
}

export interface LeftOut { company: string; reason: string; label: string; feedback_id: string; lead_id: string }
interface ActiveRow { id: string; lead_id: string | null; reason: string | null }

const FATE = /^dropped:previously_rejected:([a-z_]+):([A-Za-z0-9]+)$/

// Reports: the job's run reports (every attempt). Active: the tenant's feedback rows NOT reset. A rejection already
// undone, or one with no lead to undo from, is not listed.
export function rejectedLeftOut(reports: unknown[] | null, active: ActiveRow[]): LeftOut[] {
  const byId = new Map(active.map(r => [r.id, r]))
  const seen = new Set<string>(); const out: LeftOut[] = []
  for (const rep of reports ?? []) {
    const cands = (rep as { candidates?: { company?: unknown; fate?: unknown }[] } | null)?.candidates
    for (const c of Array.isArray(cands) ? cands : []) {
      const m = typeof c?.fate === 'string' ? FATE.exec(c.fate) : null
      if (!m || seen.has(m[2])) continue
      const row = byId.get(m[2])
      if (!row || !row.lead_id) continue
      seen.add(m[2])
      out.push({ company: String(c.company ?? '').trim() || 'A company', reason: m[1], label: REJECT_LABEL[m[1]] ?? 'rejected', feedback_id: m[2], lead_id: row.lead_id })
    }
  }
  return out
}

export function leftOutSummary(list: LeftOut[]): string {
  if (list.length === 0) return ''
  const one = list.length === 1
  return `${list.length} ${one ? 'company' : 'companies'} you rejected ${one ? 'was' : 'were'} left out: ${list.map(l => `${l.company} (${l.label})`).join(', ')}.`
}
