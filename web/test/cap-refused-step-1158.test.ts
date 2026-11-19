import assert from 'node:assert/strict'
import { bothEngines } from './helpers/engines.ts'
import { createJob } from '../lib/scan/store-db.ts'
import { readScanStatus } from '../lib/scan/status-read-service.ts'
import { estimateRun } from '../lib/scan/price-estimate.ts'
import { emptyLeadsMessage } from '../lib/scan/leads-view.ts'

bothEngines('#1158 historical cost line reports recorded paid refusals without implying a fit hold or inventing a cause', async ({ db }) => {
  const id = await createJob(db, 'A', { business_name: 'Our Co', industry: 'software', location: 'Austin' }, '{"max_usd":0.093}')
  const estimate = JSON.stringify(estimateRun({ budget: { max_usd: 0.093 }, payer: 'you' }))
  await db.run("UPDATE scan_jobs SET status = 'running' WHERE id = ?", [id])
  await db.run("UPDATE scan_jobs SET status = 'done', attempts = 2, estimate = ?, spend_cap_refusals = 12, spend_cap_usd = 0.093 WHERE id = ?", [estimate, id])
  const read = async () => {
    const s = await readScanStatus(db, 'A', id)
    assert.ok(s)
    const cost = s.cost as { actual: { summary: string } }
    assert.ok(cost.actual)
    return { s, copy: cost.actual.summary }
  }
  const put = (key: string, owner: string, attempt: number, kind: string, reason: string) => db.run(
    "INSERT INTO scan_spend_calls (id, user_id, scan_job_id, attempt, kind, reserve_usd, status, reason, created_at) VALUES (?, ?, ?, ?, ?, 0, 'refused', ?, 1)",
    [key, owner, id, attempt, kind, reason])
  await put('other-owner', 'B', 2, 'render', 'over_limit')
  await put('old-attempt', 'A', 1, 'render', 'over_limit')
  await put('ownership', 'A', 2, 'llm.anthropic', 'ownership_lost')
  assert.doesNotMatch((await read()).copy, /paid-step refusals|spending limit|0\.093|raising/)
  // Legitimate historical/other-path reasons do not depend on a new typed grading report.
  await put('account', 'A', 2, 'apollo.people', 'owner_pool_limit')
  await put('per-scan-cap', 'A', 2, 'tinyfish.fetch', 'over_cap')
  await put('per-run', 'A', 2, 'tinyfish.search', 'over_limit')
  const { s, copy } = await read()
  assert.match(copy, /1 enrichment request[s]? refused by the shared account spending limit/)
  assert.match(copy, /1 page fetch(?:es)? refused by the applicable per-scan spending cap/)
  assert.match(copy, /1 web search(?:es)? refused by this run’s spending limit/)
  assert.doesNotMatch(copy, /raising|0\.093|ownership|render|12 paid/)
  assert.deepEqual(s.scoring_budget_holds, [])
  assert.equal(await readScanStatus(db, 'B', id), undefined)
  assert.match(emptyLeadsMessage('done', 0, 1, 0, 0, s.scoring_budget_holds.some(h => h.stage === 'icp_grading'))!, /1 lower-fit lead/)
})
