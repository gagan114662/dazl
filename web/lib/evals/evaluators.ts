// Evaluators (docs/design/agent-evals.md): deterministic verifiers that score one replay. Each returns verdicts of
// pass / fail / unknown with a rationale and evidence pointers. Unknown is NEVER pass: a case with any unknown verdict
// is unknown, and validated-rate denominators count unknowns as not validated (#394). Evaluators read the case, the
// World and the replay result only; they cannot change the input, the World or the targeting.
//
// LLM judges come later and only where no deterministic check exists; each will be validated against labelled
// fixtures (#396) before its verdicts count.
import { getDomain } from 'tldts'
import type { Case } from './case.ts'
import type { World } from './world.ts'
import { CANARY, CANARY_TENANT, CASE_TENANT, type ReplayLead, type ReplayResult } from './result.ts'

export const EVAL_CONTRACT = 'dazl.evals/1'
export type VerdictStatus = 'pass' | 'fail' | 'unknown'
export interface Verdict { evaluator: string; version: number; subject: string; status: VerdictStatus; rationale: string; evidence?: string[] }
export interface EvalContext { kase: Case; world: World; result: ReplayResult }
export interface Evaluator { id: string; version: number; kind: 'deterministic' | 'judge'; critical: boolean; evaluate(ctx: EvalContext): Verdict[] }

const verified = (r: ReplayResult) => r.leads.filter(l => l.review_reason === null)
const subj = (l: ReplayLead) => `lead:${l.company}`
const v = (e: Pick<Evaluator, 'id' | 'version'>, subject: string, status: VerdictStatus, rationale: string, evidence?: string[]): Verdict => ({ evaluator: e.id, version: e.version, subject, status, rationale, ...(evidence ? { evidence } : {}) })
const squash = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase()

// The replay asked for nothing the World could not answer. A miss means the run met a gap, not the World it was built
// from, so its other verdicts describe a different run.
export const worldClosed: Evaluator = {
  id: 'world_closed', version: 1, kind: 'deterministic', critical: true,
  evaluate({ result }) {
    return [result.misses.length === 0
      ? v(this, 'run', 'pass', 'every external call was answered from the World')
      : v(this, 'run', 'fail', `${result.misses.length} call(s) the World could not answer`, result.misses.slice(0, 10).map(m => `${m.kind}:${m.key}`))]
  },
}

// A verified lead's event date is a real calendar day, not in the future, and inside the request's window at as_of.
// Whole UTC calendar days, the convention of event dates and of the replay's as_of: the as_of day itself passes, the next
// day is the future (fails) at any as_of time of day, and the window is inclusive (window_days days before as_of passes).
// v2: v1 allowed one day of slack (age >= -1), so tomorrow passed.
export const eventDateInWindow: Evaluator = {
  id: 'event_date_in_window', version: 2, kind: 'deterministic', critical: true,
  evaluate({ kase, world, result }) {
    const at = new Date(Date.parse(world.as_of))
    const asOfDay = Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate())
    const icpWindow = (kase.input.icp as { window_days?: unknown }).window_days
    const days = kase.expect.window_days ?? (typeof icpWindow === 'number' ? icpWindow : 90)
    return verified(result).map(l => {
      const d = l.event_date
      if (!d) return v(this, subj(l), 'unknown', 'verified lead has no event date')
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d)
      const t = m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) : NaN
      if (!m || new Date(t).getUTCDate() !== +m[3] || new Date(t).getUTCMonth() !== +m[2] - 1) return v(this, subj(l), 'fail', `event date ${d} is not a real calendar date`, [l.source_url])
      const age = Math.round((asOfDay - t) / 86_400_000) // both are UTC midnights: a whole number of days
      if (age < 0) return v(this, subj(l), 'fail', `event date ${d} is after the as_of day ${new Date(asOfDay).toISOString().slice(0, 10)}`, [l.source_url])
      if (age > days) return v(this, subj(l), 'fail', `event date ${d} is ${age} days before as_of, outside the ${days}-day window`, [l.source_url])
      return v(this, subj(l), 'pass', `event date ${d} is ${age} days before as_of`, [l.source_url])
    })
  },
}

// A verified lead's quote is on the page the World says the cited URL served (the agent's own fetch, or the TinyFish
// copy it was allowed to use). Checked against the frozen World, not against what the agent says it read.
export const evidenceInWorld: Evaluator = {
  id: 'evidence_in_world', version: 1, kind: 'deterministic', critical: true,
  evaluate({ world, result }) {
    return verified(result).map(l => {
      if (!l.excerpt) return v(this, subj(l), 'fail', 'verified lead carries no evidence excerpt')
      const own = world.pages[l.source_url]
      const texts = [own && 'text' in own ? own.text : null, world.tinyfish_pages[l.source_url]?.text ?? null].filter((t): t is string => !!t)
      if (texts.length === 0) return v(this, subj(l), 'fail', 'the cited URL served no text in the World', [l.source_url])
      return texts.some(t => squash(t).includes(squash(l.excerpt!)))
        ? v(this, subj(l), 'pass', 'excerpt appears on the cited page', [l.source_url])
        : v(this, subj(l), 'fail', 'excerpt does not appear on the cited page', [l.source_url])
    })
  },
}

// A verified lead's cited page names a place the request asked for. Deliberately independent of the scan's own place
// logic (lib/scan/place-agreement.ts): a plain look for the requested city on the frozen page. It has no gazetteer, so
// it cannot tell "names another city" from "names no place": both are unknown, never pass. No place requested: no verdict.
export const placeOnPage: Evaluator = {
  id: 'place_on_page', version: 1, kind: 'deterministic', critical: true,
  evaluate({ kase, world, result }) {
    const where = (kase.input.icp as { where?: unknown }).where
    const places = (Array.isArray(where) ? where : []).map(x => String(x).split(',')[0].trim().toLowerCase()).filter(x => x.length >= 2)
    if (places.length === 0) return []
    const names = (text: string, p: string) => /^[a-z .'-]+$/.test(p) ? new RegExp(`(^|[^a-z])${p.replace(/[.'-]/g, '\\$&')}([^a-z]|$)`).test(text) : text.includes(p)
    return verified(result).map(l => {
      const own = world.pages[l.source_url]
      const text = `${own && 'text' in own ? `${own.title} ${own.text}` : ''} ${world.tinyfish_pages[l.source_url]?.text ?? ''}`.toLowerCase()
      const hit = places.find(p => names(text, p))
      return hit ? v(this, subj(l), 'pass', `the cited page names ${hit}`, [l.source_url]) : v(this, subj(l), 'unknown', `the cited page never names ${places.join(' or ')}`, [l.source_url])
    })
  },
}

// A verified lead's event date is stated in the cited page's TEXT (#395: an old article with a fresh publication date). A date
// that is only the page's publication metadata says when the page was (re)published, not when the event happened: unknown, never
// pass. Recognised forms: 2026-10-08, October 8, 2026 / Oct 8, 2026, 8 October 2026. No date on the lead: no verdict here
// (event_date_in_window already holds it unknown).
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december']
function dateForms(iso: string): string[] {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso)
  if (!m) return [iso.toLowerCase()]
  const [y, mo, d] = [m[1], MONTHS[+m[2] - 1], String(+m[3])]
  if (!mo) return [iso]
  return [iso, `${mo} ${d}, ${y}`, `${mo.slice(0, 3)} ${d}, ${y}`, `${mo.slice(0, 3)}. ${d}, ${y}`, `${d} ${mo} ${y}`, `${d} ${mo.slice(0, 3)} ${y}`]
}
// A date form counts only as a whole token: "2026-10-080123", "x2026-10-08x" and "18 october 2026" do not state 2026-10-08.
const statesToken = (text: string, form: string) => new RegExp(`(?<![\\p{L}\\p{N}])${form.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}])`, 'u').test(text)
export const eventDateOnPage: Evaluator = {
  id: 'event_date_on_page', version: 2, kind: 'deterministic', critical: true,
  evaluate({ world, result }) {
    return verified(result).filter(l => l.event_date).map(l => {
      const own = world.pages[l.source_url]
      const text = squash(`${own && 'text' in own ? `${own.title} ${own.text}` : ''} ${world.tinyfish_pages[l.source_url]?.text ?? ''}`)
      if (dateForms(l.event_date!).some(f => statesToken(text, f))) return v(this, subj(l), 'pass', `the page text states ${l.event_date}`, [l.source_url])
      const published = own && 'published' in own ? own.published : null
      return published === l.event_date
        ? v(this, subj(l), 'unknown', `${l.event_date} is only the page's publication date; the text never dates the event`, [l.source_url])
        : v(this, subj(l), 'unknown', `${l.event_date} does not appear on the page`, [l.source_url])
    })
  },
}

// A verified lead's email contact is not a recruiting inbox (#395): careers@, jobs@, hr@ and the like route to hiring, not to a
// buyer. A phone or no contact gets no verdict here.
const RECRUITING_LOCAL = /^(?:jobs?|careers?|recruit(?:ing|ment|er|ers)?|talent(?:acquisition)?|hr|humanresources|hiring|apply|applications?|cv|cvs|resumes?|joinus|join|work(?:withus)?)$/
export const contactNotRecruitingInbox: Evaluator = {
  id: 'contact_not_recruiting_inbox', version: 2, kind: 'deterministic', critical: true,
  evaluate({ result }) {
    return verified(result).filter(l => l.contact && l.contact.includes('@')).map(l => {
      // the mailbox stem before any +tag: careers+toronto@ is still the careers inbox
      const local = l.contact!.trim().split('@')[0].split('+')[0].toLowerCase().replace(/[._-]/g, '')
      return RECRUITING_LOCAL.test(local)
        ? v(this, subj(l), 'fail', `contact ${l.contact} is a recruiting inbox, not a route to a buyer`, [l.source_url])
        : v(this, subj(l), 'pass', 'contact is not a recruiting inbox')
    })
  },
}

// A verified lead's email contact is at a domain that belongs to the company (case ground truth). No ground truth for the
// company, or a phone-only contact, is unknown, not pass. A lead with no contact gets no verdict here (nothing to check).
export const contactDomainMatchesCompany: Evaluator = {
  id: 'contact_domain_matches_company', version: 1, kind: 'deterministic', critical: true,
  evaluate({ kase, result }) {
    const truth = new Map(Object.entries(kase.expect.entities ?? {}).map(([k, e]) => [k.toLowerCase(), e.domains.map(d => getDomain(d) ?? d.toLowerCase())]))
    return verified(result).filter(l => l.contact).map(l => {
      const email = /@([A-Z0-9.-]+\.[A-Z]{2,})$/i.exec(l.contact!.trim())
      if (!email) return v(this, subj(l), 'unknown', 'contact is not an email; its owner cannot be checked from a domain')
      const domains = truth.get(l.company.toLowerCase())
      if (!domains) return v(this, subj(l), 'unknown', 'the case names no domains for this company')
      const got = getDomain(email[1]) ?? email[1].toLowerCase()
      return domains.includes(got)
        ? v(this, subj(l), 'pass', `contact domain ${got} belongs to the company`)
        : v(this, subj(l), 'fail', `contact domain ${got} is not one of the company's domains (${domains.join(', ')})`, [l.source_url])
    })
  },
}

// Nothing from the other tenant reached this run: its rows are untouched, no lead belongs to it, and no canary value
// appears in anything the run sent out (prompts, URLs, bodies) or produced (leads).
export const noTenantLeak: Evaluator = {
  id: 'no_tenant_leak', version: 1, kind: 'deterministic', critical: true,
  evaluate({ result }) {
    const canaries = [CANARY.company, CANARY.contact, CANARY.signal, CANARY.source_url, 'CANARY-TENANT-B']
    const found: string[] = []
    if (!result.canaryIntact) found.push('canary tenant rows changed')
    for (const l of result.leads) if (l.tenant !== CASE_TENANT) found.push(`lead ${l.company} belongs to ${l.tenant}`)
    const scan = (where: string, x: unknown) => { const s = JSON.stringify(x) ?? ''; for (const c of canaries) if (s.includes(c)) found.push(`${where} contains ${c === CANARY.contact ? 'the canary contact' : 'a canary value'}`) }
    for (const s of result.trace.spans) scan(`span ${s.id} (${s.name}) input`, s.input)
    scan('leads', result.leads)
    return [found.length === 0 ? v(this, 'run', 'pass', `no ${CANARY_TENANT} data in the run`) : v(this, 'run', 'fail', 'data from another tenant reached this run', found.slice(0, 10))]
  },
}

// The case's named outcomes: each company verified, held (optionally with the expected reason) or absent; and, when the
// case is exhaustive, no verified lead the case did not name.
export const expectedOutcomes: Evaluator = {
  id: 'expected_outcomes', version: 1, kind: 'deterministic', critical: false,
  evaluate({ kase, result }) {
    const by = new Map<string, ReplayLead[]>()
    for (const l of result.leads) by.set(l.company.toLowerCase(), [...(by.get(l.company.toLowerCase()) ?? []), l])
    const out: Verdict[] = kase.expect.leads.map(e => {
      const rows = by.get(e.company.toLowerCase()) ?? []
      const got = rows.length === 0 ? 'absent' : rows.some(r => r.review_reason === null) ? 'verified' : 'held'
      const reasons = rows.map(r => r.review_reason).filter(Boolean) as string[]
      if (got !== e.outcome) return v(this, `expect:${e.company}`, 'fail', `expected ${e.outcome}, got ${got}${reasons.length ? ` (${reasons.join(', ')})` : ''}`)
      if (e.outcome === 'held' && e.review_reason && !reasons.includes(e.review_reason)) return v(this, `expect:${e.company}`, 'fail', `held as expected but for ${reasons.join(', ')}, not ${e.review_reason}`)
      return v(this, `expect:${e.company}`, 'pass', `${got}${reasons.length ? ` (${reasons.join(', ')})` : ''}`)
    })
    if (kase.expect.exhaustive) {
      const named = new Set(kase.expect.leads.map(e => e.company.toLowerCase()))
      for (const l of verified(result)) if (!named.has(l.company.toLowerCase())) out.push(v(this, subj(l), 'fail', 'verified a company the case does not name', [l.source_url]))
    }
    return out
  },
}

export const SCAN_EVALUATORS: Evaluator[] = [worldClosed, eventDateInWindow, eventDateOnPage, evidenceInWorld, placeOnPage, contactDomainMatchesCompany, contactNotRecruitingInbox, noTenantLeak, expectedOutcomes]

export interface CaseScore {
  contract: typeof EVAL_CONTRACT; case: string; status: VerdictStatus
  evaluators: Record<string, { version: number; pass: number; fail: number; unknown: number }>
  verdicts: Verdict[]
  validated_rate: number | null     // pass / all verdicts; unknowns are in the denominator (not validated)
  unknown_rate: number | null
}

// A case passes only when every verdict passes. Any fail makes it fail; otherwise any unknown makes it unknown.
export function scoreCase(ctx: EvalContext, evaluators: Evaluator[] = SCAN_EVALUATORS): CaseScore {
  const verdicts = evaluators.flatMap(e => e.evaluate(ctx))
  const per: CaseScore['evaluators'] = {}
  for (const e of evaluators) per[e.id] = { version: e.version, pass: 0, fail: 0, unknown: 0 }
  for (const x of verdicts) per[x.evaluator][x.status]++
  const n = verdicts.length
  const count = (s: VerdictStatus) => verdicts.filter(x => x.status === s).length
  return {
    contract: EVAL_CONTRACT, case: ctx.kase.id,
    status: count('fail') ? 'fail' : count('unknown') ? 'unknown' : 'pass',
    evaluators: per, verdicts,
    validated_rate: n ? count('pass') / n : null,
    unknown_rate: n ? count('unknown') / n : null,
  }
}
