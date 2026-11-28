// #2106: the benchmark scorer's place + category proxy matches short keywords at word boundaries, and a URL's top-level suffix
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

test('#2106 a short keyword does not match inside an unrelated word', () => {
  assert.equal(matchPct('Reuters reports a Canadian procurement notice', 'https://news.example/a'), 0)
  assert.equal(matchPct('Deutsche Bahn procurement notice', 'https://news.example/b'), 0)
})

test('#2106 a bare top-level suffix on the source hostname is not a place', () => {
  assert.equal(matchPct('Canadian procurement notice', 'https://tenders.example.eu/notice/1'), 0)
})

test('#2106 control: a standalone short keyword, in any case or with punctuation, still matches', () => {
  assert.equal(matchPct('EU: procurement notice', 'https://news.example/c'), 100)
  assert.equal(matchPct('procurement (eu) tender', 'https://news.example/d'), 100)
  assert.equal(matchPct('Procurement in Europe', 'https://news.example/e'), 100, 'a longer keyword still matches as before')
})

test('#2106 control: a place word in the hostname or path still counts; an unrelated case stays at 0', () => {
  assert.equal(matchPct('Procurement notice', 'https://tenders.europe-portal.example/n/1'), 100)
  assert.equal(matchPct('Procurement notice', 'https://news.example/eu/notice-1'), 100)
  assert.equal(matchPct('Roofing company hiring in Austin', 'https://news.example/f'), 0)
})
