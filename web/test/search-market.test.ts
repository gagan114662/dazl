import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { migrateTinyfish, tfSearch, queryPrompt, resetTinyfishState, limits } from '../lib/search/tinyfish.ts'
import { normalizeIcp, icpPrompt } from '../lib/scan/icp.ts'

// TinyFish searches as US/English unless location or language is sent. These pin that the buyer's market reaches the
// search (Instinct finding 2: a Lisbon or Pune request must not be searched as if it were American).
const env = { TINYFISH_API_KEY: 'k', TINYFISH_SEARCHES_PER_SCAN: '4', TINYFISH_TENANT_DAILY: '50' }
const mk = () => { const db = new Database(':memory:'); migrateTinyfish(db); resetTinyfishState(); return db }
const NOW = 1_800_000_000

test('profile keeps a valid country and language, normalized; anything else is dropped', () => {
  const icp = normalizeIcp({ summary: 'Guitar schools in Lisbon', country: ' pt ', language: 'PT' })!
  assert.equal(icp.country, 'PT'); assert.equal(icp.language, 'pt')
  for (const bad of [{ country: 'Portugal', language: 'Portuguese' }, { country: '', language: '' }, { country: 7, language: null }, { country: 'P1', language: 'p' }]) {
    const out = normalizeIcp({ summary: 's', ...bad })!
    assert.equal('country' in out, false); assert.equal('language' in out, false)
  }
})

test('an old stored profile without the fields still loads unchanged', () => {
  const old = { summary: 's', who: [], industries: [], sizes: [], where: ['Ohio'], signals: [], exclude: [] }
  assert.deepEqual(normalizeIcp(old), old)
})

test('the inference prompt asks for country and language codes', () => {
  const p = icpPrompt('guitar lessons in Lisbon')
  assert.ok(p.includes('"country"') && p.includes('ISO 3166-1 alpha-2'))
  assert.ok(p.includes('"language"') && p.includes('ISO 639-1'))
})

test('search sends location and language when given, and neither when not', async () => {
  const db = mk(); const urls: string[] = []
  const f = (async (u: string) => { urls.push(u); return new Response(JSON.stringify({ results: [] })) }) as unknown as typeof fetch
  await tfSearch(db, 't1', 'escola de guitarra Lisboa', { location: 'PT', language: 'pt' }, { searches: 0 }, { env, fetchImpl: f, now: NOW })
  await tfSearch(db, 't1', 'roofers hiring Ohio', {}, { searches: 0 }, { env, fetchImpl: f, now: NOW })
  const a = new URL(urls[0]).searchParams; const b = new URL(urls[1]).searchParams
  assert.equal(a.get('location'), 'PT'); assert.equal(a.get('language'), 'pt')
  assert.equal(b.has('location'), false); assert.equal(b.has('language'), false)
})

test('query prompt: one signal per query, no generic OR chains, local language when not English', () => {
  const pt = queryPrompt('guitar lessons in Lisbon', { summary: 's', language: 'pt' }, 6)
  assert.ok(pt.includes('ONE specific signal') && pt.includes('Never chain generic words with OR'))
  assert.ok(pt.includes('Portuguese'))
  const en = queryPrompt('roofers in Ohio', { summary: 's', language: 'en' }, 6)
  assert.ok(!en.includes('publish in'))
  assert.ok(queryPrompt('q', { summary: 's', language: 'xx' }, 2).includes('"xx"')) // unknown code: named by code, never dropped
})

test('default search budget is wide enough to find something', () => {
  const L = limits({})
  assert.equal(L.searchesPerScan, 8); assert.equal(L.fetchesPerScan, 16)
  assert.equal(L.tenantDaily, 60) // unchanged here; any raise is its own commit
})
