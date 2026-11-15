// The research engine's stages, wired (MISSION v2): C (filter, gate: #1262), D (read, verify, proof: #1264), G (company research: #1265) plug
// into part A's slots (scan-job.ts extendResearchStages). Imported once for its side effect by the runner. Every model call is on a provider
// the runner guarded for this job (ctx.model); every search through the queued research search (search-queue.ts); pages through the
// scan's own guarded fetchers. One page cache per scan: read and verify open the same page once.
import type Database from 'better-sqlite3'
import { extendResearchStages, extendResearchAfterSave, HAIKU, type ResearchScanContext } from './scan-job.ts'
import type { ResearchStages } from './engine.ts'
import type { Candidate, CompanyResearch, ResearchEvent, Verification } from './types.ts'
import { researchSearch } from './search-queue.ts'
import { Decider } from './decider.ts'
import { filterStage } from './filter.ts'
import { gateStage } from './gate.ts'
import { readPage, type ReadablePage } from './read-page.ts'
import { verifyLead, type Decide, type EventToVerify, type PersonToVerify, type Verdict } from './verify.ts'
import { writeResearchProof, researchProofGap } from './proof.ts'
import { researchCompany } from './company.ts'
import { saveResearchContacts } from './contacts.ts'
import { fetchPageDetailed, isFail, type Page } from '../scan/fetch-page.ts'
import { defaultGet } from '../connectors/sitecrawl.ts'

const key = (sourceUrl: string, company: string) => `${sourceUrl}|${company.toLowerCase().trim()}`
// what verify decided per event, so the proof rows can be written once the runner has saved the leads (per job)
const verdicts = new Map<string, Map<string, { v: Verdict; ev: EventToVerify; person: PersonToVerify | null }>>()

class Slots {
  private free: number; private waiting: (() => void)[] = []
  constructor(n: number) { this.free = n }
  acquire(): Promise<void> { if (this.free > 0) { this.free--; return Promise.resolve() } return new Promise(r => this.waiting.push(r)) }
  release(): void { const next = this.waiting.shift(); if (next) next(); else this.free++ }
}
export const RESEARCH_MODEL_CONCURRENCY = Number(process.env.RESEARCH_MODEL_CONCURRENCY) || 3
const modelSlots = new Slots(RESEARCH_MODEL_CONCURRENCY)

export function wiredStages(ctx: ResearchScanContext, base: ResearchStages, o: { fetch?: (url: string) => Promise<Page | { fail: string }>; get?: ReturnType<typeof defaultGet>; decider?: Decider } = {}): ResearchStages {
  const haiku = ctx.model(HAIKU)
  // At most RESEARCH_MODEL_CONCURRENCY (3) model calls in flight per scan: a vendor 429 ends the whole scan (provider_rate_limited, never retried
  // automatically, #363), and the key is shared, so the engine keeps its burst small rather than racing the vendor's limit.
  const ask = async (prompt: string, max: number): Promise<string> => {
    await modelSlots.acquire()
    try { return await haiku.complete!(ctx.key, prompt, undefined, max) } catch (e) { if (ctx.isRefusal(e)) throw e; return '' } finally { modelSlots.release() }
  }
  const decider = o.decider ?? new Decider()
  // D asks yes/no questions only, so every answer is a probability; a string answer (a choice question) is not one and reads as no answer
  const decide: Decide = async (state, questions) => { const a = await decider.decide(state, questions); return a ? Object.fromEntries(Object.entries(a).map(([k, x]) => [k, typeof x === 'number' ? x : null])) : null }
  const fetchOne = o.fetch ?? ((url: string) => fetchPageDetailed(url))
  const pages = new Map<string, Promise<Page | null>>()
  const open = (url: string) => { let p = pages.get(url); if (!p) { p = fetchOne(url).then(r => (isFail(r as Page) ? null : r as Page)).catch(() => null); pages.set(url, p) } return p }
  const metaDates = (p: Page) => (p.published ? [`published: ${p.published}`] : [])
  const search = researchSearch(ctx.db, ctx.job.user_id, ctx.spent ?? { searches: 0 }, ctx.tf)
  const get = o.get ?? defaultGet()
  const mine = new Map<string, { v: Verdict; ev: EventToVerify; person: PersonToVerify | null }>()
  verdicts.set(ctx.job.id, mine)
  return {
    ...base,
    filter: filterStage({ decider, fallback: ask }),
    gate: gateStage(ask),
    read: async (c, plan, cand: Candidate) => {
      const p = await open(cand.url)
      if (!p) return { events: [], pageText: null }
      const page: ReadablePage = { url: cand.url, title: p.title, text: p.text, metaDates: metaDates(p) }
      const evs = await readPage(page, { today: c.today, category: c.category, location: c.where, offer: c.offer, triggers: plan.triggers.map(t => ({ id: t.id, name: t.name })) }, ask)
      return { pageText: p.text, events: evs.map((e): ResearchEvent => ({ company: e.company, website: e.website, pageIsCompanySite: e.pageIsCompanysOwnSite, triggerId: e.triggerId ?? cand.triggerId,
        whatHappened: e.whatHappened, whyNow: e.whyNow, quote: e.quote, eventDate: e.eventDate, dateQuote: e.dateQuote, locationQuote: e.locationQuote, people: e.people, sourceUrl: cand.url,
        indexDate: cand.date, foundBy: cand.query })) }
    },
    company: (c, plan, ev) => researchCompany(c, plan, ev, {
      search: async q => { const r = await search(q); return r.ok ? r.hits.map(h => ({ url: h.url, title: h.title, snippet: h.snippet })) : [] },
      get: async url => { try { const r = await get(url); return r ? { status: r.status, body: r.body, finalUrl: r.finalUrl } : null } catch { return null } },
      complete: async (p, max) => (await ask(p, max)) || null,
    }),
    verify: async (c, ev, r: CompanyResearch): Promise<Verification> => {
      const p = await open(ev.sourceUrl)
      const e: EventToVerify = { company: ev.company, whatHappened: ev.whatHappened, whyNow: ev.whyNow, quote: ev.quote, eventDate: ev.eventDate, dateQuote: ev.dateQuote, sourceUrl: ev.sourceUrl }
      const src = r.person ? r.sources.find(s => s.id === r.person!.sourceId) : undefined
      const person: PersonToVerify | null = r.person && src ? { name: r.person.name, title: r.person.title, quote: r.person.quote, sourceUrl: src.url, sourceText: src.text } : null
      const now = Date.parse(`${c.today}T12:00:00Z`)
      const v = p ? await verifyLead(e, { url: ev.sourceUrl, text: p.text, readAt: now, metaDates: metaDates(p) }, person, decide, { now, windowDays: c.windowDays }) : null
      if (v) mine.set(key(ev.sourceUrl, ev.company), { v, ev: e, person })
      const placeOk = ev.gate !== 'no'
      return {
        triggerLiteral: v?.event.literal ?? false, triggerP: v?.event.support ?? null, triggerOk: v?.event.ok ?? false,
        date: v?.day.date ?? null, dateTier: v?.day.date ? (v.day.onPage ? 'page' : 'index') : null, dateInWindow: v?.day.inWindow ?? false,
        personOk: v?.person.ok ?? false, personP: v?.person.support ?? null, personTier: v?.person.ok ? (src?.kind ?? 'page') : null, personUrl: v?.person.sourceUrl ?? null,
        placeP: null, categoryP: null, placeCategoryOk: placeOk,
        ready: !!v?.ready && placeOk, why: [...(v?.why ? [v.why] : p ? [] : ['the source page could not be opened again']), ...(placeOk ? [] : ['not in the place or category'])],
      }
    },
  }
}

// After the runner saved the rows: D's proof on every ready lead (the currentness gate reads it, so Leads/Home show it ready). One lead's failure
// never stops the others; each outcome is counted and logged (no lead data, only counts and gap codes).
export function writeProofs(db: Database.Database, jobId: string): Record<string, number> {
  const out: Record<string, number> = {}
  const count = (k: string) => { out[k] = (out[k] ?? 0) + 1 }
  const mine = verdicts.get(jobId)
  verdicts.delete(jobId)
  const job = db.prepare('SELECT user_id FROM scan_jobs WHERE id = ?').get(jobId) as { user_id: string } | undefined
  if (!mine || !job) return out
  for (const l of db.prepare('SELECT id, company, source_url FROM leads WHERE scan_job_id = ? AND review_reason IS NULL').all(jobId) as { id: string; company: string; source_url: string }[]) {
    const x = mine.get(key(l.source_url, l.company))
    if (!x) { count('no_verdict'); continue }
    if (!x.person) { count('no_person'); continue }
    try {
      if (!writeResearchProof(db, job.user_id, l.id, x.v, x.ev, x.person)) { count('write_refused'); continue }
      const gap = researchProofGap(db, job.user_id, l.id)
      count(gap ? `gap_${gap}` : 'proven')
    } catch (e) { count(`error_${String((e as Error)?.message ?? e).replace(/[^a-z_ ]/gi, '').slice(0, 40)}`) }
  }
  console.error(`[research] proofs for job ${jobId}: ${JSON.stringify(out)}`)
  return out
}

extendResearchStages((ctx, base) => wiredStages(ctx, base))
extendResearchAfterSave((db, jobId) => { writeProofs(db, jobId) })
// Refs #1099: the addresses company research found printed on the company's own pages, and one unverified guess per named person
extendResearchAfterSave(async (db, jobId, run) => {
  try { console.error(`[research] contacts for job ${jobId}: ${JSON.stringify(await saveResearchContacts(db, jobId, run.leads))}`) }
  catch (e) { console.error(`[research] contacts for job ${jobId} failed: ${String((e as Error)?.message ?? e).slice(0, 120)}`) }
})
