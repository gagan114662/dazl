// #1238/#1062/#1620 (production d9fa0e71, scan 5a27e8cb, an older-engine signal-watch search): the Leads header said "10 found,
// 5 need your review" while Campaigns said "6 found, 1 needs your review". The header printed the funnel the scan recorded when it
// finished (scan_jobs.candidates/needs_review: 10 includes the 4 dropped candidates, and 4 of the 5 reviews are reasons no check can
// resolve). Campaigns and the Leads history count the saved leads as they stand now. The header now uses that same split.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { migrateAllSqlite } from '../lib/db/sqlite-migrations.ts'
import { sqliteDb } from '../lib/db/client.ts'
import { historyCampaigns, listCampaigns } from '../lib/outreach/campaigns.ts'
import { scanCountTags, emptyLeadsMessage } from '../lib/scan/leads-view.ts'

// The production scan's shape: 10 candidates recorded, 1 verified, 5 needs_review, 4 dropped; 6 saved 'watch' leads - one machine-checked
// hiring lead and five with these review reasons (flags only, no names).
function store() {
  const db = new Database(':memory:'); migrateAllSqlite(db)
  db.prepare("INSERT INTO scan_jobs (id, user_id, business_name, industry, location, query, status, created_at) VALUES ('s1', 'A', 'x', '(from request)', '-', 'Companies hiring sales reps', 'running', ?)").run(Math.floor(Date.now() / 1000) - 4 * 86400)
  const lead = (id: string, review: string | null, machine: boolean, date: string | null) =>
    db.prepare("INSERT INTO leads (id, scan_job_id, company, signal, source_url, confidence, evidence_excerpt, review_reason, event_date, source_kind) VALUES (?, 's1', ?, 'hiring', 'https://jobs.example/a', ?, ?, ?, ?, 'watch')")
      .run(id, `Co ${id}`, machine ? 80 : null, machine ? `Co ${id} is hiring` : null, review, date)
  lead('a', null, true, '2026-10-21')
  lead('b', 'no_sales_hiring_evidence', false, null)
  lead('c', 'needs_javascript', false, null)
  lead('d', 'quote_unconfirmed', false, '2026-05-04')
  lead('e', 'blocked_by_site', false, '2026-11-12')
  lead('f', 'blocked_by_site', false, null)
  db.prepare("UPDATE scan_jobs SET status = 'done', candidates = 10, verified = 1, needs_review = 5, dropped = 4 WHERE id = 's1'").run()
  return db
}
const recorded = { candidates: 10, passed: 1, needs_review: 5, dropped: 4 }
const num = (tags: string[], re: RegExp) => Number(tags.find(t => re.test(t))?.match(/^\d+/)?.[0])

test('#1238: the Leads header of an older-engine search says the same found / needs-review numbers as its Campaigns card', async () => {
  const db = store()
  const [hist] = await historyCampaigns(db, sqliteDb(db), 'A', ['s1'])
  const [card] = listCampaigns(db, 'A', 20)
  const header = scanCountTags(recorded, hist)
  assert.equal(header.current, true)
  assert.equal(num(header.tags, /found$/), card.discovery.leads, 'found = the saved leads Campaigns counts')
  assert.equal(num(header.tags, /found$/), 6)
  assert.equal(header.needsReview, card.qualification.needsReview, 'needs review = the Campaigns card')
  assert.ok(header.needsReview < 5, 'never the scan-time 5: reasons no check can resolve are research only')
  assert.equal(num(header.tags, /dropped$/), 4, 'the dropped candidates were never saved; the recorded count stays')
  // the empty-list line reads the same number
  assert.equal(emptyLeadsMessage('done', 0, 0, header.needsReview), header.needsReview > 0 ? `No leads passed verification. ${header.needsReview} need${header.needsReview === 1 ? 's' : ''} your review below.` : 'The scan finished with no leads.')
})

test('#1238: without the current split the header keeps the recorded funnel and says it is recorded', () => {
  const h = scanCountTags(recorded, null)
  assert.equal(h.current, false)
  assert.deepEqual(h.tags, ['10 found', '1 source-checked', '5 need your review', '4 dropped'])
})
