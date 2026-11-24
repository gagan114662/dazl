// The whole discovery run, used by the scan lane (lib/scan/runner.ts) and by the benchmark (scripts/discover-bench.mts), so both
// measure and ship the same thing:
//   1. one Claude loop finds leads; dazl checks each proof page;
//   2. if fewer than `wantShown` leads are shown and the budget has room, a second loop looks for different companies;
//   3. a small-model pass fills the person, website and published email that shown leads still lack.
// Nothing is hidden: every lead comes back with its label. What a run may spend is stated by the caller.
import { discoverLeads, type DiscoverInput, type DiscoverUsage } from './agent.ts'
import { signalJudge, type SignalJudge } from './entail.ts'
import { checkLeads, isShown, type CheckedLead } from './check.ts'
import { dropUnseenProfile, enrichLeads, mergeEnriched, needsEnrichment } from './enrich.ts'

export interface DiscoveryBudget { maxUsd: number; maxSearches?: number; maxFetches?: number; enrichLeads?: number; wantShown?: number }
// pages: every URL the run's searches and page reads returned (the scan lane looks for LinkedIn posts among them).
export interface DiscoveryRun { pages: string[]; leads: CheckedLead[]; usd: number; searches: number; requests: number; passes: number; enriched: number; stop: string; model: string; note: string | null }
export interface DiscoveryDeps { apiKey: string; fetch?: typeof fetch; signal?: AbortSignal; discover?: typeof discoverLeads; enrich?: typeof enrichLeads | null; judge?: SignalJudge | null; now?: Date }

const r4 = (n: number) => Math.round(n * 10000) / 10000
// What the people pass has cost at most on the benchmark; a second search pass must leave room for it under the run's ceiling.
const PEOPLE_PASS_USD = 0.15
// The most one lead can cost in the people pass (lib/discover/enrich.ts): 4 web searches at US$0.01 each, plus the small model's tokens.
const PEOPLE_LEAD_USD = 0.045

export async function runDiscovery(input: DiscoverInput, budget: DiscoveryBudget, deps: DiscoveryDeps): Promise<DiscoveryRun> {
  const discover = deps.discover ?? discoverLeads, enrich = deps.enrich === undefined ? enrichLeads : deps.enrich
  const api = { apiKey: deps.apiKey, fetch: deps.fetch, signal: deps.signal }
  const sized = { ...input, ...(budget.maxSearches ? { maxSearches: budget.maxSearches } : {}), ...(budget.maxFetches ? { maxFetches: budget.maxFetches } : {}) }
  const want = budget.wantShown ?? 5
  const usage: Pick<DiscoverUsage, 'usd' | 'searches' | 'requests'> = { usd: 0, searches: 0, requests: 0 }
  const add = (u: Pick<DiscoverUsage, 'usd' | 'searches' | 'requests'>) => { usage.usd = r4(usage.usd + u.usd); usage.searches += u.searches; usage.requests += u.requests }

  const first = await discover(sized, api)
  add(first.usage)
  // one judge for the run: asked only where the quote is on the page and the words alone could not settle it (lib/discover/check.ts)
  const judge: SignalJudge | null = deps.judge === undefined ? signalJudge(api) : deps.judge
  let leads = await checkLeads(first.leads.map(l => dropUnseenProfile(l, first.seen)), first.seen, deps.fetch, 4, judge?.ask)
  const pages = first.seen.map(p => p.url)
  const stop = first.stop, model = first.model
  let passes = 1, note = first.note
  // A second pass for different companies, when the first came up short and a pass of the same size still fits the budget.
  if (leads.filter(isShown).length < want && first.stop !== 'refusal' && usage.usd + first.usage.usd + PEOPLE_PASS_USD <= budget.maxUsd) {
    try {
      const second = await discover({ ...sized, exclude: [...(input.exclude ?? []), ...first.leads.map(l => l.company)] }, api)
      add(second.usage)
      pages.push(...second.seen.map(p => p.url))
      const known = new Set(leads.map(l => l.company.toLowerCase()))
      const more = (await checkLeads(second.leads.map(l => dropUnseenProfile(l, second.seen)), second.seen, deps.fetch, 4, judge?.ask)).filter(l => !known.has(l.company.toLowerCase()))
      leads = [...leads, ...more]
      passes = 2
      note = second.note ?? note
    } catch { /* the first pass stands */ }
  }
  // People, websites and published emails for the leads that lack them: the shown ones first, then the ones that wait for the person's
  // review (owner, 2026-11-24). A lead in review with no contact cannot be acted on once the person accepts it, and a free search at
  // the launch budget returned 10 of 39 leads that way with no people pass at all (staging benchmark, `171d9102`). The pass takes
  // the first `enrichLeads` of this list, so shown leads never lose their place. A lead whose proof page is gone gets no call.
  let enriched = 0
  const wants = (l: CheckedLead) => l.proof !== 'gone' && needsEnrichment(l)
  const todo = [...leads.filter(l => isShown(l) && wants(l)), ...leads.filter(l => !isShown(l) && wants(l))]
  // Review of PR #1690: the pass was only checked once against the run's ceiling, before it started, so a run that had spent nearly
  // all of it could still start a full pass and settle past its reservation (now more likely, with leads in review included). The
  // number of leads the pass may take is what the money left can pay for at a lead's worst case.
  const maxLeads = Math.min(budget.enrichLeads ?? 12, Math.floor((budget.maxUsd - usage.usd + 1e-9) / PEOPLE_LEAD_USD))
  if (enrich && todo.length && maxLeads > 0) {
    try {
      const e = await enrich(todo, { offer: input.offer ?? null, maxLeads }, api)
      add(e.usage)
      enriched = e.enriched
      const byCompany = new Map(e.leads.map(l => [l.company, l]))
      leads = leads.map(l => { const m = byCompany.get(l.company); return m && l.proof !== 'gone' ? { ...l, ...mergeEnriched(l, m) } : l })
    } catch { /* the leads stay as found */ }
  }
  if (judge) add({ usd: judge.usage.usd, searches: 0, requests: judge.usage.requests })
  return { pages, leads, usd: usage.usd, searches: usage.searches, requests: usage.requests, passes, enriched, stop, model, note }
}
