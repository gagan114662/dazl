// Every research search waits its turn here (Hermes 15 Nov 02:15): dazl's TinyFish gate allows 20 searches a minute and REFUSES the rest at
// once ('rate'), which lost G's person searches (companies with no site). One process-wide queue spaces the research engine's searches at
// ~18 a minute so they are queued, never dropped; hunt.ts still retries a 'rate' answer as a backstop (another scan may share the minute).
// The research engine's own per-scan search budget (RESEARCH_SEARCH_BUDGET, default 160) applies only when LEAD_ENGINE=research; the old
// engine keeps TINYFISH_SEARCHES_PER_SCAN.
import { tfSearch, type TfDeps, type SearchHit, type Fail } from '../search/tinyfish.ts'
import type { DbLike } from '../db/client.ts'

export const RESEARCH_SEARCHES_PER_MINUTE = 18
export const DEFAULT_RESEARCH_SEARCH_BUDGET = 160   // Hermes 15 Nov 03:55: Sydney 8 -> 15 ready at 160 (the hunt alone sends ~46; G needs ~4 per company)
export const researchSearchBudget = (env: Record<string, string | undefined> = process.env): number => {
  const n = Number(env.RESEARCH_SEARCH_BUDGET)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_RESEARCH_SEARCH_BUDGET
}

export class SearchQueue {
  private next = 0
  readonly perMinute: number
  private now: () => number
  private sleep: (ms: number) => Promise<void>
  constructor(perMinute = RESEARCH_SEARCHES_PER_MINUTE, now: () => number = Date.now, sleep: (ms: number) => Promise<void> = ms => new Promise(r => setTimeout(r, ms))) {
    this.perMinute = perMinute; this.now = now; this.sleep = sleep
  }
  // resolves when this caller may send: slots are 60 s / perMinute apart, handed out in call order
  async slot(): Promise<void> {
    const gap = 60_000 / this.perMinute, t = Math.max(this.now(), this.next)
    this.next = t + gap
    const w = t - this.now()
    if (w > 0) await this.sleep(w)
  }
}
export const researchSearchQueue = new SearchQueue(Number(process.env.RESEARCH_SEARCHES_PER_MINUTE) || RESEARCH_SEARCHES_PER_MINUTE)

// The one search every research stage uses (hunt, company research, sources that search): queued, inside the scan's caps and spend ledger,
// with the research budget as the per-scan search cap. `spent` is the scan's shared counter, so all stages draw on the same budget.
export function researchSearch(db: DbLike, tenant: string, spent: { searches: number }, deps: TfDeps = {}, queue: SearchQueue = researchSearchQueue) {
  const env = { ...(deps.env ?? process.env) }
  env.TINYFISH_SEARCHES_PER_SCAN = String(researchSearchBudget(env))
  return async (query: string, opts: { afterDate?: string; location?: string; language?: string } = {}): Promise<{ ok: true; hits: SearchHit[] } | { ok: false; reason: Fail; status?: number }> => {
    await queue.slot()
    return tfSearch(db, tenant, query, opts, spent, { ...deps, env, rateIsWait: true })   // a free 429 is a wait here (the hunt retries it)
  }
}
