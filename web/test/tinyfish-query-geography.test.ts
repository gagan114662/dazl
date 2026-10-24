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
import { withGeography, QUERY_CAP } from '../lib/search/tinyfish.ts'

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

test('withGeography: adds missing places after the model words, leaves queries that already name them (case-insensitive)', () => {
  assert.deepEqual(withGeography(['payroll manager job posting small company'], ['Ohio']), ['payroll manager job posting small company Ohio'])
  assert.deepEqual(withGeography(['payroll manager job Ohio small company', 'office manager hiring OHIO'], ['Ohio']), ['payroll manager job Ohio small company', 'office manager hiring OHIO'])
  assert.deepEqual(withGeography(['payroll job posting'], []), ['payroll job posting'])
  assert.deepEqual(withGeography(['a payroll query here'], ['Ohio', 'Cleveland']), ['a payroll query here Ohio Cleveland'])
  assert.deepEqual(withGeography(['payroll jobs near Cleveland'], ['Ohio', 'Cleveland']), ['payroll jobs near Cleveland Ohio'], 'only the missing place is added')
  assert.deepEqual(withGeography(['payroll hiring in New  York small firms'], ['New York']), ['payroll hiring in New  York small firms'], 'multi-word place matches across whitespace')
})

test('withGeography: places match as whole words, not substrings (GA is not garden or again)', () => {
  assert.deepEqual(withGeography(['garden centre hiring again payroll'], ['GA']), ['garden centre hiring again payroll GA'])
  assert.deepEqual(withGeography(['payroll jobs in GA small firms'], ['GA']), ['payroll jobs in GA small firms'])
  assert.deepEqual(withGeography(["Ohio's small payroll teams"], ['Ohio']), ["Ohio's small payroll teams"], 'possessive still names the place')
  assert.deepEqual(withGeography(['Columbus Ohio payroll'], ['Ohio (state)']), ['Columbus Ohio payroll Ohio (state)'], 'punctuation in a place is matched literally, not as regex')
  assert.deepEqual(withGeography(['payroll .* jobs'], ['.*']), ['payroll .* jobs'], 'regex characters in a place are escaped')
})

test('withGeography: never cuts or rewords the model query; a place that does not fit the 300-character search cap is skipped', () => {
  assert.equal(QUERY_CAP, 300)
  const long = 'x'.repeat(149)
  const out150 = withGeography([long], ['Ohio'])[0]
  assert.equal(out150, `${long} Ohio`, '150-character parse convention is not a limit: the place still fits under 300')
  const q290 = 'payroll '.repeat(37) + 'j' // 297 chars: adding ' Ohio' would be 302
  assert.equal(q290.length, 297)
  assert.deepEqual(withGeography([q290], ['Ohio']), [q290], 'no room: query untouched, never truncated')
  const places = ['A'.repeat(60), 'B'.repeat(60), 'C'.repeat(60)]
  const q150 = 'y'.repeat(150)
  const out = withGeography([q150], places)[0]
  assert.ok(out.startsWith(q150), 'original is a full prefix')
  assert.ok(out.length <= QUERY_CAP, 'never past the cap')
  assert.equal(out, `${q150} ${places[0]} ${places[1]}`, 'places added in profile order while they fit; the third (60 chars, 333 total) is skipped')
  assert.deepEqual(withGeography(['ab'], ['Ohio']), ['ab Ohio'])
  assert.deepEqual(withGeography(['payroll job'], ['x', 'Z'.repeat(61), '  ']), ['payroll job'], 'too-short, too-long and blank places are ignored')
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
