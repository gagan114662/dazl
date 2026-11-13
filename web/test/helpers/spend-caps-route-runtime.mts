// #846/#847 operator check: GET /api/internal/spend-caps through the REAL route handler (tenant-route-loader maps the
// app's database to the in-memory store below). Operator only: no secret configured, or a wrong bearer, is a 404 with no
// data. With the secret it reports the four caps from the environment and simulates them in its own throwaway store:
// no model request (fetch is a counting trap) and no change to the app's store (its change counter does not move).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { NextRequest } from 'next/server'
import { setScanDb } from './tenant-route-db.ts'
import { migrateAllSqlite } from '../../lib/db/sqlite-migrations.ts'
import { GET } from '../../app/api/internal/spend-caps/route.ts'

test('#846 #847: the spend caps check needs the operator secret, spends nothing and writes nothing', async () => {
  const raw = new Database(':memory:'); migrateAllSqlite(raw); setScanDb(raw)
  raw.prepare("INSERT INTO tenant_spend_pools (tenant_id, period, reserved_usd, reported_usd, calls, updated_at) VALUES ('real-tenant', 'd:2026-11-13', 0.5, 0.5, 1, 1)").run()
  const changes = () => (raw.prepare('SELECT total_changes() AS n').get() as { n: number }).n
  const snapshot = () => (raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[])
    .map(t => `${t.name}:${(raw.prepare(`SELECT count(*) AS n FROM "${t.name}"`).get() as { n: number }).n}`).join(',')
  let fetches = 0
  const realFetch = globalThis.fetch
  globalThis.fetch = (async () => { fetches++; throw new Error('no network in the spend caps check') }) as typeof fetch
  const keys = ['AUTOPILOT_TICK_SECRET', 'DAZL_RUN_MAX_USD_USERS', 'DAZL_OWNER_MONTH_MAX_USD_USERS', 'DAZL_OWNER_DAY_MAX_USD', 'DAZL_OWNER_MONTH_MAX_USD', 'DAZL_SCAN_CAP_CAD', 'DAZL_SCAN_CAP_FX_CAD_PER_USD']
  const saved = Object.fromEntries(keys.map(k => [k, process.env[k]]))
  for (const k of keys) delete process.env[k]
  try {
    const call = (auth?: string, q = '') => GET(new NextRequest(`https://dazl.test/api/internal/spend-caps${q}`, { headers: auth ? { authorization: auth } : {} }))
    const before = snapshot(), c0 = changes()
    assert.equal((await call('Bearer undefined')).status, 404, 'no secret configured: the route does not exist')
    process.env.AUTOPILOT_TICK_SECRET = 's3cret'
    for (const bad of [undefined, 'Bearer wrong!', 'Bearer s3cre', 'Bearer s3crét', 's3cret']) {
      const r = await call(bad)
      assert.equal(r.status, 404, String(bad)); assert.doesNotMatch(await r.text(), /caps|usd/)
    }
    // Defaults: nothing set on this deployment.
    const ok = await call('Bearer s3cret')
    assert.equal(ok.status, 200)
    assert.match(ok.headers.get('cache-control') ?? '', /no-store/)
    const j = await ok.json() as Record<string, any>
    assert.equal(j.ok, true, JSON.stringify(j.problems))
    assert.deepEqual([j.model_calls, j.app_store_opened], [0, false])
    assert.deepEqual([j.caps.scan.usd, j.caps.scan.source, j.caps.scan.simulation.next], [3.333333, 'default', 'refused:over_cap'])
    assert.deepEqual([j.caps.day.usd, j.caps.day.source, j.caps.day.simulation.admitted_usd, j.caps.day.simulation.next], [10, 'default', 10, 'refused:owner_pool_limit'])
    assert.deepEqual([j.caps.month.usd, j.caps.month.source, j.caps.month.simulation.admitted_usd, j.caps.month.simulation.next], [100, 'default', 100, 'refused:owner_pool_limit'])
    assert.deepEqual([j.caps.account.path, j.caps.account.simulation.next_same_account, j.caps.account.simulation.other_account], ['transport', 'refused:owner_pool_limit', 'admitted'])
    assert.doesNotMatch(JSON.stringify(j), /real-tenant/, "never another account's data")
    // Settings: a deployment day cap, a 0 month (ignored: the default applies and it is reported), a named account.
    process.env.DAZL_OWNER_DAY_MAX_USD = '7.5'; process.env.DAZL_OWNER_MONTH_MAX_USD = '0'; process.env.DAZL_RUN_MAX_USD_USERS = 'acct_1:0.12'
    const set = await (await call('Bearer s3cret', '?tenant=acct_1')).json() as Record<string, any>
    assert.equal(set.ok, false, 'a malformed setting is reported')
    assert.deepEqual(set.problems, ['DAZL_OWNER_MONTH_MAX_USD is not a positive number: ignored, the next source applies'])
    assert.deepEqual([set.caps.day.usd, set.caps.day.source, set.caps.day.simulation.next], [7.5, 'env', 'refused:owner_pool_limit'])
    assert.deepEqual([set.caps.month.usd, set.caps.month.source, set.caps.month.ignored], [100, 'default', ['DAZL_OWNER_MONTH_MAX_USD']])
    assert.deepEqual([set.caps.account.tenant, set.caps.account.path, set.caps.account.day.usd, set.caps.account.day.source, set.caps.account.simulation.filled_usd, set.caps.account.simulation.next_same_account],
      ['acct_1', 'pooled_guard', 0.12, 'account', 0.12, 'refused:owner_pool_limit'])
    assert.equal((await call('Bearer s3cret', "?tenant=x' OR 1=1")).status, 400, 'a malformed account id is refused')
    // A malformed scan cap: every paid scan call refused, reported.
    process.env.DAZL_SCAN_CAP_CAD = '0'
    const bad = await (await call('Bearer s3cret')).json() as Record<string, any>
    assert.deepEqual([bad.caps.scan.source, bad.caps.scan.simulation.next, bad.ok], ['invalid', 'refused:cap_config_invalid', false])
    // Zero spend and zero writes.
    assert.equal(fetches, 0, 'no model or network request')
    assert.equal(changes(), c0, 'the app store saw no write')
    assert.equal(snapshot(), before, 'every table of the app store is as it was')
  } finally {
    globalThis.fetch = realFetch
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
  }
  console.log('SPEND CAPS ROUTE ok')
})
