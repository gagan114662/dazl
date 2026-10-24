import { migrateConnectors } from '../lib/connectors/store.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { migrateScan } from '../lib/scan/store.ts'
import { migrateOutreach } from '../lib/outreach/store.ts'
import { migrateAutopilot, pause } from '../lib/outreach/autopilot.ts'
import { migrateLedger } from '../lib/outreach/ledger.ts'
import { migrateReplies } from '../lib/outreach/replies.ts'
import { migrateSequences } from '../lib/outreach/sequences.ts'
import { saveSettings } from '../lib/outreach/service.ts'
import { schedulerReadiness } from '../lib/outreach/scheduler-readiness.ts'

function fresh() {
  const db = new Database(':memory:')
  migrateScan(db); migrateOutreach(db); migrateConnectors(db); migrateAutopilot(db); migrateLedger(db); migrateReplies(db); migrateSequences(db)
  return db
}
test('scheduler flag reports configuration only, in precedence order kill > operator_off > paused > configured_on', () => {
  const db = fresh()
  assert.equal(schedulerReadiness(db, 'A', {}).scheduler, 'operator_off')
  assert.equal(schedulerReadiness(db, 'A', { SEQUENCES_ENABLED: '1' }).scheduler, 'configured_on')
  assert.equal(schedulerReadiness(db, 'A', { SEQUENCES_ENABLED: '1', AUTOPILOT_KILL: '1' }).scheduler, 'kill_switch')
  db.prepare("INSERT INTO autopilot_settings (tenant_id, enabled, paused, consent_version, daily_cap) VALUES ('A', 0, 0, 'x', 20)").run()
  pause(db, 'A')
  assert.equal(schedulerReadiness(db, 'A', { SEQUENCES_ENABLED: '1' }).scheduler, 'paused')
  assert.equal(schedulerReadiness(db, 'B', { SEQUENCES_ENABLED: '1' }).scheduler, 'configured_on', 'another tenant pause does not leak')
})
test('gates list unmet account prerequisites and lists all gates as account-scoped', () => {
  const db = fresh()
  let g = schedulerReadiness(db, 'A', { SEQUENCES_ENABLED: '1' }).gates
  assert.deepEqual(g.map(x => [x.id, x.ok, x.scope]), [['gmail', false, 'account'], ['read_consent', false, 'account'], ['sender_identity', false, 'account'], ['uncertain_send', true, 'account']])
  saveSettings(db, 'A', { sender_name: 'Pat', postal_address: '1 King St W, Toronto ON M5H 1A1' })
  g = schedulerReadiness(db, 'A', {}).gates
  assert.equal(g.find(x => x.id === 'sender_identity')!.ok, true)
  assert.equal(g.find(x => x.id === 'gmail')!.ok, false)
})
