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

// Slots are 60 s / perMinute apart, handed out ROUND-ROBIN across tenants (#1267 review blocker 4): one tenant's long hunt (160 searches) never
// holds another tenant's first search behind all of it; within one tenant, in call order.
export class SearchQueue {
  readonly perMinute: number
  private next = 0
  private order: string[] = []
  private waiting = new Map<string, (() => void)[]>()
  private running = false
  private now: () => number
  private sleep: (ms: number) => Promise<void>
  constructor(perMinute = RESEARCH_SEARCHES_PER_MINUTE, now: () => number = Date.now, sleep: (ms: number) => Promise<void> = ms => new Promise(r => setTimeout(r, ms))) {
    this.perMinute = perMinute; this.now = now; this.sleep = sleep
  }
  // resolves when this caller may send
  slot(tenant = ''): Promise<void> {
    return new Promise<void>(resolve => {
      let q = this.waiting.get(tenant)
      if (!q) { q = []; this.waiting.set(tenant, q); this.order.push(tenant) }
      q.push(resolve)
      void this.pump()
    })
  }
  private async pump(): Promise<void> {
    if (this.running) return
    this.running = true
    try {
      while (this.order.length) {
        const w = this.next - this.now()
        if (w > 0) await this.sleep(w)
        const tenant = this.order.shift()!, q = this.waiting.get(tenant)!
        const go = q.shift()!
        if (q.length) this.order.push(tenant); else this.waiting.delete(tenant)
        this.next = Math.max(this.now(), this.next) + 60_000 / this.perMinute
        go()
      }
    } finally { this.running = false }
  }
}
export const researchSearchQueue = new SearchQueue(Number(process.env.RESEARCH_SEARCHES_PER_MINUTE) || RESEARCH_SEARCHES_PER_MINUTE)

// The one search every research stage uses (hunt, company research, sources that search): queued, inside the scan's caps and spend ledger,
// with the research budget as the per-scan search cap. `spent` is the scan's shared counter, so all stages draw on the same budget.
export function researchSearch(db: DbLike, tenant: string, spent: { searches: number }, deps: TfDeps = {}, queue: SearchQueue = researchSearchQueue) {
  const env = { ...(deps.env ?? process.env) }
  env.TINYFISH_SEARCHES_PER_SCAN = String(researchSearchBudget(env))
  return async (query: string, opts: { afterDate?: string; location?: string; language?: string } = {}): Promise<{ ok: true; hits: SearchHit[] } | { ok: false; reason: Fail; status?: number }> => {
    await queue.slot(tenant)
    return tfSearch(db, tenant, query, opts, spent, { ...deps, env, rateIsWait: true })   // a free 429 is a wait here (the hunt retries it)
  }
}
