import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import { bothEngines } from './helpers/engines.ts'
import { ingest, recordConfig, signBody, type FpConfigInput } from '../lib/signals/first-party.ts'

process.env.DAZL_MASTER_KEY ??= randomBytes(32).toString('base64')
const NOW = 1_793_000_000
const CFG: FpConfigInput = { site_domain: 'seller.test', basis: 'consent', privacy_url: 'https://seller.test/privacy', retention_days: 90 }
const raw = JSON.stringify({ events: [{ id: 'e1', type: 'demo_request', occurred_at: new Date(NOW * 1000).toISOString(), page_url: 'https://seller.test/demo', consent: 'granted', person: { email: 'pat@acme.io', name: 'Pat' } }] })

// #921 issue sequence at the module level: verify under the initial secret, re-record, then ingest with the same
// headers. Before the fix ingest returned ok/created:1 under the replacement config.
bothEngines('#921 ingest re-verifies the signed headers against the config it locks: a retired secret stores nothing', async ({ db }) => {
  const old = await recordConfig(db, 'A', CFG, 'actor', NOW)
  const sig = signBody(old, NOW, raw)
  await recordConfig(db, 'A', CFG, 'actor', NOW)
  const r = await ingest(db, 'A', raw, { timestamp: String(NOW), signature: sig }, NOW)
  assert.equal(r.status, 'unauthenticated'); assert.deepEqual(r.results, [])
  assert.equal((await db.all("SELECT 1 FROM lead_enrichments WHERE tenant_id = 'A' AND connector = 'first_party'")).length, 0)
  // raw bytes and timestamp are bound too: same secret, altered body or stale timestamp is refused
  const cur = await recordConfig(db, 'A', CFG, 'actor', NOW)
  assert.equal((await ingest(db, 'A', raw.replace('Pat', 'Pam'), { timestamp: String(NOW), signature: signBody(cur, NOW, raw) }, NOW)).status, 'unauthenticated')
  assert.equal((await ingest(db, 'A', raw, { timestamp: String(NOW - 3600), signature: signBody(cur, NOW - 3600, raw) }, NOW)).status, 'unauthenticated')
  const ok = await ingest(db, 'A', raw, { timestamp: String(NOW), signature: signBody(cur, NOW, raw) }, NOW)
  assert.equal(ok.status, 'ok'); assert.deepEqual(ok.counts, { created: 1 })
})

test('#921 the real hook route under an interleaved rotation/erase/disable (SQLite + Postgres when DAZL_TEST_PG_URL is set)', () => {
  const env: NodeJS.ProcessEnv = { ...process.env, DAZL_FIRST_PARTY_ENABLED: '1' }
  delete env.NODE_TEST_CONTEXT
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--import', './test/helpers/net-fence.ts', '--loader', './test/helpers/sequence-route-loader.mjs', '--test', './test/helpers/first-party-rotation-race-runtime.mts'],
    { cwd: fileURLToPath(new URL('../', import.meta.url)), env, encoding: 'utf8', timeout: 120_000 })
  assert.equal(r.error, undefined)
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.match(r.stdout, /# fail 0/); assert.match(r.stdout, /# pass ([6-9]|1[0-2])\b/)
})
