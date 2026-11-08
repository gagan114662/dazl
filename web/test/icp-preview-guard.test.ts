// The "Review profile first" preview (/api/scan/icp -> previewIcp) is a paid model call outside a scan: it runs through
// the SAME owner spend pool as the website profile read and every other non-runner call (lib/llm/owner-guard.ts, #363).
// Fail-before: previously the preview called the provider unguarded and mapped EVERY failure to key_rejected, so a
// budget stop was invisible and mislabeled. Synthetic tenant and key; the provider's HTTP call is a stub that counts
// calls, so a refused reservation provably makes no call. Nothing is billed or sent.
import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import Database from 'better-sqlite3'
import { migrateAllSqlite } from '../lib/db/sqlite-migrations.ts'
import { saveKey } from '../lib/llm/key-store.ts'
import { ProviderError, anthropicProvider, openaiProvider, type Provider } from '../lib/llm/provider.ts'
import { poolRows } from '../lib/llm/spend-pool.ts'
import { sqliteDb } from '../lib/db/client.ts'
import { previewIcp } from '../lib/scan/runner.ts'

const master = randomBytes(32)
const KA = 'sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
const GOOD = JSON.stringify({ summary: 'Seed-stage fintech founders in Europe', who: ['Founder'], where: ['Europe'], signals: ['hired first sales rep'], exclude: ['banks'] })

function setup(tenant = 'A') {
  const db = new Database(':memory:')
  migrateAllSqlite(db)
  saveKey(db, tenant, 'anthropic', KA, master)
  return db
}
const fetches: string[] = []
const answering = (text: string) => (async (u: unknown) => { fetches.push(String(u)); return new Response(JSON.stringify({ id: 'msg_1', model: 'claude-sonnet-4-5', content: [{ type: 'text', text }], usage: { input_tokens: 10, output_tokens: 10 } }), { status: 200 }) }) as unknown as typeof fetch
const realProviders = { anthropic: anthropicProvider, openai: openaiProvider }

async function withEnv<T>(vars: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const before = Object.fromEntries(Object.keys(vars).map(k => [k, process.env[k]]))
  for (const [k, v] of Object.entries(vars)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
  try { return await fn() } finally { for (const [k, v] of Object.entries(before)) { if (v === undefined) delete process.env[k]; else process.env[k] = v } }
}
const NONE = { DAZL_RUN_MAX_USD_USERS: undefined, DAZL_OWNER_MONTH_MAX_USD_USERS: undefined, DAZL_ANTHROPIC_MODEL: undefined }

test('no operator limit: the preview is unchanged and no pool row is written', async () => {
  const db = setup()
  fetches.length = 0
  await withEnv(NONE, async () => {
    const out = await previewIcp(db, 'A', 'fintech founders', { master, providers: realProviders, fetchImpl: answering(GOOD) })
    assert.ok('icp' in out && out.inferred)
    assert.equal(fetches.length, 1)
  })
  assert.deepEqual(await poolRows(sqliteDb(db), 'A'), [])
})

test('a workspace spend limit refuses the preview BEFORE any provider call and says so truthfully', async () => {
  const db = setup()
  fetches.length = 0
  await withEnv({ ...NONE, DAZL_RUN_MAX_USD_USERS: 'A:0.000001' }, async () => {
    const out = await previewIcp(db, 'A', 'fintech founders', { master, providers: realProviders, fetchImpl: answering(GOOD) })
    assert.deepEqual(out, { error: 'spend_limit' })
    assert.equal(fetches.length, 0, 'refused reservation: no provider call, nothing charged')
  })
  assert.deepEqual(await poolRows(sqliteDb(db), 'A'), [], 'a refused reservation writes nothing')
})

test('under the limit the preview reserves then settles day+month in the shared pool, and is metered by tenant', async () => {
  const db = setup()
  fetches.length = 0
  await withEnv({ ...NONE, DAZL_RUN_MAX_USD_USERS: 'A:5', DAZL_OWNER_MONTH_MAX_USD_USERS: 'A:20' }, async () => {
    const out = await previewIcp(db, 'A', 'fintech founders', { master, providers: realProviders, fetchImpl: answering(GOOD) })
    assert.ok('icp' in out && out.inferred)
    assert.equal(fetches.length, 1)
  })
  const rows = (await poolRows(sqliteDb(db), 'A')).map(r => [r.period.slice(0, 2), Math.round(r.reported_usd * 1e6) / 1e6, r.calls])
  assert.deepEqual(rows, [['d:', 0.00018, 1], ['m:', 0.00018, 1]], 'day and month each hold the settled cost; no pending marker is left')
  // The tenant metering (scan_model_calls, job_id null) records the same call, so the first paid step is not invisible.
  const metered = db.prepare("SELECT COUNT(*) AS n FROM scan_model_calls WHERE tenant_id = 'A'").get() as { n: number }
  assert.equal(metered.n, 1)
})

test('an unpriced configured model fails closed with its own name when a limit is set, and still runs when none is', async () => {
  const db = setup()
  fetches.length = 0
  await withEnv({ ...NONE, DAZL_RUN_MAX_USD_USERS: 'A:5', DAZL_ANTHROPIC_MODEL: 'claude-unlisted-model' }, async () => {
    assert.deepEqual(await previewIcp(db, 'A', 'fintech founders', { master, providers: realProviders, fetchImpl: answering(GOOD) }), { error: 'model_unpriced' })
    assert.equal(fetches.length, 0)
  })
  await withEnv({ ...NONE, DAZL_ANTHROPIC_MODEL: 'claude-unlisted-model' }, async () => {
    const out = await previewIcp(db, 'A', 'fintech founders', { master, providers: realProviders, fetchImpl: answering(GOOD) })
    assert.ok('icp' in out, 'no limit: the operator chose no cap, so the call runs')
    assert.equal(fetches.length, 1)
  })
})

test('truthful failure names: only a provider auth refusal is key_rejected; any other provider failure is provider_failed', async () => {
  const db = setup()
  const throwing = (e: unknown): Record<'anthropic' | 'openai', Provider> => {
    const p: Provider = { research: async () => { throw e }, complete: async () => { throw e } }
    return { anthropic: p, openai: p }
  }
  await withEnv(NONE, async () => {
    assert.deepEqual(await previewIcp(db, 'A', 'fintech founders', { master, providers: throwing(new ProviderError('auth', 'invalid_key', 'none')) }), { error: 'key_rejected' })
    assert.deepEqual(await previewIcp(db, 'A', 'fintech founders', { master, providers: throwing(new ProviderError('retry', 'overloaded', 'none')) }), { error: 'provider_failed' })
    assert.deepEqual(await previewIcp(db, 'A', 'fintech founders', { master, providers: throwing(new Error('net down')) }), { error: 'provider_failed' })
  })
})

test('another tenant has no pool and no key: unchanged no_api_key, and tenant isolation of the pool', async () => {
  const db = setup()
  fetches.length = 0
  await withEnv({ ...NONE, DAZL_RUN_MAX_USD_USERS: 'A:5' }, async () => {
    assert.deepEqual(await previewIcp(db, 'B', 'fintech founders', { master, providers: realProviders, fetchImpl: answering(GOOD) }), { error: 'no_api_key' })
    assert.equal(fetches.length, 0, 'no key: the trial preview path needs an ip; here the provider is never called')
  })
})
