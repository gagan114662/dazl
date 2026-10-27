import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { migrateAllSqlite } from '../lib/db/sqlite-migrations.ts'
import { listCampaigns, nextAction } from '../lib/outreach/campaigns.ts'
import { leadEvidenceState, draftBlockReason } from '../lib/outreach/service.ts'

function setup() {
  const db = new Database(':memory:')
  migrateAllSqlite(db)
  return db
}
let t = 1000
// Jobs start running: the schema's triggers accept leads only then, and only running -> done/failed afterwards.
function job(db: Database.Database, user: string, id: string, query: string, o: { candidates?: number; test?: boolean } = {}) {
  db.prepare("INSERT INTO scan_jobs (id, user_id, business_name, industry, location, query, status, candidates, created_at) VALUES (?, ?, 'x', ?, ?, ?, 'running', ?, ?)")
    .run(id, user, o.test ? 'test only' : '(from request)', o.test ? 'test only' : '-', query, o.candidates ?? null, t++)
}
const finish = (db: Database.Database, id: string) => db.prepare("UPDATE scan_jobs SET status = 'done' WHERE id = ?").run(id)
function lead(db: Database.Database, jobId: string, id: string, o: { confidence?: number | null; excerpt?: string | null; review?: string | null; confirmed?: number | null; contact?: string | null; quarantined?: number | null; purged?: number | null } = {}) {
  db.prepare("INSERT INTO leads (id, scan_job_id, company, signal, source_url, confidence, evidence_excerpt, review_reason, human_confirmed_at, contact, quarantined_at, evidence_purged_at) VALUES (?, ?, 'Co', 'opened an office', 'https://news.example/x', ?, ?, ?, ?, ?, ?, ?)")
    .run(id, jobId, o.confidence === undefined ? 80 : o.confidence, o.excerpt === undefined ? 'Co opened an office' : o.excerpt, o.review ?? null, o.confirmed ?? null, o.contact ?? null, o.quarantined ?? null, o.purged ?? null)
}
function msg(db: Database.Database, tenant: string, leadId: string, status: string) {
  db.prepare("INSERT INTO outreach_messages (id, tenant_id, lead_id, to_email, subject, body, status) VALUES (?, ?, ?, 'a@b.example', 'Hello', 'A body that is long enough to pass the check.', ?)").run(`m-${leadId}`, tenant, leadId, status)
}

test('one row per search with every stage counted from that search only', () => {
  const db = setup()
  job(db, 'A', 'j1', 'Dental owners in Ohio', { candidates: 9 })
  lead(db, 'j1', 'l1', { contact: 'hello@one.example' })               // source-checked, contact, drafted
  lead(db, 'j1', 'l2', { contact: 'hi@two.example' })                  // source-checked, contact, sent
  lead(db, 'j1', 'l3', { confidence: null, excerpt: null, review: 'quote_unconfirmed' }) // needs review
  lead(db, 'j1', 'l4', { confidence: null, excerpt: null, review: null, confirmed: 5, contact: 'x@four.example' }) // confirmed by you, no email yet
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
    qualification: { sourceChecked: 2, confirmedByYou: 1, needsReview: 1, unverified: 0, held: 2, rejected: 1 },
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
  const base = { id: 'j', query: 'q', status: 'done', error: null, created_at: 0, discovery: { candidates: 3, leads: 3 }, qualification: { sourceChecked: 3, confirmedByYou: 0, needsReview: 0, unverified: 0, held: 0, rejected: 0 }, contact: { withContact: 3 }, outreach: { drafts: 0, approved: 0, sent: 0 }, sequence: { active: 0, stopped: 0 }, reply: { replied: 0, interested: 0, bounced: 0, optOuts: 0 } }
  const at = (o: object, undrafted = 0) => nextAction({ ...base, ...o } as typeof base, undrafted)
  assert.deepEqual(at({ status: 'running' }), { label: 'Search still running', href: '/app/leads?job_id=j' })
  assert.deepEqual(at({ status: 'failed', error: 'cancelled' }).label, 'Search cancelled. Run it again if you still want it')
  assert.equal(at({ status: 'failed', error: 'no_candidates' }).label, 'Search failed. Open it to see why')
  assert.equal(at({ qualification: { ...base.qualification, needsReview: 2 }, outreach: { drafts: 4, approved: 0, sent: 0 } }).label, 'Check 2 leads that need your review', 'review comes before drafts')
  assert.deepEqual(at({ outreach: { drafts: 2, approved: 1, sent: 0 } }), { label: 'Review and approve 2 drafts', href: '/app/outreach' })
  assert.deepEqual(at({ outreach: { drafts: 0, approved: 1, sent: 0 } }), { label: 'Send 1 approved email', href: '/app/outreach' })
  assert.deepEqual(at({ reply: { ...base.reply, interested: 2 } }), { label: 'Answer 2 interested replies', href: '/app/inbox' })
  assert.deepEqual(at({}, 3), { label: 'Approve 3 leads to draft emails', href: '/app/leads?job_id=j' })
  assert.deepEqual(at({ qualification: { ...base.qualification, held: 2 } }), { label: 'Confirm the timing of 2 leads before drafting', href: '/app/leads?job_id=j' })
  assert.deepEqual(at({ discovery: { candidates: 0, leads: 0 } }), { label: 'No leads from this search. Try a broader one', href: '/app/leads' })
  assert.deepEqual(at({}), { label: 'Nothing waiting on you', href: null })
})

// Instinct #239: qualification and "ready to draft" come from the same evidence state and draft gate as the server.
test('legacy no-excerpt, purged, confirmed and verified leads are counted exactly as the server gates see them', () => {
  const db = setup()
  job(db, 'A', 'j1', 'Controls')
  lead(db, 'j1', 'legacy', { confidence: 90, excerpt: null, contact: 'hello@legacy.example' })   // confidence + contact, no excerpt
  lead(db, 'j1', 'purged', { contact: 'hello@purged.example', purged: 1 })                      // excerpt kept, copied page purged
  lead(db, 'j1', 'confirmed', { confidence: null, excerpt: null, confirmed: 5, contact: 'hi@confirmed.example' })
  lead(db, 'j1', 'verified', { contact: 'hi@verified.example' })                                 // machine-verified, timing not yet reviewed
  finish(db, 'j1')
  // The canonical server functions for each row (draftBlockReason is createDraft's first refusal; the legacy row is
  // also unverified, so it stays refused even after a timing review).
  assert.deepEqual(['legacy', 'purged', 'confirmed', 'verified'].map(id => leadEvidenceState(db, 'A', id)), ['unverified', 'machine', 'human', 'machine'])
  assert.deepEqual(['legacy', 'purged', 'confirmed', 'verified'].map(id => draftBlockReason(db, 'A', id)), ['lead_currentness_unconfirmed', 'lead_currentness_unconfirmed', null, 'lead_currentness_unconfirmed'])
  const [c] = listCampaigns(db, 'A')
  assert.deepEqual(c.qualification, { sourceChecked: 2, confirmedByYou: 1, needsReview: 0, unverified: 1, held: 2, rejected: 0 })
  assert.equal(c.contact.withContact, 4, 'a stored contact is shown as a contact')
  // Only the lead the draft gate accepts counts as ready: the legacy row with a contact does not.
  assert.deepEqual(c.next, { label: 'Approve 1 lead to draft emails', href: '/app/leads?job_id=j1' })
  // Once that one is drafted, the next step is the timing review the gate is holding, never a draft.
  msg(db, 'A', 'confirmed', 'draft'); db.prepare("UPDATE outreach_messages SET status = 'sent' WHERE lead_id = 'confirmed'").run()
  assert.deepEqual(listCampaigns(db, 'A')[0].next, { label: 'Confirm the timing of 2 leads before drafting', href: '/app/leads?job_id=j1' })
})
