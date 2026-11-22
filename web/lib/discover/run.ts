// The whole discovery run, used by the scan lane (lib/scan/runner.ts) and by the benchmark (scripts/discover-bench.mts), so both
// measure and ship the same thing:
//   1. one Claude loop finds leads; dazl checks each proof page;
//   2. if fewer than `wantShown` leads are shown and the budget has room, a second loop looks for different companies;
//   3. a small-model pass fills the person, website and published email that shown leads still lack.
// Nothing is hidden: every lead comes back with its label. What a run may spend is stated by the caller.
import { discoverLeads, type DiscoverInput, type DiscoverUsage } from './agent.ts'
import { checkLeads, isShown, type CheckedLead } from './check.ts'
import { enrichLeads, mergeEnriched, needsEnrichment } from './enrich.ts'

export interface DiscoveryBudget { maxUsd: number; maxSearches?: number; maxFetches?: number; enrichLeads?: number; wantShown?: number }
export interface DiscoveryRun { leads: CheckedLead[]; usd: number; searches: number; requests: number; passes: number; enriched: number; stop: string; model: string; note: string | null }
export interface DiscoveryDeps { apiKey: string; fetch?: typeof fetch; signal?: AbortSignal; discover?: typeof discoverLeads; enrich?: typeof enrichLeads | null; now?: Date }

const r4 = (n: number) => Math.round(n * 10000) / 10000
// What the people pass has cost at most on the benchmark; a second search pass must leave room for it under the run's ceiling.
const PEOPLE_PASS_USD = 0.15

export async function runDiscovery(input: DiscoverInput, budget: DiscoveryBudget, deps: DiscoveryDeps): Promise<DiscoveryRun> {
  const discover = deps.discover ?? discoverLeads, enrich = deps.enrich === undefined ? enrichLeads : deps.enrich
  const api = { apiKey: deps.apiKey, fetch: deps.fetch, signal: deps.signal }
  const sized = { ...input, ...(budget.maxSearches ? { maxSearches: budget.maxSearches } : {}), ...(budget.maxFetches ? { maxFetches: budget.maxFetches } : {}) }
  const want = budget.wantShown ?? 5
  const usage: Pick<DiscoverUsage, 'usd' | 'searches' | 'requests'> = { usd: 0, searches: 0, requests: 0 }
  const add = (u: Pick<DiscoverUsage, 'usd' | 'searches' | 'requests'>) => { usage.usd = r4(usage.usd + u.usd); usage.searches += u.searches; usage.requests += u.requests }

  const first = await discover(sized, api)
  add(first.usage)
  let leads = await checkLeads(first.leads, first.seen, deps.fetch, 4)
  let passes = 1, stop = first.stop, model = first.model, note = first.note
  // A second pass for different companies, when the first came up short and a pass of the same size still fits the budget.
  if (leads.filter(isShown).length < want && first.stop !== 'refusal' && usage.usd + first.usage.usd + PEOPLE_PASS_USD <= budget.maxUsd) {
    try {
      const second = await discover({ ...sized, exclude: [...(input.exclude ?? []), ...first.leads.map(l => l.company)] }, api)
      add(second.usage)
      const known = new Set(leads.map(l => l.company.toLowerCase()))
      const more = (await checkLeads(second.leads, second.seen, deps.fetch, 4)).filter(l => !known.has(l.company.toLowerCase()))
      leads = [...leads, ...more]
      passes = 2
      note = second.note ?? note
    } catch { /* the first pass stands */ }
  }
  // People, websites and published emails for the shown leads that lack them. Unshown leads are not worth the calls.
  let enriched = 0
  const todo = leads.filter(l => isShown(l) && needsEnrichment(l))
  if (enrich && todo.length && usage.usd < budget.maxUsd) {
    try {
      const e = await enrich(todo, { offer: input.offer ?? null, maxLeads: budget.enrichLeads ?? 12 }, api)
      add(e.usage)
      enriched = e.enriched
      const byCompany = new Map(e.leads.map(l => [l.company, l]))
      leads = leads.map(l => { const m = byCompany.get(l.company); return m && isShown(l) ? { ...l, ...mergeEnriched(l, m) } : l })
    } catch { /* the leads stay as found */ }
  }
  return { leads, usd: usage.usd, searches: usage.searches, requests: usage.requests, passes, enriched, stop, model, note }
}
