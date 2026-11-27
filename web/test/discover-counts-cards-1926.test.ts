// #1926 Part A (Quest live check on prod 2a148c60, comment 7226366442): a scan's summary line (discoverJobCounts /
// discoverCountsLine, the ONE state in lib/discover/card.ts) disagrees with the scan's own cards on existing stored
// scans. What the stored record itself decides, and what it does not:
//
//   Shape 3 — "0 on LinkedIn" but a card in To decide says "Ready to reach on LinkedIn". The person's own
//   published address exists but cannot be used (on the do-not-contact list, undeliverable, or not the company's
//   own site/domain), so Approve is off and the card offers the LinkedIn action. The state buried the lead in
//   no_contact. FIXED here: the state names ready_linkedin for exactly that lead, and the counts' ready total is
//   the sum of its parts. Home's rule does NOT move: a usable work email is what makes a lead ready there
//   (#2007), so discoverNotReady keeps the no-contact words for a ready_linkedin lead — the Austin replay and
//   lead-results-1707 pin that surface, and the last test below pins it here too.
//
//   Shapes 1+2 — "1 ready (1 by email), 0 research only" / "1 with no contact yet, 0 research only", but the
//   cards sit under Research only. The card side of that split is the page's timing rule (surfaceStoredIntent):
//   a stored date with no stored proof token (event_date_proof NULL) is timing-unconfirmed there. But that
//   stored shape is also exactly what the writer leaves for a date the checker CONFIRMED from the page's own
//   structured markup or a printed relative age (date_on_page false at check time, so no proof token is stored;
//   probe-verified against lib/discover/check.ts + lib/scan/runner.ts discoveredLead), and #1910 pins the state
//   Ready for it (timing-proof-1910). date_status cannot separate the two — it covers structured postings and
//   legacy dates as well as index dates (lib/discover/timing.ts says so) — and the index dates it could identify
//   are already held by their timing_note. So the state does NOT re-hold that shape; the two boundary tests
//   below pin both facts (the counts' verdict, and the card's Research placement by the page's own split) so
//   the disagreement is on record and neither side is "fixed" into the other from here. What the state holds
//   for a date is unchanged: no date, an index date (its note), a stale date, a required check, a rejection.
//
// Every scan below is built from stored rows the way the discovery writer leaves them (lib/scan/runner.ts
// discoveredLead: a page-printed date gets event_date_proof 'page_bound' and date_status 'verified'; a
// checker-confirmed structured/relative-age date keeps the date with event_date_proof NULL, date_status
// 'unverified' and no index note; an index date carries the index note in timing_note; intent is the saved
// grade, fit 4). Controls pin the shapes that must not move.
import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { migrateAllSqlite } from '../lib/db/sqlite-migrations.ts'
import { sqliteDb } from '../lib/db/client.ts'
import { addEnrichment, enrichmentsForLeads } from '../lib/connectors/store.ts'
import { getJob, listLeads } from '../lib/scan/store.ts'
import { discoverCounts, discoverCountsLine, discoverNotReady, discoverState } from '../lib/discover/card.ts'
import { discoverJobCounts } from '../lib/discover/state-db.ts'
import { isUnconfirmedTimingResearch } from '../lib/lead-state.ts'
import { reviewListSplit } from '../lib/scan/leads-view.ts'
import { leadCardSummary } from '../lib/scan/lead-card.ts'
import { surfaceStoredIntent } from '../lib/scan/scoreboard.ts'
import { timingOptsFor } from '../lib/outreach/lead-hold.ts'
import { discoverRecipientRefusal } from '../lib/outreach/service.ts'
import { confirmLeadReview } from '../lib/scan/review-confirm.ts'
import { AUSTIN_ENRICHMENTS, AUSTIN_LEADS } from './fixtures/austin-0e6a919e.ts'

const T = 'A'
const daysAgo = (n: number) => new Date(Date.now() - n * 86400_000).toISOString().slice(0, 10)
const INDEX_NOTE = 'The page prints no date. This is the day the search index dates the page.'

function buildDb() {
  const db = new Database(':memory:')
  migrateAllSqlite(db)
  return db
}
let seq = 0
function job(db: Database.Database): string {
  const id = String(++seq).padStart(24, 'a')
  db.prepare("INSERT INTO scan_jobs (id, user_id, business_name, industry, location, query, status, candidates, created_at) VALUES (?, ?, 'x', '(from request)', '-', 'companies opening another site', 'running', 1, 1000)").run(id, T)
  return id
}
const finish = (db: Database.Database, id: string) => db.prepare("UPDATE scan_jobs SET status = 'done' WHERE id = ?").run(id)
// A discovery lead as the lane's writer stores it. proof: 'page_bound' (printed date), null with note null
// (checker-confirmed structured/relative-age date), or null with the index note (search-index date).
function lead(db: Database.Database, jobId: string, id: string, o: { proof?: string | null; note?: string | null; review?: string | null } = {}) {
  const proof = o.proof === undefined ? 'page_bound' : o.proof
  db.prepare(`INSERT INTO leads (id, scan_job_id, name, company, signal, source_url, confidence, evidence_excerpt, review_reason, event_date, event_date_proof, date_status, timing_note, fit, intent, company_domain, source_kind)
    VALUES (?, ?, ?, ?, 'opening another site', ?, 85, 'is opening another site', ?, ?, ?, ?, ?, 4, 4, ?, 'discover')`)
    .run(id, jobId, 'Dana Ruiz', `Co ${id}`, `https://news.example/${id}`, o.review ?? null, daysAgo(10), proof, proof ? 'verified' : 'unverified', o.note ?? null, `${id}.example`)
}
const row = (db: Database.Database, id: string, kind: string, value: string, label: string | null, sourceUrl?: string) =>
  addEnrichment(db, T, id, { connector: 'discover', kind, value, label, confidence: null, source_url: sourceUrl ?? `https://${id}.example/team`, source_date: daysAgo(10), retrieved_at: 1 })
const person = (db: Database.Database, id: string) => row(db, id, 'person', 'Dana Ruiz, Founder', 'named on a public page')
const ownEmail = (db: Database.Database, id: string) => row(db, id, 'email', `dana.ruiz@${id}.example`, 'published on a public page')
const profile = (db: Database.Database, id: string) => row(db, id, 'linkedin', 'https://www.linkedin.com/in/dana-ruiz/', 'linked from a public page')

// The scan's leads as GET /api/leads hands them to the page: the stored row, its stored rows, the timing the
// route computes from the stored proof, the server's recipient verdict, the saved grade beside the shown one.
type CardLeadRow = Record<string, unknown> & { id: string }
function cardLeads(db: Database.Database, jobId: string): CardLeadRow[] {
  const rows = listLeads(db, T, jobId, 500, true) as unknown as Record<string, unknown>[]
  const enr = enrichmentsForLeads(db, T, rows.map(l => l.id as string))
  const timing = timingOptsFor(getJob(db, T, jobId) as never)
  return rows.map(l => {
    const t = surfaceStoredIntent(l as never, timing)
    return { ...l, id: l.id as string, stored_intent: l.intent as number | null, intent: t.intent, timing: t.timing,
      recipient_refused: discoverRecipientRefusal(db, T, l.id as string), gate_held: false, enrichments: enr[l.id as string] ?? [] }
  })
}
// The buckets the Leads page itself builds (leads-client): the Research only section is reviewListSplit's research
// plus the unconfirmed-timing leads; the rest of the review list is To decide / Needs your review.
function buckets(db: Database.Database, jobId: string) {
  const leads = cardLeads(db, jobId)
  const split = reviewListSplit(leads as never) as unknown as { research: CardLeadRow[]; review: CardLeadRow[] }
  const research = new Set([...split.research.map(l => l.id), ...leads.filter(l => isUnconfirmedTimingResearch(l as never)).map(l => l.id)])
  const review = new Set(split.review.map(l => l.id))
  const cards = new Map(leads.map(l => [l.id as string, leadCardSummary(l as never)]))
  const byId = new Map(leads.map(l => [l.id as string, l]))
  return { research, review, cards, byId }
}

test('shape 3: an own address that cannot be used (do-not-contact) with the person\'s LinkedIn profile counts ready on LinkedIn, as its card says', async () => {
  const db = buildDb()
  const J = job(db)
  lead(db, J, 's3'); person(db, 's3'); ownEmail(db, 's3'); profile(db, 's3')
  db.prepare("INSERT INTO suppressions (tenant_id, email, reason) VALUES (?, ?, 'manual')").run(T, 'dana.ruiz@s3.example'); finish(db, J)
  const counts = await discoverJobCounts(sqliteDb(db), T, J)
  const b = buckets(db, J)
  const card = b.cards.get('s3')!
  assert.equal(card.approve.ok, false, 'Approve is off: the address is on the do-not-contact list')
  assert.ok(card.linkedin, 'the card offers the person\'s LinkedIn profile: "Ready to reach on LinkedIn"')
  assert.equal(b.research.has('s3'), false, 'the card is in To decide, not Research only')
  assert.equal(counts?.no_contact, 0, 'the summary must not call it "no contact yet": a contact route is ready')
  assert.equal(counts?.ready_linkedin, 1, 'the summary counts it ready on LinkedIn, like the card')
  assert.equal(counts?.ready, 1)
  assert.equal(discoverCountsLine(counts!), '1 lead found: 1 ready (0 by email, 1 on LinkedIn), 0 with no contact yet, 0 need your review, 0 research only, 0 rejected')
  // Home's surface does not move with the counts: the same lead is held there, with the no-contact words
  // (austin-ready-replay-1910 and lead-results-1707 pin this on their own fixtures).
  assert.equal(discoverNotReady(b.byId.get('s3') as never), 'no contact found yet', 'Home still holds it: ready there requires a usable work email (#2007)')
})

test('shape 3: an own address published off the company\'s site, with the person\'s profile, counts ready on LinkedIn', async () => {
  const db = buildDb()
  const J = job(db)
  lead(db, J, 's3b'); person(db, 's3b'); profile(db, 's3b')
  row(db, 's3b', 'email', 'dana.ruiz@elsewhere.example', 'published on a public page', 'https://press.example/dana-ruiz'); finish(db, J)
  const counts = await discoverJobCounts(sqliteDb(db), T, J)
  const b = buckets(db, J)
  assert.equal(b.cards.get('s3b')!.approve.ok, false, 'Approve is off: the address is not the company\'s own')
  assert.ok(b.cards.get('s3b')!.linkedin, 'the card offers the LinkedIn action')
  assert.equal(counts?.ready_email, 0)
  assert.equal(counts?.ready_linkedin, 1, 'the summary counts it ready on LinkedIn, like the card')
  assert.equal(counts?.no_contact, 0)
})

test('shape 3: an own address the deliverability check rejected, with the person\'s profile, counts ready on LinkedIn', async () => {
  const db = buildDb()
  const J = job(db)
  lead(db, J, 's3c'); person(db, 's3c'); ownEmail(db, 's3c'); profile(db, 's3c')
  addEnrichment(db, T, 's3c', { connector: 'mailbox-check', kind: 'deliverability', value: 'dana.ruiz@s3c.example|rejected', label: null, confidence: null, source_url: `https://s3c.example/team`, source_date: daysAgo(10), retrieved_at: 2 })
  finish(db, J)
  const counts = await discoverJobCounts(sqliteDb(db), T, J)
  assert.equal(counts?.ready_linkedin, 1, 'the summary counts it ready on LinkedIn: the mailbox is refused, the profile is the route')
  assert.equal(counts?.ready_email, 0)
  assert.equal(counts?.no_contact, 0)
})

test('the captured Austin lead with its date proven afterwards: the counts name its LinkedIn channel; Home still holds it for no contact', () => {
  // The real captured lead (test/fixtures/austin-0e6a919e.ts, prod job 0e6a919e) after the replay's own update:
  // an exact, dated first-party posting is persisted (page_bound), leaving its published address — a .invalid
  // address on the company's own team page — still not a usable work email on the company domain.
  const target = AUSTIN_LEADS.find(l => l.company_domain && l.name && !l.event_date)!
  const enrichments = AUSTIN_ENRICHMENTS.filter(e => e.lead_id === target.id)
    .map(e => ({ connector: 'discover', kind: e.kind, value: e.value, label: e.label, source_url: e.source_url }))
  const leadRow = { source_kind: 'discover', name: target.name, company_domain: target.company_domain, signal: target.signal,
    event_date: '2026-11-25', date_status: 'verified', event_date_proof: 'page_bound', review_reason: null,
    fit: null, intent: null, enrichments }
  assert.equal(discoverState(leadRow as never), 'ready_linkedin', 'the state names the channel its card offers')
  const counts = discoverCounts([discoverState(leadRow as never)])
  assert.equal(counts.ready, 1)
  assert.equal(counts.ready_linkedin, 1)
  assert.equal(counts.no_contact, 0)
  assert.equal(discoverNotReady(leadRow as never), 'no contact found yet',
    'Home holds it with the no-contact words: date proof alone cannot supply a named buyer\'s published work email (#1910)')
})

test('boundary (shapes 1+2): a checker-confirmed structured/relative-age date is counted by its contact, as #1910 pins — its card\'s Research place is the page timing split\'s, not the state\'s', async () => {
  const db = buildDb()
  const J = job(db)
  lead(db, J, 'b1', { proof: null }); person(db, 'b1'); ownEmail(db, 'b1')
  lead(db, J, 'b2', { proof: null })
  finish(db, J)
  const counts = await discoverJobCounts(sqliteDb(db), T, J)
  const b = buckets(db, J)
  // The state's verdicts, pinned by timing-proof-1910 for this exact stored shape: the date was confirmed by
  // the checker, so the state judges the contact, not the missing proof token.
  assert.equal(counts?.ready_email, 1, 'the dated lead with a usable published email counts ready by email (#1910)')
  assert.equal(counts?.no_contact, 1, 'the dated lead with nobody to reach counts as no contact yet (#1910)')
  assert.equal(counts?.research, 0)
  // The page's own split still places both cards under Research only: its timing rule reads the stored proof
  // token, which the writer does not store for this date kind. Recorded here so the residual is a pinned fact,
  // not a surprise; aligning it belongs to the writer/route, and re-holding the date in the state is what
  // broke #1910 (and, through discoverLinkedIn, the LinkedIn card action).
  assert.equal(b.research.has('b1'), true, 'the page timing split places the proof-token-less card under Research only')
  assert.equal(b.research.has('b2'), true)
})

test('control: an index-dated lead is research in the counts, as its card is — held by its note, not by date_status', async () => {
  const db = buildDb()
  const J = job(db)
  lead(db, J, 'ix', { proof: null, note: INDEX_NOTE }); person(db, 'ix'); ownEmail(db, 'ix'); finish(db, J)
  const counts = await discoverJobCounts(sqliteDb(db), T, J)
  const b = buckets(db, J)
  assert.equal(b.research.has('ix'), true, 'the card sits under Research only')
  assert.equal(counts?.research, 1, 'the summary counts it research, like the card')
  assert.equal(counts?.ready_email, 0)
})

test('control: a genuinely Ready lead counts ready_email and renders a Ready card', async () => {
  const db = buildDb()
  const J = job(db)
  lead(db, J, 'ok'); person(db, 'ok'); ownEmail(db, 'ok'); finish(db, J)
  const counts = await discoverJobCounts(sqliteDb(db), T, J)
  const b = buckets(db, J)
  assert.equal(counts?.ready_email, 1)
  assert.equal(counts?.ready, 1)
  assert.equal(b.cards.get('ok')!.approve.ok, true, 'Approve is on')
  assert.equal(b.research.has('ok'), false)
})

test('control: a LinkedIn-only lead with no address of the person\'s own stays no_contact, its card still offering the profile (#2007)', async () => {
  const db = buildDb()
  const J = job(db)
  lead(db, J, 'li'); person(db, 'li'); profile(db, 'li'); finish(db, J)
  const counts = await discoverJobCounts(sqliteDb(db), T, J)
  const b = buckets(db, J)
  assert.equal(counts?.no_contact, 1, 'no usable work email: not counted ready (#2007)')
  assert.equal(counts?.ready_linkedin, 0)
  assert.equal(b.cards.get('li')!.approve.ok, false)
  assert.ok(b.cards.get('li')!.linkedin, 'the manual LinkedIn action stays on the card')
  assert.equal(b.research.has('li'), false)
})

test('control: a lead the person confirmed themselves is usable on their confirmation, in the counts as on the card', async () => {
  const db = buildDb()
  const J = job(db)
  lead(db, J, 'cf', { proof: null, review: 'source_review_required' }); person(db, 'cf'); ownEmail(db, 'cf'); finish(db, J)
  assert.equal(await confirmLeadReview(sqliteDb(db), T, 'cf'), true, 'the person checked the source and confirmed the lead')
  const counts = await discoverJobCounts(sqliteDb(db), T, J)
  const b = buckets(db, J)
  assert.equal(b.research.has('cf'), false, 'the page does not hold a confirmed lead under Research only for its timing')
  assert.equal(b.cards.get('cf')!.approve.ok, true, 'Approve is on under the person\'s own confirmation')
  assert.equal(counts?.ready_email, 1, 'the counts follow the same confirmation')
  assert.equal(counts?.research, 0)
})
