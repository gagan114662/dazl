// Search-side fixture test (isolated in-memory DB, stub provider, stub fetch). Not live proof, not product yield.
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
import { withGeography } from '../lib/search/tinyfish.ts'

const master = randomBytes(32)
process.env.DAZL_MASTER_KEY = master.toString('base64')
const KEY = 'sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
const recent = new Date(Date.now() - 20 * 86_400_000).toISOString().slice(0, 10)
const QUOTE = 'Harbor Freight Supply of Columbus Ohio is hiring a payroll specialist to manage biweekly payroll'
const REQUEST = 'Find Ohio companies with 10 to 100 employees that recently posted a payroll, HR or office manager job'
const ICP = { summary: 'Ohio SMBs hiring payroll', who: ['Controller'], industries: [], sizes: ['10-100 employees'], where: ['Ohio'], signals: ['payroll job'], exclude: [] }

function run(modelQueries: string[]) {
  const db = new Database(':memory:')
  migrateScan(db); migrateKeys(db); migratePlans(db); migrateConnectors(db); migrateEvents(db)
  saveKey(db, 'A', 'anthropic', KEY, master)
  createQueryJob(db, 'A', { query: REQUEST, icp: JSON.stringify(ICP) })
  const job = claimKeyedJob(db)!
  const searched: string[] = []
  const fetchImpl = (async (u: string) => {
    if (u.startsWith('https://api.search.tinyfish.ai')) {
      searched.push(new URL(u).searchParams.get('query') ?? '')
      return new Response(JSON.stringify({ results: [{ url: 'https://jobs.example/hf', title: 'Payroll specialist', snippet: QUOTE, date: recent }] }), { status: 200 })
    }
    if (u.startsWith('https://api.fetch.tinyfish.ai')) return new Response(JSON.stringify({ results: [{ url: 'https://jobs.example/hf', title: 'Payroll specialist', text: `Posted ${recent}. ${QUOTE}. Apply now.` }] }), { status: 200 })
    return new Response('{}', { status: 200 })
  }) as typeof fetch
  const lead = { name: '', company: 'Harbor Freight Supply', contact: null, signal: 'Hiring a payroll specialist', source_url: 'https://jobs.example/hf', score: 80, excerpt: QUOTE, event_date: recent }
  const providers: Record<'anthropic' | 'openai', Provider> = {
    anthropic: {
      research: async () => ({ text: '', citedUrls: [] }),
      complete: async (_k: string, _p: string, _f?: typeof fetch, maxTokens?: number) => maxTokens === 300 ? JSON.stringify(modelQueries) : JSON.stringify([lead]),
    },
    openai: { research: async () => ({ text: '', citedUrls: [] }) },
  }
  const page = async () => ({ text: `Posted ${recent}. ${QUOTE}. Apply now.`, title: 'Payroll specialist', retrievedAt: 1_700_000_000 })
  const realFetch = globalThis.fetch
  globalThis.fetch = fetchImpl // the TinyFish helpers take the global fetch; restored below
  return runJob(db, job, { providers, master, fetchPage: page, fetchImpl, score: false, judge: null }).then(r => ({ r, searched })).finally(() => { globalThis.fetch = realFetch })
}

test('withGeography: adds missing place terms, leaves queries that already name them, never empty', () => {
  assert.deepEqual(withGeography(['payroll manager job posting small company'], ['Ohio']), ['payroll manager job posting small company Ohio'])
  assert.deepEqual(withGeography(['payroll manager job Ohio small company', 'office manager hiring OHIO'], ['Ohio']), ['payroll manager job Ohio small company', 'office manager hiring OHIO'])
  assert.deepEqual(withGeography(['payroll job posting'], []), ['payroll job posting'])
  assert.deepEqual(withGeography(['x'.repeat(149)], ['Ohio']).map(q => q.length <= 150), [true])
  assert.deepEqual(withGeography(['a payroll query here'], ['Ohio', 'Cleveland']), ['a payroll query here Ohio Cleveland'])
})

test('every TinyFish query of an Ohio-profile scan names Ohio even when the model wrote queries without it', async () => {
  process.env.TINYFISH_API_KEY = 'test-tinyfish-key'
  try {
    const { r, searched } = await run(['small company hiring payroll specialist', 'complaints about payroll software small business', 'office manager job posting payroll duties'])
    assert.equal(r, 'done')
    assert.ok(searched.length >= 1)
    for (const q of searched) assert.match(q, /ohio/i, `query lacks the profile geography: ${q}`)
  } finally { delete process.env.TINYFISH_API_KEY }
})
