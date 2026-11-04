// #399 slice 1 (Acceptance Contract: docs/design/acceptance-contract.md worked example): config validation,
// pause/stop idempotency, and no duplicate contact across arms. Staging stub only: nothing here sources, contacts,
// sends, calls a provider or spends. Nothing in the app calls this module yet; live launch is a separate,
// separately authorized step (#399), and `liveEnabled` is refused by the validator.
//
// Persistence is on the async Db layer (lib/db/client.ts), so it runs the same on SQLite and Postgres. Schema:
// migrateExperiments below (SQLite, run by lib/db/sqlite-migrations.ts) and lib/db/migrations/pg/0049_experiments.sql.
// Tables, all scoped by tenant_id (tomb-guarded like every tenant table):
//   experiments            one row per experiment, PRIMARY KEY (tenant_id, id): another tenant's id is simply absent.
//   experiment_arm_claims  one row per (tenant, experiment, prospect): the prospect's arm, claimed exactly once.
//   experiment_events      append-only record of every create/start/pause/stop/claim call and its outcome, refusals
//                          and no-ops included, so a refused or repeated call still leaves its result behind.
//
// Lifecycle: createExperiment writes status 'draft' (no claims). startExperiment moves draft -> running. Here
// 'running' means only "arm claims are allowed in the staging stub"; it is NOT a live launch and grants no contact.
// pauseExperiment (running -> paused) and stopExperiment (draft/running/paused -> stopped) are idempotent: a repeat is
// a recorded no-op, never an error, and never touches claims already made. There is no resume in this slice.
//
// "No duplicate contact across arms": claimArmForProspect runs one transaction that first locks the experiment row
// (an UPDATE of its attempt counter: a row lock on Postgres, an IMMEDIATE transaction on SQLite), so every claim on one
// experiment is serialized; it re-reads status and caps under that lock, then inserts the claim with ON CONFLICT DO
// NOTHING. Only the (tenant, experiment, prospect) key conflict is absorbed: every other failure (locked store, missing
// table, CHECK) propagates and rolls the transaction back, and a conflict whose winning row cannot be read back throws
// instead of being reported as a claim. There is no catch-all anywhere in this module.
//
// What each validated config field does at claim time (EXPERIMENT_FIELD_ENFORCEMENT, held by the test):
//   audience, exclusions  enforced: only an audience member that is not excluded can be claimed;
//   arms                  enforced: only a configured arm can be claimed;
//   volumeCap             enforced: at most volumeCap prospects are claimed per experiment;
//   timeHorizonDays       enforced: no claim later than timeHorizonDays after start;
//   spendCapCents, channels, senderIdentity, stopConditions
//                         validated only: this slice makes no paid call, sends nothing and measures nothing, so there
//                         is nothing to cap, route or stop yet. The slice that adds sending or spend must enforce them.
//   liveEnabled           refused unless absent or false.
import type Database from 'better-sqlite3'
import { randomBytes } from 'node:crypto'
import type { Db, Param, Tx, TxBody } from '../db/client.ts'

export type ExperimentStatus = 'draft' | 'running' | 'paused' | 'stopped'

export interface ExperimentConfig {
  audience: string[] // fixed account ids; the caller resolves cohort queries to this list before validating
  exclusions: string[]
  arms: string[] // >= 2, distinct
  channels: string[]
  volumeCap: number // integer > 0
  spendCapCents: number // integer > 0
  senderIdentity: string
  timeHorizonDays: number // integer > 0
  stopConditions: string[] // e.g. ['reply_rate_anomaly', 'complaint_threshold', 'bounce_threshold']; must be non-empty
  liveEnabled?: boolean // must be absent/false here: this issue grants no launch authority
}

export const EXPERIMENT_FIELD_ENFORCEMENT: Record<keyof ExperimentConfig, 'enforced_on_claim' | 'validated_only' | 'refused_if_set'> = {
  audience: 'enforced_on_claim',
  exclusions: 'enforced_on_claim',
  arms: 'enforced_on_claim',
  volumeCap: 'enforced_on_claim',
  timeHorizonDays: 'enforced_on_claim',
  spendCapCents: 'validated_only',
  channels: 'validated_only',
  senderIdentity: 'validated_only',
  stopConditions: 'validated_only',
  liveEnabled: 'refused_if_set',
}

// Bounds: a config or an id past these is refused, never truncated.
export const MAX_ID_LEN = 200
export const MAX_AUDIENCE = 10_000
export const MAX_LIST = 50
export const MAX_VOLUME_CAP = 100_000
export const MAX_SPEND_CAP_CENTS = 10_000_000
export const MAX_HORIZON_DAYS = 366
const DAY_MS = 86_400_000

export type ValidationResult = { ok: true } | { ok: false; reason: string }

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/
const CONTROL = /[\u0000-\u001f\u007f]/
// A usable id: a non-blank, well-formed (no lone UTF-16 surrogate), bounded string with no control characters.
export function isId(v: unknown): v is string {
  return typeof v === 'string' && v.trim() !== '' && v.length <= MAX_ID_LEN && !LONE_SURROGATE.test(v) && !CONTROL.test(v)
}
const idList = (v: unknown, max: number): v is string[] => Array.isArray(v) && v.length <= max && v.every(isId)
const posInt = (v: unknown, max: number): v is number => typeof v === 'number' && Number.isInteger(v) && v > 0 && v <= max

const KEYS = new Set<string>(Object.keys(EXPERIMENT_FIELD_ENFORCEMENT))

// Takes unknown on purpose: the config may come from JSON. Fails closed on any wrong type, missing or extra key.
export function validateExperimentConfig(input: unknown): ValidationResult {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return { ok: false, reason: 'config must be an object' }
  const cfg = input as Record<string, unknown>
  const extra = Object.keys(cfg).filter((k) => !KEYS.has(k))
  if (extra.length) return { ok: false, reason: `unknown config key(s): ${extra.slice(0, 5).join(', ')}` }
  if (cfg.liveEnabled !== undefined && cfg.liveEnabled !== false) return { ok: false, reason: 'liveEnabled is not granted by this issue; configure live authorization separately' }
  if (!idList(cfg.audience, MAX_AUDIENCE)) return { ok: false, reason: `audience must be a list of at most ${MAX_AUDIENCE} account ids` }
  if (!idList(cfg.exclusions, MAX_AUDIENCE)) return { ok: false, reason: `exclusions must be a list of at most ${MAX_AUDIENCE} account ids` }
  const excluded = new Set(cfg.exclusions)
  if (!cfg.audience.some((a) => !excluded.has(a))) return { ok: false, reason: 'no eligible accounts after exclusions' }
  if (!idList(cfg.arms, MAX_LIST)) return { ok: false, reason: `arms must be a list of at most ${MAX_LIST} arm names` }
  const distinctArms = new Set(cfg.arms)
  if (cfg.arms.length !== distinctArms.size) return { ok: false, reason: 'duplicate arm names' }
  if (distinctArms.size < 2) return { ok: false, reason: 'at least 2 distinct arms are required' }
  if (!idList(cfg.channels, MAX_LIST) || cfg.channels.length === 0) return { ok: false, reason: 'at least one channel is required' }
  if (!posInt(cfg.volumeCap, MAX_VOLUME_CAP)) return { ok: false, reason: `volumeCap must be an integer from 1 to ${MAX_VOLUME_CAP}` }
  if (!posInt(cfg.spendCapCents, MAX_SPEND_CAP_CENTS)) return { ok: false, reason: `spendCapCents must be an integer from 1 to ${MAX_SPEND_CAP_CENTS}` }
  if (!isId(cfg.senderIdentity)) return { ok: false, reason: 'senderIdentity is required' }
  if (!posInt(cfg.timeHorizonDays, MAX_HORIZON_DAYS)) return { ok: false, reason: `timeHorizonDays must be an integer from 1 to ${MAX_HORIZON_DAYS}` }
  if (!idList(cfg.stopConditions, MAX_LIST) || cfg.stopConditions.length === 0) return { ok: false, reason: 'at least one stop condition is required' }
  return { ok: true }
}

// SQLite schema (startup migration chain: lib/db/sqlite-migrations.ts). Postgres: migrations/pg/0049_experiments.sql.
export function migrateExperiments(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS experiments (
      tenant_id      TEXT NOT NULL,
      id             TEXT NOT NULL,
      config_json    TEXT NOT NULL,
      status         TEXT NOT NULL CHECK (status IN ('draft','running','paused','stopped')),
      volume_cap     INTEGER NOT NULL CHECK (volume_cap > 0),
      claimed_count  INTEGER NOT NULL DEFAULT 0 CHECK (claimed_count >= 0 AND claimed_count <= volume_cap),
      claim_attempts INTEGER NOT NULL DEFAULT 0,
      created_at     INTEGER NOT NULL,
      started_at     INTEGER,
      paused_at      INTEGER,
      stopped_at     INTEGER,
      PRIMARY KEY (tenant_id, id)
    );
    CREATE TABLE IF NOT EXISTS experiment_arm_claims (
      tenant_id     TEXT NOT NULL,
      experiment_id TEXT NOT NULL,
      prospect_key  TEXT NOT NULL,
      arm           TEXT NOT NULL,
      claimed_at    INTEGER NOT NULL,
      PRIMARY KEY (tenant_id, experiment_id, prospect_key)
    );
    CREATE TABLE IF NOT EXISTS experiment_events (
      id            TEXT PRIMARY KEY,
      tenant_id     TEXT NOT NULL,
      experiment_id TEXT NOT NULL,
      action        TEXT NOT NULL CHECK (action IN ('create','start','pause','stop','claim')),
      outcome       TEXT NOT NULL CHECK (outcome IN ('ok','noop','refused','already_claimed')),
      reason        TEXT,
      prospect_key  TEXT,
      arm           TEXT,
      created_at    INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS experiment_events_exp ON experiment_events (tenant_id, experiment_id, created_at);
  `)
}

type Action = 'create' | 'start' | 'pause' | 'stop' | 'claim'
type Outcome = 'ok' | 'noop' | 'refused' | 'already_claimed'

const EVENT_INSERT = 'INSERT INTO experiment_events (id, tenant_id, experiment_id, action, outcome, reason, prospect_key, arm, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
function* recordTx(t: Tx, tenantId: string, experimentId: unknown, action: Action, outcome: Outcome, reason: string | null, now: number, prospectKey: unknown = null, arm: unknown = null): TxBody<void> {
  // Malformed values are recorded as NULL (or '' for the experiment id), never stored raw.
  const p: Param[] = [randomBytes(12).toString('hex'), tenantId, isId(experimentId) ? experimentId : '', action, outcome, reason,
    isId(prospectKey) ? prospectKey : null, isId(arm) ? arm : null, now]
  yield* t.run(EVENT_INSERT, p)
}

export type CreateResult = { ok: true; created: boolean } | { ok: false; reason: string }
export interface Clock { now?: number }

const EXP_INSERT = "INSERT INTO experiments (tenant_id, id, config_json, status, volume_cap, created_at) VALUES (?, ?, ?, 'draft', ?, ?) ON CONFLICT (tenant_id, id) DO NOTHING"
const EXP_CONFIG = 'SELECT config_json FROM experiments WHERE tenant_id = ? AND id = ?'

// Stored form: the known keys in a fixed order, so a replay with reordered keys still matches.
function canonicalJson(cfg: Record<string, unknown>): string {
  const o: Record<string, unknown> = {}
  for (const k of Object.keys(EXPERIMENT_FIELD_ENFORCEMENT)) if (cfg[k] !== undefined) o[k] = cfg[k]
  return JSON.stringify(o)
}

// Creates the experiment in 'draft'. A replay with the same config is a recorded no-op ({created:false}); the same id
// with a different config is refused (recorded). A tenant id that is not a usable id is refused with nothing written:
// there is no tenant to record it under.
export async function createExperiment(db: Db, tenantId: unknown, id: unknown, cfg: unknown, clock: Clock = {}): Promise<CreateResult> {
  if (!isId(tenantId)) return { ok: false, reason: 'invalid tenant id' }
  const now = clock.now ?? Date.now()
  const v: ValidationResult = isId(id) ? validateExperimentConfig(cfg) : { ok: false, reason: 'invalid experiment id' }
  return db.tx(function* (t): TxBody<CreateResult> {
    if (!v.ok) { yield* recordTx(t, tenantId, id, 'create', 'refused', v.reason, now); return v }
    const c = cfg as Record<string, unknown>
    const json = canonicalJson(c)
    const r = yield* t.run(EXP_INSERT, [tenantId, id as string, json, c.volumeCap as number, now])
    if (r.changes === 1) { yield* recordTx(t, tenantId, id, 'create', 'ok', null, now); return { ok: true, created: true } }
    const row = yield* t.get<{ config_json: string }>(EXP_CONFIG, [tenantId, id as string])
    if (!row) throw new Error('experiment insert conflicted but no row exists for this tenant and id')
    if (row.config_json === json) { yield* recordTx(t, tenantId, id, 'create', 'noop', 'replay', now); return { ok: true, created: false } }
    yield* recordTx(t, tenantId, id, 'create', 'refused', 'id in use with a different config', now)
    return { ok: false, reason: 'id in use with a different config' }
  })
}

export type TransitionResult = { changed: boolean } | { refused: string }

const START_SQL = "UPDATE experiments SET status = 'running', started_at = ? WHERE tenant_id = ? AND id = ? AND status = 'draft'"
const PAUSE_SQL = "UPDATE experiments SET status = 'paused', paused_at = ? WHERE tenant_id = ? AND id = ? AND status = 'running'"
const STOP_SQL = "UPDATE experiments SET status = 'stopped', stopped_at = ? WHERE tenant_id = ? AND id = ? AND status IN ('draft','running','paused')"
const EXP_STATUS = 'SELECT status FROM experiments WHERE tenant_id = ? AND id = ?'

function transition(action: 'start' | 'pause' | 'stop', sql: string) {
  return async (db: Db, tenantId: unknown, experimentId: unknown, clock: Clock = {}): Promise<TransitionResult> => {
    if (!isId(tenantId)) return { refused: 'invalid tenant id' }
    const now = clock.now ?? Date.now()
    return db.tx(function* (t): TxBody<TransitionResult> {
      if (!isId(experimentId)) { yield* recordTx(t, tenantId, experimentId, action, 'refused', 'invalid experiment id', now); return { refused: 'invalid experiment id' } }
      const r = yield* t.run(sql, [now, tenantId, experimentId])
      if (r.changes === 1) { yield* recordTx(t, tenantId, experimentId, action, 'ok', null, now); return { changed: true } }
      const row = yield* t.get<{ status: ExperimentStatus }>(EXP_STATUS, [tenantId, experimentId])
      if (!row) { yield* recordTx(t, tenantId, experimentId, action, 'refused', 'no such experiment', now); return { refused: 'no such experiment' } }
      // A start only moves a draft: once running, paused or stopped it is a no-op (there is no resume in this slice).
      yield* recordTx(t, tenantId, experimentId, action, 'noop', `already ${row.status}`, now)
      return { changed: false }
    })
  }
}

// draft -> running. "running" = arm claims allowed in the staging stub; never a live launch.
export const startExperiment = transition('start', START_SQL)
// running -> paused; idempotent.
export const pauseExperiment = transition('pause', PAUSE_SQL)
// draft/running/paused -> stopped; idempotent.
export const stopExperiment = transition('stop', STOP_SQL)

export type ClaimResult = { claimed: true; arm: string } | { claimed: false; arm: string } | { refused: string }

const CLAIM_LOCK = 'UPDATE experiments SET claim_attempts = claim_attempts + 1 WHERE tenant_id = ? AND id = ?'
const CLAIM_READ = 'SELECT status, config_json, volume_cap, claimed_count, started_at FROM experiments WHERE tenant_id = ? AND id = ?'
const CLAIM_EXISTING = 'SELECT arm FROM experiment_arm_claims WHERE tenant_id = ? AND experiment_id = ? AND prospect_key = ?'
const CLAIM_INSERT = 'INSERT INTO experiment_arm_claims (tenant_id, experiment_id, prospect_key, arm, claimed_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (tenant_id, experiment_id, prospect_key) DO NOTHING'
const CLAIM_COUNT = 'UPDATE experiments SET claimed_count = claimed_count + 1 WHERE tenant_id = ? AND id = ?'

type ExpRow = { status: ExperimentStatus; config_json: string; volume_cap: number; claimed_count: number; started_at: number | null }

function parseStored(json: string): ExperimentConfig | null {
  let cfg: unknown
  try { cfg = JSON.parse(json) } catch (e) {
    if (e instanceof SyntaxError) return null // a corrupt stored config refuses claims (recorded), never guesses
    throw e
  }
  return validateExperimentConfig(cfg).ok ? cfg as ExperimentConfig : null
}

// Claims `arm` for `prospectKey` in the tenant's experiment, once. A repeat (same or another arm) reports the arm that
// won as {claimed:false} and writes no second claim. Every call with a usable tenant id is recorded in
// experiment_events; a malformed tenant id is refused with nothing written.
export async function claimArmForProspect(db: Db, tenantId: unknown, experimentId: unknown, prospectKey: unknown, arm: unknown, clock: Clock = {}): Promise<ClaimResult> {
  if (!isId(tenantId)) return { refused: 'invalid tenant id' }
  const now = clock.now ?? Date.now()
  return db.tx(function* (t): TxBody<ClaimResult> {
    const refuse = function* (reason: string): TxBody<ClaimResult> {
      yield* recordTx(t, tenantId, experimentId, 'claim', 'refused', reason, now, prospectKey, arm)
      return { refused: reason }
    }
    if (!isId(experimentId)) return yield* refuse('invalid experiment id')
    if (!isId(prospectKey)) return yield* refuse('invalid prospect key')
    if (!isId(arm)) return yield* refuse('invalid arm')
    // Lock first: every claim on this experiment is serialized from here to commit.
    const locked = yield* t.run(CLAIM_LOCK, [tenantId, experimentId])
    const exp = locked.changes === 1 ? (yield* t.get<ExpRow>(CLAIM_READ, [tenantId, experimentId])) : undefined
    if (!exp) return yield* refuse('no such experiment')
    if (exp.status !== 'running') return yield* refuse(`experiment is ${exp.status}, not running`)
    const cfg = parseStored(exp.config_json)
    if (!cfg) return yield* refuse('stored config is unreadable')
    if (exp.started_at === null || now > Number(exp.started_at) + cfg.timeHorizonDays * DAY_MS) return yield* refuse('time horizon has passed')
    if (!cfg.arms.includes(arm)) return yield* refuse('unknown arm')
    if (!cfg.audience.includes(prospectKey)) return yield* refuse('prospect is not in the audience')
    if (cfg.exclusions.includes(prospectKey)) return yield* refuse('prospect is excluded')
    const prior = yield* t.get<{ arm: string }>(CLAIM_EXISTING, [tenantId, experimentId, prospectKey])
    if (prior) {
      yield* recordTx(t, tenantId, experimentId, 'claim', 'already_claimed', null, now, prospectKey, arm)
      return { claimed: false, arm: prior.arm }
    }
    if (Number(exp.claimed_count) >= Math.min(Number(exp.volume_cap), cfg.volumeCap)) return yield* refuse('volume cap reached')
    const ins = yield* t.run(CLAIM_INSERT, [tenantId, experimentId, prospectKey, arm, now])
    if (ins.changes !== 1) {
      // Only the key conflict lands here, and the lock above means it should not (the prior read found nothing). Report
      // the winner only if it can actually be read back; otherwise fail loudly, never as a claim.
      const won = yield* t.get<{ arm: string }>(CLAIM_EXISTING, [tenantId, experimentId, prospectKey])
      if (!won) throw new Error('arm claim conflicted but no claim row exists for this prospect')
      yield* recordTx(t, tenantId, experimentId, 'claim', 'already_claimed', null, now, prospectKey, arm)
      return { claimed: false, arm: won.arm }
    }
    yield* t.run(CLAIM_COUNT, [tenantId, experimentId])
    yield* recordTx(t, tenantId, experimentId, 'claim', 'ok', null, now, prospectKey, arm)
    return { claimed: true, arm }
  })
}
