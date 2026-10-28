import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import Database from 'better-sqlite3'
import { migrateScan, createJob, getJob } from '../lib/scan/store.ts'
import { migrateOutreach } from '../lib/outreach/store.ts'
import { campaignDetail } from '../lib/outreach/campaign-detail.ts'
import { leadStatus } from '../lib/outreach/campaign-view.ts'

const hex = () => randomBytes(12).toString('hex')
function fixture() {
  const db = new Database(':memory:')
  migrateScan(db); migrateOutreach(db)
  const job = (t: string, q: string) => { const id = createJob(db, t, { business_name: 'x', industry: 'test', location: 'test' }); db.prepare("UPDATE scan_jobs SET status='running', query=? WHERE id=?").run(q, id); return id }
  const lead = (j: string, company: string) => { const id = hex(); db.prepare("INSERT INTO leads(id,scan_job_id,company,name,contact,signal,source_url,evidence_excerpt,confidence,score) VALUES(?,?,?,'',?,'Hiring','https://x.invalid/a','quote',80,70)").run(id, j, company, `${id}@x.invalid`); return id }
  const msg = (t: string, l: string, status: string, created: number) => db.prepare("INSERT INTO outreach_messages(id,tenant_id,lead_id,to_email,subject,body,status,created_at,sent_at) VALUES(?,?,?,?,?,?,?,?,?)").run(hex(), t, l, `${l}@x.invalid`, `Subject ${l}`, 'Fixture body text long enough for the guard, twenty chars plus.', status, created, status === 'sent' ? created : null)
  return { db, job, lead, msg }
}

// Instinct #259: the page used the account-wide newest-200 Outreach list, so an old campaign's email could vanish and
// its lead read "Source-checked, not drafted".
test("an old campaign's sent email is found behind 250 newer emails from another campaign; every one of 250 leads is listed", () => {
  const { db, job, lead, msg } = fixture()
  const old = job('A', 'Old play'), other = job('A', 'New play')
  const oldLeads = Array.from({ length: 250 }, (_, i) => lead(old, `Old ${i}`))
  msg('A', oldLeads[0], 'sent', 1_000)
  msg('A', oldLeads[1], 'draft', 1_001)
  for (let i = 0; i < 250; i++) msg('A', lead(other, `New ${i}`), 'draft', 2_000 + i)
  const d = campaignDetail(db, 'A', old)!
  assert.equal(d.job.query, 'Old play')
  assert.equal(d.leads.length, 250, 'all leads, no cap')
  assert.equal(d.messages.length, 2, "only this scan's emails, none of the 250 newer ones")
  assert.deepEqual(leadStatus(d.leads[0], d.messages), { stage: 'sent', text: 'Sent' })
  assert.deepEqual(leadStatus(d.leads[1], d.messages), { stage: 'draft', text: 'Draft waiting for your review' })
})

test("owner-scoped: another tenant's scan, a missing scan and a malformed id are all null", () => {
  const { db, job } = fixture()
  const a = job('A', 'Mine')
  assert.equal(campaignDetail(db, 'B', a), null)
  assert.equal(campaignDetail(db, 'A', hex()), null)
  assert.equal(campaignDetail(db, 'A', 'not-a-scan'), null)
})

// Instinct #259: the scan status read (getJob) reaps stale running jobs - account-wide - on every call.
test('reading a campaign never writes: a stale running job stays exactly as it was (the status read would reap it)', () => {
  const { db, job, lead, msg } = fixture()
  const a = job('A', 'Mine'); msg('A', lead(a, 'Co'), 'sent', 1)
  const stale = job('A', 'Stale'); db.prepare('UPDATE scan_jobs SET claimed_at = 1, attempts = 1 WHERE id = ?').run(stale)
  const snap = () => JSON.stringify(['scan_jobs', 'leads', 'outreach_messages'].map(t => db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all()))
  const before = snap()
  campaignDetail(db, 'A', a); campaignDetail(db, 'A', stale); campaignDetail(db, 'B', a)
  assert.equal(snap(), before, 'campaignDetail left every row byte-unchanged')
  // Control: the status read does mutate the same fixture, which is why the page no longer uses it.
  getJob(db, 'A', a)
  assert.equal((db.prepare('SELECT status FROM scan_jobs WHERE id = ?').get(stale) as { status: string }).status, 'pending', 'control: getJob reaped the stale job')
})

test('the campaign read carries the counts the runner recorded, so the page can tell zero-match, all-dropped and failed apart', async () => {
  const { scanOutcome } = await import('../lib/scan/scan-outcome.ts')
  const { db, job } = fixture()
  const dropped = job('A', 'All dropped'), zero = job('A', 'Zero'), broke = job('A', 'Broke')
  db.prepare("UPDATE scan_jobs SET status='done', candidates=6, verified=0, needs_review=0, dropped=6 WHERE id=?").run(dropped)
  db.prepare("UPDATE scan_jobs SET status='failed', error='no_candidates', candidates=0 WHERE id=?").run(zero)
  db.prepare("UPDATE scan_jobs SET status='failed', error='upstream 500' WHERE id=?").run(broke)
  const ownKey = job('A', 'Own key'), trialKey = job('A', 'Trial key')
  db.prepare("UPDATE scan_jobs SET status='failed', error='key_rejected' WHERE id=?").run(ownKey)
  db.prepare("UPDATE scan_jobs SET status='failed', error='key_rejected', funded_by='trial' WHERE id=?").run(trialKey)
  const label = (id: string) => scanOutcome(campaignDetail(db, 'A', id)!.job).label
  assert.deepEqual([label(ownKey), label(trialKey)], ['Failed - your AI provider rejected your key', 'Failed - the free-search key had trouble (not your key)'], 'funding identity comes from the record')
  const kind = (id: string) => { const d = campaignDetail(db, 'A', id)!; return scanOutcome({ ...d.job, lead_count: d.leads.length }).kind }
  assert.deepEqual(campaignDetail(db, 'A', dropped)!.job, { ...campaignDetail(db, 'A', dropped)!.job, candidates: 6, verified: 0, needs_review: 0, dropped: 6 })
  assert.deepEqual([kind(dropped), kind(zero), kind(broke)], ['all_dropped', 'none_extracted', 'failed'])
})
