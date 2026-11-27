// #2048 (follow-up to #2106): the benchmark scorer's place + category proxy matches short keywords at word boundaries, and a URL's top-level suffix
// is not evidence of where the buyer is. Offline: stored rows measured through the real measureCase, no network, no model.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { migrateScan } from '../lib/scan/store.ts'
import { migrateConnectors } from '../lib/connectors/store.ts'
import { measureCase } from '../scripts/matrix-score.mts'

const NOW = Math.floor(Date.now() / 1000)
const euExpect = { location_keywords: ['eu', 'europe'], category_keywords: ['procurement'] }

function matchPct(signal: string, sourceUrl: string, expect = euExpect, company = 'Acme Buyer'): number {
  const db = new Database(':memory:'); migrateScan(db); migrateConnectors(db)
  db.prepare("INSERT INTO scan_jobs (id, user_id, business_name, industry, location, query, status, candidates, created_at) VALUES ('j1', 'A', 'x', '(from request)', '-', 'q', 'running', 1, ?)").run(NOW)
  db.prepare("INSERT INTO leads (id, scan_job_id, company, name, contact, signal, source_url, company_domain, event_date, event_date_proof, quarantined_at, fit, created_at) VALUES ('l1', 'j1', ?, '', NULL, ?, ?, NULL, NULL, NULL, NULL, NULL, ?)").run(company, signal, sourceUrl, NOW)
  db.prepare("UPDATE scan_jobs SET status = 'done' WHERE id = 'j1'").run()
  return measureCase(db, 'A', 'j1', { expect }).match_pct
}

const held = { location_keywords: ['linkedin', 'eu'], category_keywords: ['cio', 'ciso', 'rfp', 'crm'] }
test('#2048 a short keyword also matches its plural as a whole word', () => {
  assert.equal(matchPct('Three new CIOs started, posted on linkedin', 'https://news.example/p1', held), 100)
  assert.equal(matchPct('New CISOs announced on linkedin', 'https://news.example/p2', held), 100)
  assert.equal(matchPct('Open RFPs across the EU this month', 'https://news.example/p3', held), 100)
  assert.equal(matchPct('Teams evaluating CRMs on linkedin', 'https://news.example/p4', held), 100)
})
test('#2048 control: a trailing s does not open a short keyword to longer words', () => {
  assert.equal(matchPct('Precious metals on linkedin', 'https://news.example/p5', held), 0)
  assert.equal(matchPct('Ciosk kiosk deals on linkedin', 'https://news.example/p6', held), 0)
  assert.equal(matchPct('Reuters reports an RFP', 'https://news.example/p7', held), 0)
})
