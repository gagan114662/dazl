import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { migrateScan } from '../lib/scan/store.ts'
import { migrateOutreach } from '../lib/outreach/store.ts'
import { migrateReplies } from '../lib/outreach/replies.ts'
import { migrateSequences } from '../lib/outreach/sequences.ts'
import { listCampaigns, nextAction } from '../lib/outreach/campaigns.ts'

function setup() {
  const db = new Database(':memory:')
  for (const m of [migrateScan, migrateOutreach, migrateReplies, migrateSequences]) m(db)
  return db
}
let t = 1000
// Jobs start running: the schema's triggers accept leads only then, and only running -> done/failed afterwards.
function job(db: Database.Database, user: string, id: string, query: string, o: { candidates?: number; test?: boolean } = {}) {
  db.prepare("INSERT INTO scan_jobs (id, user_id, business_name, industry, location, query, status, candidates, created_at) VALUES (?, ?, 'x', ?, ?, ?, 'running', ?, ?)")
    .run(id, user, o.test ? 'test only' : '(from request)', o.test ? 'test only' : '-', query, o.candidates ?? null, t++)
}
const finish = (db: Database.Database, id: string) => db.prepare("UPDATE scan_jobs SET status = 'done' WHERE id = ?").run(id)
function lead(db: Database.Database, jobId: string, id: string, o: { confidence?: number | null; review?: string | null; confirmed?: number | null; contact?: string | null; quarantined?: number | null } = {}) {
  db.prepare("INSERT INTO leads (id, scan_job_id, company, signal, source_url, confidence, review_reason, human_confirmed_at, contact, quarantined_at) VALUES (?, ?, 'Co', 'opened an office', 'https://news.example/x', ?, ?, ?, ?, ?)")
    .run(id, jobId, o.confidence === undefined ? 80 : o.confidence, o.review ?? null, o.confirmed ?? null, o.contact ?? null, o.quarantined ?? null)
}
function msg(db: Database.Database, tenant: string, leadId: string, status: string) {
  db.prepare("INSERT INTO outreach_messages (id, tenant_id, lead_id, to_email, subject, body, status) VALUES (?, ?, ?, 'a@b.example', 'Hello', 'A body that is long enough to pass the check.', ?)").run(`m-${leadId}`, tenant, leadId, status)
}

test('one row per search with every stage counted from that search only', () => {
  const db = setup()
  job(db, 'A', 'j1', 'Dental owners in Ohio', { candidates: 9 })
  lead(db, 'j1', 'l1', { contact: 'hello@one.example' })               // source-checked, contact, drafted
  lead(db, 'j1', 'l2', { contact: 'hi@two.example' })                  // source-checked, contact, sent
  lead(db, 'j1', 'l3', { confidence: null, review: 'quote_unconfirmed' }) // needs review
  lead(db, 'j1', 'l4', { confidence: null, review: null, confirmed: 5, contact: 'x@four.example' }) // confirmed by you, no email yet
  lead(db, 'j1', 'l5', { quarantined: 7, contact: 'q@five.example' })  // rejected
  msg(db, 'A', 'l1', 'draft'); msg(db, 'A', 'l2', 'sent')
  db.prepare("INSERT INTO inbound_messages (gmail_id, tenant_id, thread_id, lead_id, from_email, excerpt, classification, received_at) VALUES ('g1','A','t1','l2','a@b.example','yes please','positive',1)").run()
  // Another tenant's job and data never appear.
  db.prepare("INSERT INTO sequences (id, tenant_id, lead_id, message_id, to_email, status) VALUES ('s1','A','l2','m-l2','a@b.example','active')").run()
  job(db, 'B', 'jb', 'B search'); lead(db, 'jb', 'lb', { contact: 'b@b.example' }); msg(db, 'B', 'lb', 'draft')
  db.prepare("INSERT INTO sequences (id, tenant_id, lead_id, message_id, to_email, status) VALUES ('sb','B','lb','m-lb','b@b.example','stopped')").run()
  // Test fixtures and imports without a query are not campaigns.
  job(db, 'A', 'jt', 'fixture', { test: true })
  for (const id of ['j1', 'jb', 'jt']) finish(db, id)
  const [c, ...rest] = listCampaigns(db, 'A')
  assert.equal(rest.length, 0)
  assert.deepEqual({ ...c, created_at: 0 }, {
    id: 'j1', query: 'Dental owners in Ohio', status: 'done', error: null, created_at: 0,
    discovery: { candidates: 9, leads: 5 },
    qualification: { sourceChecked: 2, confirmedByYou: 1, needsReview: 1, rejected: 1 },
    contact: { withContact: 3 },
    outreach: { drafts: 1, approved: 0, sent: 1 },
    sequence: { active: 1, stopped: 0 },
    reply: { replied: 1, interested: 1, bounced: 0, optOuts: 0 },
    next: { label: 'Check 1 lead that needs your review', href: '/app/leads?job_id=j1' },
  })
  assert.equal(listCampaigns(db, 'B')[0].outreach.drafts, 1)
  assert.equal(listCampaigns(db, 'B')[0].reply.interested, 0)
  assert.deepEqual(listCampaigns(db, 'B')[0].sequence, { active: 0, stopped: 1 })
})

test('next action follows the pipeline order and never skips a gate', () => {
  const base = { id: 'j', query: 'q', status: 'done', error: null, created_at: 0, discovery: { candidates: 3, leads: 3 }, qualification: { sourceChecked: 3, confirmedByYou: 0, needsReview: 0, rejected: 0 }, contact: { withContact: 3 }, outreach: { drafts: 0, approved: 0, sent: 0 }, sequence: { active: 0, stopped: 0 }, reply: { replied: 0, interested: 0, bounced: 0, optOuts: 0 } }
  const at = (o: object, undrafted = 0) => nextAction({ ...base, ...o } as typeof base, undrafted)
  assert.deepEqual(at({ status: 'running' }), { label: 'Search still running', href: '/app/leads?job_id=j' })
  assert.deepEqual(at({ status: 'failed', error: 'cancelled' }).label, 'Search cancelled. Run it again if you still want it')
  assert.equal(at({ status: 'failed', error: 'no_candidates' }).label, 'Search failed. Open it to see why')
  assert.equal(at({ qualification: { ...base.qualification, needsReview: 2 }, outreach: { drafts: 4, approved: 0, sent: 0 } }).label, 'Check 2 leads that need your review', 'review comes before drafts')
  assert.deepEqual(at({ outreach: { drafts: 2, approved: 1, sent: 0 } }), { label: 'Review and approve 2 drafts', href: '/app/outreach' })
  assert.deepEqual(at({ outreach: { drafts: 0, approved: 1, sent: 0 } }), { label: 'Send 1 approved email', href: '/app/outreach' })
  assert.deepEqual(at({ reply: { ...base.reply, interested: 2 } }), { label: 'Answer 2 interested replies', href: '/app/inbox' })
  assert.deepEqual(at({}, 3), { label: 'Approve 3 leads to draft emails', href: '/app/leads?job_id=j' })
  assert.deepEqual(at({ discovery: { candidates: 0, leads: 0 } }), { label: 'No leads from this search. Try a broader one', href: '/app/leads' })
  assert.deepEqual(at({}), { label: 'Nothing waiting on you', href: null })
})
