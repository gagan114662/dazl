// #399 slice 1 acceptance tests (Acceptance Contract in the issue thread): config validation, pause/stop idempotency,
// no duplicate contact across arms. Staging stub only: no network, no keys, no provider, no send, no live enablement.
// Store tests run on both engines (test/helpers/engines.ts): [sqlite] in-memory, [pg] a fresh migrated schema in CI.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import type { Db } from '../lib/db/client.ts'
import {
  validateExperimentConfig, createExperiment, startExperiment, claimArmForProspect, pauseExperiment, stopExperiment,
  EXPERIMENT_FIELD_ENFORCEMENT, MAX_AUDIENCE, MAX_ID_LEN, type ExperimentConfig,
} from '../lib/autopilot/experiment-runner.ts'
import { bothEngines } from './helpers/engines.ts'

const A = 'tenant-a'
const B = 'tenant-b'
const T0 = 1_800_000_000_000
const DAY = 86_400_000

const baseCfg = (): ExperimentConfig => ({
  audience: ['acct-1', 'acct-2', 'acct-3', 'acct-4'],
  exclusions: ['acct-4'],
  arms: ['offer-a', 'offer-b'],
  channels: ['email'],
  volumeCap: 100,
  spendCapCents: 500,
  senderIdentity: 'sender-1',
  timeHorizonDays: 14,
  stopConditions: ['reply_rate_anomaly'],
})
const reason = (v: unknown) => (v as { reason: string }).reason
const without = (k: keyof ExperimentConfig) => Object.fromEntries(Object.entries(baseCfg()).filter(([key]) => key !== k))

async function running(db: Db, tenant = A, id = 'exp-1', cfg: ExperimentConfig = baseCfg()) {
  assert.deepEqual(await createExperiment(db, tenant, id, cfg, { now: T0 }), { ok: true, created: true })
  assert.deepEqual(await startExperiment(db, tenant, id, { now: T0 }), { changed: true })
}
const n = async (db: Db, sql: string, p: (string | number)[] = []) => Number((await db.get<{ n: number }>(sql, p))!.n)
const claims = (db: Db, tenant: string, exp = 'exp-1') => db.all<{ prospect_key: string; arm: string }>('SELECT prospect_key, arm FROM experiment_arm_claims WHERE tenant_id = ? AND experiment_id = ? ORDER BY prospect_key', [tenant, exp])
type Ev = { action: string; outcome: string; reason: string | null; prospect_key: string | null; arm: string | null; experiment_id: string }
const events = (db: Db, tenant: string) => db.all<Ev>('SELECT action, outcome, reason, prospect_key, arm, experiment_id FROM experiment_events WHERE tenant_id = ? ORDER BY created_at, action, outcome, reason', [tenant])
const lastEvent = async (db: Db, tenant: string, action: string) => (await events(db, tenant)).filter(e => e.action === action).at(-1)

// ---- validation (pure) ----

test('#399 config validation: refuses each missing piece by name, accepts a complete config', () => {
  assert.deepEqual(validateExperimentConfig(baseCfg()), { ok: true })
  assert.deepEqual(validateExperimentConfig({ ...baseCfg(), liveEnabled: false }), { ok: true })
  assert.match(reason(validateExperimentConfig({ ...baseCfg(), audience: ['acct-1'], exclusions: ['acct-1'] })), /no eligible accounts/)
  assert.match(reason(validateExperimentConfig({ ...baseCfg(), arms: ['offer-a'] })), /at least 2 distinct arms/)
  assert.match(reason(validateExperimentConfig({ ...baseCfg(), arms: ['offer-a', 'offer-a'] })), /duplicate arm/)
  assert.match(reason(validateExperimentConfig({ ...baseCfg(), channels: [] })), /channel/)
  assert.match(reason(validateExperimentConfig({ ...baseCfg(), volumeCap: 0 })), /volumeCap/)
  assert.match(reason(validateExperimentConfig({ ...baseCfg(), spendCapCents: 0 })), /spendCapCents/)
  assert.match(reason(validateExperimentConfig({ ...baseCfg(), senderIdentity: '' })), /senderIdentity/)
  assert.match(reason(validateExperimentConfig({ ...baseCfg(), timeHorizonDays: 0 })), /timeHorizonDays/)
  assert.match(reason(validateExperimentConfig({ ...baseCfg(), stopConditions: [] })), /stop condition/)
  assert.match(reason(validateExperimentConfig({ ...baseCfg(), liveEnabled: true })), /not granted/)
})

test('#399 config validation fails closed on malformed input: wrong types, null, missing or extra keys, huge, non-UTF-16, nesting', () => {
  const bad: [string, unknown, RegExp][] = [
    ['null', null, /object/], ['array', [baseCfg()], /object/], ['string', JSON.stringify(baseCfg()), /object/], ['number', 1, /object/], ['undefined', undefined, /object/],
    ['extra key', { ...baseCfg(), launchNow: true }, /unknown config key/], ['__proto__-ish key', { ...baseCfg(), constructor: 1 }, /unknown config key/],
    ['audience as string', { ...baseCfg(), audience: 'acct-1' }, /audience/], ['audience with a number', { ...baseCfg(), audience: ['acct-1', 2] }, /audience/],
    ['audience with null', { ...baseCfg(), audience: [null] }, /audience/], ['nested audience', { ...baseCfg(), audience: [['acct-1']] }, /audience/],
    ['huge audience', { ...baseCfg(), audience: Array.from({ length: MAX_AUDIENCE + 1 }, (_, i) => `a${i}`) }, /audience/],
    ['exclusions as dict', { ...baseCfg(), exclusions: { 'acct-1': true } }, /exclusions/],
    ['arms as dict', { ...baseCfg(), arms: { a: 1, b: 2 } }, /arms/], ['arm with blank name', { ...baseCfg(), arms: ['offer-a', '  '] }, /arms/],
    ['arm name too long', { ...baseCfg(), arms: ['offer-a', 'x'.repeat(MAX_ID_LEN + 1)] }, /arms/],
    ['arm with lone surrogate', { ...baseCfg(), arms: ['offer-a', 'bad\uD800'] }, /arms/], ['arm with control char', { ...baseCfg(), arms: ['offer-a', 'b\u0000'] }, /arms/],
    ['channels missing', without('channels'), /channel/], ['audience missing', without('audience'), /audience/], ['arms missing', without('arms'), /arms/],
    ['volumeCap as string', { ...baseCfg(), volumeCap: '100' }, /volumeCap/], ['volumeCap NaN', { ...baseCfg(), volumeCap: NaN }, /volumeCap/],
    ['volumeCap Infinity', { ...baseCfg(), volumeCap: Infinity }, /volumeCap/], ['volumeCap fraction', { ...baseCfg(), volumeCap: 1.5 }, /volumeCap/],
    ['volumeCap negative', { ...baseCfg(), volumeCap: -1 }, /volumeCap/], ['volumeCap huge', { ...baseCfg(), volumeCap: 1e12 }, /volumeCap/], ['volumeCap bool', { ...baseCfg(), volumeCap: true }, /volumeCap/],
    ['spendCapCents missing', without('spendCapCents'), /spendCapCents/], ['spendCapCents as string', { ...baseCfg(), spendCapCents: '500' }, /spendCapCents/],
    ['senderIdentity as number', { ...baseCfg(), senderIdentity: 7 }, /senderIdentity/], ['senderIdentity null', { ...baseCfg(), senderIdentity: null }, /senderIdentity/],
    ['timeHorizonDays as string', { ...baseCfg(), timeHorizonDays: '14' }, /timeHorizonDays/], ['timeHorizonDays huge', { ...baseCfg(), timeHorizonDays: 100000 }, /timeHorizonDays/],
    ['stopConditions as string', { ...baseCfg(), stopConditions: 'reply_rate_anomaly' }, /stop condition/],
    ['liveEnabled null', { ...baseCfg(), liveEnabled: null }, /not granted/], ['liveEnabled "false"', { ...baseCfg(), liveEnabled: 'false' }, /not granted/], ['liveEnabled 1', { ...baseCfg(), liveEnabled: 1 }, /not granted/],
  ]
  for (const [name, cfg, re] of bad) {
    const v = validateExperimentConfig(cfg)
    assert.equal(v.ok, false, name)
    assert.match(reason(v), re, name)
  }
})

test('#399 every config field is declared enforced on claim, validated only, or refused if set', () => {
  assert.deepEqual(Object.keys(EXPERIMENT_FIELD_ENFORCEMENT).sort(), Object.keys({ ...baseCfg(), liveEnabled: false }).sort())
  assert.deepEqual(Object.entries(EXPERIMENT_FIELD_ENFORCEMENT).filter(([, v]) => v === 'validated_only').map(([k]) => k).sort(), ['channels', 'senderIdentity', 'spendCapCents', 'stopConditions'])
})

test('#399 the runner makes no provider call, send or spend: it imports only the Db layer and node:crypto', () => {
  const src = readFileSync(new URL('../lib/autopilot/experiment-runner.ts', import.meta.url), 'utf8')
  const imports = [...src.matchAll(/^import\b[^\n]*from\s+'([^']+)'/gm)].map(m => m[1]).sort()
  assert.deepEqual(imports, ['../db/client.ts', 'better-sqlite3', 'node:crypto'])
  assert.doesNotMatch(src, /\bfetch\(|getAuthDb|getScanDb|\.prepare\(/)
  assert.doesNotMatch(src, /catch\s*\{/, 'no bare catch in the runner')
})

// ---- store, both engines ----

bothEngines('#399 createExperiment: an invalid config is refused, recorded, and writes no experiment', async ({ db }) => {
  assert.deepEqual(await createExperiment(db, A, 'exp-1', { ...baseCfg(), arms: ['only-one'] }), { ok: false, reason: 'at least 2 distinct arms are required' })
  assert.equal(await n(db, 'SELECT count(*) AS n FROM experiments'), 0)
  assert.deepEqual(await lastEvent(db, A, 'create'), { action: 'create', outcome: 'refused', reason: 'at least 2 distinct arms are required', prospect_key: null, arm: null, experiment_id: 'exp-1' })
  for (const badId of [null, 7, {}, ['exp'], '', 'x'.repeat(MAX_ID_LEN + 1), 'e\uDC00']) {
    assert.deepEqual(await createExperiment(db, A, badId, baseCfg()), { ok: false, reason: 'invalid experiment id' })
  }
  assert.equal(await n(db, "SELECT count(*) AS n FROM experiment_events WHERE tenant_id = ? AND experiment_id = '' AND reason = 'invalid experiment id'", [A]), 7)
  for (const badTenant of [null, undefined, 3, { id: A }, '', ' ']) {
    assert.deepEqual(await createExperiment(db, badTenant, 'exp-2', baseCfg()), { ok: false, reason: 'invalid tenant id' })
  }
  assert.equal(await n(db, 'SELECT count(*) AS n FROM experiments'), 0)
  assert.equal(await n(db, "SELECT count(*) AS n FROM experiment_events WHERE experiment_id = 'exp-2'"), 0, 'no tenant to record a malformed tenant id under')
})

bothEngines('#399 createExperiment starts in draft: a draft refuses claims until an explicit start; start is idempotent', async ({ db }) => {
  assert.deepEqual(await createExperiment(db, A, 'exp-1', baseCfg(), { now: T0 }), { ok: true, created: true })
  assert.equal((await db.get<{ status: string }>('SELECT status FROM experiments WHERE tenant_id = ? AND id = ?', [A, 'exp-1']))!.status, 'draft')
  assert.deepEqual(await claimArmForProspect(db, A, 'exp-1', 'acct-1', 'offer-a', { now: T0 }), { refused: 'experiment is draft, not running' })
  assert.deepEqual(await startExperiment(db, A, 'exp-1', { now: T0 }), { changed: true })
  assert.deepEqual(await startExperiment(db, A, 'exp-1', { now: T0 + 1 }), { changed: false })
  assert.deepEqual(await claimArmForProspect(db, A, 'exp-1', 'acct-1', 'offer-a', { now: T0 + 2 }), { claimed: true, arm: 'offer-a' })
  // ordered by time, then action: at T0 create, start and the refused claim; then the no-op start, then the claim
  assert.deepEqual((await events(db, A)).map(e => `${e.action}:${e.outcome}`), ['claim:refused', 'create:ok', 'start:ok', 'start:noop', 'claim:ok'])
  assert.equal(await n(db, "SELECT count(*) AS n FROM experiment_events WHERE tenant_id = ? AND action = 'start' AND outcome = 'noop' AND reason = 'already running'", [A]), 1)
})

bothEngines('#399 createExperiment replay: the same config (keys reordered) is a recorded no-op; a different config under the same id is refused', async ({ db }) => {
  await createExperiment(db, A, 'exp-1', baseCfg(), { now: T0 })
  const reordered = Object.fromEntries(Object.entries(baseCfg()).reverse())
  assert.deepEqual(await createExperiment(db, A, 'exp-1', reordered, { now: T0 + 1 }), { ok: true, created: false })
  assert.deepEqual(await createExperiment(db, A, 'exp-1', { ...baseCfg(), volumeCap: 5 }, { now: T0 + 2 }), { ok: false, reason: 'id in use with a different config' })
  assert.equal(await n(db, 'SELECT count(*) AS n FROM experiments'), 1)
  assert.equal((await db.get<{ volume_cap: number }>('SELECT volume_cap FROM experiments WHERE tenant_id = ? AND id = ?', [A, 'exp-1']))!.volume_cap, 100)
  assert.deepEqual((await events(db, A)).map(e => `${e.outcome}:${e.reason ?? ''}`), ['ok:', 'noop:replay', 'refused:id in use with a different config'])
})

bothEngines("#399 tenants: another tenant's experiment id is absent to the caller for claim, start, pause and stop; the same id per tenant is independent", async ({ db }) => {
  await running(db, A)
  for (const call of [
    () => claimArmForProspect(db, B, 'exp-1', 'acct-1', 'offer-a', { now: T0 }),
    () => startExperiment(db, B, 'exp-1'), () => pauseExperiment(db, B, 'exp-1'), () => stopExperiment(db, B, 'exp-1'),
  ]) assert.deepEqual(await call(), { refused: 'no such experiment' })
  const a = (await db.get<{ status: string; claim_attempts: number }>('SELECT status, claim_attempts FROM experiments WHERE tenant_id = ? AND id = ?', [A, 'exp-1']))!
  assert.deepEqual([a.status, Number(a.claim_attempts)], ['running', 0], "tenant A's row is untouched")
  assert.deepEqual((await events(db, B)).map(e => `${e.action}:${e.outcome}:${e.reason}`).sort(), ['claim:refused:no such experiment', 'pause:refused:no such experiment', 'start:refused:no such experiment', 'stop:refused:no such experiment'])
  // B makes its own exp-1: independent rows, independent claims
  await running(db, B)
  assert.deepEqual(await claimArmForProspect(db, B, 'exp-1', 'acct-1', 'offer-b', { now: T0 }), { claimed: true, arm: 'offer-b' })
  assert.deepEqual(await claimArmForProspect(db, A, 'exp-1', 'acct-1', 'offer-a', { now: T0 }), { claimed: true, arm: 'offer-a' })
  assert.deepEqual(await claims(db, A), [{ prospect_key: 'acct-1', arm: 'offer-a' }])
  assert.deepEqual(await claims(db, B), [{ prospect_key: 'acct-1', arm: 'offer-b' }])
})

bothEngines('#399 claims enforce the config: unknown arm, prospect outside the audience and excluded prospect are refused and recorded', async ({ db }) => {
  await running(db)
  assert.deepEqual(await claimArmForProspect(db, A, 'exp-1', 'acct-1', 'not-an-arm', { now: T0 }), { refused: 'unknown arm' })
  assert.deepEqual(await claimArmForProspect(db, A, 'exp-1', 'acct-999', 'offer-a', { now: T0 }), { refused: 'prospect is not in the audience' })
  assert.deepEqual(await claimArmForProspect(db, A, 'exp-1', 'acct-4', 'offer-a', { now: T0 }), { refused: 'prospect is excluded' })
  assert.deepEqual(await claims(db, A), [])
  assert.deepEqual((await events(db, A)).filter(e => e.action === 'claim').map(e => [e.reason, e.prospect_key, e.arm]).sort(), [
    ['prospect is excluded', 'acct-4', 'offer-a'], ['prospect is not in the audience', 'acct-999', 'offer-a'], ['unknown arm', 'acct-1', 'not-an-arm']])
})

bothEngines('#399 volumeCap is enforced: claims past the cap are refused; a replay at the cap still reports its arm', async ({ db }) => {
  await running(db, A, 'exp-1', { ...baseCfg(), volumeCap: 2 })
  assert.deepEqual(await claimArmForProspect(db, A, 'exp-1', 'acct-1', 'offer-a', { now: T0 }), { claimed: true, arm: 'offer-a' })
  assert.deepEqual(await claimArmForProspect(db, A, 'exp-1', 'acct-2', 'offer-b', { now: T0 }), { claimed: true, arm: 'offer-b' })
  assert.deepEqual(await claimArmForProspect(db, A, 'exp-1', 'acct-3', 'offer-a', { now: T0 }), { refused: 'volume cap reached' })
  assert.deepEqual(await claimArmForProspect(db, A, 'exp-1', 'acct-1', 'offer-b', { now: T0 }), { claimed: false, arm: 'offer-a' })
  assert.equal((await claims(db, A)).length, 2)
  assert.equal(await n(db, 'SELECT claimed_count AS n FROM experiments WHERE tenant_id = ? AND id = ?', [A, 'exp-1']), 2)
  assert.equal(await n(db, "SELECT count(*) AS n FROM experiment_events WHERE tenant_id = ? AND outcome = 'already_claimed'", [A]), 1)
})

bothEngines('#399 timeHorizonDays is enforced: no claim after start + horizon', async ({ db }) => {
  await running(db, A, 'exp-1', { ...baseCfg(), timeHorizonDays: 1 })
  assert.deepEqual(await claimArmForProspect(db, A, 'exp-1', 'acct-1', 'offer-a', { now: T0 + DAY }), { claimed: true, arm: 'offer-a' })
  assert.deepEqual(await claimArmForProspect(db, A, 'exp-1', 'acct-2', 'offer-a', { now: T0 + DAY + 1 }), { refused: 'time horizon has passed' })
})

bothEngines('#399 validated-only fields do not gate claims (no spend, send, channel or measurement exists in this slice)', async ({ db }) => {
  await running(db, A, 'exp-1', { ...baseCfg(), spendCapCents: 1, channels: ['linkedin'], senderIdentity: 'nobody', stopConditions: ['complaint_threshold'] })
  assert.deepEqual(await claimArmForProspect(db, A, 'exp-1', 'acct-1', 'offer-a', { now: T0 }), { claimed: true, arm: 'offer-a' })
})

bothEngines('#399 no duplicate contact across arms: a second arm (and a replay of the first) for the same prospect gets the winner, never a second claim', async ({ db }) => {
  await running(db)
  assert.deepEqual(await claimArmForProspect(db, A, 'exp-1', 'acct-1', 'offer-a', { now: T0 }), { claimed: true, arm: 'offer-a' })
  assert.deepEqual(await claimArmForProspect(db, A, 'exp-1', 'acct-1', 'offer-b', { now: T0 }), { claimed: false, arm: 'offer-a' })
  assert.deepEqual(await claimArmForProspect(db, A, 'exp-1', 'acct-1', 'offer-a', { now: T0 }), { claimed: false, arm: 'offer-a' })
  assert.deepEqual(await claims(db, A), [{ prospect_key: 'acct-1', arm: 'offer-a' }])
  assert.equal(await n(db, 'SELECT claimed_count AS n FROM experiments WHERE tenant_id = ? AND id = ?', [A, 'exp-1']), 1)
  assert.equal(await n(db, "SELECT count(*) AS n FROM experiment_events WHERE tenant_id = ? AND outcome = 'already_claimed'", [A]), 2)
})

// [pg]: the pool hands these out over up to 8 separate connections, so the claims really overlap in Postgres.
// [sqlite]: one connection; the calls are interleaved promises serialized by the IMMEDIATE transaction.
bothEngines('#399 concurrent claims: many arms racing for the same prospects, under a volume cap, yield exactly one claim per prospect and never pass the cap', async ({ db }) => {
  const audience = Array.from({ length: 12 }, (_, i) => `p${i}`)
  await running(db, A, 'exp-1', { ...baseCfg(), audience, exclusions: [], arms: ['a1', 'a2', 'a3'], volumeCap: 8 })
  const calls = audience.flatMap(p => ['a1', 'a2', 'a3'].map(arm => () => claimArmForProspect(db, A, 'exp-1', p, arm, { now: T0 })))
  const results = await Promise.all(calls.map(c => c()))
  const won = results.filter(r => 'claimed' in r && r.claimed)
  assert.equal(won.length, 8, 'exactly volumeCap prospects were claimed')
  const rows = await claims(db, A)
  assert.equal(rows.length, 8)
  assert.equal(new Set(rows.map(r => r.prospect_key)).size, 8, 'one row per prospect')
  for (const r of results.filter(r => 'claimed' in r && !r.claimed) as { arm: string }[]) assert.ok(rows.some(w => w.arm === r.arm))
  assert.equal(results.filter(r => 'refused' in r).length + results.filter(r => 'claimed' in r).length, 36)
  assert.ok(results.filter(r => 'refused' in r).every(r => (r as { refused: string }).refused === 'volume cap reached'))
  assert.equal(await n(db, 'SELECT claimed_count AS n FROM experiments WHERE tenant_id = ? AND id = ?', [A, 'exp-1']), 8)
  assert.equal(await n(db, 'SELECT claim_attempts AS n FROM experiments WHERE tenant_id = ? AND id = ?', [A, 'exp-1']), 36)
  assert.equal(await n(db, "SELECT count(*) AS n FROM experiment_events WHERE tenant_id = ? AND action = 'claim'", [A]), 36, 'every attempt is recorded')
}, { pgMax: 8 })

bothEngines('#399 pause then stop are each idempotent and recorded; claims made before stay; paused and stopped refuse new claims', async ({ db }) => {
  await running(db)
  assert.deepEqual(await claimArmForProspect(db, A, 'exp-1', 'acct-1', 'offer-a', { now: T0 }), { claimed: true, arm: 'offer-a' })
  assert.deepEqual(await pauseExperiment(db, A, 'exp-1'), { changed: true })
  assert.deepEqual(await pauseExperiment(db, A, 'exp-1'), { changed: false })
  assert.deepEqual(await claimArmForProspect(db, A, 'exp-1', 'acct-2', 'offer-a', { now: T0 }), { refused: 'experiment is paused, not running' })
  assert.deepEqual(await startExperiment(db, A, 'exp-1'), { changed: false }, 'no resume in this slice')
  assert.deepEqual(await stopExperiment(db, A, 'exp-1'), { changed: true })
  assert.deepEqual(await stopExperiment(db, A, 'exp-1'), { changed: false })
  assert.deepEqual(await pauseExperiment(db, A, 'exp-1'), { changed: false })
  assert.deepEqual(await claimArmForProspect(db, A, 'exp-1', 'acct-2', 'offer-a', { now: T0 }), { refused: 'experiment is stopped, not running' })
  assert.deepEqual(await claims(db, A), [{ prospect_key: 'acct-1', arm: 'offer-a' }])
  const row = (await db.get<{ status: string; stopped_at: number; paused_at: number }>('SELECT status, stopped_at, paused_at FROM experiments WHERE tenant_id = ? AND id = ?', [A, 'exp-1']))!
  assert.equal(row.status, 'stopped')
  assert.ok(Number(row.stopped_at) > 0 && Number(row.paused_at) > 0)
  assert.equal(await n(db, "SELECT count(*) AS n FROM experiment_events WHERE tenant_id = ? AND outcome = 'noop'", [A]), 4)
  // stop also closes a draft; unknown ids are refused, not thrown
  await createExperiment(db, A, 'exp-2', baseCfg())
  assert.deepEqual(await stopExperiment(db, A, 'exp-2'), { changed: true })
  assert.deepEqual(await claimArmForProspect(db, A, 'no-such-experiment', 'acct-1', 'offer-a'), { refused: 'no such experiment' })
})

bothEngines('#399 claim inputs fail closed and are recorded: wrong types, null, huge, non-UTF-16 ids; a malformed tenant id writes nothing', async ({ db }) => {
  await running(db)
  const bad: unknown[] = [null, undefined, 1, true, {}, ['acct-1'], '', ' ', 'x'.repeat(MAX_ID_LEN + 1), 'a\uD800']
  for (const v of bad) {
    assert.deepEqual(await claimArmForProspect(db, A, v, 'acct-1', 'offer-a'), { refused: 'invalid experiment id' })
    assert.deepEqual(await claimArmForProspect(db, A, 'exp-1', v, 'offer-a'), { refused: 'invalid prospect key' })
    assert.deepEqual(await claimArmForProspect(db, A, 'exp-1', 'acct-1', v), { refused: 'invalid arm' })
    assert.deepEqual(await claimArmForProspect(db, v, 'exp-1', 'acct-1', 'offer-a'), { refused: 'invalid tenant id' })
    for (const f of [startExperiment, pauseExperiment, stopExperiment]) {
      assert.deepEqual(await f(db, A, v), { refused: 'invalid experiment id' })
      assert.deepEqual(await f(db, v, 'exp-1'), { refused: 'invalid tenant id' })
    }
  }
  assert.deepEqual(await claims(db, A), [])
  const ev = await events(db, A)
  assert.equal(ev.filter(e => e.action === 'claim' && e.outcome === 'refused').length, bad.length * 3)
  assert.equal(ev.filter(e => e.action !== 'claim' && e.reason === 'invalid experiment id').length, bad.length * 3)
  // malformed values are stored as NULL / '', never raw
  assert.ok(ev.filter(e => e.reason === 'invalid prospect key').every(e => e.prospect_key === null))
  assert.ok(ev.filter(e => e.reason === 'invalid experiment id').every(e => e.experiment_id === ''))
  assert.equal(await n(db, 'SELECT count(*) AS n FROM experiment_events WHERE tenant_id <> ?', [A]), 0)
  assert.equal((await db.get<{ status: string }>('SELECT status FROM experiments WHERE tenant_id = ? AND id = ?', [A, 'exp-1']))!.status, 'running')
})

bothEngines('#399 a corrupt stored config refuses claims (recorded), never guesses', async ({ db }) => {
  await running(db)
  for (const json of ['{not json', 'null', '{"arms":["only"]}']) {
    await db.run('UPDATE experiments SET config_json = ? WHERE tenant_id = ? AND id = ?', [json, A, 'exp-1'])
    assert.deepEqual(await claimArmForProspect(db, A, 'exp-1', 'acct-1', 'offer-a', { now: T0 }), { refused: 'stored config is unreadable' })
  }
  assert.deepEqual(await claims(db, A), [])
})

// Instinct #642 defect 1: the old claim swallowed every insert error in a bare catch and read `.arm` off a row that
// may not exist (TypeError), so a store failure looked like "already claimed". Now only the key conflict is absorbed.
bothEngines('#399 a non-constraint store failure on claim propagates (rolled back, nothing claimed or recorded as ok), never reported as already claimed', async ({ db, kind }) => {
  await running(db)
  if (kind === 'sqlite') await db.run("CREATE TRIGGER exp_fail BEFORE INSERT ON experiment_arm_claims BEGIN SELECT RAISE(ABORT, 'injected store failure'); END")
  else {
    await db.run("CREATE FUNCTION exp_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected store failure'; END $$")
    await db.run('CREATE TRIGGER exp_fail BEFORE INSERT ON experiment_arm_claims FOR EACH ROW EXECUTE FUNCTION exp_fail()')
  }
  await assert.rejects(claimArmForProspect(db, A, 'exp-1', 'acct-1', 'offer-a', { now: T0 }), (e: Error) => !(e instanceof TypeError) && /injected store failure/.test(e.message))
  assert.deepEqual(await claims(db, A), [])
  const row = (await db.get<{ claimed_count: number; claim_attempts: number }>('SELECT claimed_count, claim_attempts FROM experiments WHERE tenant_id = ? AND id = ?', [A, 'exp-1']))!
  assert.deepEqual([Number(row.claimed_count), Number(row.claim_attempts)], [0, 0], 'the whole claim transaction rolled back')
  assert.equal(await n(db, "SELECT count(*) AS n FROM experiment_events WHERE action = 'claim'"), 0)
  // a missing table is a store failure too, not "already claimed"
  await db.run('DROP TABLE experiment_arm_claims')
  await assert.rejects(claimArmForProspect(db, A, 'exp-1', 'acct-1', 'offer-a', { now: T0 }), (e: Error) => !(e instanceof TypeError) && /experiment_arm_claims/.test(e.message))
})

// The old code's exact failure shape: the insert does not land and no winning row exists. SQLite can produce it with a
// RAISE(IGNORE) trigger; the claim must fail loudly, never report a claim or read `.arm` off undefined.
bothEngines('#399 an insert that silently does not land, with no winning row, throws a clear error instead of reporting a claim', async ({ db, kind }) => {
  await running(db)
  if (kind === 'sqlite') await db.run('CREATE TRIGGER exp_ignore BEFORE INSERT ON experiment_arm_claims BEGIN SELECT RAISE(IGNORE); END')
  else {
    await db.run('CREATE FUNCTION exp_ignore() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$')
    await db.run('CREATE TRIGGER exp_ignore BEFORE INSERT ON experiment_arm_claims FOR EACH ROW EXECUTE FUNCTION exp_ignore()')
  }
  await assert.rejects(claimArmForProspect(db, A, 'exp-1', 'acct-1', 'offer-a', { now: T0 }), (e: Error) => !(e instanceof TypeError) && /conflicted but no claim row exists/.test(e.message))
  assert.equal(await n(db, 'SELECT claimed_count AS n FROM experiments WHERE tenant_id = ? AND id = ?', [A, 'exp-1']), 0)
})
