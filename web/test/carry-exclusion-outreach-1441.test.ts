// Qodo on #1441 (7739406, finding 2): a carried exclusion must stop outreach itself, not just label the lead. A
// finished changed-offer job whose lead matches a carried exclusion can never be drafted (manual or automatic), and is
// held at every approval/send/follow-up check (leadHeld). A non-matching lead of the same job is not held by it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { migrateScan, createQueryJob } from '../lib/scan/store.ts'
import { migrateOutreach } from '../lib/outreach/store.ts'
import { migrateMemory } from '../lib/memory.ts'
import { migrateKeys, saveKey } from '../lib/llm/key-store.ts'
import { claimKeyedJob } from '../lib/scan/runner.ts'
import { draftBlockReason, leadHeld } from '../lib/outreach/service.ts'

test('a lead matching a carried exclusion cannot be drafted, approved or sent', () => {
  const db = new Database(':memory:')
  migrateScan(db); migrateOutreach(db); migrateMemory(db); migrateKeys(db)
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
})
