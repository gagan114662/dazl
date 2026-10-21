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

export type MatchValue = 'match' | 'mismatch' | 'unknown'
export interface IcpMatch {
  role: MatchValue
  industry: MatchValue
  size: MatchValue
  location: MatchValue
  note: string       // short mismatch reason, '' when everything matches or is unknown
}
const UNKNOWN_MATCH: IcpMatch = { role: 'unknown', industry: 'unknown', size: 'unknown', location: 'unknown', note: '' }

export interface LeadScore {
  fit: number        // 0-5 ICP fit: would this user sell to this company
  intent: number     // 0-5 is there a reason to contact them NOW
  action: number     // 0-5 can the user act: identifiable company, reachable, right size
  why: string        // one sentence: why this lead, why now
  signals: SignalId[]
  match: IcpMatch    // per-criterion role/industry/size/location read from the evidence
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
- match: four letters, one per ICP criterion, in this order: role, industry, size, location.
  y = the evidence shows the lead matches that criterion, n = the evidence shows it does NOT,
  ? = the evidence does not say. Judge each criterion only against the ICP above; when the ICP
  says nothing about a criterion, answer ?. Never guess a y or n without evidence.
- mism: when any match letter is n, a few words naming what is off (e.g. "wrong industry: manufacturing"); omit it otherwise.

Reply with one line per lead, exactly this format, no preamble:
LEAD <n> | fit <0-5> | intent <0-5> | action <0-5> | match <4 letters like yy?n> | signals <comma list or none> | why <sentence>[ | mism <words>]

${leads.map((l, i) => `LEAD ${i + 1}: company=${l.company || '?'} name=${l.name || '?'}\nsignal: ${l.signal}\nevidence: ${l.excerpt ?? '(none)'}`).join('\n\n')}`
}

const clamp5 = (n: number) => Math.max(0, Math.min(5, Math.round(n)))

// Tolerant parser: models rarely keep the exact pipe format. Split on LEAD <n> markers and read
// each axis wherever it appears in that lead's chunk (colon, pipe or comma separated).
export function parseScores(text: string, count: number): LeadScore[] | null {
  const out: (LeadScore | null)[] = Array.from({ length: count }, () => null)
  const chunks = text.split(/(?=LEAD\s+\d+)/i)
  for (const chunk of chunks) {
    const head = /^LEAD\s+(\d+)/i.exec(chunk.trim())
    if (!head) continue
    const idx = Number(head[1]) - 1
    if (idx < 0 || idx >= count) continue
    const num = (axis: string) => { const m = new RegExp(`${axis}\\s*[:=|]?\\s*(-?\\d+(?:\\.\\d+)?)`, 'i').exec(chunk); return m ? clamp5(Number(m[1])) : null }
    const fit = num('fit'), intent = num('intent'), action = num('action')
    if (fit === null || intent === null || action === null) continue
    const sm = /signals\s*[:=|]?\s*([^|\n]*)/i.exec(chunk)
    const signals = (sm?.[1] ?? '').split(',').map(s => s.trim().toLowerCase().replace(/[\s-]+/g, '_')).filter(s => SIGNAL_SET.has(s)) as SignalId[]
    const wm = /why\s*[:=|]?\s*(.+)/i.exec(chunk)
    let why = (wm?.[1] ?? '').trim()
    const mm = /match\s*[:=|]?\s*([yn?]{4})/i.exec(chunk)
    const nm = /mism\s*[:=|]?\s*(.+)$/im.exec(chunk)
    const note = (nm?.[1] ?? '').trim().slice(0, 160)
    if (note && why.endsWith(note)) why = why.slice(0, -note.length).replace(/[|\s]*mism\s*[:=|]?\s*$/i, '').replace(/[|\s]+$/, '')
    const letter = (c: string): MatchValue => (c.toLowerCase() === 'y' ? 'match' : c.toLowerCase() === 'n' ? 'mismatch' : 'unknown')
    const match: IcpMatch = mm
      ? { role: letter(mm[1][0]), industry: letter(mm[1][1]), size: letter(mm[1][2]), location: letter(mm[1][3]), note }
      : { ...UNKNOWN_MATCH }
    out[idx] = { fit, intent, action, signals, why: why.slice(0, 300), match }
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
    const parsed = parseScores(text, Math.min(leads.length, 40))
    if (!parsed) console.error('lead scoring: could not parse model output', text.slice(0, 300))
    return parsed
  } catch (e) {
    console.error('lead scoring failed', e instanceof Error ? e.message : 'error')
    return null
  }
}

export function icpTextFor(icp: Icp | null, fallback: string): string {
  if (!icp) return fallback
  return [icp.summary, icp.who.length ? `buyers: ${icp.who.join('; ')}` : '', icp.industries.length ? `industries: ${icp.industries.join('; ')}` : '', icp.sizes.length ? `sizes: ${icp.sizes.join('; ')}` : '', icp.where.length ? `where: ${icp.where.join('; ')}` : '', icp.signals.length ? `intent signals: ${icp.signals.join('; ')}` : '', icp.exclude.length ? `exclude: ${icp.exclude.join('; ')}` : ''].filter(Boolean).join('\n')
}

// Gate on criteria the ICP actually specifies. A mismatch the model read from the
// evidence on a specified criterion moves the lead into the hidden lane (fit <= 1)
// with the reason named; 'unknown' never gates, and criteria the ICP leaves open
// never gate either. Returns the same array with scores adjusted in place.
export function applyIcpGate(scores: LeadScore[], icp: Icp | null): LeadScore[] {
  if (!icp) return scores
  const checks: { key: keyof Omit<IcpMatch, 'note'>; specified: boolean }[] = [
    { key: 'role', specified: icp.who.length > 0 },
    { key: 'industry', specified: icp.industries.length > 0 },
    { key: 'size', specified: icp.sizes.length > 0 },
    { key: 'location', specified: icp.where.length > 0 },
  ]
  for (const s of scores) {
    const misses = checks.filter(c => c.specified && s.match[c.key] === 'mismatch')
    if (!misses.length) continue
    const names = misses.map(m => m.key).join('/')
    s.fit = Math.min(s.fit, HIDE_FIT_AT)
    s.why = `ICP mismatch (${names}${s.match.note ? `: ${s.match.note}` : ''}). ${s.why}`.slice(0, 300)
  }
  return scores
}

// Evidence-quality gate (deterministic, post-model): a lead whose quoted evidence reads as
// generic job-posting boilerplate is not a buying signal - it is a job ad. When the excerpt
// trips the job-posting markers and shows no active pain (frustration, switching intent or a
// competitor being named), cap the 0-100 score below 50 and force intent to 1/5. Hiring alone
// is not intent; the quote has to show the pain. Leads whose job post DOES show pain keep
// their grade.
const JOB_POSTING_MARKERS = /\b(responsibilities|requirements|qualifications|we are looking for|years? of experience|what you'?ll (do|be doing)|about the role|job description|job duties|who you are|what we'?re looking for|preferred qualifications|day[- ]to[- ]day)\b/i
const ACTIVE_PAIN_MARKERS = /\b(frustrat\w*|fed up|switch(ing)?\b|switch to|looking for (an? )?(alternative|replacement)|replac(e|ing|ment)\w*|migrat(e|ing|ion)\w* (away|off|from)|moving (off|away from)|hate|hates|sucks|terrible|awful|painful|nightmare|overpriced|too expensive|broken|clunky|outgrow(n|ing)?\b|rip (it |them )?out|ditch\w*|unhappy|disappointed|complain\w*|lacks?\b|missing features|can'?t do|limitation)\w*/i

export function readsLikeJobPosting(text: string): boolean { return JOB_POSTING_MARKERS.test(text) }
export function showsActivePain(text: string): boolean { return ACTIVE_PAIN_MARKERS.test(text) }

// Mutates leads in place. Returns how many leads were gated (for the audit trail).
export function applyEvidenceQualityGate(leads: { signal: string; excerpt?: string | null; score: number; intent?: number; why?: string }[]): number {
  let gated = 0
  for (const l of leads) {
    const text = `${l.signal}\n${l.excerpt ?? ''}`
    if (!readsLikeJobPosting(text) || showsActivePain(text)) continue
    gated++
    l.score = Math.min(l.score, 49)
    if (typeof l.intent === 'number') l.intent = Math.min(l.intent, 1)
    l.why = `Evidence reads as a job posting without active pain. ${l.why ?? ''}`.trim().slice(0, 300)
  }
  return gated
}
