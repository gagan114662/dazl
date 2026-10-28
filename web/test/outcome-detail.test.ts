import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { migrateScan, createJob } from '../lib/scan/store.ts'
import { migrateRunReport } from '../lib/scan/run-report.ts'
import { recordedEmptyReason } from '../lib/scan/outcome-detail.ts'
import { scanOutcome } from '../lib/scan/scan-outcome.ts'

const note = (o: object) => ({ results: 0, requested: 0, fetched: 0, fetch_failed: 0, fetch_error: false, offered: 0, page_texts_given: 0, snippet_only: 0, fetched_unused: 0, fetched_too_short: 0, job_pages_fetched: 0, reply: 'usable', returned: 0, reason: 'returned_zero', ...o })
function fixture() {
  const db = new Database(':memory:')
  migrateScan(db); migrateRunReport(db)
  const failedJob = (tenant: string, extraction: object | null) => {
    const id = createJob(db, tenant, { business_name: 'x', industry: 'test', location: 'test' })
    db.prepare("UPDATE scan_jobs SET status='running' WHERE id=?").run(id)
    db.prepare("UPDATE scan_jobs SET status='failed', error='no_candidates', candidates=0 WHERE id=?").run(id)
    if (extraction) db.prepare('INSERT INTO scan_run_report (job_id, attempt, report) VALUES (?, 1, ?)').run(id, JSON.stringify({ extraction }))
    return { id, status: 'failed', error: 'no_candidates', candidates: 0 }
  }
  return { db, failedJob }
}

// Instinct #274: no extracted candidates is not "no matches"; keep what the run recorded.
test('a scan that read pages but extracted none keeps its recorded diagnostic, distinct from one whose search had no hits', () => {
  const { db, failedJob } = fixture()
  const noHits = failedJob('A', note({}))
  const readNone = failedJob('A', note({ results: 8, requested: 5, fetched: 4, fetch_failed: 1, offered: 6, page_texts_given: 4, snippet_only: 2 }))
  const a = recordedEmptyReason(db, 'A', noHits)!, b = recordedEmptyReason(db, 'A', readNone)!
  assert.match(a, /^The search returned 0 results/)
  assert.match(b, /^The search returned 8 results; dazl asked to read 5 pages and read 4/)
  assert.match(b, /returned 0 candidates.*does not show that no matching companies exist/)
  for (const [job, why] of [[noHits, a], [readNone, b]] as const) {
    const o = scanOutcome({ ...job, empty_reason: why })
    assert.deepEqual([o.kind, o.label, o.detail], ['none_extracted', 'No candidates were extracted', why])
  }
})

test('nothing recorded, another outcome or another tenant: no diagnostic, and the outcome still never claims no matches', () => {
  const { db, failedJob } = fixture()
  const bare = failedJob('A', null)
  assert.equal(recordedEmptyReason(db, 'A', bare), null)
  assert.match(scanOutcome({ ...bare, empty_reason: null }).detail!, /does not show that no matching companies exist/)
  const other = failedJob('B', note({ results: 3 }))
  assert.equal(recordedEmptyReason(db, 'A', other), null, "another tenant's run report is never read")
  assert.equal(recordedEmptyReason(db, 'A', { id: other.id, status: 'done', error: null, candidates: 4 }), null)
})
