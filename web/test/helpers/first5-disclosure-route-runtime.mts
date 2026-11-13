// #1037 (Hermes review finding 2): the REAL POST /api/scan handler for mode first5 answers with a budget disclosure that follows
// the server's people-search setting. In-memory db, network fenced, runner never started (same harness as scan-route-runtime).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import Database from 'better-sqlite3'
import { NextRequest } from 'next/server'
import { setScanDb, setUser } from './tenant-route-db.ts'
import { migrateScan } from '../../lib/scan/store.ts'
import { migrateKeys, saveKey } from '../../lib/llm/key-store.ts'
import { migratePlans } from '../../lib/plans.ts'
import { migratePlatform } from '../../lib/db/platform-tables.ts'
import { POST } from '../../app/api/scan/route.ts'

process.env.DAZL_MASTER_KEY = randomBytes(32).toString('base64')
globalThis.fetch = (async (u: unknown) => { throw new Error(`network fenced: ${String(u)}`) }) as typeof fetch
let n = 0
function setup() { const db = new Database(':memory:'); migrateScan(db); migrateKeys(db); migratePlans(db); migratePlatform(db); setScanDb(db); return db }
function as(db: Database.Database) { const id = `U${++n}`; saveKey(db, id, 'anthropic', 'sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'); setUser({ id, business_name: 'Acme' }) }
const post = (body: unknown) => POST(new NextRequest('http://localhost/api/scan', { method: 'POST', headers: { 'content-type': 'application/json', host: 'localhost', 'x-forwarded-for': `10.0.1.${++n}` }, body: JSON.stringify(body) }))
const Q = 'B2B SaaS startups hiring their first sales rep (SDR or account executive), job posted in the last 30 days'
type Disc = { surfaces: { surface: string; status: string; note: string }[]; excluded_paths: string[] }
async function first5(env: Record<string, string | undefined>): Promise<Disc> {
  for (const [k, v] of Object.entries(env)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
  const db = setup(); as(db)
  const r = await post({ mode: 'first5', query: Q })
  const j = await r.json() as { budget?: Disc; error?: string }
  assert.equal(r.status, 202, JSON.stringify(j))
  assert.ok(j.budget, 'a first5 job is answered with its disclosure')
  return j.budget!
}
const people = (d: Disc) => d.excluded_paths.filter(x => x.startsWith('People search after the scan'))

test('#1037 route: people search off (PEOPLE_SEARCH_ENABLED=0) and the lead fallback off -> search_and_fetch off, no people line', async () => {
  const d = await first5({ PEOPLE_SEARCH_ENABLED: '0', TINYFISH_API_KEY: 'tf-fixture', DAZL_FIRST_PLAY_PEOPLE_SEARCHES: undefined, DAZL_FIRST_PLAY_LEAD_SEARCHES: '0' })
  const s = d.surfaces.find(x => x.surface === 'search_and_fetch')!
  assert.equal(s.status, 'off'); assert.deepEqual(people(d), [])
})

test('#1037 item 1 route: people search off but the capped lead fallback on -> not_covered, states the server cap', async () => {
  const d = await first5({ PEOPLE_SEARCH_ENABLED: '0', TINYFISH_API_KEY: 'tf-fixture', DAZL_FIRST_PLAY_PEOPLE_SEARCHES: undefined, DAZL_FIRST_PLAY_LEAD_SEARCHES: '2', DAZL_FIRST_PLAY_LEAD_FETCHES: undefined })
  const s = d.surfaces.find(x => x.surface === 'search_and_fetch')!
  assert.equal(s.status, 'not_covered'); assert.match(s.note, /capped at 2 lead searches and 6 page reads/); assert.deepEqual(people(d), [])
})

test('#1037 item 1 route: no TinyFish key -> the lead fallback cannot run and is not stated', async () => {
  const d = await first5({ PEOPLE_SEARCH_ENABLED: '0', TINYFISH_API_KEY: undefined, DAZL_FIRST_PLAY_PEOPLE_SEARCHES: undefined, DAZL_FIRST_PLAY_LEAD_SEARCHES: undefined })
  assert.equal(d.surfaces.find(x => x.surface === 'search_and_fetch')!.status, 'off')
})

test('#1037 route: DAZL_FIRST_PLAY_PEOPLE_SEARCHES=3 -> "up to 3" in the surface AND the excluded path, nothing else', async () => {
  const d = await first5({ PEOPLE_SEARCH_ENABLED: undefined, TINYFISH_API_KEY: 'tf-fixture', DAZL_FIRST_PLAY_PEOPLE_SEARCHES: '3' })
  const s = d.surfaces.find(x => x.surface === 'search_and_fetch')!
  assert.equal(s.status, 'not_covered'); assert.match(s.note, /up to 3 TinyFish people searches/)
  assert.deepEqual(people(d).map(x => /up to (\d+)/.exec(x)?.[1]), ['3'])
})
