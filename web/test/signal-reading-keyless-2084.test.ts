// #2084 follow-up (Ziggy, on #2084): the reading is a paid call, so who pays for it? After Ziggy's call on the PR it is the SCAN's own
// key, spend cap and ledger - one bounded call per scan, cached per wording text - and never the operator key. This test pins what a
// workspace without a key gets: no scan runs (the queue only runs keyed or trial-funded jobs), so no reading, no play, and nothing
// claimed. #1958 stays intact: saving a key is still refused.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import Database from 'better-sqlite3'
import { migrateKeys, readKeyStatus } from '../lib/llm/key-store.ts'
import { sqliteDb } from '../lib/db/client.ts'
import { businessPlays, type BrainProfile } from '../lib/business-brain.ts'
import { fillReadings, withReadings } from '../lib/scan/signal-readings.ts'
import { normalizeIcp } from '../lib/scan/icp.ts'
import { operatorKey } from '../lib/scan/trial.ts'
import { providers } from '../lib/llm/provider.ts'

const rd = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8')
const buyer = (lang: string, signals: string[]) => ({
  summary: 'Dental practices in Ohio', who: ['Practice owner'], industries: ['dentistry'], sizes: [], where: ['Ohio'], signals, exclude: [], language: lang,
})
const migrateUsers = (db: Database.Database) => db.exec('CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, buyer_profile TEXT)')

test('#2084 a fresh workspace has no stored key, so no scan runs and the German signal gets no reading and makes no play', async () => {
  const db = new Database(':memory:')
  migrateKeys(db)
  migrateUsers(db)
  assert.deepEqual(await readKeyStatus(sqliteDb(db), 'fresh'), [], 'a new workspace stores no key')

  const icp = normalizeIcp(buyer('de', ['Wir stellen SDRs ein']))!
  const kept = await withReadings(icp, null)
  assert.deepEqual(kept.signals, ['Wir stellen SDRs ein'], 'the signal is kept')
  assert.equal(kept.signal_readings, undefined, 'and nothing is read')
  assert.equal(kept.signal_unread, undefined, 'no attempt was made, so nothing is labelled')
  assert.deepEqual(businessPlays({ buyer: kept } as BrainProfile, [], {}).map(p => p.query), [], 'no play from an unread non-English signal')
})

test('#2084 the reading step makes no call of its own when the scan has no completion to lend it', async () => {
  const db = new Database(':memory:')
  migrateKeys(db)
  migrateUsers(db)
  // A provider with no complete() is the shape a run without a usable model path has; fillReadings must not reach for anything else.
  const icp = normalizeIcp(buyer('de', ['Wir stellen SDRs ein']))!
  const got = await fillReadings(db, 'fresh', icp, 'sk-ant-test', { ...providers.anthropic, complete: undefined } as unknown as typeof providers.anthropic)
  assert.equal(got, icp, 'unchanged: no key of its own, no operator key, no call')
})

test('#2084 the reading call is the scan’s: fillReadings passes the scan’s key to the scan’s provider, and nothing else', async () => {
  const db = new Database(':memory:')
  migrateKeys(db)
  migrateUsers(db)
  const seen: { key: string; prompt: string }[] = []
  const provider = { ...providers.anthropic, complete: async (key: string, prompt: string) => { seen.push({ key, prompt }); return '1. HIRING: SDRs' } } as unknown as typeof providers.anthropic
  const icp = normalizeIcp(buyer('de', ['Wir stellen SDRs ein']))!
  const got = await fillReadings(db, 'fresh', icp, 'sk-ant-scan', provider)
  assert.equal(seen.length, 1, 'one call for the scan')
  assert.equal(seen[0].key, 'sk-ant-scan', 'on the scan’s key, not the operator key')
  assert.deepEqual(got.signal_readings?.['Wir stellen SDRs ein']?.kind, 'hiring')
})

test('#2084 nothing here adds a platform-key fallback: the reading path never consults the trial operator key', () => {
  const readings = rd('../lib/scan/signal-readings.ts')
  assert.doesNotMatch(readings, /operatorKey|DAZL_TRIAL_ANTHROPIC_KEY|process\.env/, 'no platform key and no environment lookup')
  const route = rd('../app/api/settings/profile/route.ts')
  assert.doesNotMatch(route, /operatorKey|DAZL_TRIAL_ANTHROPIC_KEY|ownerGuarded/, 'and no model call at save either')
  // The operator key still exists for trial scans; this only states the reading path does not use it.
  assert.equal(operatorKey({ DAZL_TRIAL_ANTHROPIC_KEY: 'sk-ant-op' } as unknown as NodeJS.ProcessEnv)?.vendor, 'anthropic')
})

test('#2084 #1958 stays intact: saving a key is refused, so a fresh workspace cannot acquire one this way', () => {
  const keyRoute = rd('../app/api/settings/llm-key/route.ts')
  assert.match(keyRoute, /export async function PUT/)
  assert.match(keyRoute, /'Saving AI keys is no longer supported\.'/)
  assert.match(keyRoute, /status: 410/)
  const queue = rd('../lib/scan/queue-runner.ts')
  assert.match(queue, /FROM tenant_llm_keys\)\s*OR funded_by = 'trial'/)
})
