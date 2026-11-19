import assert from 'node:assert/strict'
import { test } from 'node:test'
import Database from 'better-sqlite3'
import { releasedBeforeCost, reservationCost, settlePinnedTrialReservation } from '../lib/billing/trial-budget.ts'
import { qaClaudeOnlyBudget } from '../lib/scan/qa-provider-policy.ts'
import { createQueryJob, pinAdmittedStrictJob, migrateScan } from '../lib/scan/store.ts'
import { runStrictLocalJob } from '../lib/scan/strict-local-launch.ts'
import { migrateTrial } from '../lib/scan/trial.ts'

for (const unsettled of [false, true]) test(`pinned trial missing its key finishes its own attempt and ${unsettled ? 'keeps' : 'settles'} the reserve`, async () => {
  const db = new Database(':memory:')
  try {
    migrateScan(db); migrateTrial(db)
    db.exec('CREATE TABLE tenant_llm_keys(tenant_id TEXT, vendor TEXT)')
    const raw = qaClaudeOnlyBudget(null)
    const j = db.transaction(() => {
      createQueryJob(db, 'A', { id: 'job', query: 'Dental practices hiring in New York', runBudget: raw })
      db.prepare("UPDATE scan_jobs SET funded_by='trial' WHERE id='job'").run()
      db.prepare("INSERT INTO trial_reservations(id,tenant_id,job_id,reserve_usd,day,created_at) VALUES ('r','A','job',0.3,1,1)").run()
      return pinAdmittedStrictJob(db, 'A', 'job', raw)
    }).immediate()
    if (unsettled) db.prepare("INSERT INTO scan_spend_calls(id,user_id,scan_job_id,attempt,kind,reserve_usd,status,created_at) VALUES ('c','A','job',1,'llm.anthropic',0.02,'reserved',1)").run()
    await runStrictLocalJob(db, j)
    const r = db.prepare('SELECT r.*,j.status,j.error,j.attempts,j.spend_reserved_usd FROM trial_reservations r JOIN scan_jobs j ON j.id=r.job_id').get() as Parameters<typeof reservationCost>[0]
    assert.equal(r.status, 'failed')
    assert.equal(r.error, 'qa_provider_disabled')
    assert.equal(r.settled_attempt, unsettled ? null : 1)
    assert.equal(releasedBeforeCost(r), !unsettled)
    assert.equal(reservationCost(r), unsettled ? 0.3 : 0)
    await settlePinnedTrialReservation(db, 'A', 'job', 1, 1)
    assert.equal((db.prepare('SELECT settled_at FROM trial_reservations').get() as { settled_at: number | null }).settled_at, r.settled_at)
  } finally { db.close() }
})
