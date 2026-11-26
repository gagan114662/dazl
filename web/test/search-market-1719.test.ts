import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { mergeIntoRunReport } from '../lib/scan/enrichment-trace.ts'
import assert from 'node:assert/strict'
import test from 'node:test'
import Database from 'better-sqlite3'
import { sqliteDb } from '../lib/db/client.ts'
import { migrateAuth } from '../lib/db/sqlite-store.ts'
import { migrateKeys, saveKey } from '../lib/llm/key-store.ts'
import { migrateScan, createQueryJob, getJob } from '../lib/scan/store.ts'
import { claimKeyedJob, runJob } from '../lib/scan/runner.ts'
import { resetTinyfishState } from '../lib/search/tinyfish.ts'
import { captureAccountMarket, readAccountMarket, writeAccountMarket } from '../lib/settings/search-market-store.ts'
import { browserMarket, resolveSearchMarket, tinyfishMarket, MARKET_NOTICE } from '../lib/scan/search-market.ts'
import { userMessage } from '../lib/discover/agent.ts'
import { buildRunReport, readRunReport, writeRunReport } from '../lib/scan/run-report.ts'

test('place-free search shares a non-US account market with TinyFish and the discovery planner', () => {
  const query = 'Find manufacturers adding warehouse capacity'
  const market = resolveSearchMarket(query, null, browserMarket('fr-CH'))
  assert.deepEqual(tinyfishMarket(market), { location: 'CH', language: 'fr' })
  const prompt = userMessage({ query, market }, '2026-11-26', 5)
  assert.match(prompt, /country CH/)
  assert.match(prompt, /language fr/)
})

test('the explicit search place wins over both saved country tiers', () => {
  const market = resolveSearchMarket('Manufacturers expanding near Tokyo', { country: 'CA' }, browserMarket('fr-CH'))
  assert.deepEqual(tinyfishMarket(market), { location: 'JP' })
})

test('an empty market preserves TinyFish options and records an honest notice', () => {
  const market = resolveSearchMarket('Find manufacturers adding warehouse capacity', null, null)
  assert.deepEqual(tinyfishMarket(market), {})
  assert.equal(buildRunReport({ market_notice: MARKET_NOTICE }, [], [], 1).market_notice, MARKET_NOTICE)
})

test('a browser language without a region does not create a country or let TinyFish infer one', () => {
  const account = browserMarket('pt')
  assert.deepEqual(account, { country: null, language: 'pt' })
  const market = resolveSearchMarket('Find machinery exporters', null, account)
  assert.deepEqual(market, account)
  assert.deepEqual(tinyfishMarket(market), {})
})

test('real runner uses per-tenant market hints and preserves the no-market call count', async t => {
  const raw = new Database(':memory:')
  t.after(() => raw.close())
  migrateAuth(raw)
  migrateScan(raw)
  migrateKeys(raw)
  resetTinyfishState()
  const db = sqliteDb(raw)
  const master = Buffer.alloc(32, 1)
  const urls: URL[] = []
  const fetchImpl: typeof fetch = async input => {
    const url = new URL(String(input))
    assert.equal(url.hostname, 'api.search.tinyfish.ai')
    urls.push(url)
    return Response.json({ results: [] })
  }
  t.mock.method(globalThis, 'fetch', fetchImpl)
  const env = { TINYFISH_API_KEY: 'fixture', TINYFISH_ENABLED: '1', NEWS_SEARCH_ENABLED: '0', DAZL_RUN_REPORT: '1' }
  const before = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]))
  Object.assign(process.env, env)
  t.after(() => {
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    resetTinyfishState()
  })
  const complete = async () => JSON.stringify(['manufacturers adding warehouse capacity'])
  const research = async () => ({ text: '[]', citedUrls: [] })
  const provider = { complete, research }
  async function scan(tenant: string, query: string, locale?: string) {
    raw.prepare("INSERT INTO organizations (id, kind, created_by, created_at) VALUES (?, 'team', ?, 0)").run(tenant, tenant)
    if (locale) await captureAccountMarket(db, tenant, locale)
    saveKey(raw, tenant, 'anthropic', 'sk-ant-api03-fixture', master)
    const id = createQueryJob(raw, tenant, { query, icp: JSON.stringify({ summary: 'Manufacturers adding warehouses' }) })
    urls.length = 0
    const outcome = await runJob(raw, claimKeyedJob(raw, id)!, { discover: false, master, providers: { anthropic: provider, openai: provider }, score: false, judge: null })
    assert.equal(outcome, 'failed')
    assert.equal(getJob(raw, tenant, id)?.error, 'no_candidates')
    const report = (await readRunReport(db, tenant, id))?.at(-1)
    assert.equal(urls.length, 1)
    return { params: urls[0].searchParams, report }
  }

  const query = 'Find manufacturers adding warehouse capacity'
  const missing = await scan('missing', query)
  assert.equal(missing.params.get('location'), null)
  assert.equal(missing.params.get('language'), null)
  assert.equal((missing.report as { market_notice?: string }).market_notice, MARKET_NOTICE)

  const account = await scan('account', query, 'fr-CH')
  assert.equal(account.params.get('location'), 'CH')
  assert.equal(account.params.get('language'), 'fr')
  assert.equal((account.report as { market_notice?: string }).market_notice, undefined)

  const explicit = await scan('explicit', 'Manufacturers expanding near Tokyo', 'fr-CH')
  assert.equal(explicit.params.get('location'), 'JP')
  assert.equal(explicit.params.get('language'), null)

  const languageOnly = await scan('language', query, 'pt')
  assert.equal(languageOnly.params.get('location'), null)
  assert.equal(languageOnly.params.get('language'), null)
  assert.deepEqual(await readAccountMarket(db, 'language'), { country: null, language: 'pt' })

  await writeAccountMarket(db, 'account', { country: 'BE', language: 'nl' })
  await captureAccountMarket(db, 'account', 'en-US')
  assert.deepEqual(await readAccountMarket(db, 'account'), { country: 'BE', language: 'nl' })
  assert.deepEqual(await readAccountMarket(db, 'explicit'), { country: 'CH', language: 'fr' })
})

test('the result notice stays available when optional diagnostics are disabled', async t => {
  const raw = new Database(':memory:')
  t.after(() => raw.close())
  migrateScan(raw)
  const job = createQueryJob(raw, 'tenant', { query: 'Find exporters' })
  const env = { DAZL_RUN_REPORT: '0' }
  assert.equal(writeRunReport(raw, job, 1, buildRunReport({}, [], [], 1), env), false)
  const report = buildRunReport({ queries: ['exporters'], market_notice: MARKET_NOTICE }, [], [], 1)
  assert.equal(writeRunReport(raw, job, 2, report, env), true)
  assert.equal(mergeIntoRunReport(raw, job, 2, { enrichment: [], held_lead_ids: ['private-id'] }), false)
  assert.deepEqual(await readRunReport(sqliteDb(raw), 'tenant', job), [{ attempt: 2, market_notice: MARKET_NOTICE }])
})


test('#1719: two requested countries do not inherit an unrelated saved market', () => {
  const market = resolveSearchMarket('Find manufacturers in France, Germany', { country: 'CA', language: 'en' }, { country: 'CH', language: 'fr' })
  assert.deepEqual(tinyfishMarket(market), {})
})


test('#1719: overlapping or stopped polls cannot restore an obsolete market notice', async () => {
  const source = readFileSync(new URL('../app/app/leads/leads-client.tsx', import.meta.url), 'utf8')
  const noticeUpdate = source.indexOf("      setMarketNotice(typeof notice")
  const start = source.lastIndexOf('    let stop = false', noticeUpdate)
  assert.ok(start >= 0 && noticeUpdate > start)
  const end = source.indexOf('\n', noticeUpdate)
  const responses: Promise<Response>[] = []
  const notices: unknown[] = []
  const { tick, stopPolling } = runInNewContext(
    `${source.slice(start, end)}\n    }\n    ;({ tick, stopPolling: () => { stop = true } })`,
    {
      fetch: () => responses.shift()!,
      jobId: 'test-job', passiveJob: { current: false }, statusFails: { current: 0 },
      setMarketNotice: (notice: unknown) => notices.push(notice),
    },
  ) as { tick: () => Promise<void>; stopPolling: () => void }

  const deferred = () => {
    const body = Promise.withResolvers<unknown>()
    responses.push(Promise.resolve({ ok: true, json: () => body.promise } as Response))
    return body
  }
  const first = deferred()
  const firstPoll = tick()
  const second = deferred()
  const secondPoll = tick()
  second.resolve({ attempts: 2, run_report: [] })
  await secondPoll
  first.resolve({ attempts: 1, run_report: [{ attempt: 1, market_notice: MARKET_NOTICE }] })
  await firstPoll
  assert.deepEqual(notices, [null])

  const third = deferred()
  const thirdPoll = tick()
  await Promise.resolve()
  stopPolling()
  third.resolve({ attempts: 2, run_report: [{ attempt: 2, market_notice: MARKET_NOTICE }] })
  await thirdPoll
  assert.deepEqual(notices, [null])
})
