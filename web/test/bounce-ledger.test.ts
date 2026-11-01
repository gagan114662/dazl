import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { migrateAutopilot } from '../lib/outreach/autopilot.ts'
import { migrateOutreach } from '../lib/outreach/store.ts'
import { migrateBounceLedger, applyBounceVerdict, bounceCount } from '../lib/outreach/bounce-ledger.ts'
import type { DsnVerdict } from '../lib/outreach/dsn.ts'

const db = () => { const d = new Database(':memory:'); migrateOutreach(d); migrateAutopilot(d); migrateBounceLedger(d); return d }
const perm = (msgId: string, recipient: string): DsnVerdict => ({ kind: 'permanent', recipient, originalMessageId: `dazl.${msgId}@sender.example`, outreachMessageId: msgId })
const suppressed = (d: Database.Database, email: string) => !!d.prepare('SELECT 1 FROM suppressions WHERE tenant_id = ? AND email = ?').get('A', email)

test('a permanent verdict records once: suppression + audit + one ledger row', () => {
  const d = db()
  assert.equal(applyBounceVerdict(d, 'A', perm('m1', 'lead@x.example'), 'dsn', 'gmail-1'), 'recorded')
  assert.equal(bounceCount(d, 'A'), 1)
  assert.ok(suppressed(d, 'lead@x.example'))
  assert.equal((d.prepare("SELECT count(*) AS n FROM autopilot_audit WHERE tenant_id = 'A' AND action = 'bounce'").get() as { n: number }).n, 1)
})

test('duplicate DSNs with different Gmail ids for the same send+recipient never double-count', () => {
  const d = db()
  assert.equal(applyBounceVerdict(d, 'A', perm('m1', 'lead@x.example'), 'dsn', 'gmail-1'), 'recorded')
  assert.equal(applyBounceVerdict(d, 'A', perm('m1', 'lead@x.example'), 'dsn', 'gmail-2'), 'duplicate')
  assert.equal(applyBounceVerdict(d, 'A', perm('m1', 'lead@x.example'), 'thread', 'gmail-3'), 'duplicate', 'the in-thread path shares the ledger')
  assert.equal(bounceCount(d, 'A'), 1)
  assert.equal((d.prepare("SELECT count(*) AS n FROM autopilot_audit WHERE tenant_id = 'A' AND action = 'bounce'").get() as { n: number }).n, 1, 'recordBounce ran exactly once')
})

test('different sends to the same recipient, and different recipients, are separate accounts', () => {
  const d = db()
  assert.equal(applyBounceVerdict(d, 'A', perm('m1', 'lead@x.example'), 'dsn', 'g1'), 'recorded')
  assert.equal(applyBounceVerdict(d, 'A', perm('m2', 'lead@x.example'), 'dsn', 'g2'), 'recorded', 'a later send to the same address is its own account')
  assert.equal(applyBounceVerdict(d, 'A', perm('m3', 'other@y.example'), 'dsn', 'g3'), 'recorded')
  assert.equal(bounceCount(d, 'A'), 3)
})

test('soft, held and ignored verdicts never write or suppress', () => {
  const d = db()
  assert.equal(applyBounceVerdict(d, 'A', { kind: 'soft', recipient: 'lead@x.example', status: '4.4.2' }, 'dsn', 'g1'), 'ignored')
  assert.equal(applyBounceVerdict(d, 'A', { kind: 'hold', reason: 'untrusted_authserv' }, 'dsn', 'g2'), 'held')
  assert.equal(applyBounceVerdict(d, 'A', { kind: 'ignore', reason: 'recipient_mismatch' }, 'dsn', 'g3'), 'ignored')
  assert.equal(bounceCount(d, 'A'), 0)
  assert.ok(!suppressed(d, 'lead@x.example'))
})

test('a crash between the ledger insert and the suppression rolls back completely; the replay records and suppresses', () => {
  const d = db()
  const crash = () => { throw new Error('simulated crash mid-write') }
  assert.throws(() => applyBounceVerdict(d, 'A', perm('m1', 'lead@x.example'), 'dsn', 'gmail-1', undefined, crash), /simulated crash/)
  assert.equal(bounceCount(d, 'A'), 0, 'no dedup row survives the failed write')
  assert.ok(!suppressed(d, 'lead@x.example'), 'no suppression either')
  assert.equal(applyBounceVerdict(d, 'A', perm('m1', 'lead@x.example'), 'dsn', 'gmail-1'), 'recorded', 'the replay is not misread as a duplicate')
  assert.equal(bounceCount(d, 'A'), 1)
  assert.ok(suppressed(d, 'lead@x.example'))
})

test('tenants and recipients are isolated in the ledger', () => {
  const d = db()
  assert.equal(applyBounceVerdict(d, 'A', perm('m1', 'lead@x.example'), 'dsn', 'g1'), 'recorded')
  assert.equal(applyBounceVerdict(d, 'B', perm('m1', 'lead@x.example'), 'dsn', 'g2'), 'recorded', 'same send id + recipient under another tenant is separate')
  assert.equal(applyBounceVerdict(d, 'A', perm('m1', 'Lead@X.example'), 'dsn', 'g3'), 'duplicate', 'recipient case folds within a tenant')
  assert.equal(bounceCount(d, 'A'), 1)
  assert.equal(bounceCount(d, 'B'), 1)
  assert.ok(!suppressed(d, 'lead@y.example'), "tenant A's suppression never names another address")
})
