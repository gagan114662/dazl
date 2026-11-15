// The scan entry point of the research engine (LEAD_ENGINE=research, MISSION v2 part A). The runner (lib/scan/runner.ts runJobCapped) calls
// runResearchScan after the job's profile (ICP) is settled; it returns the leads in the runner's own shape, and the runner writes them with
// its own finish() (same INSERT, same review lane, same report), so Leads, Home and the journey read them exactly like the old engine's.
// Not runnable (a stage not built yet, the engine switched off, a CSV job): returns null and the runner runs the old engine.
import type { Provider } from '../llm/provider.ts'
import type { DbLike } from '../db/client.ts'
import type { TfDeps } from '../search/tinyfish.ts'
import type { SafeGet } from '../sources/types.ts'
import type { Icp } from '../scan/icp.ts'
import { planResearch } from './triggers.ts'
import { huntWithRegistry, tinyfishSearch } from './hunt.ts'
import { safeGet } from '../sources/http.ts'
import { researchReady, researchEngineOn, runResearch, type ResearchRun, type ResearchStages } from './engine.ts'
import type { ResearchCase, VerifiedLead } from './types.ts'

export const SONNET = 'claude-sonnet-4-5'
export const HAIKU = 'claude-haiku-4-5'

export interface ResearchScanContext {
  db: DbLike
  job: { id: string; user_id: string; query?: string | null; offer?: string | null; seller?: string | null }
  icp: Icp
  key: string                                         // the job's model key (owner's, or the trial operator's)
  model: (name: string) => Provider                   // a provider for one model, wrapped in the job's spend guards and meter by the runner
  isRefusal: (e: unknown) => boolean                  // a spend refusal (SpendRefused): it stops the scan, never swallowed
  tf?: TfDeps
  http?: SafeGet                                      // the registry sources' getter (default: the guarded safeGet); tests stub it
  now?: Date
  spent?: { searches: number }
}

// The case, from the job's own reviewed profile: the places and industries it names, its window (else the prototype's 90 days).
export function researchCaseFor(ctx: ResearchScanContext): ResearchCase | null {
  const where = (ctx.icp.where ?? []).filter(Boolean).join(', '), category = (ctx.icp.industries ?? []).filter(Boolean).join(', ')
  if (!ctx.job.query || !where || !category) return null   // no place or no category: the research prompts would guess them; the old engine runs
  return { tenant: ctx.job.user_id, jobId: ctx.job.id, query: ctx.job.query, offer: (ctx.job.offer ?? ctx.job.seller ?? '').trim() || ctx.job.query, seller: ctx.job.seller ?? null,
    where, category, windowDays: ctx.icp.window_days ?? 90, today: (ctx.now ?? new Date()).toISOString().slice(0, 10) }
}

// The stages this build has. Parts C (filter, gate), D (read, verify) and G (company research) register theirs through `extend` (the wiring PR);
// until all five exist the engine is not runnable and the old engine runs.
export type StageExtension = (ctx: ResearchScanContext, base: ResearchStages) => ResearchStages
const extensions: StageExtension[] = []
export const extendResearchStages = (x: StageExtension) => { extensions.push(x) }
export function researchStagesFor(ctx: ResearchScanContext, env: Record<string, string | undefined> = process.env): ResearchStages {
  const sonnet = ctx.model(SONNET)
  const spent = ctx.spent ?? { searches: 0 }
  const base: ResearchStages = {
    plan: c => planResearch(c, (p, max) => sonnet.complete!(ctx.key, p, undefined, max), ctx.isRefusal),
    // E's registry sources (free public records, dated by construction) join the search hits (lib/research/hunt.ts huntWithRegistry)
    hunt: (c, plan) => huntWithRegistry(c, plan, tinyfishSearch(ctx.db, c.tenant, spent, ctx.tf), ctx.http ?? safeGet, { env }),
  }
  return extensions.reduce((s, x) => x({ ...ctx, spent }, s), base)
}

// The runner's lead shape (lib/scan/runner.ts VerifiedLead / ReviewLead), structurally, so this module does not import the runner.
export interface ScanLeadRow {
  name: string; company: string; contact: string | null; signal: string; source_url: string; score: number; excerpt: string
  event_date: string | null; event_date_proof?: 'page_bound' | null; event_date_proof_note?: string | null
  confidence: number; date_status: 'verified' | 'unverified' | 'undated'; retrieved_at: number; why?: string
  review_reason?: string
}
export const RESEARCH_HELD = 'research_unverified'

// One verified research lead -> the runner's row. The event day is page_bound only when the page's own date quote proved it (D's verify);
// an index-dated day is kept unproven. Ready leads go to the leads list; the rest to the review lane with RESEARCH_HELD and what failed.
export function toScanRow(l: VerifiedLead, now: Date = new Date()): ScanLeadRow {
  const v = l.verification
  const proven = v.dateTier === 'page' && !!v.date
  return {
    name: l.company.person && v.personOk ? l.company.person.name : '',
    company: l.event.company,
    contact: null,
    signal: l.event.whatHappened,
    source_url: l.event.sourceUrl,
    score: Math.round(100 * Math.max(0, Math.min(1, v.triggerP ?? 0))),
    excerpt: l.event.quote,
    event_date: v.date,
    event_date_proof: proven ? 'page_bound' : null,
    event_date_proof_note: proven ? `research: the page's own date text "${(l.event.dateQuote ?? '').slice(0, 120)}"`.slice(0, 200) : null,
    confidence: Math.round(100 * Math.max(0, Math.min(1, v.triggerP ?? 0))),
    date_status: v.date ? (proven ? 'verified' : 'unverified') : 'undated',
    retrieved_at: Math.floor(now.getTime() / 1000),
    why: l.event.whyNow,
    ...(v.ready ? {} : { review_reason: RESEARCH_HELD }),
  }
}

// after the runner saved the rows: D writes its proof rows (the lead card's proof, the ready rule) and G its people, per saved lead
export type AfterSave = (db: import('better-sqlite3').Database, jobId: string, run: ResearchRun) => void | Promise<void>
const afterSaves: AfterSave[] = []
export const extendResearchAfterSave = (x: AfterSave) => { afterSaves.push(x) }
export interface ResearchScanResult { run: ResearchRun; leads: ScanLeadRow[]; review: (ScanLeadRow & { review_reason: string })[]; candidates: number; afterSave?: (db: import('better-sqlite3').Database, jobId: string) => Promise<void> }
export async function runResearchScan(ctx: ResearchScanContext, env: Record<string, string | undefined> = process.env): Promise<ResearchScanResult | null> {
  if (!researchEngineOn(env)) return null
  const c = researchCaseFor(ctx)
  if (!c) return null
  const stages = researchStagesFor(ctx, env)
  if (!researchReady(stages)) return null
  const run = await runResearch(c, stages, { isRefusal: ctx.isRefusal })
  const rows = run.leads.map(l => toScanRow(l, ctx.now))
  const hunted = run.funnel.stages.find(s => s.stage === 'hunt')?.out ?? 0
  return { run, leads: rows.filter(r => !r.review_reason), review: rows.filter((r): r is ScanLeadRow & { review_reason: string } => !!r.review_reason), candidates: hunted,
    afterSave: async (db, jobId) => { for (const x of afterSaves) await x(db, jobId, run) } }
}
