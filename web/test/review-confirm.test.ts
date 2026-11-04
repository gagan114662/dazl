import { migrateConnectors } from '../lib/connectors/store.ts'
import { sqliteDb } from '../lib/db/client.ts'
import { seedOffers } from './helpers/seed-offer.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import Database from 'better-sqlite3'
import { migrateScan, createJob, listLeads } from '../lib/scan/store.ts'
import { migrateOutreach } from '../lib/outreach/store.ts'
import { confirmLeadReview, unconfirmLeadReview } from '../lib/scan/review-confirm.ts'
import { createDraft } from '../lib/outreach/service.ts'
import { REVIEWABLE, RESEARCH_REASONS, heldState } from '../lib/lead-state.ts'
import { reviewAction } from '../lib/scan/review-action.ts'

// Human confirmation of needs-review leads: the machine verdict never changes, the
// original reason is preserved, confirmation is reversible, tenant-scoped, and it makes
// the lead draft-eligible ONLY through the same explicit per-lead draft click as any
// verified lead - never through autopilot, which requires a machine confidence score.

function setup() {
  const db = new Database(':memory:')
  migrateScan(db); migrateOutreach(db); migrateConnectors(db); seedOffers(db)
  return db
}
function addReviewLead(db: Database.Database, tenant: string, o: { contact?: string | null; reason?: string } = {}) {
  const job = createJob(db, tenant, { business_name: 'Acme', industry: 'roofing', location: 'Toronto' })
  const id = randomBytes(12).toString('hex')
  db.prepare("UPDATE scan_jobs SET status = 'running' WHERE id = ?").run(job)
  db.prepare('INSERT INTO leads (id, scan_job_id, company, contact, signal, source_url, evidence_excerpt, confidence, review_reason, score) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
    id, job, 'Northside Builders', 'contact' in o ? o.contact : 'info@northside.example',
    'Northside Builders is hiring five roofers', 'https://news.example/a',
    'Northside Builders is hiring five roofers', null, o.reason ?? 'quote_unconfirmed', 70)
  return { id, job }
}
const row = (db: Database.Database, id: string) =>
  db.prepare('SELECT review_reason, human_confirmed_at, human_confirmed_from, confidence, evidence_excerpt FROM leads WHERE id = ?').get(id) as { review_reason: string | null; human_confirmed_at: number | null; human_confirmed_from: string | null; confidence: number | null; evidence_excerpt: string | null }

test('confirm moves the lead out of review, preserves the reason, and never invents confidence', async () => {
  const db = setup()
  const { id, job } = addReviewLead(db, 'A')
  assert.equal(await confirmLeadReview(sqliteDb(db), 'A', id), true)
  const r = row(db, id)
  assert.equal(r.review_reason, null)
  assert.equal(r.human_confirmed_from, 'quote_unconfirmed') // provenance kept
  assert.ok(r.human_confirmed_at && r.human_confirmed_at > 0)
  assert.equal(r.confidence, null) // no fake machine score
  assert.equal(r.evidence_excerpt, 'Northside Builders is hiring five roofers') // original excerpt untouched
  // the lead now appears in the tenant's main list, not in the review list
  const leads = listLeads(db, 'A', job) as { id: string; review_reason: string | null; human_confirmed_at: number | null }[]
  assert.equal(leads.length, 1)
  assert.equal(leads[0].review_reason, null)
  assert.ok(leads[0].human_confirmed_at)
  // idempotent: a second confirm changes nothing
  assert.equal(await confirmLeadReview(sqliteDb(db), 'A', id), false)
})

test('confirm is tenant-scoped and only applies to leads actually in review', async () => {
  const db = setup()
  const { id } = addReviewLead(db, 'A')
  assert.equal(await confirmLeadReview(sqliteDb(db), 'B', id), false) // another tenant
  assert.equal(row(db, id).review_reason, 'quote_unconfirmed')
  assert.equal(await confirmLeadReview(sqliteDb(db), 'A', randomBytes(12).toString('hex')), false) // unknown lead
  // a lead that is not in review cannot be "confirmed"
  const job2 = createJob(db, 'A', { business_name: 'Acme', industry: 'x', location: 'y' })
  const plain = randomBytes(12).toString('hex')
  db.prepare("UPDATE scan_jobs SET status = 'running' WHERE id = ?").run(job2)
  db.prepare('INSERT INTO leads (id, scan_job_id, company, signal, source_url, score) VALUES (?, ?, ?, ?, ?, ?)').run(plain, job2, 'Plain Co', 'signal', 'https://x.example', 50)
  assert.equal(await confirmLeadReview(sqliteDb(db), 'A', plain), false)
})

test('withdraw restores the exact original review reason', async () => {
  const db = setup()
  const { id } = addReviewLead(db, 'A', { reason: 'job_closed' })
  assert.equal(await unconfirmLeadReview(sqliteDb(db), 'A', id), false) // nothing to withdraw
  assert.equal(await confirmLeadReview(sqliteDb(db), 'A', id), true)
  assert.equal(await unconfirmLeadReview(sqliteDb(db), 'B', id), false) // tenant-scoped
  assert.equal(await unconfirmLeadReview(sqliteDb(db), 'A', id), true)
  const r = row(db, id)
  assert.equal(r.review_reason, 'job_closed')
  assert.equal(r.human_confirmed_at, null)
  assert.equal(r.human_confirmed_from, null)
})

test('draft gate: unconfirmed review leads are refused; human-confirmed leads draft through the same explicit click; sends stay separate', async () => {
  const db = setup()
  const { id } = addReviewLead(db, 'A')
  assert.throws(() => createDraft(db, 'A', id, 'Acme'), /lead_not_verified/) // still refused while in review
  assert.equal(await confirmLeadReview(sqliteDb(db), 'A', id), true)
  const draftId = createDraft(db, 'A', id, 'Acme') // human-confirmed: draft-eligible
  assert.ok(draftId)
  const m = db.prepare('SELECT status, approved_hash, sent_at, test FROM outreach_messages WHERE id = ?').get(draftId) as { status: string; approved_hash: string | null; sent_at: number | null; test: number }
  assert.equal(m.status, 'draft') // preparation only - approval and send remain separate steps
  assert.equal(m.approved_hash, null)
  assert.equal(m.sent_at, null)
  assert.equal(m.test, 0)
  // one draft per lead, same as verified leads
  assert.throws(() => createDraft(db, 'A', id, 'Acme'), /already_drafted/)
})

test('autopilot never picks up a human-confirmed lead (it requires a machine confidence score)', async () => {
  const db = setup()
  const { id } = addReviewLead(db, 'A')
  assert.equal(await confirmLeadReview(sqliteDb(db), 'A', id), true)
  // the autopilot selection predicate, asserted against the row itself: confidence is
  // NULL after confirmation, and NULL >= any threshold is never true
  const n = db.prepare('SELECT count(*) AS n FROM leads WHERE id = ? AND evidence_excerpt IS NOT NULL AND confidence >= 55 AND contact IS NOT NULL').get(id) as { n: number }
  assert.equal(n.n, 0)
})

// #352: confirming a lead held for a fact about its evidence (someone else's customer, a different place, a closed opening) keeps it as research:
// the confirmation is recorded and reversible, but drafting stays refused - what its "Keep as research" card says.
test('#352: a lead confirmed out of counterparty_signal / location_mismatch / job_closed stays out of drafting; a checkable reason still drafts', async () => {
  for (const reason of ['counterparty_signal', 'location_mismatch', 'job_closed']) {
    const db = setup()
    const { id } = addReviewLead(db, 'A', { reason })
    assert.equal(await confirmLeadReview(sqliteDb(db), 'A', id), true, reason)
    assert.equal(row(db, id).human_confirmed_from, reason)
    assert.throws(() => createDraft(db, 'A', id, 'Acme'), /lead_currentness_unconfirmed/, reason)
    assert.equal((db.prepare('SELECT count(*) AS n FROM outreach_messages').get() as { n: number }).n, 0, reason)
  }
  const db = setup()
  const { id } = addReviewLead(db, 'A', { reason: 'location_unconfirmed' })
  assert.equal(await confirmLeadReview(sqliteDb(db), 'A', id), true)
  assert.ok(createDraft(db, 'A', id, 'Acme'))
})

// #352 review follow-up: the three surfaces agree for every reason. Home's "review" (heldState) <=> the card offers a draftable confirm (reviewAction) <=> after the
// user confirms, the server draft gate lets it draft. Each research reason (a hold no check can change, a required check that could not run, a window hold) is refused.
test('#352: for every hold reason, Home, the Leads card and the draft gate agree on whether confirming makes the lead draftable', async () => {
  const outcome = async (reason: string) => {
    const db = setup()
    const { id, job } = addReviewLead(db, 'A', { reason })
    // A window hold is recorded only on a job whose request has a window; give those reasons the job and the stale date that produced them.
    const windowed = reason === 'outside_window' || reason === 'outside_window_undated'
    if (windowed) db.prepare("UPDATE scan_jobs SET icp = ?, query = 'roofers hiring in the past 30 days' WHERE id = ?").run(JSON.stringify({ window_days: 30 }), job)
    if (reason === 'outside_window') db.prepare("UPDATE leads SET event_date = '2025-01-01' WHERE id = ?").run(id)
    assert.equal(await confirmLeadReview(sqliteDb(db), 'A', id), true, reason)
    try { createDraft(db, 'A', id, 'Acme'); return 'drafted' } catch (e) { return (e as Error).message }
  }
  for (const reason of [...REVIEWABLE, ...RESEARCH_REASONS]) {
    const dated = { review_reason: reason, event_date: '2026-10-20', window_held: reason === 'outside_window' || reason === 'outside_window_undated' }
    const card = reviewAction(dated, new Date('2026-11-03T12:00:00Z')).label !== 'Keep as research'
    const home = heldState({ id: 'x', company: 'C', signal: 's', source_url: 'https://a.example', evidence_excerpt: 'e', event_date: '2026-10-20', date_status: 'verified', fit: 4, intent: 4, why: '', icp_match: null, company_domain: null, contact: null, quarantined_at: null, confidence: null, human_confirmed_at: null, currentness_held: false, enrichments: [], ...dated } as never)?.state === 'review'
    const server = (await outcome(reason)) === 'drafted'
    assert.equal(card, REVIEWABLE.has(reason), `${reason}: reviewable reasons, and only they, get a draftable confirm`)
    assert.ok(card === home && home === server, `${reason}: card=${card} home=${home} server=${server}`)
  }
})
