// Qodo on #1441 (7739406, finding 2): a carried exclusion must stop outreach itself, not just label the lead. A
// finished changed-offer job whose lead matches a carried exclusion can never be drafted (manual or automatic), and is
// held at every approval/send/follow-up check (leadHeld). A non-matching lead of the same job is not held by it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { migrateAllSqlite } from '../lib/db/sqlite-migrations.ts'
import { createQueryJob } from '../lib/scan/store.ts'
import { saveKey } from '../lib/llm/key-store.ts'
import { claimKeyedJob } from '../lib/scan/runner.ts'
import { approve, approveBlockReason, draftBlockReason, leadHeld, sendBlockReason } from '../lib/outreach/service.ts'

test('a lead matching a carried exclusion cannot be drafted, approved or sent', () => {
  const db = new Database(':memory:')
  migrateAllSqlite(db)
  db.exec("INSERT INTO users (id,email,password_hash,salt) VALUES ('W','owner@example.test','x','y')")
  saveKey(db, 'W', 'anthropic', 'fixture-only-unused-key', Buffer.alloc(32, 1))
  const icp = JSON.stringify({ summary: 'B2B SaaS founders', who: ['founder'], industries: [], sizes: [], where: [], signals: [], exclude: [], carry_exclude: ['Acme Dental (acme.example)'] })
  const job = createQueryJob(db, 'W', { query: 'SaaS founders hiring sales', icp, offer: 'Leadly (leadly.example), AI lead finding' })
  const claim = claimKeyedJob(db, job)
  assert.equal(claim?.id, job)
  assert.equal(claim?.attempts, 1)
  const running = db.prepare('SELECT status, claimed_at FROM scan_jobs WHERE id = ?').get(job) as { status: string; claimed_at: number }
  assert.equal(running.status, 'running')
  assert.ok(running.claimed_at > 0)
  const ins = db.prepare('INSERT INTO leads (id,scan_job_id,company,company_domain,contact,signal,source_url,evidence_excerpt,confidence,score,fit,intent) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
  ins.run('X', job, 'Acme Dental Group', 'acme.example', 'ceo@acme.example', 'hiring', 'https://news.example/a', 'hiring', 90, 80, 5, 4)
  ins.run('Y', job, 'Northwind', 'northwind.example', 'ceo@northwind.example', 'hiring', 'https://news.example/b', 'hiring', 90, 80, 5, 4)
  db.prepare("UPDATE scan_jobs SET status = 'done' WHERE id = ?").run(job)   // a finished changed-offer job
  assert.equal(draftBlockReason(db, 'W', 'X'), 'lead_excluded')
  assert.equal(leadHeld(db, 'W', 'X'), true)
  assert.notEqual(draftBlockReason(db, 'W', 'Y'), 'lead_excluded')
  assert.equal(leadHeld(db, 'W', 'Y'), false)
  // Existing drafts (created before the exclusion applied) must be refused by
  // the real approval check even after a legitimate source review.
  db.prepare("UPDATE leads SET human_confirmed_at=unixepoch() WHERE id IN ('X','Y')").run()
  const seedDraft = db.prepare('INSERT INTO outreach_messages (id,tenant_id,lead_id,to_email,subject,body) VALUES (?,?,?,?,?,?)')
  seedDraft.run('draftX','W','X','ceo@acme.example','Local fixture','Fixture message kept local only.')
  seedDraft.run('draftY','W','Y','ceo@northwind.example','Local fixture','Fixture message kept local only.')
  assert.equal(approveBlockReason(db, 'W', 'draftX', { skipAccount:true }), 'lead_excluded')
  assert.throws(() => approve(db, 'W', 'draftX'), { code:'lead_excluded' })
  assert.equal(db.prepare("SELECT status FROM outreach_messages WHERE id='draftX'").pluck().get(), 'draft')
  assert.equal(approveBlockReason(db, 'W', 'draftY', { skipAccount:true }), null)
  db.prepare("UPDATE outreach_messages SET status='approved' WHERE id='draftX'").run()
  assert.equal(sendBlockReason(db, 'W', 'draftX', { skipAccount:true }), 'lead_ungraded')

})

// Qodo on 3d50097 (3): a lead held by an exclusion is reported as excluded, never as an ICP grading failure.
test('a held excluded lead is reported as lead_excluded', async () => {
  const { leadHoldCode } = await import('../lib/outreach/service.ts')
  const db = new Database(':memory:')
  migrateScan(db); migrateOutreach(db); migrateMemory(db)
  const icp = JSON.stringify({ summary: 'S', who: [], industries: [], sizes: [], where: [], signals: [], exclude: [], carry_exclude: ['Acme Dental (acme.example)'] })
  const job = createQueryJob(db, 'W', { query: 'SaaS founders hiring sales', icp, offer: 'Leadly (leadly.example), AI lead finding' })
  db.prepare("UPDATE scan_jobs SET status = 'running' WHERE id = ?").run(job)
  const ins = db.prepare('INSERT INTO leads (id,scan_job_id,company,company_domain,contact,signal,source_url,evidence_excerpt,confidence,score,fit,intent) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
  ins.run('X', job, 'Acme Dental Group', 'acme.example', 'ceo@acme.example', 'hiring', 'https://news.example/a', 'hiring', 90, 80, 8, 7)
  ins.run('U', job, 'Northwind', 'northwind.example', 'ceo@northwind.example', 'hiring', 'https://news.example/b', 'hiring', 90, 80, 0, null)
  assert.equal(leadHoldCode(db, 'W', 'X'), 'lead_excluded')
  assert.equal(leadHoldCode(db, 'W', 'U'), 'lead_ungraded')
})
