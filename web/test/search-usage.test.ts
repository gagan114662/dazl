// Search-stats fixture test (isolated in-memory DB, stub provider, stub fetch). Not live proof, not product yield.
// Observed on a live Ohio scan: one candidate came back from the whole search. The Ohio profile names a US state in
// icp.where, but TinyFish's location option takes a country code only, so the state can only reach the search through
// the query text, and the model writes those queries freely. This pins that every issued query carries the profile's
// geography. The verifier is not touched.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import Database from 'better-sqlite3'
import { migrateKeys, saveKey } from '../lib/llm/key-store.ts'
import { migrateScan, createQueryJob } from '../lib/scan/store.ts'
import { migratePlans } from '../lib/plans.ts'
import { migrateConnectors } from '../lib/connectors/store.ts'
import { migrateEvents } from '../lib/events/store.ts'
import type { Provider } from '../lib/llm/provider.ts'
import { claimKeyedJob, runJob } from '../lib/scan/runner.ts'

const master = randomBytes(32)
process.env.DAZL_MASTER_KEY = master.toString('base64')
const KEY = 'sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
const recent = new Date(Date.now() - 20 * 86_400_000).toISOString().slice(0, 10)
const QUOTE = 'Harbor Freight Supply of Columbus Ohio is hiring a payroll specialist to manage biweekly payroll'
const REQUEST = 'Find Ohio companies with 10 to 100 employees that recently posted a payroll, HR or office manager job'
const ICP = { summary: 'Ohio SMBs hiring payroll', who: ['Controller'], industries: [], sizes: ['10-100 employees'], where: ['Ohio'], signals: ['payroll job'], exclude: [] }

function run(modelQueries: string[] | string, searchStatus = 200, _unused: unknown[] = [], detailed?: (maxTokens: number | undefined) => { text: string; model: string | null; usage?: Record<string, number> }) {
  const db = new Database(':memory:')
  migrateScan(db); migrateKeys(db); migratePlans(db); migrateConnectors(db); migrateEvents(db)
  saveKey(db, 'A', 'anthropic', KEY, master)
  createQueryJob(db, 'A', { query: REQUEST, icp: JSON.stringify(ICP) })
  const job = claimKeyedJob(db)!
  const searched: string[] = []
  const fetchImpl = (async (u: string) => {
    if (u.startsWith('https://api.search.tinyfish.ai')) {
      searched.push(new URL(u).searchParams.get('query') ?? '')
      return new Response(JSON.stringify({ results: [{ url: 'https://jobs.example/hf', title: 'Payroll specialist', snippet: QUOTE, date: recent }] }), { status: searchStatus })
    }
    if (u.startsWith('https://api.fetch.tinyfish.ai')) return new Response(JSON.stringify({ results: [{ url: 'https://jobs.example/hf', title: 'Payroll specialist', text: `Posted ${recent}. ${QUOTE}. Apply now.` }] }), { status: 200 })
    return new Response('{}', { status: 200 })
  }) as typeof fetch
  const lead = { name: '', company: 'Harbor Freight Supply', contact: null, signal: 'Hiring a payroll specialist', source_url: 'https://jobs.example/hf', score: 80, excerpt: QUOTE, event_date: recent }
  const providers: Record<'anthropic' | 'openai', Provider> = {
    anthropic: {
      research: async () => ({ text: '', citedUrls: [] }),
      complete: async (_k: string, _p: string, _f?: typeof fetch, maxTokens?: number) => maxTokens === 300 ? (typeof modelQueries === 'string' ? modelQueries : JSON.stringify(modelQueries)) : JSON.stringify([lead]),
      ...(detailed ? { configuredModel: () => 'configured-model-x', completeDetailed: async (_k: string, _p: string, _f?: typeof fetch, maxTokens?: number) => detailed(maxTokens) } : {}),
    },
    openai: { research: async () => ({ text: '', citedUrls: [] }) },
  }
  const page = async () => ({ text: `Posted ${recent}. ${QUOTE}. Apply now.`, title: 'Payroll specialist', retrievedAt: 1_700_000_000 })
  const realFetch = globalThis.fetch
  globalThis.fetch = fetchImpl // the TinyFish helpers take the global fetch; restored below
  return runJob(db, job, { providers, master, fetchPage: page, fetchImpl, score: false, judge: null }).then(r => ({ r, searched, db })).finally(() => { globalThis.fetch = realFetch })
}

const withEnv = async <T>(f: () => Promise<T>) => {
  process.env.TINYFISH_API_KEY = 'test-tinyfish-key'; process.env.DAZL_SOURCE_STATS = '1'
  try { return await f() } finally { delete process.env.TINYFISH_API_KEY; delete process.env.DAZL_SOURCE_STATS }
}
const MODEL_Q = ['small company hiring payroll specialist', 'complaints about payroll software small business']
const lead = { name: '', company: 'Harbor Freight Supply', contact: null, signal: 'Hiring a payroll specialist', source_url: 'https://jobs.example/hf', score: 80, excerpt: QUOTE, event_date: recent }

test('model usage: the query call and the extraction call are counted, tokens summed, requested and served model recorded', async () => {
  const seen: (number | undefined)[] = []
  const { r, db } = await withEnv(() => run(MODEL_Q, 200, [], mt => { seen.push(mt); return mt === 300 ? { text: JSON.stringify(MODEL_Q), model: 'served-model-y', usage: { input_tokens: 400, output_tokens: 50 } } : { text: JSON.stringify([lead]), model: 'served-model-y', usage: { input_tokens: 9000, output_tokens: 700 } } }))
  assert.equal(r, 'done'); assert.deepEqual(seen, [300, 3000])
  const row = db.prepare('SELECT model_requested, model_served, model_calls, input_tokens, output_tokens FROM scan_source_stats').get() as Record<string, unknown>
  assert.deepEqual(row, { model_requested: 'configured-model-x', model_served: 'served-model-y', model_calls: 2, input_tokens: 9400, output_tokens: 750 })
})

test('model usage: a call that reports no usage makes the token totals unknown (null), never a partial sum or zero', async () => {
  const { db } = await withEnv(() => run(MODEL_Q, 200, [], mt => mt === 300 ? { text: JSON.stringify(MODEL_Q), model: null } : { text: JSON.stringify([lead]), model: 'served-model-y', usage: { input_tokens: 9000, output_tokens: 700 } }))
  const row = db.prepare('SELECT model_served, model_calls, input_tokens, output_tokens FROM scan_source_stats').get() as Record<string, unknown>
  assert.equal(row.model_calls, 2); assert.equal(row.input_tokens, null); assert.equal(row.output_tokens, null)
  assert.equal(row.model_served, 'served-model-y', 'a null served model on one call does not erase the one that was reported')
})

test('model usage: a provider without detailed completions (plain complete) records no model fields and the scan result is unchanged', async () => {
  const withDetail = await withEnv(() => run(MODEL_Q, 200, [], mt => mt === 300 ? { text: JSON.stringify(MODEL_Q), model: 'm', usage: { input_tokens: 1, output_tokens: 1 } } : { text: JSON.stringify([lead]), model: 'm', usage: { input_tokens: 1, output_tokens: 1 } }))
  const plain = await withEnv(() => run(MODEL_Q))
  const row = plain.db.prepare('SELECT model_requested, model_served, model_calls, input_tokens, output_tokens FROM scan_source_stats').get() as Record<string, unknown>
  assert.deepEqual(row, { model_requested: null, model_served: null, model_calls: null, input_tokens: null, output_tokens: null })
  const snap = (db: Database.Database) => JSON.stringify({ leads: db.prepare('SELECT company, source_url FROM leads ORDER BY rowid').all(), job: db.prepare('SELECT status, candidates, verified, needs_review, dropped FROM scan_jobs').get() })
  assert.equal(snap(withDetail.db), snap(plain.db), 'using the detailed call changes nothing about the scan result')
})
