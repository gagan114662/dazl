// Council R1-4 on d6c89bf2: the read path end to end on one store, the REAL admission (lib/scan/trial-site-read.ts) and
// the REAL icpFromWebsite with its guard, asserting the wallet row and the account's read after each outcome. This is the
// composition the stubbed-admission tests could not see (R1-1, R1-2). SQLite only: icpFromWebsite takes the raw handle;
// the admission's own both-engine proof is test/trial-site-read.test.ts. Synthetic page, key and provider; no network.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { migrateAllSqlite } from '../lib/db/sqlite-migrations.ts'
import { sqliteDb } from '../lib/db/client.ts'
import { icpFromWebsite } from '../lib/scan/icp-from-site.ts'
import { admitTrialSiteRead } from '../lib/scan/trial-site-read.ts'
import { admitTrialScan, TRIAL_SITE_READ_RESERVE_USD } from '../lib/billing/trial-budget.ts'
import type { Provider } from '../lib/llm/provider.ts'
import type { Lookup } from '../lib/net/public-fetch.ts'

const OP = 'sk-ant-api03-OPERATOROPERATOROPERATOROPERATOR'
const ENV = { DAZL_TRIAL_ANTHROPIC_KEY: OP, DAZL_TRIAL_SITE_READS_PER_DAY: '50', DAZL_TRIAL_SCAN_RESERVE_USD: '0.30', DAZL_TRIAL_ACCOUNT_TOTAL_USD: '1',
  DAZL_TRIAL_GLOBAL_DAILY_USD: '10', TINYFISH_API_KEY: 'tf-fixture', DAZL_TRIAL_TINYFISH_SEARCH_USD: '0.004', DAZL_TRIAL_TINYFISH_FETCH_USD: '0.002' }
const pubLookup: Lookup = async () => [{ address: '93.184.216.34', family: 4 }]
const page = (body: string) => (async () => new Response(`<html><head><title>T</title></head><body>${body}</body></html>`, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } })) as unknown as typeof fetch
const LATIN = page('we sell crm tools to sales teams '.repeat(30)), CJK = page('我们为销售团队提供客户关系管理工具。'.repeat(400))
const ICP = JSON.stringify({ sells: 'CRM cleanup', summary: 'Sales ops teams at B2B SaaS companies that need CRM cleanup.', who: ['Sales ops managers'], industries: ['B2B SaaS'], sizes: [], where: [], signals: [], exclude: [] })
const USAGE = { input_tokens: 2000, output_tokens: 300 }, COST = (2000 * 3 + 300 * 15) / 1e6
const provider = (o: { model?: string; fail?: boolean; usage?: boolean } = {}): Provider => ({
  research: async () => { throw new Error('unused') },
  configuredModel: () => o.model ?? 'claude-sonnet-4-5',
  completeDetailed: async () => { if (o.fail) throw new Error('provider 500'); return { text: ICP, model: o.model ?? 'claude-sonnet-4-5', ...(o.usage === false ? {} : { usage: USAGE }) } },
})
const uid = (n: number) => n.toString(16).padStart(32, '0')

test('#444 R1-4 end to end: reported cost settles the wallet; a failed call ends at the reserve; a guard refusal before any call releases; a refused account reserves nothing', async () => {
  const raw = new Database(':memory:'); migrateAllSqlite(raw)
  const db = sqliteDb(raw)
  const counts = new Map<string, number>()
  const limit = async (key: string, max: number) => { const c = (counts.get(key) ?? 0) + 1; counts.set(key, c); return { ok: c <= max, retryAfterS: 60 } }
  const refund = async (key: string) => { counts.set(key, (counts.get(key) ?? 1) - 1); return true }
  const account = async (n: number, email: string, google = true) => {
    const id = uid(n)
    await db.run("INSERT INTO users (id, email, name, business_name, password_hash, salt) VALUES (?, ?, 'n', 'b', 'x', 'y')", [id, email])
    if (google) await db.run("INSERT INTO oauth_identities (provider, subject, user_id) VALUES ('google', ?, ?)", [`sub-${id}`, id])
    return { id, email }
  }
  const rows = async (id: string) => db.all<{ settled_at: number | null; spent_usd: number | null; reserve_usd: number }>('SELECT settled_at, spent_usd, reserve_usd FROM trial_reservations WHERE tenant_id = ? ORDER BY created_at', [id])
  const read = (u: { id: string; email: string }, p: Provider, fetchImpl = LATIN) =>
    icpFromWebsite(raw, u.id, 'https://acme.example', { lookup: pubLookup, fetchImpl, providers: { anthropic: p }, trial: () => admitTrialSiteRead(db, u, '203.0.113.5', { env: ENV, limit, refund }) })
  const reads = (id: string) => counts.get(`trial-site:${id}`) ?? 0

  // 1. Reported usage: one reservation, settled to the reported cost; one read counted.
  const a = await account(1, 'a@gmail.com')
  const ok = await read(a, provider())
  assert.ok('icp' in ok && ok.funded === 'trial', JSON.stringify(ok))
  assert.deepEqual((await rows(a.id)).map(r => [r.settled_at !== null, r.spent_usd]), [[true, COST]])
  assert.equal(reads(a.id), 1)

  // 2. The call fails: the reservation ends at its full reserve, settled now; the read stays counted (a call was made).
  const b = await account(2, 'b@gmail.com')
  assert.deepEqual(await read(b, provider({ fail: true })), { error: 'trial_read_failed' })
  assert.deepEqual((await rows(b.id)).map(r => [r.settled_at !== null, r.spent_usd]), [[true, TRIAL_SITE_READ_RESERVE_USD]])
  assert.equal(reads(b.id), 1)
  // ... and it does not hold the day ceiling open: a $0.30 scan under a $0.30 day ceiling is admitted on the next day
  // (the failed read ended today), while the account itself still pays the reserve.
  const tomorrow = Math.floor(Date.now() / 1000) + 86400
  const c = await account(3, 'c@gmail.com')
  assert.equal((await admitTrialScan(db, c, { env: { ...ENV, DAZL_TRIAL_GLOBAL_DAILY_USD: '0.30' }, now: tomorrow })).ok, true, 'next day: the failed read no longer counts')
  assert.deepEqual(await admitTrialScan(db, b, { env: { ...ENV, DAZL_TRIAL_ACCOUNT_TOTAL_USD: '0.34' }, now: tomorrow }), { ok: false, reason: 'account_total_cap' }, 'the account pays $0.05 + $0.30 > $0.34')

  // 3. The guard refuses before any call (operator model it cannot price): no reservation left, the read given back.
  const d = await account(4, 'd@gmail.com')
  assert.deepEqual(await read(d, provider({ model: 'some-new-model' })), { error: 'trial_read_failed' })
  assert.deepEqual(await rows(d.id), [], 'released: nothing in the wallet')
  assert.equal(reads(d.id), 0, 'released: the account\'s read given back')

  // 4. A CJK page at the character cap (R1-1): admitted and read in one call under the ceiling, settled to its cost.
  const e = await account(5, 'e@gmail.com')
  const cjk = await read(e, provider(), CJK)
  assert.ok('icp' in cjk, JSON.stringify(cjk))
  assert.deepEqual((await rows(e.id)).map(r => [r.settled_at !== null, r.spent_usd]), [[true, COST]])

  // 5. An account the trial refuses (no Google sign-in): no reservation, no read, no call, the reason with no_api_key.
  const f = await account(6, 'f@gmail.com', false)
  let calls = 0
  const counting: Provider = { ...provider(), completeDetailed: async () => { calls++; return { text: ICP, model: 'claude-sonnet-4-5', usage: USAGE } } }
  assert.deepEqual(await read(f, counting), { error: 'no_api_key', trial: 'google_required' })
  assert.deepEqual([await rows(f.id), reads(f.id), calls], [[], 0, 0])

  // 5b. An unreadable page (JS only): no admission is asked for, nothing in the wallet, no read counted.
  const h = await account(8, 'h@gmail.com')
  assert.deepEqual(await read(h, provider(), page('<script>app()</script>')), { error: 'js_only' })
  assert.deepEqual([await rows(h.id), reads(h.id)], [[], 0])

  // 6. No usage reported: the read ends at its reserve (never left pending).
  const g = await account(7, 'g@gmail.com')
  assert.ok('icp' in await read(g, provider({ usage: false })))
  assert.deepEqual((await rows(g.id)).map(r => [r.settled_at !== null, r.spent_usd]), [[true, TRIAL_SITE_READ_RESERVE_USD]])
  assert.equal(Number((await db.get<{ n: number }>("SELECT COUNT(*) AS n FROM trial_reservations WHERE kind = 'site_read' AND settled_at IS NULL"))!.n), 0, 'no read is ever left pending by the read path')
})
