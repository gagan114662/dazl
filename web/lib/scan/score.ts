// Lead scoring: ICP fit, intent/timing and actionability, graded by the tenant's own model.
// The verifier proves the quoted evidence is real; this stage answers "is this lead worth the
// user's time, and why now". Every grade must cite the lead's already-verified evidence.
import type { Provider } from '../llm/provider.ts'
import type { Icp } from './icp.ts'

// Key-free signal taxonomy. Each signal is observable on public pages (news, jobs boards,
// company sites, changelogs, community posts) and must be backed by the lead's cited evidence.
export const SIGNALS = [
  'raised_funding',        // seed/series/grant announced
  'hiring',                // open roles at all
  'hiring_relevant_role',  // hiring the role the ICP cares about (e.g. first sales hire)
  'leadership_change',     // new VP/CRO/CTO/founder appointment
  'product_launch',        // new product or major feature shipped
  'expansion',             // new office, market or geography
  'tech_stack_change',     // migration/ adoption visible on public pages
  'partnership',           // announced partnership or integration
  'press_mention',         // covered by press or a known publication
  'rebranding',            // rename/rebrand/new site
  'layoffs',               // cutting staff (usually an exclude signal)
  'growing_team',          // headcount growth visible publicly
  'new_website',           // new or relaunched site
  'community_activity',    // active in public communities (HN/YC/PH/forums)
  'open_role_language',    // job post language matching the ICP's pains
  'founder_post',          // founder publicly asking/announcing something
  'event_presence',        // speaking/exhibiting at an event
  'compliance_driver',     // regulation forcing action (SOC2, GDPR, ...)
  'seasonal_driver',       // time-bound seasonal need
  'customer_win',          // announced a notable customer
  'pricing_change',        // new pricing/packaging
  'integration_launch',    // launched an integration with another tool
  'job_board_presence',    // active on public job boards
  'accelerator',           // in YC/Techstars/etc batch
] as const
export type SignalId = (typeof SIGNALS)[number]
const SIGNAL_SET = new Set<string>(SIGNALS)

export interface LeadScore {
  fit: number        // 0-5 ICP fit: would this user sell to this company
  intent: number     // 0-5 is there a reason to contact them NOW
  action: number     // 0-5 can the user act: identifiable company, reachable, right size
  why: string        // one sentence: why this lead, why now
  signals: SignalId[]
}

// Leads at or below this fit stay in the scan but are hidden behind a toggle.
export const HIDE_FIT_AT = 1
export const isHidden = (s: LeadScore | null): boolean => !!s && s.fit <= HIDE_FIT_AT

export function scorePrompt(icpText: string, leads: { company: string; name: string; signal: string; excerpt: string | null }[]): string {
  return `You are grading sales leads for one seller. Their target profile (ICP):
${icpText}

Grade each lead below on three axes, 0-5 each:
- fit: is this company someone the seller would actually sell to, given the ICP (0 = irrelevant or excluded, 5 = exact ICP)
- intent: is there a reason to contact them NOW, a live trigger event (0 = no timing signal, 5 = urgent live trigger)
- action: can the seller act on it (0 = anonymous or unreachable giant, 5 = identifiable, right-sized, contactable)

Rules:
- Grade ONLY from the evidence shown. If the evidence does not show timing, intent is low. A true quote about the wrong company is still fit 0.
- Announcements, listicles and news about a company are not the same as that company being a buyer; grade fit on who the company is, intent on what just happened to them.
- why: one sentence, "why this lead, why now", grounded in the evidence. No flattery.
- signals: pick from this list only, and only when the evidence supports them: ${SIGNALS.join(', ')}

Reply with one line per lead, exactly this format, no preamble:
LEAD <n> | fit <0-5> | intent <0-5> | action <0-5> | signals <comma list or none> | why <sentence>

${leads.map((l, i) => `LEAD ${i + 1}: company=${l.company || '?'} name=${l.name || '?'}\nsignal: ${l.signal}\nevidence: ${l.excerpt ?? '(none)'}`).join('\n\n')}`
}

const clamp5 = (n: number) => Math.max(0, Math.min(5, Math.round(n)))

export function parseScores(text: string, count: number): LeadScore[] | null {
  const out: (LeadScore | null)[] = Array.from({ length: count }, () => null)
  const re = /LEAD\s+(\d+)\s*\|\s*fit\s+(-?\d+(?:\.\d+)?)\s*\|\s*intent\s+(-?\d+(?:\.\d+)?)\s*\|\s*action\s+(-?\d+(?:\.\d+)?)\s*\|\s*signals\s+([^|]*)\|\s*why\s+(.+)/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    const idx = Number(m[1]) - 1
    if (idx < 0 || idx >= count) continue
    const signals = m[5].split(',').map(s => s.trim().toLowerCase().replace(/\s+/g, '_')).filter(s => SIGNAL_SET.has(s)) as SignalId[]
    out[idx] = { fit: clamp5(Number(m[2])), intent: clamp5(Number(m[3])), action: clamp5(Number(m[4])), signals, why: m[6].trim().slice(0, 300) }
  }
  // All-or-nothing: a partially parsed batch would rank unscored leads unfairly.
  return out.every(Boolean) ? (out as LeadScore[]) : null
}

// One model call per scan (not per lead). Returns null when the model cannot score - the scan
// then completes unscored rather than failing.
export async function scoreLeads(provider: Provider, apiKey: string, icpText: string, leads: { company: string; name: string; signal: string; excerpt: string | null }[], fetchImpl?: typeof fetch): Promise<LeadScore[] | null> {
  if (!provider.complete || leads.length === 0) return null
  try {
    const text = await provider.complete(apiKey, scorePrompt(icpText, leads.slice(0, 40)), fetchImpl, 2500)
    return parseScores(text, Math.min(leads.length, 40))
  } catch {
    return null
  }
}

export function icpTextFor(icp: Icp | null, fallback: string): string {
  if (!icp) return fallback
  return [icp.summary, icp.who.length ? `buyers: ${icp.who.join('; ')}` : '', icp.where.length ? `where: ${icp.where.join('; ')}` : '', icp.signals.length ? `intent signals: ${icp.signals.join('; ')}` : '', icp.exclude.length ? `exclude: ${icp.exclude.join('; ')}` : ''].filter(Boolean).join('\n')
}
