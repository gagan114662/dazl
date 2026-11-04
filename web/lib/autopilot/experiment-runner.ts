// #399 slice 1 (Acceptance Contract: docs/design/acceptance-contract.md worked example): config validation,
// pause/stop idempotency, and no duplicate contact across arms — staging-stub only, no live enablement.
// Everything past this (actually sourcing/contacting/measuring under live authorization) is NOT this slice.
//
// "No duplicate contact across arms": a prospect's arm is claimed exactly once, atomically, via the connector_claims
// pattern already used in lib/connectors/store.ts (INSERT whose PRIMARY KEY makes a second claim fail, not a
// check-then-insert race). A paused or stopped experiment refuses every new claim without touching claims already
// made — history is never deleted or rewritten, only closed to new ones.
import type Database from 'better-sqlite3'

export type ExperimentStatus = 'draft' | 'running' | 'paused' | 'stopped'

export interface ExperimentConfig {
  audience: string[] // fixed account ids; the caller resolves cohort queries to this list before validating
  exclusions: string[]
  arms: string[] // >= 2, distinct
  channels: string[]
  volumeCap: number // > 0
  spendCapCents: number // > 0
  senderIdentity: string
  timeHorizonDays: number // > 0
  stopConditions: string[] // e.g. ['reply_rate_anomaly', 'complaint_threshold', 'bounce_threshold']; must be non-empty
  liveEnabled?: boolean // must be absent/false here — this issue grants no launch authority
}

export type ValidationResult = { ok: true } | { ok: false; reason: string }

export function validateExperimentConfig(cfg: ExperimentConfig): ValidationResult {
  if (cfg.liveEnabled) return { ok: false, reason: 'liveEnabled is not granted by this issue; configure live authorization separately' }
  const eligible = cfg.audience.filter((a) => !cfg.exclusions.includes(a))
  if (eligible.length === 0) return { ok: false, reason: 'no eligible accounts after exclusions' }
  const distinctArms = new Set(cfg.arms)
  if (cfg.arms.length !== distinctArms.size) return { ok: false, reason: 'duplicate arm names' }
  if (distinctArms.size < 2) return { ok: false, reason: 'at least 2 distinct arms are required' }
  if (cfg.channels.length === 0) return { ok: false, reason: 'at least one channel is required' }
  if (!(cfg.volumeCap > 0)) return { ok: false, reason: 'volumeCap must be > 0' }
  if (!(cfg.spendCapCents > 0)) return { ok: false, reason: 'spendCapCents must be > 0' }
  if (!cfg.senderIdentity.trim()) return { ok: false, reason: 'senderIdentity is required' }
  if (!(cfg.timeHorizonDays > 0)) return { ok: false, reason: 'timeHorizonDays must be > 0' }
  if (cfg.stopConditions.length === 0) return { ok: false, reason: 'at least one stop condition is required' }
  return { ok: true }
}

export function migrateExperiments(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS experiments (
      id          TEXT PRIMARY KEY,
      tenant_id   TEXT NOT NULL,
      config_json TEXT NOT NULL,
      status      TEXT NOT NULL CHECK (status IN ('draft','running','paused','stopped')),
      created_at  INTEGER NOT NULL,
      stopped_at  INTEGER
    );
    CREATE TABLE IF NOT EXISTS experiment_arm_claims (
      experiment_id TEXT NOT NULL,
      prospect_key  TEXT NOT NULL,
      arm           TEXT NOT NULL,
      claimed_at    INTEGER NOT NULL,
      PRIMARY KEY (experiment_id, prospect_key)
    );
  `)
}

export function createExperiment(db: Database.Database, id: string, tenantId: string, cfg: ExperimentConfig): void {
  const v = validateExperimentConfig(cfg)
  if (!v.ok) throw new Error(`refused: ${v.reason}`)
  db.prepare('INSERT INTO experiments (id, tenant_id, config_json, status, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(id, tenantId, JSON.stringify(cfg), 'running' satisfies ExperimentStatus, Date.now())
}

export type ClaimResult = { claimed: true; arm: string } | { claimed: false; arm: string } | { refused: string }

// Atomic: the PRIMARY KEY on (experiment_id, prospect_key) means a second claim for the same prospect can never
// succeed, racing or not — there is no read-then-write window for two arms to both think they won.
export function claimArmForProspect(db: Database.Database, experimentId: string, prospectKey: string, arm: string): ClaimResult {
  const exp = db.prepare('SELECT status FROM experiments WHERE id = ?').get(experimentId) as { status: ExperimentStatus } | undefined
  if (!exp) return { refused: 'no such experiment' }
  if (exp.status !== 'running') return { refused: `experiment is ${exp.status}, not running` }
  try {
    db.prepare('INSERT INTO experiment_arm_claims (experiment_id, prospect_key, arm, claimed_at) VALUES (?, ?, ?, ?)')
      .run(experimentId, prospectKey, arm, Date.now())
    return { claimed: true, arm }
  } catch {
    const existing = db.prepare('SELECT arm FROM experiment_arm_claims WHERE experiment_id = ? AND prospect_key = ?')
      .get(experimentId, prospectKey) as { arm: string }
    return { claimed: false, arm: existing.arm }
  }
}

// Idempotent: only a transition FROM 'running' changes anything. A second pause (already paused, or already
// stopped) touches 0 rows and is reported as such, never an error and never a second timestamp write.
export function pauseExperiment(db: Database.Database, experimentId: string): { changed: boolean } {
  const r = db.prepare("UPDATE experiments SET status = 'paused' WHERE id = ? AND status = 'running'").run(experimentId)
  return { changed: r.changes === 1 }
}

export function stopExperiment(db: Database.Database, experimentId: string): { changed: boolean } {
  const r = db.prepare("UPDATE experiments SET status = 'stopped', stopped_at = ? WHERE id = ? AND status IN ('draft','running','paused')")
    .run(Date.now(), experimentId)
  return { changed: r.changes === 1 }
}
