import test from 'node:test'
import assert from 'node:assert/strict'
import { migrateAllSqlite } from '../lib/db/sqlite-migrations.ts'
import { sqliteDb } from '../lib/db/client.ts'
import { readScanStatus } from '../lib/scan/status-read-service.ts'
import { reserveScanSpend } from '../lib/scan/spend-cap.ts'
import { BUYER_BUDGET_WHY, ICP_BUDGET_WHY, readScoreBudgetHolds, scoreBudgetCopy } from '../lib/scan/scoring-budget.ts'
import { emptyLeadsMessage, scoreLabel } from '../lib/scan/leads-view.ts'
import { daysAgo, runFixture } from './helpers/acceptance-harness.ts'

const co = 'Brightloop'
const evidence = 'https://brightloop.com/news/job', home = 'https://brightloop.com/'
const quote = 'Brightloop is hiring a product manager for its B2B software team in Austin to replace its broken sales workflow'
const page = { title: 'Brightloop sales hiring', text: `On ${daysAgo(2)}, ${quote}. ${'We offer software for small companies to manage their customer relationships and track growth in Texas. '.repeat(10)}` }
const request = 'Find B2B software companies in Austin hiring product managers'
const profile = { summary: 'B2B software companies', who: ['Founder'], industries: ['software'], sizes: [], where: ['Austin, TX'], signals: ['hiring product managers'], exclude: [], country: 'US', language: 'en', window_days: 60 }

for (const refusedStage of ['icp_grading', 'buyer_fit'] as const) test(`#1158 exact capped refusal at ${refusedStage} is explicit, and reviewed partial evidence remains`, async t => {
  const crawlFlag = process.env.SITECRAWL_ENABLED
  process.env.SITECRAWL_ENABLED = '1' // all HTTP is injected; npm test normally disables this phase
  t.after(() => { if (crawlFlag === undefined) delete process.env.SITECRAWL_ENABLED; else process.env.SITECRAWL_ENABLED = crawlFlag })
  const tried: string[] = [], sent: string[] = []
  const extract = [{ company: co, signal: 'hiring product manager', source_url: evidence, excerpt: quote, event_date: daysAgo(2) }]
  const answer = async (_key: string, prompt: string, _fetch?: typeof fetch, max?: number) => {
    const stage = prompt.startsWith('You are grading sales leads') ? 'icp_grading'
      : prompt.startsWith('You check whether companies fit') ? 'buyer_fit' : 'upstream'
    tried.push(stage)
    if (stage === refusedStage) {
      // This is the real durable scan cap, not a synthetic error string.
      // Refusal occurs before the synthetic provider send below.
      const h = await reserveScanSpend('llm.anthropic', () => 10)
      if (h) throw new Error('fixture should not reserve the refused step')
    }
    sent.push(stage)
    const text = stage === 'icp_grading'
      ? 'LEAD 1 | fit 5 | intent 4 | action 4 | match yyyy | signals none | why the evidence identifies a software company'
      : max === 300 ? JSON.stringify(['Brightloop software hiring']) : JSON.stringify(extract)
    return { text, model: 'claude-sonnet-4-5', usage: { input_tokens: 100, output_tokens: 60 } }
  }
  const provider = { research: async () => ({ text: '[]', citedUrls: [] }),
    complete: async (...args: Parameters<typeof answer>) => (await answer(...args)).text, completeDetailed: answer, configuredModel: () => 'claude-sonnet-4-5' }
  const crawlGet = async (url: string) => {
    const path = new URL(url).pathname
    const body = path === '/robots.txt' ? 'User-agent: *\nAllow: /' : path === '/' ? '<h1>Brightloop</h1><p>123 Main St, Austin, TX 78701</p>' : '<a href="https://brightloop.com/">Brightloop</a>'
    return { status: 200, body, finalUrl: url }
  }
  const r = await runFixture({ request, modelIcp: profile, reviewedIcp: profile, icpReviewed: true, tinyfishOff: true,
    modelQueries: ['Brightloop software hiring'], hits: [{ url: evidence, title: page.title, snippet: quote, date: daysAgo(2) }],
    tfPages: { [evidence]: page }, own: { [evidence]: page, [home]: page }, extraction: extract,
    // The pre-save case exercises the declared run limit. The post-save case
    // exercises the independent service cap, which applies to every job.
    runBudget: JSON.stringify({ first5: true, ...(refusedStage === 'icp_grading' ? { max_usd: 0.093 } : {}), paid_fallback: false, credit_enrichment: false }),
    beforeRun: db => { migrateAllSqlite(db) },
    deps: {
      score: true, providers: { anthropic: provider, openai: provider }, crawlGet,
      fetchImpl: async (u: unknown) => { assert.match(String(u), /count_tokens/); return Response.json({ input_tokens: 100 }) },
      newsHttp: async () => ({ status: 200, body: JSON.stringify({ articles: [{ url: evidence, title: page.title, seendate: daysAgo(2).replaceAll('-', '') + 'T100000Z' }] }) }),
    } })
  assert.equal(r.r, 'done', JSON.stringify({ job: r.job, tried }))
  assert.equal(r.job.error, null)
  assert.equal(r.leads.filter(l => !l.review_reason).length, 1, JSON.stringify(r.leads))
  assert.ok(tried.includes(refusedStage), JSON.stringify({ tried, rows: r.db.prepare('SELECT fit, why, company_domain, signal FROM leads').all() }))
  assert.ok(!sent.includes(refusedStage))
  const ledger = r.db.prepare("SELECT status, reason FROM scan_spend_calls WHERE status = 'refused'").all()
  assert.deepEqual(ledger, [{ status: 'refused', reason: 'over_cap' }])
  const id = (r.db.prepare('SELECT id FROM scan_jobs').get() as { id: string }).id
  const status = await readScanStatus(sqliteDb(r.db), 'A', id)
  assert.deepEqual(status?.scoring_budget_holds, [{ stage: refusedStage, reason: 'over_cap', requested_max_usd: refusedStage === 'icp_grading' ? 0.093 : null }])
  assert.equal(await readScanStatus(sqliteDb(r.db), 'B', id), undefined)
  const lead = r.db.prepare('SELECT fit, intent, why FROM leads WHERE company = ?').get(co) as { fit: number; intent: number | null; why: string }
  assert.equal(lead.fit, refusedStage === 'icp_grading' ? 0 : 3)
  assert.match(lead.why, /spending limit prevented/)
  assert.match(scoreLabel(88, lead.fit, lead.intent, undefined, lead.why), /not (graded|checked)/)
  const words = scoreBudgetCopy(status!.scoring_budget_holds)
  if (refusedStage === 'icp_grading') assert.match(words ?? '', /\$0\.093/)
  else assert.match(words ?? '', /applicable per-scan spending cap/)
  assert.match(words ?? '', refusedStage === 'icp_grading' ? /ICP fit grading/ : /company-site buyer-fit check/)
  assert.doesNotMatch(emptyLeadsMessage('done', 0, 1, 0, 0, true)!, /nothing above|lower-fit/)
})

test('#1158 public copy and report are fail-closed for stale attempts, unrelated errors and actual low fit', () => {
  const over = { stage: 'icp_grading' as const, reason: 'over_limit' as const, requested_max_usd: 0.093 }
  assert.match(scoreBudgetCopy([over])!, /higher run limit may/)
  assert.doesNotMatch(scoreBudgetCopy([{ ...over, reason: 'over_cap' }])!, /higher run limit/)
  assert.doesNotMatch(scoreBudgetCopy([{ ...over, reason: 'owner_pool_limit' }])!, /higher run limit/)
  assert.deepEqual(readScoreBudgetHolds({ attempt: 1, scoring_budget_holds: [over] }, 2), [])
  assert.deepEqual(readScoreBudgetHolds({ attempt: 1, scoring_budget_holds: [{ ...over, reason: 'ledger_unavailable' }] }, 1), [])
  assert.match(emptyLeadsMessage('done', 0, 1)!, /lower-fit/)
  assert.equal(scoreLabel(80, 0, null, undefined, ICP_BUDGET_WHY), 'not graded (spending limit)')
  assert.equal(scoreLabel(80, 3, 1, undefined, BUYER_BUDGET_WHY), 'buyer fit not checked (spending limit)')
  assert.equal(scoreLabel(80, 0, null, undefined, 'model error'), 'scoring failed')
})
