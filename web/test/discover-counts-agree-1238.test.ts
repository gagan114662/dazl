// #1238 / #684 / #1062 (staging 96111ddd, 2026-11-23): one search of the new engine, and every page counted its leads differently.
// Home said a lead was ready that had no action; Campaigns said "1 with a contact" beside a Leads page with no contact for anyone;
// the Leads page said "review" where the campaign's page said "research". A new-engine lead now has ONE state
// (lib/discover/card.ts discoverState) and every counter reads it. This test builds one search with every state in it and asks each
// page's own code for its numbers: they must be the same numbers.
import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { migrateAllSqlite } from '../lib/db/sqlite-migrations.ts'
import { sqliteDb } from '../lib/db/client.ts'
import { addEnrichment, enrichmentsForLeads } from '../lib/connectors/store.ts'
import { getJob, listLeads } from '../lib/scan/store.ts'
import { discoverCountsLine, discoverState, type DiscoverCounts } from '../lib/discover/card.ts'
import { discoverJobCounts } from '../lib/discover/state-db.ts'
import { previewSplit, journey, type PreviewLead } from '../lib/journey.ts'
import { leadHoldReason, timingOptsFor } from '../lib/outreach/lead-hold.ts'
import { historyCampaigns, listCampaigns } from '../lib/outreach/campaigns.ts'
import { campaignDetail } from '../lib/outreach/campaign-detail.ts'
import { leadStatus, qualificationLines } from '../lib/outreach/campaign-view.ts'
import { campaignStatus, currentQual, currentRun, runStatusOf } from '../lib/run-status.ts'
import { leadCardSummary } from '../lib/scan/lead-card.ts'

const T = 'A', J = 'a'.repeat(24)
// What every page must report for the search below.
const WANT: DiscoverCounts = { found: 9, ready: 2, ready_email: 1, ready_linkedin: 1, no_contact: 2, review: 2, research: 2, rejected: 1 }

function build() {
  const db = new Database(':memory:')
  migrateAllSqlite(db)
  db.prepare("INSERT INTO scan_jobs (id, user_id, business_name, industry, location, query, status, candidates, created_at) VALUES (?, ?, 'x', '(from request)', '-', 'B2B SaaS founders hiring their first salesperson', 'running', 9, 1000)").run(J, T)
  const lead = (id: string, o: { date?: string | null; review?: string | null; fit?: number | null; intent?: number | null; name?: string; rejected?: boolean } = {}) =>
    db.prepare(`INSERT INTO leads (id, scan_job_id, name, company, signal, source_url, confidence, evidence_excerpt, review_reason, event_date, fit, intent, company_domain, source_kind, quarantined_at)
      VALUES (?, ?, ?, ?, 'hiring a first salesperson', ?, 85, 'is hiring its first salesperson', ?, ?, ?, ?, ?, 'discover', ?)`)
      .run(id, J, o.name ?? '', `Co ${id}`, `https://jobs.example/${id}`, o.review ?? null, o.date === undefined ? '2026-11-10' : o.date, o.fit === undefined ? 4 : o.fit, o.intent === undefined ? 4 : o.intent, `${id}.example`, o.rejected ? 5 : null)
  const row = (id: string, kind: string, value: string, page = `https://${id}.example/team`) => addEnrichment(db, T, id, { connector: 'discover', kind, value, label: 'x', confidence: null, source_url: page, source_date: '2026-11-22', retrieved_at: 1 })
  const person = (id: string) => row(id, 'person', 'Dana Ruiz, Founder')
  const ownEmail = (id: string) => row(id, 'email', `dana.ruiz@${id}.example`)
  const profile = (id: string) => row(id, 'linkedin', 'https://www.linkedin.com/in/dana-ruiz/')

  lead('email'); person('email'); ownEmail('email')                                    // ready by email: Approve is on
  lead('linkedin'); person('linkedin'); profile('linkedin')                             // ready on LinkedIn: named person, own profile, no own address
  lead('nobody')                                                                        // no contact: dated proof, nobody named
  lead('inbox'); person('inbox'); row('inbox', 'email', 'info@inbox.example'); row('inbox', 'linkedin', 'https://www.linkedin.com/company/inbox/')   // no contact: a shared inbox and a company page reach nobody
  lead('unsure', { review: 'source_review_required' }); person('unsure'); ownEmail('unsure')   // review: proof page not confirmed, although an address is stored
  lead('unsure2', { review: 'source_review_required', date: null })                     // review: the user can still check the page
  lead('undated', { date: null }); person('undated'); profile('undated')                // research: no date. The staging lead Home called ready and Campaigns called "with a contact"
  lead('unfit', { fit: 0, intent: null }); person('unfit'); ownEmail('unfit')           // research: not graded a fit
  lead('gone', { rejected: true }); person('gone'); ownEmail('gone')                    // rejected by the user
  db.prepare("UPDATE scan_jobs SET status = 'done', verified = 7, needs_review = 2, dropped = 0 WHERE id = ?").run(J)
  return db
}
// The search's leads as GET /api/leads hands them to the browser: the row, its stored rows, the saved grade beside the shown one.
function apiLeads(db: Database.Database) {
  const rows = listLeads(db, T, J, 500, true) as (PreviewLead & { intent: number | null })[]
  const enr = enrichmentsForLeads(db, T, rows.map(l => l.id))
  return rows.map(l => ({ ...l, stored_intent: l.intent, gate_held: false, enrichments: enr[l.id] ?? [] })) as unknown as PreviewLead[]
}

test('one search, every state: Home, the Leads header, the Campaigns list, past scans and the campaign page report the same numbers', async () => {
  const db = build()
  const leads = apiLeads(db)
  assert.equal(leads.length, 9)

  // The Leads page header (GET /api/leads discover_counts).
  assert.deepEqual(await discoverJobCounts(sqliteDb(db), T, J), WANT, 'Leads header')

  // Home, the current search's card (lib/journey.ts previewSplit): "Leads ready", "need your review", "research only", "no contact yet".
  const split = previewSplit(leads)
  assert.deepEqual({ ready: split.opportunities.length, review: split.review.length, research: split.research.length, no_contact: split.noContact.length, rejected: split.rejected.length },
    { ready: WANT.ready, review: WANT.review, research: WANT.research, no_contact: WANT.no_contact, rejected: WANT.rejected }, 'Home card')
  assert.ok(split.opportunities.every(l => l.contactReady), 'every ready lead on Home has its contact')

  // Home's "Ready leads" tile and the checked list (lib/outreach/home-ready.ts judges each lead with leadHoldReason).
  const job = getJob(db, T, J) as { id: string; query: string | null; icp: string | null }
  const enr = enrichmentsForLeads(db, T, leads.map(l => l.id))
  const why = new Map(leads.map(l => [l.id, leadHoldReason(db, T, l as never, enr[l.id] ?? [], timingOptsFor(job), new Date('2026-11-23T12:00:00Z'))]))
  const tally = (reason: string | null) => [...why.values()].filter(x => x === reason).length
  assert.equal(tally(null), WANT.ready, 'Home tile: ready')
  assert.equal(tally('needs your review'), WANT.review, 'Home tile: review')
  assert.equal(tally('no contact found yet'), WANT.no_contact, 'Home tile: no contact')
  assert.equal(tally('rejected'), WANT.rejected, 'Home tile: rejected')
  assert.equal(why.get('undated'), 'the signal has no date, so its timing is unknown')
  assert.equal(why.get('unfit'), 'graded as not a fit for your profile')

  // The Campaigns list (GET /api/campaigns).
  const recorded = { id: J, status: 'done', error: null, query: 'q', candidates: 9, verified: 7, needs_review: 2, dropped: 0, lead_count: 9 }
  const card = campaignStatus(listCampaigns(db, T)[0], recorded as never)
  assert.deepEqual(card.qualification.discover, WANT, 'Campaigns list')
  assert.equal(card.discovery.leads, WANT.found)
  assert.deepEqual([card.qualification.sourceChecked + card.qualification.confirmedByYou, card.qualification.needsReview, card.qualification.research, card.qualification.noContact, card.qualification.rejected, card.qualification.unverified, card.qualification.held],
    [WANT.ready, WANT.review, WANT.research, WANT.no_contact, WANT.rejected, 0, 0], 'Campaigns list: the same leads in the funnel\'s own columns')
  assert.equal(card.contact.withContact, WANT.ready, '"with a contact" means ready by email or on LinkedIn, nothing else')
  assert.equal(card.contact.readyWithContact, WANT.ready)
  assert.deepEqual(qualificationLines(card.qualification, card.discovery.leads), ['2 ready (1 by email, 1 on LinkedIn)', '2 with no contact yet, 2 need your review, 2 research only, 1 rejected'])

  // Leads > Past scans (GET /api/campaigns/history).
  const past = campaignStatus((await historyCampaigns(db, sqliteDb(db), T, [J]))[0], recorded as never)
  assert.deepEqual(past.qualification.discover, WANT, 'Past scans')

  // One campaign's page (GET /api/campaigns/<id>, counted by currentQual).
  const detail = (await campaignDetail(sqliteDb(db), T, J))!
  const q = currentQual(detail.leads)
  assert.deepEqual(q.discover, WANT, 'Campaign page')
  assert.deepEqual([q.sourceChecked + q.confirmedByYou, q.needsReview, q.research, q.noContact, q.rejected, q.unverified], [WANT.ready, WANT.review, WANT.research, WANT.no_contact, WANT.rejected, 0])
  const page = currentRun(runStatusOf(recorded as never), q, 'q')

  // One sentence for the search, the same on all three.
  const line = '9 leads found: 2 ready (1 by email, 1 on LinkedIn), 2 with no contact yet, 2 need your review, 2 research only, 1 rejected'
  assert.equal(discoverCountsLine(WANT), line)
  assert.deepEqual([card.run?.label, past.run?.label, page.label], [line, line, line])
  assert.deepEqual([card.run?.tag, past.run?.tag, page.tag], ['Leads found', 'Leads found', 'Leads found'])

  // Lead by lead: the campaign page's label, the state, and the actions the Leads card offers agree.
  const status = new Map(detail.leads.map(l => [l.id, leadStatus(l, []).text]))
  assert.deepEqual(Object.fromEntries(status), {
    email: 'Ready - approve it to draft an email', linkedin: 'Ready - message them on LinkedIn', nobody: 'No contact found yet', inbox: 'No contact found yet',
    unsure: 'Needs your review', unsure2: 'Needs your review', undated: 'Research only - checking the source cannot make it ready', unfit: 'Research only - checking the source cannot make it ready', gone: 'Rejected' })
  for (const l of leads) {
    const s = discoverState(l as never), c = leadCardSummary(l as never)
    assert.equal(s, detail.leads.find(x => x.id === l.id)!.discover_state, `${l.id}: the server's state is the browser's state`)
    assert.equal(c.approve.ok, s === 'ready_email', `${l.id}: Approve is on exactly when it is ready by email`)
    assert.equal(!!c.linkedin && !c.approve.ok, s === 'ready_linkedin', `${l.id}: Message on LinkedIn is the action exactly when it is ready on LinkedIn`)
  }
})

test('Home never calls a lead ready that has no action: a search with proof but nobody to reach says so and counts 0 ready', () => {
  const db = build()
  db.prepare("DELETE FROM leads WHERE id NOT IN ('nobody', 'inbox')").run()
  const play = { id: J, status: 'done', error: null, query: 'q', csv_domain: null, created_at: 1, candidates: 2, verified: 2, needs_review: 0, dropped: 0, lead_count: 2, test_only: false }
  const j = journey({ profile: { sells: 'x' }, jobs: [play], leads: apiLeads(db), drafts: null })
  assert.equal(j.stage, 'no_contact')
  assert.equal(j.split?.opportunities.length, 0)
  assert.equal(j.line, '0 opportunities. 2 leads have proof but no contact found yet.')
  assert.equal(listCampaigns(db, T)[0].next.label, '2 leads have proof but no contact yet. Open the search to see them')
})

test('an older-engine lead in the same account keeps its own rules', async () => {
  const db = build()
  const O = 'b'.repeat(24)
  db.prepare("INSERT INTO scan_jobs (id, user_id, business_name, industry, location, query, status, created_at) VALUES (?, ?, 'x', '(from request)', '-', 'older search', 'running', 2000)").run(O, T)
  db.prepare("INSERT INTO leads (id, scan_job_id, company, signal, source_url, confidence, evidence_excerpt, contact) VALUES ('old', ?, 'Old Co', 'opened an office', 'https://news.example/x', 80, 'Old Co opened an office', 'hi@old.example')").run(O)
  db.prepare("UPDATE scan_jobs SET status = 'done' WHERE id = ?").run(O)
  const c = listCampaigns(db, T).find(x => x.id === O)!
  assert.equal(c.qualification.discover, undefined)
  assert.deepEqual([c.qualification.sourceChecked, c.contact.withContact, c.qualification.noContact], [1, 1, undefined])
  assert.equal(await discoverJobCounts(sqliteDb(db), T, O), null)
})
