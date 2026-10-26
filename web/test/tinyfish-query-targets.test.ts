// Search-side fixture test for model-written query targets.
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
import { sanitizeQueries } from '../lib/search/tinyfish.ts'

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


// The exact three model-written queries observed in live Ohio job 7f69533e (fixtures only: not live proof, not yield).
const OBSERVED = [
  'Ohio company "payroll manager" OR "HR manager" OR "office manager" job posting 10-100 employees site:linkedin.com',
  'Ohio "frustrated with payroll" OR "payroll software problems" OR "payroll system issues" 2024',
  'site:indeed.com OR site:glassdoor.com Ohio "payroll manager" OR "HR manager" hiring 10-100 employees',
]
const NOW = new Date('2026-10-24T21:00:00Z')

test('observed model queries: login-walled site targets and a year before the 365-day window are removed; quotes, role alternatives and Ohio stay', () => {
  assert.deepEqual(sanitizeQueries(OBSERVED, REQUEST, NOW), [
    'Ohio company "payroll manager" OR "HR manager" OR "office manager" job posting 10-100 employees',
    'Ohio "frustrated with payroll" OR "payroll software problems" OR "payroll system issues"',
    'Ohio "payroll manager" OR "HR manager" hiring 10-100 employees',
  ])
})

test('legitimate targets and explicit user constraints are kept', () => {
  assert.deepEqual(sanitizeQueries(['payroll manager Ohio site:greenhouse.io', 'site:boards.greenhouse.io payroll Ohio', 'payroll Ohio 2025'], REQUEST, NOW), ['payroll manager Ohio site:greenhouse.io', 'site:boards.greenhouse.io payroll Ohio', 'payroll Ohio 2025'], 'other hosts and an in-window year are untouched')
  assert.deepEqual(sanitizeQueries(['payroll Ohio site:linkedin.com'], 'Find Ohio payroll managers on linkedin.com', NOW), ['payroll Ohio site:linkedin.com'], 'the user named the site')
  assert.deepEqual(sanitizeQueries(['payroll complaints Ohio 2024'], 'Find Ohio firms complaining about payroll in 2024', NOW), ['payroll complaints Ohio 2024'], 'the user named the year')
  assert.deepEqual(sanitizeQueries(['payroll Ohio 10-100 employees 1999 founded'], REQUEST, NOW), ['payroll Ohio 10-100 employees founded'], 'a stale year is dropped, numbers like 10-100 are not years')
})

test('a query that would be empty after cleaning is left as the model wrote it', () => {
  assert.deepEqual(sanitizeQueries(['site:linkedin.com'], REQUEST, NOW), ['site:linkedin.com'])
})

test('issued TinyFish queries of an Ohio scan carry no login-walled site: target and no stale year (observed strings)', async () => {
  process.env.TINYFISH_API_KEY = 'test-tinyfish-key'
  try {
    const { r, searched } = await run(OBSERVED)
    assert.equal(r, 'done')
    assert.equal(searched.length, 2 + OBSERVED.length, '2 direct ATS queries + every observed model query (default cap is 8)')
    for (const q of searched) { assert.doesNotMatch(q, /site:(?:[\w-]+\.)*(linkedin|indeed|glassdoor)\.com/i, q); assert.doesNotMatch(q, /\b2024\b/, q); assert.match(q, /ohio/i, q) }
  } finally { delete process.env.TINYFISH_API_KEY }
})

// Review edges (each written before the fix).
test('a negated site: operator is a legitimate exclusion: never stripped, never leaves a dangling minus', () => {
  assert.deepEqual(sanitizeQueries(['payroll -site:linkedin.com Ohio', 'payroll Ohio -site:indeed.com -site:glassdoor.com'], REQUEST, NOW), ['payroll -site:linkedin.com Ohio', 'payroll Ohio -site:indeed.com -site:glassdoor.com'])
})
test('host match is exact on the label boundary: lookalike hosts are untouched, a walled subdomain and a walled path are removed whole', () => {
  assert.deepEqual(sanitizeQueries(['payroll Ohio site:linkedin.com.evil.com', 'payroll Ohio site:notlinkedin.com', 'payroll Ohio site:linkedin.company.org'], REQUEST, NOW), ['payroll Ohio site:linkedin.com.evil.com', 'payroll Ohio site:notlinkedin.com', 'payroll Ohio site:linkedin.company.org'])
  assert.deepEqual(sanitizeQueries(['payroll Ohio site:www.linkedin.com/jobs', 'payroll Ohio site:uk.indeed.com/viewjob hiring'], REQUEST, NOW), ['payroll Ohio', 'payroll Ohio hiring'])
})
test('years: a fully stale range goes, a range reaching the window stays, counts and money that look like years stay', () => {
  assert.deepEqual(sanitizeQueries(['payroll Ohio 2023-2024', 'payroll Ohio 2023 to 2024 complaints', 'payroll Ohio 2024-2026', 'payroll Ohio 2000 employees', 'payroll Ohio $2024 budget', 'payroll Ohio 10-100 employees'], REQUEST, NOW),
    ['payroll Ohio', 'payroll Ohio complaints', 'payroll Ohio 2024-2026', 'payroll Ohio 2000 employees', 'payroll Ohio $2024 budget', 'payroll Ohio 10-100 employees'])
  assert.deepEqual(sanitizeQueries(['payroll Ohio 2023-2024'], 'Find Ohio payroll complaints from 2023', NOW), ['payroll Ohio 2023-2024'], 'the user named a year in the range')
})
