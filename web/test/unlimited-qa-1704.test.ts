import assert from 'node:assert/strict'
import test from 'node:test'
import { playsPageItems, type PlaysAnswer, type WatchRow } from '../lib/saved-plays.ts'
import { estimateForBody } from '../lib/scan/estimate-request.ts'
import { customerView } from '../lib/scan/price-estimate.ts'
import { bothEngines } from './helpers/engines.ts'

const watch: WatchRow = {
  id: 'daily', query: 'Find new buyers', icp: null, active: false, next_run_at: null, last_run_at: null,
  paused_reason: 'trial_used', last_job_id: null, last_status: null, new_leads: 0, auto: true,
}
const answer: PlaysAnswer = {
  plays: [{ key: 'watch-daily', kind: 'watch', id: watch.id, query: watch.query, runs: [], last_job_id: null, last_run_at: null, last_status: null }],
  watches: [watch], monitors: [],
}

test('#1704 Plays does not report an exhausted allowance to unlimited QA accounts', () => {
  const exemptAnswer = { ...answer, trial_exempt: true }
  assert.deepEqual(playsPageItems(exemptAnswer)[0]?.saved?.status, { tone: 'paused', label: 'Paused' })
  assert.match(playsPageItems(answer)[0]?.saved?.status.label ?? '', /free searches are used up/)
})

bothEngines('#1704 the estimate panel keeps the spend guard without displaying a trial cap to unlimited QA accounts', async ({ db }) => {
  const qa = 'a'.repeat(32), regular = 'b'.repeat(32)
  await db.run("INSERT INTO users (id, email, name, business_name, password_hash, salt) VALUES (?, ?, 'Fixture', 'Fixture', 'x', 'y'), (?, ?, 'Fixture', 'Fixture', 'x', 'y')",
    [qa, 'qa-fixture@example.test', regular, 'regular-fixture@example.test'])
  const env = {
    DAZL_TRIAL_QA_EXEMPT: 'qa-fixture@example.test',
    DAZL_TRIAL_SCAN_RESERVE_USD: '0.75',
    DAZL_TRIAL_ACCOUNT_TOTAL_USD: '1',
    DAZL_TRIAL_GLOBAL_DAILY_USD: '10',
    DAZL_TRIAL_ANTHROPIC_KEY: 'sk-ant-fixture',
    TINYFISH_API_KEY: 'tf-fixture',
    DAZL_TRIAL_TINYFISH_SEARCH_USD: '0',
    DAZL_TRIAL_TINYFISH_FETCH_USD: '0',
  }
  const old = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]))
  Object.assign(process.env, env)
  try {
    async function estimate(tenantId: string, trialRefusal: string | null = null) {
      const result = await estimateForBody({ query: 'Find new buyers' }, { db, tenantId, hasOwnKey: false, trialRefusal, enrichmentVendors: [] })
      assert.ok(result.ok, JSON.stringify(result))
      return result.estimate
    }
    const regularEstimate = await estimate(regular)
    assert.equal(customerView(regularEstimate).trial_cap_line, 'Free trial scans stop at $0.75.')
    const qaEstimate = await estimate(qa)
    const view = customerView(qaEstimate)
    assert.equal(view.trial_cap_line, null)
    assert.equal(qaEstimate.cap.run_max_usd, 0.75)
    assert.ok(view.total.max <= 0.75)
    assert.equal(qaEstimate.payer, 'trial')
    assert.doesNotMatch([qaEstimate.verdict.message, qaEstimate.verdict.warning, ...qaEstimate.verdict.change, ...view.assumptions].join(' '),
      /free trial stops|trial's .* limit per scan|3 scans per account|used up/i)
    const blocked = await estimate(qa, 'global_daily_cap')
    assert.equal(blocked.verdict.ok, false)
    assert.match(blocked.verdict.message, /free searches are fully booked/)
    assert.doesNotMatch(blocked.verdict.message, /used.*free search attempts|used up/i)
  } finally {
    for (const [key, value] of Object.entries(old)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
})
