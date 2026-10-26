import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { migrateScan, createJob, exportLeads, listLeads } from '../lib/scan/store.ts'
import { migrateConnectors, addEnrichment } from '../lib/connectors/store.ts'
import { migrateOutreach } from '../lib/outreach/store.ts'
import { migrateMemory } from '../lib/memory.ts'
import { setQuarantine, isQuarantined } from '../lib/scan/quarantine.ts'
import { createDraft, domainReviewStatus, domainHoldCode, OutreachError } from '../lib/outreach/service.ts'

// Owner-approved quarantine for the wrong-company lead of #197: kept with its evidence, blocked from every outreach path.
function setup() {
  const db = new Database(':memory:'); migrateScan(db); migrateConnectors(db); migrateOutreach(db); migrateMemory(db)
  const job = createJob(db, 'A', { business_name: 'Seller', industry: 'x', location: 'y' })
  db.prepare("UPDATE scan_jobs SET status = 'running' WHERE id = ?").run(job)
  db.prepare('INSERT INTO leads (id,scan_job_id,company,contact,signal,source_url,evidence_excerpt,confidence,score,fit,human_confirmed_at,human_confirmed_from) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
    .run('L1', job, 'Smile Avenue Dental', 'hello@smileavenuedental.com', 'Opened a new practice in Sunnyside', 'https://qns.example/a', 'Smile Avenue Dental opened at 45-04 Greenpoint Ave in Sunnyside', 90, 85, 4, 1800000000, 'test_review')
  addEnrichment(db, 'A', 'L1', { connector: 'sitecrawl', kind: 'phone', value: '+1 562 904 0400', label: 'x', confidence: null, source_url: 'https://smileavenuedental.com/contact', source_date: '2026-10-26', retrieved_at: 1 })
  db.prepare("UPDATE scan_jobs SET status = 'done' WHERE id = ?").run(job)
  return { db, job }
}

test('quarantine keeps the lead and its evidence, is tenant-scoped and reversible', () => {
  const { db, job } = setup()
  assert.deepEqual(setQuarantine(db, 'B', 'L1', 'quarantine', 'x'), { status: 'not_found' }) // another tenant cannot
  assert.deepEqual(setQuarantine(db, 'A', 'L1', 'quarantine', 'Wrong company: Pico Rivera CA site'), { status: 'quarantined' })
  assert.equal(isQuarantined(db, 'L1'), true)
  const row = (listLeads(db, 'A', job, 200, true) as { id: string; quarantine_reason: string; evidence_excerpt: string }[])[0]
  assert.equal(row.quarantine_reason, 'Wrong company: Pico Rivera CA site'); assert.ok(row.evidence_excerpt.includes('Greenpoint'))
  assert.equal((db.prepare('SELECT count(*) n FROM lead_enrichments WHERE lead_id = ?').get('L1') as { n: number }).n, 1) // nothing deleted
  assert.deepEqual(setQuarantine(db, 'A', 'L1', 'release'), { status: 'released' })
  assert.equal(isQuarantined(db, 'L1'), false)
  assert.deepEqual(setQuarantine(db, 'A', 'L1', 'release'), { status: 'unchanged' })
})

test('a quarantined lead cannot be drafted, is held at the send gate, and is left out of exports', () => {
  const { db } = setup()
  setQuarantine(db, 'A', 'L1', 'quarantine', 'wrong company')
  assert.throws(() => createDraft(db, 'A', 'L1', 'Seller'), (e: unknown) => e instanceof OutreachError && e.code === 'lead_quarantined')
  assert.equal(domainReviewStatus(db, 'A', 'L1', 'hello@smileavenuedental.com'), 'quarantined')
  assert.equal(domainHoldCode(db, 'A', 'L1', 'hello@smileavenuedental.com'), 'lead_quarantined')
  assert.equal((exportLeads(db, 'A') as unknown[]).length, 0)
  setQuarantine(db, 'A', 'L1', 'release')
  assert.equal((exportLeads(db, 'A') as unknown[]).length, 1)
  assert.notEqual(domainReviewStatus(db, 'A', 'L1', 'hello@smileavenuedental.com'), 'quarantined')
})

test('autopilot never selects a quarantined lead (the candidate query excludes it)', async () => {
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(new URL('../lib/outreach/autopilot.ts', import.meta.url), 'utf8')
  assert.match(src, /l\.contact IS NOT NULL AND l\.quarantined_at IS NULL/)
})
