import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { addEnrichment } from '../../lib/connectors/store.ts'
import { migrateAllSqlite } from '../../lib/db/sqlite-migrations.ts'
import { homeReady } from '../../lib/outreach/home-ready.ts'
import { setScanDb } from './tenant-route-db.ts'

const now = Math.floor(Date.now() / 1000)
const day = new Date((now - 86_400) * 1000).toISOString().slice(0, 10)
const tenant = 'home-ready-date-fixture'
const job = 'a'.repeat(24)
const db = new Database(':memory:')
try {
  migrateAllSqlite(db)
  setScanDb(db)
  db.prepare(`INSERT INTO scan_jobs
    (id, user_id, business_name, industry, location, query, status)
    VALUES (?, ?, 'Workspace', 'services', '-', 'Companies opening another site', 'running')`).run(job, tenant)

  const insert = db.prepare(`INSERT INTO leads
    (id, scan_job_id, name, company, company_domain, signal, source_url, evidence_excerpt, event_date,
      event_date_proof, date_status, timing_note, source_kind, score, confidence, fit, intent, created_at)
    VALUES (?, ?, 'Lee Rivera', ?, ?, 'Opening another site', ?, 'Opening another site', ?,
      ?, 'unverified', ?, 'discover', 85, 85, 4, 4, ?)`)
  for (const [id, company, dateProof, timingNote] of [
    ['source-dated', 'Source fixture', 'page_bound', null],
    ['index-dated', 'Index fixture', null, 'The page prints no date. This is the day the search index dates the page.'],
  ] as const) {
    const host = `${id}.example`
    const source = `https://${host}/news`
    insert.run(id, job, company, host, source, day, dateProof, timingNote, now)
    for (const [kind, value] of [['person', 'Lee Rivera, Owner'], ['email', `lee.rivera@${host}`]]) {
      addEnrichment(db, tenant, id, {
        connector: 'discover', kind, value, label: 'published on a public page', confidence: null,
        source_url: `https://${host}/team`, source_date: day, retrieved_at: now,
      })
    }
  }
  db.prepare("UPDATE scan_jobs SET status = 'done' WHERE id = ?").run(job)

  const results = await homeReady(tenant, now)
  assert.equal(results.judged, 2)
  assert.equal(results.ready, 1)
  assert.deepEqual(results.scans, [{ job_id: job, ready: 1 }])
  assert.equal(results.companies.find(company => company.lead_id === 'source-dated')?.ready, true)
  assert.equal(results.companies.find(company => company.lead_id === 'index-dated')?.ready, false)
  assert.deepEqual(results.held.map(({ count, reason }) => ({ count, reason })), [
    { count: 1, reason: 'the event date is unconfirmed' },
  ])
} finally {
  db.close()
}
