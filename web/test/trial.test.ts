import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { migrateTrial, trialStatus, recordTrialScan, operatorKey, TRIAL_SCANS_PER_ACCOUNT, TRIAL_SCANS_PER_IP_PER_DAY } from '../lib/scan/trial.ts'
import { migrateScan, createJob } from '../lib/scan/store.ts'
import { scansThisMonth } from '../lib/plans.ts'

const KEY_ENV = { DAZL_TRIAL_ANTHROPIC_KEY: 'sk-ant-test' }
const setup = () => { const db = new Database(':memory:'); migrateScan(db); migrateTrial(db); return db }
const job = (db: Database.Database, t: string) => { const id = createJob(db, t, { business_name: 'B', industry: 'i', location: 'l' }); db.prepare("UPDATE scan_jobs SET funded_by='trial' WHERE id=?").run(id); return id }
const setStatus = (db: Database.Database, id: string, status: 'done' | 'failed') => {
  db.prepare("UPDATE scan_jobs SET status='running' WHERE id=?").run(id)
  db.prepare('UPDATE scan_jobs SET status=? WHERE id=?').run(status, id)
}

test('operator key: absent means trial off; present means anthropic', () => {
  assert.equal(operatorKey({} as unknown as NodeJS.ProcessEnv), null)
  assert.deepEqual(operatorKey(KEY_ENV as unknown as NodeJS.ProcessEnv), { vendor: 'anthropic', key: 'sk-ant-test' })
})

test('per-account cap: 3 non-failed trial scans, then denied with account_cap', () => {
  process.env.DAZL_TRIAL_ANTHROPIC_KEY = 'sk-ant-test'
  try {
    const db = setup()
    for (let i = 0; i < TRIAL_SCANS_PER_ACCOUNT; i++) {
      const t = trialStatus(db, 't1', '1.2.3.4')
      assert.equal(t.funded, true); assert.equal(t.remaining, TRIAL_SCANS_PER_ACCOUNT - i)
      const id = job(db, 't1'); recordTrialScan(db, 't1', id, '1.2.3.4')
      setStatus(db, id, 'done')
    }
    const t = trialStatus(db, 't1', '1.2.3.4')
    assert.equal(t.funded, false); assert.equal(t.reason, 'account_cap'); assert.equal(t.remaining, 0)
    // a different account on the same IP is still under its own account cap (IP cap not hit yet)
    assert.equal(trialStatus(db, 't2', '1.2.3.4').funded, true)
  } finally { delete process.env.DAZL_TRIAL_ANTHROPIC_KEY }
})

test('failed trial scans refund the slot', () => {
  process.env.DAZL_TRIAL_ANTHROPIC_KEY = 'sk-ant-test'
  try {
    const db = setup()
    const id = job(db, 't1'); recordTrialScan(db, 't1', id, '1.2.3.4')
    setStatus(db, id, 'failed')
    const t = trialStatus(db, 't1', '1.2.3.4')
    assert.equal(t.funded, true); assert.equal(t.remaining, TRIAL_SCANS_PER_ACCOUNT)
  } finally { delete process.env.DAZL_TRIAL_ANTHROPIC_KEY }
})

test('per-IP daily throttle: 9 trial scans per IP per day regardless of account', () => {
  process.env.DAZL_TRIAL_ANTHROPIC_KEY = 'sk-ant-test'
  try {
    const db = setup()
    for (let i = 0; i < TRIAL_SCANS_PER_IP_PER_DAY; i++) {
      const id = job(db, `acct${i}`); recordTrialScan(db, `acct${i}`, id, '9.9.9.9')
      setStatus(db, id, 'done')
    }
    const t = trialStatus(db, 'fresh-acct', '9.9.9.9')
    assert.equal(t.funded, false); assert.equal(t.reason, 'ip_throttle')
    // another network is unaffected
    assert.equal(trialStatus(db, 'fresh-acct', '8.8.8.8').funded, true)
  } finally { delete process.env.DAZL_TRIAL_ANTHROPIC_KEY }
})

test('trial scans do not count against the monthly plan quota', () => {
  const db = setup()
  const id = job(db, 't1'); recordTrialScan(db, 't1', id, '1.2.3.4')
  setStatus(db, id, 'done')
  assert.equal(scansThisMonth(db, 't1'), 0)
  const own = createJob(db, 't1', { business_name: 'B', industry: 'i', location: 'l' })
  setStatus(db, own, 'done')
  assert.equal(scansThisMonth(db, 't1'), 1)
})

test('not configured: keyless accounts get no_api_key behavior (not funded)', () => {
  delete process.env.DAZL_TRIAL_ANTHROPIC_KEY
  const db = setup()
  const t = trialStatus(db, 't1', '1.2.3.4')
  assert.equal(t.funded, false); assert.equal(t.reason, 'not_configured')
})
