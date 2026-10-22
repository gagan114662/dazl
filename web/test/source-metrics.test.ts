import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { migrateScan } from '../lib/scan/store.ts'
import { migrateSequences } from '../lib/outreach/sequences.ts'
import { sourceMetrics, REPLY_WINDOW_S } from '../lib/scan/source-metrics.ts'

const NOW = 1_800_000_000
const OLD = NOW - 30 * 86400

function setup() {
  const d = new Database(':memory:')
  migrateScan(d); migrateSequences(d)
  // Insert jobs 'running' (the lead-insert trigger rejects writes to finished jobs); flip after.
  const job = d.prepare("INSERT INTO scan_jobs (id, user_id, status, business_name, industry, location) VALUES (?, 't1', 'running', 'B', 'i', 'l')")
  job.run('job1'); job.run('job2')
  return d
}
function credit(d: Database.Database, leadId: string, collector: string, jobId = 'job1') {
  d.prepare("INSERT OR IGNORE INTO leads (id, scan_job_id, name, company, signal, source_url, created_at) VALUES (?, ?, 'N', 'C', 'S', 'https://x.example', ?)").run(leadId, jobId, OLD)
  d.prepare('INSERT INTO lead_sources (lead_id, collector, attempt) VALUES (?, ?, 1)').run(leadId, collector)
}
function finishJobs(d: Database.Database) { d.prepare("UPDATE scan_jobs SET status = 'done'").run() }
function seq(d: Database.Database, leadId: string, status: string) {
  d.prepare("INSERT INTO sequences (id, tenant_id, lead_id, message_id, to_email, status) VALUES (?, 't1', ?, ?, 'a@b.co', ?)").run(`seq-${leadId}`, leadId, `msg-${leadId}`, status)
}

test('per-collector funnel: credited leads, ICP grades, outreach, replies; overlap counts toward each collector', () => {
  const d = setup()
  // reddit found lead A (fit 5, replied) and lead B (fit 2, no outreach); both also credited to tinyfish (overlap).
  credit(d, 'leadA', 'adapter:reddit'); credit(d, 'leadA', 'search:tinyfish')
  credit(d, 'leadB', 'adapter:reddit'); credit(d, 'leadB', 'search:tinyfish')
  d.prepare('UPDATE leads SET fit = 5 WHERE id = ?').run('leadA')
  d.prepare('UPDATE leads SET fit = 2 WHERE id = ?').run('leadB')
  seq(d, 'leadA', 'replied')
  finishJobs(d)
  const m = sourceMetrics(d, 't1', NOW)
  const reddit = m.rows.find(r => r.collector === 'adapter:reddit')!
  const tinyfish = m.rows.find(r => r.collector === 'search:tinyfish')!
  for (const row of [reddit, tinyfish]) {
    assert.equal(row.leads, 2) // overlap: both collectors get credit for both leads
    assert.equal(row.icp_graded, 2)
    assert.equal(row.strong_fit, 1) // only leadA is fit 4-5
    assert.equal(row.outreach_started, 1)
    assert.equal(row.replied, 1)
  }
  // And the rows must never be summed into a total: 2 + 2 leads across rows is 2 real leads.
})

test('ungraded leads count as ungraded, not as zero fit; young leads reported separately for reply latency', () => {
  const d = setup()
  credit(d, 'leadU', 'adapter:rss')
  d.prepare('UPDATE leads SET created_at = ? WHERE id = ?').run(NOW - 3600, 'leadU') // found an hour ago
  finishJobs(d)
  const rss = sourceMetrics(d, 't1', NOW).rows.find(r => r.collector === 'adapter:rss')!
  assert.equal(rss.leads, 1)
  assert.equal(rss.icp_graded, 0) // fit NULL: ungraded, not a zero
  assert.equal(rss.recent_leads, 1) // inside the 7-day reply window: not fair to judge replies yet
  assert.equal(rss.replied, 0)
})

test('unknown run counters stay NULL when any contributing run was unobserved', () => {
  const d = setup()
  d.prepare("INSERT INTO scan_source_runs (job_id, attempt, collector, status, evidence_count, candidate_count, verified_count, review_count, inserted_count) VALUES ('job1', 1, 'search:tinyfish', 'ok', 3, 5, 2, 0, 1)").run()
  d.prepare("INSERT INTO scan_source_runs (job_id, attempt, collector, status, evidence_count, candidate_count, verified_count, review_count, inserted_count) VALUES ('job2', 1, 'search:tinyfish', 'ok', 1, NULL, NULL, 0, 0)").run()
  const tf = sourceMetrics(d, 't1', NOW).rows.find(r => r.collector === 'search:tinyfish')!
  assert.equal(tf.jobs, 2)
  assert.equal(tf.candidates, null) // one run unobserved: total unknown, not "5"
  assert.equal(tf.verified, null)
  assert.equal(tf.inserted, 1) // inserted_count is always recorded: sum is real
})

test('a collector with runs but zero surviving leads still appears; tenant isolation holds', () => {
  const d = setup()
  d.prepare("INSERT INTO scan_source_runs (job_id, attempt, collector, status, evidence_count, candidate_count, verified_count, review_count, inserted_count) VALUES ('job1', 1, 'adapter:github', 'ok', 4, 4, 0, 1, 0)").run()
  // Another tenant's data must not leak in.
  d.prepare("INSERT INTO scan_jobs (id, user_id, status, business_name, industry, location) VALUES ('jobX', 't2', 'running', 'B', 'i', 'l')").run()
  d.prepare("INSERT INTO scan_source_runs (job_id, attempt, collector, status, evidence_count, candidate_count, verified_count, review_count, inserted_count) VALUES ('jobX', 1, 'adapter:hackernews', 'ok', 9, 9, 9, 0, 9)").run()
  const m = sourceMetrics(d, 't1', NOW)
  const gh = m.rows.find(r => r.collector === 'adapter:github')!
  assert.equal(gh.candidates, 4)
  assert.equal(gh.leads, 0)
  assert.equal(m.rows.some(r => r.collector === 'adapter:hackernews'), false)
})

test('replied beats stopped/done; a draft-only sequence is not outreach started... is outreach started, but not a reply', () => {
  const d = setup()
  credit(d, 'leadR', 'adapter:reddit'); credit(d, 'leadS', 'adapter:reddit'); credit(d, 'leadD', 'adapter:reddit')
  seq(d, 'leadR', 'replied'); seq(d, 'leadS', 'stopped'); seq(d, 'leadD', 'draft')
  finishJobs(d)
  const reddit = sourceMetrics(d, 't1', NOW).rows.find(r => r.collector === 'adapter:reddit')!
  assert.equal(reddit.outreach_started, 3) // sequence rows exist for all three
  assert.equal(reddit.replied, 1) // only the replied one
})
