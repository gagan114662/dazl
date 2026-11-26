// #2084 follow-up (Ziggy, on #2084): the signal reader is built from the tenant's own stored key, and #1958 retired key saving
// (PUT /api/settings/llm-key answers 410). So what does an ordinary new workspace with no stored key actually get? This test answers
// that with the real key store and the real reading gate, and pins the answer until the owner decides otherwise. It does not
// change the product: no platform-key fallback is added here.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import Database from 'better-sqlite3'
import { migrateKeys, readKeyStatus, saveKey } from '../lib/llm/key-store.ts'
import { sqliteDb } from '../lib/db/client.ts'
import { businessPlays, type BrainProfile } from '../lib/business-brain.ts'
import { withReadings } from '../lib/scan/signal-readings.ts'
import { normalizeIcp } from '../lib/scan/icp.ts'
import { operatorKey } from '../lib/scan/trial.ts'

const rd = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8')

// The route's reader (app/api/settings/profile/route.ts) returns null unless the workspace has a stored key: the same two reads,
// in the same order, so this mirrors the real gate instead of restating it.
async function readerFor(db: Database.Database, tenantId: string) {
  const rows = await readKeyStatus(sqliteDb(db), tenantId)
  const vendor = rows[0]?.vendor ?? null
  return vendor ? { vendor } : null
}

const buyer = (lang: string, signals: string[]) => ({
  summary: 'Dental practices in Ohio', who: ['Practice owner'], industries: ['dentistry'], sizes: [], where: ['Ohio'], signals, exclude: [], language: lang,
})

test('#2084 a fresh workspace has no stored key, so the route builds no reader: the German signal gets no reading and makes no play', async () => {
  const db = new Database(':memory:')
  migrateKeys(db)
  assert.deepEqual(await readKeyStatus(sqliteDb(db), 'fresh'), [], 'a new workspace stores no key')
  assert.equal(await readerFor(db, 'fresh'), null, 'no key row means no reader, which is the route’s first guard')

  const icp = normalizeIcp(buyer('de', ['Wir stellen SDRs ein']))!
  // No reader: the save keeps the signal and stores no reading (lib/scan/signal-readings.ts withReadings).
  const kept = await withReadings(icp, null)
  assert.deepEqual(kept.signals, ['Wir stellen SDRs ein'], 'the signal is kept')
  assert.equal(kept.signal_readings, undefined, 'and nothing is read')

  // A signal with no reading makes no play: it is never read on English rules instead.
  assert.deepEqual(businessPlays({ buyer: kept } as BrainProfile, [], {}).map(p => p.query), [], 'no play from an unread non-English signal')
})

test('#2084 the control: a workspace that does hold a key reaches the reader, so the gate is the key and not the language', async () => {
  const db = new Database(':memory:')
  migrateKeys(db)
  saveKey(db, 'has-key', 'anthropic', 'sk-ant-test-0123456789', Buffer.alloc(32, 7))
  assert.equal((await readerFor(db, 'has-key'))?.vendor, 'anthropic')
  assert.equal(await readerFor(db, 'fresh'), null)
})

test('#2084 nothing here adds a platform-key fallback: the reader never consults the trial operator key', () => {
  const route = rd('../app/api/settings/profile/route.ts')
  assert.match(route, /readKeyStatus\(db, tenantId\)/, 'the reader reads the tenant’s own key status')
  assert.match(route, /fetchKey\(db, tenantId, vendor\)/, 'and the tenant’s own key')
  assert.doesNotMatch(route, /operatorKey|DAZL_TRIAL_ANTHROPIC_KEY/, 'no implicit platform key in the profile route')
  // The operator key exists and is the trial scans’ key; this test only states that the profile reader does not use it.
  assert.equal(operatorKey({ DAZL_TRIAL_ANTHROPIC_KEY: 'sk-ant-op' } as unknown as NodeJS.ProcessEnv)?.vendor, 'anthropic')
})

test('#2084 #1958 stays intact: saving a key is refused, so a fresh workspace cannot acquire one this way', () => {
  const keyRoute = rd('../app/api/settings/llm-key/route.ts')
  assert.match(keyRoute, /export async function PUT/)
  assert.match(keyRoute, /'Saving AI keys is no longer supported\.'/)
  assert.match(keyRoute, /status: 410/)
  // Nothing in this change re-opens saving, and the queue runner still only runs keyed or trial-funded jobs.
  const queue = rd('../lib/scan/queue-runner.ts')
  assert.match(queue, /FROM tenant_llm_keys\)\s*OR funded_by = 'trial'/)
})
