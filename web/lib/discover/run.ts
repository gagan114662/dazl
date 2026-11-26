// The whole discovery run, used by the scan lane (lib/scan/runner.ts) and by the benchmark (scripts/discover-bench.mts), so both
// measure and ship the same thing:
//   1. one Claude loop finds leads; dazl checks each proof page;
//   2. if fewer than `wantShown` leads are shown and the budget has room, a second loop looks for different companies;
//   3. a small-model pass fills the person, website and published email that shown leads still lack.
// Nothing is hidden: every lead comes back with its label. What a run may spend is stated by the caller.
import { discoverLeads, type DiscoverInput, type DiscoverResult, type DiscoverUsage } from './agent.ts'
import { configuredSearchAllowance, createSearchBudget, searchAllowance } from './search-budget.ts'
import { signalJudge, type SignalJudge } from './entail.ts'
import { checkEmailSource, checkLeads, isShown, type CheckedLead } from './check.ts'
import { dropUnseenProfile, enrichLeads, mergeEnriched, needsEnrichment } from './enrich.ts'

export interface DiscoveryBudget { maxUsd: number; maxSearches?: number; maxFetches?: number; enrichLeads?: number; wantShown?: number }
// pages: every URL the run's searches and page reads returned (the scan lane looks for LinkedIn posts among them).
export interface DiscoveryRun { pages: string[]; leads: CheckedLead[]; usd: number; searches: number; requests: number; passes: number; enriched: number; emailDropped: number; stop: string; model: string; note: string | null; accountingUncertain?: boolean }
export interface DiscoveryDeps {
  apiKey: string
  fetch?: typeof fetch
  /** Provider transport only; public proof reads still use fetch. */
  providerFetch?: typeof fetch
  signal?: AbortSignal
  discover?: typeof discoverLeads
  enrich?: typeof enrichLeads | null
  judge?: SignalJudge | null
  now?: Date
}

const r4 = (n: number) => Math.round(n * 10000) / 10000
// What the people pass has cost at most on the benchmark; a second search pass must leave room for it under the run's ceiling.
const PEOPLE_PASS_USD = 0.15
// What one lead costs in the people pass at most in the ordinary case (lib/discover/enrich.ts): 4 web searches at US$0.01 each, plus the
// small model's tokens. Not a strict ceiling: a call the server pauses and resumes can search again (up to 12 searches, US$0.12).
// That rare case is covered by the gap between what a run may spend (80% of its reservation) and the reservation itself.
const PEOPLE_LEAD_USD = 0.045

export async function runDiscovery(input: DiscoverInput, budget: DiscoveryBudget, deps: DiscoveryDeps): Promise<DiscoveryRun> {
  const discover = deps.discover ?? discoverLeads, enrich = deps.enrich === undefined ? enrichLeads : deps.enrich
  // The profile limits each pass, while one durable ceiling applies across all passes and enrichment.
  const perPass = searchAllowance(budget.maxSearches ?? input.maxSearches)
  const ceiling = perPass === 0 ? 0 : configuredSearchAllowance(process.env.DAZL_DISCOVER_SEARCHES)
  const api = { apiKey: deps.apiKey, fetch: deps.providerFetch ?? deps.fetch, signal: deps.signal, searchBudget: createSearchBudget(ceiling) }
  const sized = { ...input, ...(budget.maxSearches !== undefined ? { maxSearches: budget.maxSearches } : {}), ...(budget.maxFetches ? { maxFetches: budget.maxFetches } : {}) }
  const want = budget.wantShown ?? 5
  const usage: Pick<DiscoverUsage, 'usd' | 'searches' | 'requests'> = { usd: 0, searches: 0, requests: 0 }
  const add = (u: Pick<DiscoverUsage, 'usd' | 'searches' | 'requests'>) => { usage.usd = r4(usage.usd + u.usd); usage.searches += u.searches; usage.requests += u.requests }

  const first = await discover(sized, api)
  add(first.usage)
  // one judge for the run: asked only where the quote is on the page and the words alone could not settle it (lib/discover/check.ts)
  const judge: SignalJudge | null = deps.judge === undefined ? signalJudge(api) : deps.judge
  let emailDropped = 0
  const check = async ({ leads: candidates, seen }: DiscoverResult) => {
    const checked = await checkLeads(candidates.map(l => dropUnseenProfile(l, seen)), seen, deps.fetch, 4, judge?.ask)
    emailDropped += checked.filter((lead, index) => candidates[index].email && !lead.email).length
    return checked
  }
  let leads = await check(first)
  const seen = [...first.seen]
  const pages = first.seen.map(p => p.url)
  const model = first.model
  let stop = first.stop
  let passes = 1, note = first.note, accountingUncertain = judge?.usage.accountingUncertain === true
  // A second pass for different companies, when the first came up short and a pass of the same size still fits the budget.
  if (!accountingUncertain && leads.filter(isShown).length < want && first.stop !== 'refusal' && first.stop !== 'search_cap' && usage.usd + first.usage.usd + PEOPLE_PASS_USD <= budget.maxUsd) {
    try {
      const second = await discover({ ...sized, exclude: [...(input.exclude ?? []), ...first.leads.map(l => l.company)] }, api)
      add(second.usage)
      pages.push(...second.seen.map(p => p.url))
      const known = new Set(leads.map(l => l.company.toLowerCase()))
      const more = await check({ ...second, leads: second.leads.filter(l => !known.has(l.company.toLowerCase())) })
      seen.push(...second.seen)
      leads = [...leads, ...more]
      passes = 2
      accountingUncertain ||= judge?.usage.accountingUncertain === true
      if (second.stop === 'search_cap') stop = 'search_cap'
      note = second.note ?? note
    } catch { accountingUncertain = true }
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
  if (!accountingUncertain && enrich && todo.length && maxLeads > 0) {
    try {
      const e = await enrich(todo, { offer: input.offer ?? null, maxLeads }, api)
      add(e.usage)
      enriched = e.enriched
      accountingUncertain = e.accountingUncertain === true
      const byCompany = new Map(e.leads.map(l => [l.company, l]))
      const sourcePages = [...e.seen, ...seen]
      // Only a new address needs rechecking. The merge keeps an already-proven address and its citation.
      const merged = await Promise.all(leads.map(async lead => {
        const candidate = byCompany.get(lead.company)
        if (!candidate || lead.proof === 'gone') return { lead, dropped: false }
        const updated = { ...lead, ...mergeEnriched(lead, candidate) }
        if (lead.email) return { lead: updated, dropped: false }
        const checked = await checkEmailSource(updated, sourcePages)
        return { lead: checked, dropped: !!updated.email && !checked.email }
      }))
      emailDropped += merged.filter(item => item.dropped).length
      leads = merged.map(item => item.lead)

    } catch { accountingUncertain = true }
  }
  if (judge) {
    add({ usd: judge.usage.usd, searches: 0, requests: judge.usage.requests })
    accountingUncertain ||= judge.usage.accountingUncertain === true
  }
  return { pages, leads, usd: usage.usd, searches: usage.searches, requests: usage.requests, passes, enriched, emailDropped, stop: accountingUncertain ? 'accounting_uncertain' : stop, model,
    note: accountingUncertain ? 'Some research could not be accounted for. Earlier evidence is kept; the full spending reservation remains held.' : note, accountingUncertain }
}
