import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { randomBytes } from 'node:crypto'
import { migrateNewsjacks, parseArticle, createNewsjack, approveNewsjack, recentNewsjacks } from '../lib/seo/newsjack.ts'
import { migrateKeys, saveKey } from '../lib/llm/key-store.ts'
import type { Lookup } from '../lib/net/public-fetch.ts'

const pubLookup: Lookup = async () => [{ address: '93.184.216.34', family: 4 }]

const master = randomBytes(32)
const LONG = 'TAKE\nthing happened and it matters because reasons.\nANGLE\na practical view from selling.\nTALKING POINTS\n- one\n- two\n- three'
const ARTICLE = `<html><head><title>Big CRM bought by MegaCorp</title><style>x{}</style></head><body><script>evil()</script><p>${'News content here. '.repeat(30)}</p></body></html>`
function setup() { const db = new Database(':memory:'); migrateKeys(db); migrateNewsjacks(db); return db }

test('parseArticle: title out, scripts/styles stripped, text compacted', () => {
  const a = parseArticle(ARTICLE)
  assert.equal(a.title, 'Big CRM bought by MegaCorp')
  assert.ok(!a.excerpt.includes('evil()'))
  assert.ok(a.excerpt.includes('News content here.'))
})

test('createNewsjack: https only, no key -> no_key, fetch failure -> fetch, thin page -> fetch', async () => {
  const db = setup()
  assert.deepEqual(await createNewsjack(db, 'u1', 'http://x.example/a', { master }), { error: 'invalid' })
  assert.deepEqual(await createNewsjack(db, 'u1', 'https://x.example/a', { master }), { error: 'no_key' })
  saveKey(db, 'u1', 'anthropic', 'sk-ant-test-1234', master)
  assert.deepEqual(await createNewsjack(db, 'u1', 'https://x.example/a', { fetchImpl: (async () => new Response('no', { status: 404 })) as never, lookup: pubLookup, master }), { error: 'fetch' })
  assert.deepEqual(await createNewsjack(db, 'u1', 'https://x.example/a', { fetchImpl: (async () => new Response('<title>t</title>', { status: 200 })) as never, lookup: pubLookup, master }), { error: 'fetch' })
})

test('createNewsjack: draft stored as draft; approve marks approved once; nothing published', async () => {
  const db = setup()
  saveKey(db, 'u1', 'anthropic', 'sk-ant-test-1234', master)
  const f = (async (u: string, init?: RequestInit) => {
    if (String(u).includes('anthropic.com')) return new Response(JSON.stringify({ content: [{ type: 'text', text: LONG }] }), { status: 200 })
    return new Response(ARTICLE, { status: 200 })
  }) as unknown as typeof fetch
  const r = await createNewsjack(db, 'u1', 'https://news.example/story', { fetchImpl: f, lookup: pubLookup, master, now: 1_800_000_000 })
  assert.ok(!('error' in r))
  if ('error' in r) return
  assert.equal(r.status, 'draft')
  assert.equal(r.title, 'Big CRM bought by MegaCorp')
  assert.equal(approveNewsjack(db, 'u1', r.id), true)
  assert.equal(approveNewsjack(db, 'u1', r.id), false) // second approve is a no-op
  assert.equal(approveNewsjack(db, 'u2', r.id), false) // tenant isolation
  const list = recentNewsjacks(db, 'u1')
  assert.equal(list[0].status, 'approved')
})

test('upstream failure and thin draft store nothing', async () => {
  const db = setup()
  saveKey(db, 'u1', 'anthropic', 'sk-ant-test-1234', master)
  const bad = (async (u: string) => String(u).includes('anthropic.com') ? new Response('no', { status: 500 }) : new Response(ARTICLE, { status: 200 })) as unknown as typeof fetch
  assert.deepEqual(await createNewsjack(db, 'u1', 'https://news.example/a', { fetchImpl: bad, lookup: pubLookup, master }), { error: 'upstream' })
  const thin = (async (u: string) => String(u).includes('anthropic.com') ? new Response(JSON.stringify({ content: [{ type: 'text', text: 'hi' }] }), { status: 200 }) : new Response(ARTICLE, { status: 200 })) as unknown as typeof fetch
  assert.deepEqual(await createNewsjack(db, 'u1', 'https://news.example/a', { fetchImpl: thin, lookup: pubLookup, master }), { error: 'upstream' })
  assert.equal(recentNewsjacks(db, 'u1').length, 0)
})
