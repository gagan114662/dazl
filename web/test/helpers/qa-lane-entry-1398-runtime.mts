// #1398: on a production server (NODE_ENV=production, no DAZL_ENV) there is exactly one request that starts the isolated
// Claude-only job, and it is the one the real first-run screen sends for its "Use Claude Web Search for this play" box:
// mode first5 with budget { web_search: 'anthropic_estimated_v1' } (plus target_review for the reviewed target), from an
// account that has saved its own Anthropic key. Every other spelling a caller could post to the REAL handlers - the three
// names the audit listed, the server-written policy and execution words used as a mode, those words inside the budget, or as
// top-level fields - is refused with nothing written, or ignored without changing the job.
// Only the session and the store are swapped (tenant-route-db.ts); nothing calls out.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import Database from 'better-sqlite3'
import { NextRequest } from 'next/server'
import { setScanDb, setUser } from './tenant-route-db.ts'
import { setSellerLine } from './scan-route-auth-stub.ts'
import { migrateScan } from '../../lib/scan/store.ts'
import { migrateKeys, saveKey } from '../../lib/llm/key-store.ts'
import { migratePlans } from '../../lib/plans.ts'
import { migratePlatform } from '../../lib/db/platform-tables.ts'
import { migrateWatch } from '../../lib/watch.ts'
import { normalizeRunBudget } from '../../lib/scan/csv-import.ts'
import { POST } from '../../app/api/scan/route.ts'
import { POST as ESTIMATE } from '../../app/api/scan/estimate/route.ts'
import { POST as WATCH } from '../../app/api/watch/route.ts'

assert.equal(process.env.NODE_ENV, 'production', 'this file must run as a production server')
assert.equal(process.env.DAZL_ENV, undefined, 'this file must run without the staging flag')
process.env.DAZL_MASTER_KEY = randomBytes(32).toString('base64')
globalThis.fetch = (async (u: unknown) => { throw new Error(`network fenced: ${String(u)}`) }) as typeof fetch
let n = 0
const Q = 'Independent dental practices hiring a receptionist in New York in the past 90 days'
const ICP = { summary: 'Dental practices', who: ['Practice owner'], industries: [], sizes: [], where: ['Toronto'], signals: [], exclude: [] }
const SEARCH = 'anthropic_estimated_v1'
function setup() {
  const db = new Database(':memory:'); migrateScan(db); migrateKeys(db); migratePlans(db); migratePlatform(db); migrateWatch(db)
  setScanDb(db)
  return db
}
// Every request comes from a fresh account (the routes rate-limit per account), by default with its own Anthropic key.
function as(db: Database.Database, key: 'anthropic' | 'openai' | 'none' = 'anthropic') {
  const id = `U${++n}`
  if (key === 'anthropic') saveKey(db, id, 'anthropic', 'sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA')
  if (key === 'openai') saveKey(db, id, 'openai', 'sk-proj-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA')
  setSellerLine(id, 'Independent compliance consulting'); setUser({ id, business_name: 'Acme' }); return id
}
const req = (path: string, body: unknown) => new NextRequest(`http://localhost${path}`, { method: 'POST', headers: { 'content-type': 'application/json', host: 'localhost', origin: 'http://localhost', 'x-forwarded-for': `10.0.2.${++n % 250}` }, body: JSON.stringify(body) })
const jobs = (db: Database.Database) => db.prepare('SELECT run_budget, status FROM scan_jobs').all() as { run_budget: string | null; status: string }[]
const count = (db: Database.Database, table: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n
// The free-trial tables are created the first time a trial is touched; absent means no trial was touched.
const trialRows = (db: Database.Database) => ['trial_scans', 'trial_reservations']
  .filter(t => db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t)).reduce((sum, t) => sum + count(db, t), 0)

// The three names in the audit, the two words the server writes into a job, and near-misses of the one real mode.
const RETIRED_MODES = ['claude_only_v1', 'first5_claude_only_v1', 'first5_claude_only_pinned_v2']
const OTHER_MODES = ['local_once_v1', SEARCH, 'first5_claude_only_pinned_v3', 'qa', 'FIRST5', 'first5 ', ['first5'], { mode: 'first5' }, true, 1]
// Budgets that try to carry the lane's own markers. None is the exact opt-in, so each must be refused whole.
const NO_MODE_BUDGETS = [
  { provider_policy: 'claude_only_v1' }, { execution: 'local_once_v1' }, { web_search_policy: SEARCH }, { web_search: SEARCH },
  { paid_fallback: false, provider_policy: 'claude_only_v1' }, { max_usd: 1, execution: 'local_once_v1' },
  { web_search: SEARCH, target_review: 'manual_v1' },
]
const FIRST5_BUDGETS = [
  { provider_policy: 'claude_only_v1' }, { execution: 'local_once_v1' }, { web_search_policy: SEARCH },
  { web_search: SEARCH, provider_policy: 'claude_only_v1' }, { web_search: SEARCH, execution: 'local_once_v1' },
  { web_search: SEARCH, max_usd: 100 }, { web_search: 'anthropic_estimated_v2' }, { web_search: true },
  { web_search: SEARCH, target_review: 'manual_v2' }, { web_search: SEARCH, target_review: 'manual_v1', paid_fallback: true },
]

test('#1398 POST /api/scan: no mode name other than first5 starts anything', async () => {
  for (const mode of [...RETIRED_MODES, ...OTHER_MODES]) {
    const db = setup(); as(db)
    const r = await POST(req('/api/scan', { query: Q, mode }))
    assert.equal(r.status, 400, JSON.stringify(mode))
    assert.equal((await r.json() as { error: string }).error, 'unknown_mode', JSON.stringify(mode))
    assert.equal(jobs(db).length, 0, `${JSON.stringify(mode)}: no job written`)
  }
})

test('#1398 POST /api/scan: the lane\'s own markers inside a budget are refused whole, with or without mode first5', async () => {
  for (const [mode, budgets] of [[undefined, NO_MODE_BUDGETS], ['first5', FIRST5_BUDGETS]] as const) {
    for (const budget of budgets) {
      const db = setup(); as(db)
      const r = await POST(req('/api/scan', { query: Q, icp: ICP, ...(mode ? { mode } : {}), budget }))
      const label = `${mode ?? 'no mode'} ${JSON.stringify(budget)}`
      assert.equal(r.status, 400, label)
      assert.equal((await r.json() as { error: string }).error, 'invalid_budget', label)
      assert.equal(jobs(db).length, 0, `${label}: no job written`)
    }
  }
})

test('#1398 POST /api/scan: the same markers as top-level fields change nothing about the job', async () => {
  const forged = { provider_policy: 'claude_only_v1', execution: 'local_once_v1', web_search_policy: SEARCH, web_search: SEARCH,
    run_budget: JSON.stringify({ provider_policy: 'claude_only_v1', execution: 'local_once_v1' }) }
  const db = setup(); as(db)
  const plain = await POST(req('/api/scan', { query: Q, ...forged }))
  assert.equal(plain.status, 202)
  assert.deepEqual(Object.keys(await plain.json() as object), ['job_id'])
  assert.deepEqual(jobs(db), [{ run_budget: null, status: 'pending' }])
  const db2 = setup(); as(db2)
  const first = await POST(req('/api/scan', { query: Q, mode: 'first5', ...forged }))
  assert.equal(first.status, 202)
  const ack = await first.json() as Record<string, unknown>
  assert.deepEqual([ack.provider_policy, ack.execution, ack.web_search_policy], [undefined, undefined, undefined])
  assert.deepEqual(JSON.parse(jobs(db2)[0].run_budget!), { first5: true, paid_fallback: false, credit_enrichment: false })
  assert.equal(jobs(db2)[0].status, 'pending', 'an ordinary queued first play, not the pinned local job')
})

test('#1398 POST /api/scan: the one real opt-in needs the account\'s own Anthropic key; a trial or OpenAI-key account starts nothing', async () => {
  for (const budget of [{ web_search: SEARCH }, { web_search: SEARCH, target_review: 'manual_v1' }]) {
    for (const key of ['none', 'openai'] as const) {
      const db = setup(); as(db, key)
      const r = await POST(req('/api/scan', { query: Q, icp: ICP, mode: 'first5', budget }))
      assert.equal(r.status, 409, `${key} ${JSON.stringify(budget)}`)
      assert.equal((await r.json() as { error: string }).error, 'qa_search_requires_own_key')
      assert.equal(jobs(db).length, 0, `${key}: no job written`)
      assert.equal(trialRows(db), 0, `${key}: no free-trial scan counted or reserved`)
    }
  }
  // and with its own Anthropic key the exact request is the only one that gets the isolated job
  const db = setup(); as(db)
  const ok = await POST(req('/api/scan', { query: Q, mode: 'first5', budget: { web_search: SEARCH } }))
  assert.equal(ok.status, 202)
  const stored = JSON.parse(jobs(db)[0].run_budget!)
  assert.deepEqual([stored.provider_policy, stored.execution, stored.web_search_policy, stored.paid_fallback, stored.credit_enrichment],
    ['claude_only_v1', 'local_once_v1', SEARCH, false, false])
})

test('#1398 POST /api/scan/estimate: the same modes and budgets are priced nowhere', async () => {
  for (const mode of [...RETIRED_MODES, ...OTHER_MODES]) {
    const db = setup(); as(db)
    const r = await ESTIMATE(req('/api/scan/estimate', { query: Q, mode }))
    assert.equal(r.status, 400, JSON.stringify(mode))
    assert.equal((await r.json() as { error: string }).error, 'unknown_mode', JSON.stringify(mode))
  }
  for (const [mode, budgets] of [[undefined, NO_MODE_BUDGETS], ['first5', FIRST5_BUDGETS]] as const) {
    for (const budget of budgets) {
      const db = setup(); as(db)
      const r = await ESTIMATE(req('/api/scan/estimate', { query: Q, icp: ICP, ...(mode ? { mode } : {}), budget }))
      const label = `${mode ?? 'no mode'} ${JSON.stringify(budget)}`
      assert.equal(r.status, 400, label)
      assert.equal((await r.json() as { error: string }).error, 'invalid_budget', label)
    }
  }
})

test('#1398 a scheduled play and a CSV import cannot carry the markers either', async () => {
  const db = setup()
  for (const budget of NO_MODE_BUDGETS) {
    as(db)
    const r = await WATCH(req('/api/watch', { query: 'dental practices in Toronto hiring', icp: ICP, budget }))
    assert.equal(r.status, 400, JSON.stringify(budget))
    assert.equal((await r.json() as { error: string }).error, 'invalid_budget', JSON.stringify(budget))
    assert.equal(normalizeRunBudget(budget, true).ok, false, `csv ${JSON.stringify(budget)}`)
  }
  assert.equal(count(db, 'watches'), 0, 'no scheduled play was saved')
  // a mode on a scheduled play is not read at all: the play is saved with no budget
  as(db)
  const ok = await WATCH(req('/api/watch', { query: 'dental practices in Ohio hiring', icp: ICP, mode: 'first5_claude_only_pinned_v2', provider_policy: 'claude_only_v1' }))
  assert.equal(ok.status, 200)
  assert.deepEqual(db.prepare('SELECT run_budget FROM watches').all(), [{ run_budget: null }])
})
