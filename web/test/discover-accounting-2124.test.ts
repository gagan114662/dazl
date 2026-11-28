// #2124 (launch blocker): a scan failed one second in with accounting_uncertain while a $0.75 web_search reservation was held and NO model
// call or search had run. The precise boundary: a SpendRefused is thrown BEFORE a request is sent (it cost $0), yet the broad
// `catch { accountingUncertain = true }` blocks in runDiscovery (and the judge) marked the attempt uncertain, so the runner held the whole
// reservation (settle(null)) and finish()/failOrRetry reported accounting_uncertain. A refusal that dispatched nothing must never be
// accounting_uncertain.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runDiscovery, type DiscoveryDeps } from '../lib/discover/run.ts'
import { SpendRefused } from '../lib/llm/spend-guard.ts'
import { ProviderError } from '../lib/llm/provider.ts'

const input = { query: 'dental practices in Ohio' }
const budget = { maxUsd: 5, wantShown: 5 }
const empty = { leads: [], seen: [], usage: { usd: 0, searches: 0, requests: 0 }, stop: 'done', model: 'stub', note: null }
const deps = (discover: unknown): DiscoveryDeps => ({ apiKey: 'sk-test', discover: discover as never, enrich: null, judge: null })

test('#2124 a SpendRefused on the second pass is a clean refusal, never accounting_uncertain (nothing was sent)', async () => {
  let n = 0
  const discover = async () => { n++; if (n === 1) return empty; throw new SpendRefused('over_cap') }
  const run = await runDiscovery(input, budget, deps(discover))
  assert.equal(n, 2, 'the second pass ran and was refused')
  assert.notEqual(run.accountingUncertain, true, 'a refused (never-sent) step is not uncertain')
  assert.notEqual(run.stop, 'accounting_uncertain', 'and the run does not claim accounting_uncertain')
})

test('#2124 control: a genuinely maybe-billed failure on the second pass IS accounting_uncertain', async () => {
  let n = 0
  const discover = async () => { n++; if (n === 1) return empty; throw new ProviderError('retry', 'server_error', 'uncertain') }
  const run = await runDiscovery(input, budget, deps(discover))
  assert.equal(run.accountingUncertain, true, 'a request that may have been billed stays uncertain')
})

test('#2124 simultaneous-scan negative control: one scan refusing does not mark the other uncertain', async () => {
  let a = 0
  const refused = async () => { a++; if (a === 1) return empty; throw new SpendRefused('over_cap') }
  const ok = async () => ({ ...empty, stop: 'search_cap' }) // a clean first pass, no second pass
  const [r1, r2] = await Promise.all([
    runDiscovery(input, budget, deps(refused)),
    runDiscovery(input, budget, deps(ok)),
  ])
  assert.notEqual(r1.accountingUncertain, true, 'the refusing scan is not uncertain')
  assert.notEqual(r2.accountingUncertain, true, 'the other scan is untouched')
  assert.equal(r2.stop, 'search_cap', 'the other scan keeps its own stop')
})
