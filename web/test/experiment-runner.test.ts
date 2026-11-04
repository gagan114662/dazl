// #399 slice 1 acceptance test (Acceptance Contract in the issue thread): config validation, pause/stop
// idempotency, no duplicate contact across arms under a real race. Staging-stub only: no network, no keys,
// no live enablement — matches the issue's own "this does not authorize production load tests or real-prospect
// outreach" line.
import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import {
  migrateExperiments, validateExperimentConfig, createExperiment, claimArmForProspect, pauseExperiment, stopExperiment,
  type ExperimentConfig,
} from '../lib/autopilot/experiment-runner.ts'

const baseCfg = (): ExperimentConfig => ({
  audience: ['acct-1', 'acct-2', 'acct-3'],
  exclusions: [],
  arms: ['offer-a', 'offer-b'],
  channels: ['email'],
  volumeCap: 100,
  spendCapCents: 500,
  senderIdentity: 'sender-1',
  timeHorizonDays: 14,
  stopConditions: ['reply_rate_anomaly'],
})

function setup() {
  const db = new Database(':memory:')
  migrateExperiments(db)
  return db
}

test('#399 config validation: refuses each missing piece by name, accepts a complete config', () => {
  assert.deepEqual(validateExperimentConfig(baseCfg()), { ok: true })
  assert.match((validateExperimentConfig({ ...baseCfg(), audience: ['acct-1'], exclusions: ['acct-1'] }) as { reason: string }).reason, /no eligible accounts/)
  assert.match((validateExperimentConfig({ ...baseCfg(), arms: ['offer-a'] }) as { reason: string }).reason, /at least 2 distinct arms/)
  assert.match((validateExperimentConfig({ ...baseCfg(), arms: ['offer-a', 'offer-a'] }) as { reason: string }).reason, /duplicate arm/)
  assert.match((validateExperimentConfig({ ...baseCfg(), channels: [] }) as { reason: string }).reason, /channel/)
  assert.match((validateExperimentConfig({ ...baseCfg(), volumeCap: 0 }) as { reason: string }).reason, /volumeCap/)
  assert.match((validateExperimentConfig({ ...baseCfg(), spendCapCents: 0 }) as { reason: string }).reason, /spendCapCents/)
  assert.match((validateExperimentConfig({ ...baseCfg(), senderIdentity: '' }) as { reason: string }).reason, /senderIdentity/)
  assert.match((validateExperimentConfig({ ...baseCfg(), timeHorizonDays: 0 }) as { reason: string }).reason, /timeHorizonDays/)
  assert.match((validateExperimentConfig({ ...baseCfg(), stopConditions: [] }) as { reason: string }).reason, /stop condition/)
  assert.match((validateExperimentConfig({ ...baseCfg(), liveEnabled: true }) as { reason: string }).reason, /not granted/)
})

test('#399 createExperiment refuses an invalid config and writes nothing', () => {
  const db = setup()
  assert.throws(() => createExperiment(db, 'exp-1', 'tenant-1', { ...baseCfg(), arms: ['only-one'] }), /refused:/)
  assert.equal((db.prepare('SELECT count(*) AS n FROM experiments').get() as { n: number }).n, 0)
})

test('#399 no duplicate contact across arms: two arms racing for the same prospect, exactly one wins', () => {
  const db = setup()
  createExperiment(db, 'exp-1', 'tenant-1', baseCfg())
  const a = claimArmForProspect(db, 'exp-1', 'acct-1', 'offer-a')
  const b = claimArmForProspect(db, 'exp-1', 'acct-1', 'offer-b') // "racing": same prospect, second call after the first committed
  assert.deepEqual(a, { claimed: true, arm: 'offer-a' })
  assert.deepEqual(b, { claimed: false, arm: 'offer-a' }) // reports the SAME arm the first call won, never a second contact
  assert.equal((db.prepare('SELECT count(*) AS n FROM experiment_arm_claims WHERE experiment_id = ? AND prospect_key = ?').get('exp-1', 'acct-1') as { n: number }).n, 1)
})

test('#399 pause then stop are each idempotent: a second call changes nothing and throws nothing', () => {
  const db = setup()
  createExperiment(db, 'exp-1', 'tenant-1', baseCfg())
  assert.deepEqual(pauseExperiment(db, 'exp-1'), { changed: true })
  assert.deepEqual(pauseExperiment(db, 'exp-1'), { changed: false }) // already paused: no-op, not an error
  assert.deepEqual(stopExperiment(db, 'exp-1'), { changed: true })
  assert.deepEqual(stopExperiment(db, 'exp-1'), { changed: false }) // already stopped: no-op
  const row = db.prepare('SELECT status, stopped_at FROM experiments WHERE id = ?').get('exp-1') as { status: string; stopped_at: number }
  assert.equal(row.status, 'stopped')
  assert.ok(row.stopped_at > 0)
})

test('#399 a paused experiment refuses new claims but keeps claims already made', () => {
  const db = setup()
  createExperiment(db, 'exp-1', 'tenant-1', baseCfg())
  assert.deepEqual(claimArmForProspect(db, 'exp-1', 'acct-1', 'offer-a'), { claimed: true, arm: 'offer-a' })
  pauseExperiment(db, 'exp-1')
  assert.deepEqual(claimArmForProspect(db, 'exp-1', 'acct-2', 'offer-a'), { refused: 'experiment is paused, not running' })
  // the claim made before pausing is untouched
  assert.equal((db.prepare('SELECT count(*) AS n FROM experiment_arm_claims WHERE experiment_id = ?').get('exp-1') as { n: number }).n, 1)
})

test('#399 a stopped experiment refuses new claims; unknown experiment id is refused, not thrown', () => {
  const db = setup()
  createExperiment(db, 'exp-1', 'tenant-1', baseCfg())
  stopExperiment(db, 'exp-1')
  assert.deepEqual(claimArmForProspect(db, 'exp-1', 'acct-1', 'offer-a'), { refused: 'experiment is stopped, not running' })
  assert.deepEqual(claimArmForProspect(db, 'no-such-experiment', 'acct-1', 'offer-a'), { refused: 'no such experiment' })
})
