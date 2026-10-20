import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { addWorkerLeads, claimNextJob, completeJob, createJob, getJob, listLeads, migrateScan } from '../lib/scan/store.ts'
import { parseLeads } from '../lib/scan/validate-leads.ts'

const input = { business_name: 'Acme', industry: 'pest', location: 'Toronto' }
function setup() {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  migrateScan(db)
  return db
}

test('claim hands out the oldest pending job once, then none', () => {
  const db = setup()
  const a = createJob(db, 'u1', input)
  const b = createJob(db, 'u2', input)
  assert.equal(claimNextJob(db)?.job_id, a)
  assert.equal(claimNextJob(db)?.job_id, b)
  assert.equal(claimNextJob(db), null)
})

test('worker flow: claim, add leads, complete; owner sees them', () => {
  const db = setup()
  const id = createJob(db, 'u1', input)
  claimNextJob(db)
  const leads = parseLeads([{ company: 'Cafe X', signal: 'Failed inspection', source_url: 'https://example.com/r', contact: 'A@X.com', score: 88 }])
  assert.ok(Array.isArray(leads))
  assert.equal(addWorkerLeads(db, id, leads as never), 1)
  assert.equal(completeJob(db, id, 'done'), true)
  assert.equal(getJob(db, 'u1', id)?.status, 'done')
  assert.equal((listLeads(db, 'u1', id)[0] as { contact: string }).contact, 'a@x.com')
  assert.equal(listLeads(db, 'u2', id).length, 0)
  assert.equal(completeJob(db, id, 'failed'), false) // final
  assert.throws(() => addWorkerLeads(db, id, leads as never), /running/)
})

test('re-claim after a stale reset clears earlier partial leads', () => {
  const db = setup()
  const id = createJob(db, 'u1', input)
  claimNextJob(db)
  addWorkerLeads(db, id, parseLeads([{ company: 'C', signal: 's', source_url: 'https://e.com' }]) as never)
  db.prepare("UPDATE scan_jobs SET claimed_at = 1 WHERE id = ?").run(id)
  const again = claimNextJob(db)
  assert.equal(again?.job_id, id)
  assert.equal(listLeads(db, 'u1', id).length, 0)
})

test('lead validation rejects bad input', () => {
  assert.equal(typeof parseLeads([]), 'string')
  assert.equal(typeof parseLeads([{ company: 'C', signal: 's', source_url: 'javascript:alert(1)' }]), 'string')
  assert.equal(typeof parseLeads([{ company: 'C', signal: '', source_url: 'https://e.com' }]), 'string')
  assert.equal(typeof parseLeads([{ signal: 's', source_url: 'https://e.com' }]), 'string')
  assert.equal(typeof parseLeads(Array(51).fill({ company: 'C', signal: 's', source_url: 'https://e.com' })), 'string')
})
