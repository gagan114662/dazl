// The whole discovery run, used by the scan lane (lib/scan/runner.ts) and by the benchmark (scripts/discover-bench.mts), so both
// measure and ship the same thing:
//   1. one Claude loop finds leads; dazl checks each proof page;
//   2. if fewer than `wantShown` leads are shown and the budget has room, a second loop looks for different companies;
//   3. a small-model pass fills the person, website and published email that shown leads still lack.
// Nothing is hidden: every lead comes back with its label. What a run may spend is stated by the caller.
import { discoverLeads, type DiscoverInput, type DiscoverUsage, type DiscoveredLead, type SeenPage } from './agent.ts'
import { atsPostingRef } from '../sources/ats-posting.ts'
import { companyKey } from '../scan/evidence.ts'
import { configuredSearchAllowance, createSearchBudget, searchAllowance } from './search-budget.ts'
import { meterSignalJudge, signalJudge, type SignalJudge } from './entail.ts'
import { checkLeads, isShown, postingRecord, type CheckedLead } from './check.ts'
import { dropUnseenProfile, enrichLeads, mergeEnriched, needsEnrichment } from './enrich.ts'

export interface DiscoveryBudget { maxUsd: number; maxSearches?: number; maxFetches?: number; enrichLeads?: number; wantShown?: number }
// pages: every URL the run's searches and page reads returned (the scan lane looks for LinkedIn posts among them).
export interface DiscoveryRun { pages: string[]; leads: CheckedLead[]; usd: number; searches: number; requests: number; passes: number; enriched: number; stop: string; model: string; note: string | null; accountingUncertain?: boolean }
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

function employerPostingUrl(raw: string, lead: DiscoveredLead, aggregator: URL): string | null {
  const url = URL.parse(raw)
  if (url?.protocol !== 'https:' || url.username || url.password || url.port) return null
  const host = url.hostname.replace(/^www\./, '')
  if (host === aggregator.hostname.replace(/^www\./, '')) return null
  const ats = atsPostingRef(url.href)
  const employer = companyKey(lead.company).replace(/[^a-z0-9]/g, '')
  const owned = ats
    ? employer.length >= 4 && ats.org.toLowerCase().replace(/[^a-z0-9]/g, '') === employer
    : host === lead.domain && /(?:^|\/)(?:careers|jobs|vacancies)(?:\/|$)/i.test(url.pathname)
  return owned ? url.href : null
}

function employerAlternate(lead: DiscoveredLead, seen: SeenPage[]): DiscoveredLead | null {
  const aggregator = URL.parse(lead.evidence_url)
  if (!aggregator || !/(^|\.)(?:indeed\.[a-z.]+|ziprecruiter\.com|talent\.com)$/i.test(aggregator.hostname)) return null
  const alternative = lead.alternate_evidence
  const urls = new Set(seen.map(page => employerPostingUrl(page.url, lead, aggregator)).filter(url => url !== null))
  const preferred = alternative && employerPostingUrl(alternative.url, lead, aggregator)
  const explicit = preferred && urls.has(preferred)
  const evidence_url = explicit ? preferred : urls.size === 1 ? [...urls][0] : null
  const evidence_quote = explicit ? alternative?.quote : lead.evidence_quote
  if (!evidence_url || !evidence_quote) return null
  return { ...lead, evidence_url, evidence_quote, signal_date: null, alternate_evidence: undefined }
}

async function checkRunLeads(result: { leads: DiscoveredLead[]; seen: SeenPage[] }, deps: DiscoveryDeps, judge: SignalJudge | null): Promise<CheckedLead[]> {
  const inputs = result.leads.map(lead => dropUnseenProfile(lead, result.seen))
  const checked = await checkLeads(inputs, result.seen, deps.fetch, 4, judge?.ask)
  const alternates = checked.flatMap((lead, index) => {
    if (lead.proof === 'gone' || (isShown(lead) && lead.proof_read_by && lead.evidence_url === inputs[index].evidence_url)) return []
    if (isShown(lead) && lead.date_source === 'page' && lead.date_on_page) return []
    const candidate = employerAlternate(inputs[index], result.seen)
    return candidate ? [{ index, candidate }] : []
  })
  if (!alternates.length || deps.signal?.aborted) return checked
  const records = alternates.map(({ candidate }) => postingRecord(new URL(candidate.evidence_url)))
  const recordUrls = new Set(records.flatMap(record => record ? [record.url] : []))
  const bodies = new Map<string, Promise<unknown>>()
  // A redirect cannot establish the date of the employer posting we intend to cite.
  const read: typeof fetch = async (url, init) => {
    const response = await (deps.fetch ?? fetch)(url, { ...init, redirect: 'error',
      signal: deps.signal && init?.signal ? AbortSignal.any([deps.signal, init.signal]) : deps.signal ?? init?.signal })
    if (response.ok && recordUrls.has(String(url))) bodies.set(String(url), response.clone().json().catch(() => null))
    return response
  }
  const rechecked = await checkLeads(alternates.map(item => item.candidate), result.seen, read, 4, judge?.ask)
  for (const [i, lead] of rechecked.entries()) {
    const original = checked[alternates[i].index]
    if (lead.proof_check && !isShown(original)) original.proof_check ??= lead.proof_check
    if (lead.proof !== 'confirmed' || !isShown(lead) || !lead.date || lead.date_source !== 'page') continue
    if (!lead.date_on_page) {
      // Only the exact posting record can supply an otherwise unbound machine-readable date.
      const record = records[i]
      const value = record && record.day(await bodies.get(record.url))
      const timestamp = typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : NaN
      const day = new Date(timestamp)
      if (!Number.isFinite(day.getTime()) || day.toISOString().slice(0, 10) !== lead.date) continue
    }
    checked[alternates[i].index] = { ...lead, date_on_page: true }
  }
  return checked
}

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
  const rawJudge = deps.judge === undefined ? signalJudge(api) : deps.judge
  const remaining = () => budget.maxUsd - usage.usd - (rawJudge?.usage.usd ?? 0)
  const judge = rawJudge && meterSignalJudge(rawJudge, remaining)
  let leads = await checkRunLeads(first, deps, judge)
  const pages = first.seen.map(p => p.url)
  const model = first.model
  let stop = first.stop
  let passes = 1, note = first.note, accountingUncertain = judge?.usage.accountingUncertain === true
  // A second pass for different companies, when the first came up short and a pass of the same size still fits the budget.
  if (!accountingUncertain && leads.filter(isShown).length < want && first.stop !== 'refusal' && first.stop !== 'search_cap' && first.usage.usd + PEOPLE_PASS_USD <= remaining()) {
    try {
      const second = await discover({ ...sized, exclude: [...(input.exclude ?? []), ...first.leads.map(l => l.company)] }, api)
      add(second.usage)
      pages.push(...second.seen.map(p => p.url))
      const known = new Set(leads.map(l => l.company.toLowerCase()))
      const more = (await checkRunLeads(second, deps, judge)).filter(l => !known.has(l.company.toLowerCase()))
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
  const maxLeads = Math.min(budget.enrichLeads ?? 12, Math.floor((remaining() + 1e-9) / PEOPLE_LEAD_USD))
  if (!accountingUncertain && enrich && todo.length && maxLeads > 0) {
    try {
      const e = await enrich(todo, { offer: input.offer ?? null, maxLeads }, api)
      add(e.usage)
      enriched = e.enriched
      accountingUncertain = e.accountingUncertain === true
      const byCompany = new Map(e.leads.map(l => [l.company, l]))
      leads = leads.map(l => { const m = byCompany.get(l.company); return m && l.proof !== 'gone' ? { ...l, ...mergeEnriched(l, m) } : l })
    } catch { accountingUncertain = true }
  }
  if (judge) {
    add({ usd: judge.usage.usd, searches: 0, requests: judge.usage.requests })
    accountingUncertain ||= judge.usage.accountingUncertain === true
  }
  return { pages, leads, usd: usage.usd, searches: usage.searches, requests: usage.requests, passes, enriched, stop: accountingUncertain ? 'accounting_uncertain' : stop, model,
    note: accountingUncertain ? 'Some research could not be accounted for. Earlier evidence is kept; the full spending reservation remains held.' : note, accountingUncertain }
}
