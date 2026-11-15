// The research engine's orchestration (LEAD_ENGINE=research; port of ~/work/proto/ai-research/pipeline.py run()):
//   understand (A) -> hunt (A, + E/F sources) -> filter (C) -> read (D) -> literal pre-check, window, one event per company -> gate (C)
//   -> research (G) -> verify (D)
// Each part owns its stage behind the ResearchStages interface; this file only runs them in order, keeps the funnel and enforces the
// prototype's between-stage rules. A stage that is not built yet makes the engine not runnable (researchReady), and the scan then runs the
// old engine: the switch never produces a half-run scan.
import type { Candidate, CompanyResearch, Funnel, FunnelStage, ResearchCase, ResearchEvent, ResearchPlan, Verification, VerifiedLead } from './types.ts'
import type { HuntResult } from './hunt.ts'

export interface ResearchStages {
  plan(c: ResearchCase): Promise<ResearchPlan>
  hunt(c: ResearchCase, plan: ResearchPlan): Promise<HuntResult>
  filter?(c: ResearchCase, plan: ResearchPlan, cands: Candidate[]): Promise<{ all: Candidate[]; keep: Candidate[] }>                       // C
  read?(c: ResearchCase, plan: ResearchPlan, cand: Candidate): Promise<{ events: ResearchEvent[]; pageText: string | null }>               // D
  gate?(c: ResearchCase, events: ResearchEvent[]): Promise<ResearchEvent[]>                                                                // C
  research?(c: ResearchCase, plan: ResearchPlan, ev: ResearchEvent): Promise<CompanyResearch>                                              // G
  verify?(c: ResearchCase, ev: ResearchEvent, r: CompanyResearch): Promise<Verification>                                                   // D
}
export type ReadyStages = Required<ResearchStages>
export const researchReady = (s: ResearchStages): s is ReadyStages => !!(s.filter && s.read && s.gate && s.research && s.verify)
export const researchEngineOn = (env: Record<string, string | undefined> = process.env) => env.LEAD_ENGINE === 'research'

export const MAX_COMPANIES = 28

// the prototype's literal pre-check: the event's quote is on the page it was read from (whitespace and case folded), before anything is paid for it
const fold = (s: string) => s.toLowerCase().normalize('NFKC').replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, ' ').trim()
export const quoteOnPage = (quote: string, page: string): boolean => fold(quote).length >= 12 && fold(page).includes(fold(quote))
const inWindow = (day: string | null, c: ResearchCase): boolean | null => {
  if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return null
  const t = Date.parse(`${day}T00:00:00Z`), today = Date.parse(`${c.today}T00:00:00Z`)
  return t <= today && t >= today - c.windowDays * 86_400_000
}
// one event per company: a page-dated one first, then an index-dated one inside the window, then one naming people
export const companyKey = (name: string) => name.toLowerCase().replace(/[^\p{L}\p{N} ]+/gu, ' ').split(/\s+/).filter(w => w.length > 2 && !['the', 'and', 'inc', 'llc', 'llp', 'ltd', 'gmbh', 'group', 'company', 'pvt', 'limited'].includes(w)).join(' ') || name.toLowerCase().trim()
export function pickEvents(c: ResearchCase, events: { ev: ResearchEvent; pageText: string | null }[]): { kept: ResearchEvent[]; dropped: Record<string, number> } {
  const dropped: Record<string, number> = {}
  const drop = (k: string) => { dropped[k] = (dropped[k] ?? 0) + 1 }
  const by = new Map<string, { ev: ResearchEvent; rank: number }>()
  for (const { ev, pageText } of events) {
    if (!pageText || !quoteOnPage(ev.quote, pageText)) { drop('quote_not_on_page'); continue }
    const w = inWindow(ev.eventDate, c)
    if (w === false) { drop('outside_window'); continue }
    const rank = (w ? 2 : inWindow(ev.indexDate, c) ? 1 : 0) + (ev.people.length ? 0.5 : 0)
    const k = companyKey(ev.company), had = by.get(k)
    if (had) drop('same_company')
    if (!had || rank > had.rank) by.set(k, { ev, rank })
  }
  return { kept: [...by.values()].sort((a, b) => b.rank - a.rank).map(x => x.ev), dropped }
}

async function pmap<T, R>(items: T[], n: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length); let i = 0
  await Promise.all(Array.from({ length: Math.max(1, Math.min(n, items.length)) }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k]) } }))
  return out
}

export interface ResearchRun { plan: ResearchPlan; leads: VerifiedLead[]; funnel: Funnel }
export async function runResearch(c: ResearchCase, s: ReadyStages, o: { maxCompanies?: number; concurrency?: number } = {}): Promise<ResearchRun> {
  const stages: FunnelStage[] = []
  const timed = async <T>(fn: () => Promise<T>): Promise<[T, number]> => { const t = Date.now(); const r = await fn(); return [r, Math.round((Date.now() - t) / 1000)] }
  const [plan, s1] = await timed(() => s.plan(c))
  stages.push({ stage: 'understand', in: 1, out: plan.triggers.length, dropped: plan.source === 'fallback' ? { fallback_plan: 1 } : {}, seconds: s1 })
  const h = await s.hunt(c, plan); stages.push(h.funnel)
  const [f, s3] = await timed(() => s.filter(c, plan, h.candidates))
  const fd: Record<string, number> = {}; for (const x of f.all) if (x.dropped) fd[x.dropped] = (fd[x.dropped] ?? 0) + 1
  stages.push({ stage: 'filter', in: h.candidates.length, out: f.keep.length, dropped: fd, seconds: s3 })
  const [reads, s4] = await timed(() => pmap(f.keep, o.concurrency ?? 8, x => s.read(c, plan, x)))
  const raw = reads.flatMap(r => r.events.map(ev => ({ ev, pageText: r.pageText })))
  const picked = pickEvents(c, raw)
  stages.push({ stage: 'read', in: f.keep.length, out: picked.kept.length, dropped: { ...picked.dropped, pages_unread: reads.filter(r => r.pageText === null).length }, seconds: s4 })
  const [gated, s5] = await timed(() => s.gate(c, picked.kept))
  const surv = gated.slice(0, o.maxCompanies ?? MAX_COMPANIES)
  stages.push({ stage: 'gate', in: picked.kept.length, out: surv.length, dropped: { place_or_category: picked.kept.length - gated.length, company_budget: gated.length - surv.length }, seconds: s5 })
  const [ress, s6] = await timed(() => pmap(surv, o.concurrency ?? 6, ev => s.research(c, plan, ev)))
  stages.push({ stage: 'research', in: surv.length, out: ress.filter(r => r.person).length, dropped: { no_person: ress.filter(r => !r.person).length }, seconds: s6 })
  const [vs, s7] = await timed(() => pmap(surv.map((ev, i) => [ev, ress[i]] as const), o.concurrency ?? 6, ([ev, r]) => s.verify(c, ev, r)))
  const leads = surv.map((event, i) => ({ event, company: ress[i], verification: vs[i] })).filter(l => l.verification.triggerOk)
  stages.push({ stage: 'verify', in: surv.length, out: leads.filter(l => l.verification.ready).length, dropped: { trigger_unverified: surv.length - leads.length, held: leads.filter(l => !l.verification.ready).length }, seconds: s7 })
  return { plan, leads, funnel: { stages } }
}
