// #444 restack (Instinct 2026-10-30): the website read's two funding identities on one tree, each with its own spend
// guard and its own error, proven against the real guards and the real shared store (no stubs of the guards):
//   own   - the tenant's key on the owner's workspace spend pool (lib/llm/owner-guard.ts, #363): reserved in
//           tenant_spend_pools before the call, settled to the reported cost after it, 'spend_limit' when the pool refuses
//           (over the limit, or another call of the owner unsettled), and never a trial admission;
//   trial - dazl's key, admitted per read (deps.trial: the trial wallet's bounded reservation), held by the read's own
//           guard, settled to the reported cost in the wallet, 'trial_read_failed' on any failure, and never a row in the
//           owner's pool, even when that pool would refuse.
// Synthetic store, key and provider; the provider double records the key each call was made with. Nothing is billed.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import Database from 'better-sqlite3'
import { icpFromWebsite } from '../lib/scan/icp-from-site.ts'
import { migrateKeys, saveKey } from '../lib/llm/key-store.ts'
import { migrateSpendPools, poolRows, sharedPool } from '../lib/llm/spend-pool.ts'
import type { Provider } from '../lib/llm/provider.ts'
import type { Lookup } from '../lib/net/public-fetch.ts'
import type { SiteReadAdmission } from '../lib/scan/trial-site-read.ts'

const master = randomBytes(32)
const KEY = 'sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
const OP = 'sk-ant-api03-OPERATOROPERATOROPERATOROPERATOR'
const pubLookup: Lookup = async () => [{ address: '93.184.216.34', family: 4 }]
const HTML = '<html><head><title>Acme</title></head><body>' + 'we sell crm tools to sales teams '.repeat(30) + '</body></html>'
const page = (async () => new Response(HTML, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } })) as unknown as typeof fetch
const ICP = JSON.stringify({ sells: 'CRM cleanup', summary: 'Sales ops teams at B2B SaaS companies that need CRM cleanup.', who: ['Sales ops managers'], industries: ['B2B SaaS'], sizes: [], where: [], signals: ['Hiring a CRM admin'], exclude: [] })
// 2000 in + 300 out at the listed $3 / $15 per million: what both settles record.
const USAGE = { input_tokens: 2000, output_tokens: 300 }
const COST = (2000 * 3 + 300 * 15) / 1e6

function store(ownKey: boolean) {
  const db = new Database(':memory:')
  migrateKeys(db); migrateSpendPools(db)
  if (ownKey) saveKey(db, 'A', 'anthropic', KEY, master)
  return db
}
// Records the key of every call. Reports usage as the real providers do, so each path has a cost to settle.
const provider = (seen: string[], o: { model?: string; usage?: typeof USAGE | null; fail?: boolean } = {}): Provider => ({
  research: async () => { throw new Error('unused') },
  configuredModel: () => o.model ?? 'claude-sonnet-4-5',
  complete: async k => { seen.push(k); if (o.fail) throw new Error('provider 500'); return ICP },
  completeDetailed: async k => { seen.push(k); if (o.fail) throw new Error('provider 500'); return { text: ICP, model: o.model ?? 'claude-sonnet-4-5', ...(o.usage === null ? {} : { usage: o.usage ?? USAGE }) } },
})
const read = (db: Database.Database, p: Provider, trial?: () => Promise<SiteReadAdmission>) =>
  icpFromWebsite(db, 'A', 'https://acme.example', { master, lookup: pubLookup, fetchImpl: page, providers: { anthropic: p }, ...(trial ? { trial } : {}) })
// A trial admission that records how often it was asked and what the read settled into the wallet.
const admitted = (calls: { n: number }, settled: (number | null)[] = [], released = { n: 0 }) => async () => { calls.n++; return { ok: true as const, key: { vendor: 'anthropic' as const, key: OP }, settle: async (usd: number | null) => { settled.push(usd) }, release: async () => { released.n++ } } }
const neverTrial = async (): Promise<never> => { throw new Error('the trial must not be asked for an own-key read') }
const round = (n: number) => Math.round(n * 1e6) / 1e6
const pool = async (db: Database.Database) => (await poolRows(db, 'A')).map(r => [r.period.slice(0, 2), round(r.reserved_usd), round(r.reported_usd), r.calls])

// The operator's per-owner limits the way production sets them (environment), restored after each test.
async function withEnv<T>(vars: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const before = Object.fromEntries(Object.keys(vars).map(k => [k, process.env[k]]))
  for (const [k, v] of Object.entries(vars)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
  try { return await fn() } finally { for (const [k, v] of Object.entries(before)) { if (v === undefined) delete process.env[k]; else process.env[k] = v } }
}
const NONE = { DAZL_RUN_MAX_USD_USERS: undefined, DAZL_OWNER_MONTH_MAX_USD_USERS: undefined, DAZL_ANTHROPIC_MODEL: undefined, DAZL_SPEND_BUSY_WAIT_MS: undefined }

test('own key: the read runs on the owner\'s spend pool: reserved in the shared store and settled to the reported cost; the trial is never asked', async () => {
  const db = store(true), seen: string[] = []
  await withEnv({ ...NONE, DAZL_RUN_MAX_USD_USERS: 'A:5', DAZL_OWNER_MONTH_MAX_USD_USERS: 'A:20' }, async () => {
    const out = await read(db, provider(seen), neverTrial)
    assert.ok('icp' in out && out.funded === 'own', JSON.stringify(out))
    assert.deepEqual(seen, [KEY], 'one call, on the tenant\'s own key')
    // Day and month each hold the settled cost, one call; the pending-settlement marker is gone (settled).
    assert.deepEqual(await pool(db), [['d:', round(COST), round(COST), 1], ['m:', round(COST), round(COST), 1]])
  })
  // No limit set for this owner: the pool is not involved and nothing is written (main's behaviour, unchanged).
  const db2 = store(true), seen2: string[] = []
  await withEnv(NONE, async () => {
    assert.ok('icp' in await read(db2, provider(seen2), neverTrial))
    assert.deepEqual([seen2, await pool(db2)], [[KEY], []])
  })
})

test('own key: the pool refuses (over the limit, or another call of the owner unsettled) -> spend_limit, no call, no trial fallback', async () => {
  const db = store(true), seen: string[] = [], calls = { n: 0 }
  await withEnv({ ...NONE, DAZL_RUN_MAX_USD_USERS: 'A:0.001' }, async () => {
    assert.deepEqual(await read(db, provider(seen), admitted(calls)), { error: 'spend_limit' })
    assert.deepEqual([seen, calls.n, await pool(db)], [[], 0, []], 'refused: no provider call, no trial admission, nothing written')
  })
  // One unsettled call per owner (#466): a fresh pending marker from another path or instance refuses this read too.
  await withEnv({ ...NONE, DAZL_RUN_MAX_USD_USERS: 'A:5', DAZL_SPEND_BUSY_WAIT_MS: '0' }, async () => {
    const p = sharedPool(db, 'A', { day: 5 })
    await p.reserve(0.001, p.now(), 'abcdef0123')
    assert.deepEqual(await read(db, provider(seen), admitted(calls)), { error: 'spend_limit' })
    assert.deepEqual([seen, calls.n], [[], 0])
  })
})

test('trial: a keyless account reads on the trial key under the read\'s own guard and settles into the trial wallet; the owner\'s pool is never touched, even one that would refuse', async () => {
  const db = store(false), seen: string[] = [], calls = { n: 0 }, settled: (number | null)[] = []
  // An owner limit that refuses every own-key call, and an unsettled marker: neither applies to dazl's trial money.
  await withEnv({ ...NONE, DAZL_RUN_MAX_USD_USERS: 'A:0.000001', DAZL_SPEND_BUSY_WAIT_MS: '0' }, async () => {
    const p = sharedPool(db, 'A', { day: 5 })
    await p.reserve(0, p.now(), 'abcdef0123')
    const before = await poolRows(db, 'A')
    const out = await read(db, provider(seen), admitted(calls, settled))
    assert.ok('icp' in out && out.funded === 'trial', JSON.stringify(out))
    assert.deepEqual([seen, calls.n, settled], [[OP], 1, [COST]], 'one admission, one call on the operator key, settled to the reported cost in the wallet')
    assert.deepEqual(await poolRows(db, 'A'), before, 'the owner\'s pool rows are exactly as before: no reservation, no settle, no marker')
  })
})

test('the two refusals are distinct and never cross: owner pool -> spend_limit; trial ceiling or trial failure -> trial_read_failed; own-key failure -> key_rejected', async () => {
  const own = store(true), trial = store(false), seen: string[] = []
  await withEnv({ ...NONE, DAZL_RUN_MAX_USD_USERS: 'A:0.001' }, async () => {
    // Own key, pool refuses: spend_limit (and never trial_read_failed, which would blame dazl for the owner's limit).
    assert.deepEqual(await read(own, provider(seen), admitted({ n: 0 })), { error: 'spend_limit' })
    // Trial, the read's ceiling refuses an unpriced model: trial_read_failed (and never spend_limit, which would send the
    // user to their workspace limit). No call was made, so the admission is released, not settled. The owner's pool for A
    // stays empty.
    const unpriced = { settled: [] as (number | null)[], released: { n: 0 } }
    assert.deepEqual(await read(trial, provider(seen, { model: 'some-new-model' }), admitted({ n: 0 }, unpriced.settled, unpriced.released)), { error: 'trial_read_failed' })
    assert.deepEqual([unpriced.settled, unpriced.released.n], [[], 1], 'refused before any call: released, never settled')
    // Trial, the provider fails: trial_read_failed, never key_rejected (the user has no key to be rejected).
    const settled: (number | null)[] = []
    assert.deepEqual(await read(trial, provider(seen, { fail: true }), admitted({ n: 0 }, settled)), { error: 'trial_read_failed' })
    assert.deepEqual([settled, await pool(trial)], [[null], []], 'a failed trial call ends its wallet reservation at the full reserve (settle null) and writes nothing to the owner pool')
    assert.deepEqual(seen, [OP], 'the only call made was the failed trial one')
  })
  await withEnv({ ...NONE, DAZL_RUN_MAX_USD_USERS: 'A:5' }, async () => {
    // Own key, the provider fails: key_rejected, as on main; the pool's reservation stands (the vendor may have billed it).
    seen.length = 0
    assert.deepEqual(await read(own, provider(seen, { fail: true }), neverTrial), { error: 'key_rejected' })
    assert.deepEqual(seen, [KEY])
    // Only a day limit is set here: one window row, holding the failed call's worst-case reservation, nothing reported.
    const rows = await pool(own)
    assert.deepEqual(rows.map(r => [r[0], (r[1] as number) > 0, r[2], r[3]]), [['d:', true, 0, 1]], `the failed call's worst-case reservation is kept: ${JSON.stringify(rows)}`)
  })
})
