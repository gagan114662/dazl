// #683 (part of #352): research-only leads are never counted or shown as actionable review items on any page.
// The live audit's NYC dental run had 2 held leads that no check could make ready (no usable date; someone else's customer),
// yet Campaigns said "Check 2 leads that need your review", the campaign page said "Needs your review" on every lead, and
// Home's checklist said "2 leads in this search need your review" with a Review leads button. Every surface now counts by the
// one verdict Home's journey and the Leads cards already use (lib/lead-state.ts reviewIsActionable / heldState).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { migrateAllSqlite } from '../lib/db/sqlite-migrations.ts'
import { sqliteDb } from '../lib/db/client.ts'
import { listCampaigns } from '../lib/outreach/campaigns.ts'
import { campaignDetail } from '../lib/outreach/campaign-detail.ts'
import { leadStatus } from '../lib/outreach/campaign-view.ts'
import { campaignStatus, currentQual, currentRun, runStatusOf } from '../lib/run-status.ts'
import { readyItems } from '../lib/ready-card.ts'
import type { ReadinessInput } from '../lib/readiness.ts'
import { reviewIsActionable, heldState } from '../lib/lead-state.ts'
import { previewSplit, type PreviewLead } from '../lib/journey.ts'
import { qualificationLines } from '../lib/outreach/campaign-view.ts'
import { recentPlays } from '../lib/readiness.ts'
import { requiredGateHeld } from '../lib/scan/held-state.ts'
import { currentnessHeld } from '../lib/outreach/currentness.ts'

const DAY = 86_400_000
const recent = new Date(Date.now() - 10 * DAY).toISOString().slice(0, 10)
let t = 1000
function setup() { const db = new Database(':memory:'); migrateAllSqlite(db); return db }
function job(db: Database.Database, user: string, id: string, query: string, windowDays: number | null) {
  db.prepare("INSERT INTO scan_jobs (id, user_id, business_name, industry, location, query, icp, status, candidates, created_at) VALUES (?, ?, 'x', '(from request)', '-', ?, ?, 'running', 5, ?)")
    .run(id, user, query, windowDays === null ? null : JSON.stringify({ window_days: windowDays }), t++)
}
const finish = (db: Database.Database, id: string) => db.prepare("UPDATE scan_jobs SET status = 'done' WHERE id = ?").run(id)
// review: an unverified lead in the review list. machine: a source-checked lead (quote on the page).
function lead(db: Database.Database, jobId: string, id: string, o: { review?: string | null; machine?: boolean; date?: string | null; confirmedFrom?: string | null }) {
  db.prepare("INSERT INTO leads (id, scan_job_id, company, signal, source_url, confidence, evidence_excerpt, review_reason, event_date, human_confirmed_at, human_confirmed_from) VALUES (?, ?, ?, 'hiring a receptionist', 'https://news.example/x', ?, ?, ?, ?, ?, ?)")
    .run(id, jobId, `Co ${id}`, o.machine ? 80 : null, o.machine ? 'Co is hiring a receptionist' : null, o.review ?? null, o.date ?? null, o.confirmedFrom ? 5 : null, o.confirmedFrom ?? null)
}
const NYC = 'Dental practices in New York hiring front desk staff'

// The audit's NYC zero-ready run (and the London shapes: a different place, a closed opening) in one workspace.
function nyc() {
  const db = setup()
  job(db, 'A', 'jn', NYC, 90)
  lead(db, 'jn', 'n1', { review: 'outside_window_undated' })       // no usable date
  lead(db, 'jn', 'n2', { review: 'counterparty_signal', date: recent }) // someone else's customer
  finish(db, 'jn')
  return db
}

test('NYC run on Campaigns: 0 to review, 2 research only, and the next step changes the search instead of asking for a review', () => {
  const [c] = listCampaigns(nyc(), 'A')
  assert.equal(c.qualification.needsReview, 0, 'research-only leads are not review items')
  assert.equal(c.qualification.research, 2)
  assert.deepEqual(c.next, { label: '2 research-only leads: checking them cannot make them ready. Change the search', href: `/app/leads?q=${encodeURIComponent(NYC)}` })
  assert.doesNotMatch(c.next.label, /review/i)
})

test('NYC run on its campaign page: tag, label, next step and every lead row say research only, never "needs your review"', async () => {
  const db = nyc()
  const d = (await campaignDetail(sqliteDb(db), 'A', 'jn'))!
  assert.deepEqual(d.leads.map(l => l.window_held), [true, false], 'the undated lead is held by the 90-day window; the dated one is not')
  const q = currentQual(d.leads)
  assert.equal(q.needsReview, 0); assert.equal(q.research, 2)
  const recorded = runStatusOf({ id: 'jn', status: 'done', error: null, candidates: 5, verified: 0, needs_review: 2, dropped: 3, lead_count: 2 } as never)
  assert.equal(recorded.tag, 'Needs your review', 'the scan-time record called them review items')
  const run = currentRun(recorded, q, NYC)
  assert.equal(run.tag, 'Research only')
  assert.equal(run.label, '2 leads found: 0 source-checked, 0 confirmed by you, 0 need your review, 2 research only, 0 rejected')
  assert.deepEqual(run.next, { text: 'Change the search', href: `/app/leads?q=${encodeURIComponent(NYC)}` })
  assert.match(run.detail ?? '', /cannot make them ready/)
  for (const l of d.leads) assert.deepEqual(leadStatus(l, []), { stage: 'research', text: 'Research only - checking the source cannot make it ready' })
  // The Campaigns list row (campaignStatus) keeps the funnel's research next step, not a review prompt.
  const [c] = listCampaigns(db, 'A')
  const row = campaignStatus(c, { id: 'jn', status: 'done', error: null, candidates: 5, verified: 0, needs_review: 2, dropped: 3, lead_count: 2 } as never)
  assert.equal(row.run?.tag, 'Research only'); assert.doesNotMatch(row.next.label, /review/i)
})

const base: ReadinessInput = {
  profile: { website: 'https://www.brightsmile.example', sells: 'Online booking for dental practices', business_name: 'Brightsmile', buyer: { summary: 'Independent dental practices', who: ['Practice owner'] } },
  usage: { has_key: true }, keys: [{ vendor: 'anthropic', last4: 'Ab12', validated_at: 1 }], rejection: null,
  outreach: { gmail: { email: 'dana@brightsmile.example', status: 'active' }, sender: { sender_name: 'Dana Smith', postal_address: '1 Main St' }, daily_cap: 20 },
  sources: { web_index: false, news: true, websites: true }, advanced: { available: true, platforms: [] },
  jobs: [{ id: 'jn', status: 'done', error: null, query: NYC, csv_domain: null, created_at: 1, lead_count: 2 }], totals: { searches: 1, finished: 1 }, messages: [],
}

test('NYC run on Home: the Qualified-lead step names research only, with a step that can change the result, not "need your review"', () => {
  const camps = listCampaigns(nyc(), 'A')
  const q = readyItems({ ...base, campaigns: camps }).find(x => x.id === 'qualified')!
  assert.equal(q.state, 'todo')
  assert.equal(q.detail, '2 leads in this search are research only - checking them cannot make them ready. Search again with a different signal or source')
  assert.deepEqual(q.fix, { href: `/app/leads?q=${encodeURIComponent(NYC)}`, label: 'Change the search' })
})

test('Home journey agrees: 0 review, 2 research, stage research_only (the surface that was already right stays right)', () => {
  const pl = (o: Partial<PreviewLead>): PreviewLead => ({ id: 'x', company: 'Co', evidence_excerpt: null, confidence: null, human_confirmed_at: null, quarantined_at: null, ...o } as PreviewLead)
  const s = previewSplit([pl({ id: 'n1', review_reason: 'outside_window_undated', window_held: true }), pl({ id: 'n2', review_reason: 'counterparty_signal' })])
  assert.equal(s.review.length, 0); assert.equal(s.research.length, 2)
})

test('mixed run: only leads a check can release are review items; window-held, other-place, unknown-reason and window-held source-checked leads are research', () => {
  const db = setup()
  job(db, 'A', 'jm', 'Dental practices in New York', 90)
  lead(db, 'jm', 'm1', { review: 'quote_unconfirmed', date: recent })   // a check can release it
  lead(db, 'jm', 'm2', { review: 'quote_unconfirmed' })                 // reviewable reason, but no date under a window: research
  lead(db, 'jm', 'm3', { review: 'location_mismatch', date: recent })   // a different place
  lead(db, 'jm', 'm4', { review: 'made_up_reason', date: recent })      // unknown: fails closed to research
  lead(db, 'jm', 'm5', { machine: true })                                // source-checked, undated under a window: held, research
  lead(db, 'jm', 'm6', { machine: true, date: recent })                  // source-checked, timing proof missing: held, a timing review can help
  lead(db, 'jm', 'm7', { review: null, confirmedFrom: 'job_closed', date: recent }) // confirmed out of a closed opening: held, research
  finish(db, 'jm')
  // Another tenant's research-only lead never leaks into A's counts.
  job(db, 'B', 'jb', 'B', 90); lead(db, 'jb', 'b1', { review: 'outside_window_undated' }); finish(db, 'jb')
  const [c, ...rest] = listCampaigns(db, 'A')
  assert.equal(rest.length, 0)
  const { needsReview, research, held, heldResearch } = c.qualification
  assert.deepEqual({ needsReview, research, held, heldResearch }, { needsReview: 1, research: 3, held: 3, heldResearch: 2 })
  assert.deepEqual(c.next, { label: 'Check 1 lead that needs your review', href: '/app/leads?job_id=jm' })
  const q = readyItems({ ...base, campaigns: [c] }).find(x => x.id === 'qualified')!
  assert.equal(q.detail, '2 leads in this search need your review - open the list to see why each was held', 'm1 plus the timing-held m6; not the 5 research-only leads')
  assert.deepEqual(q.fix, { href: '/app/leads?job_id=jm', label: 'Review leads' })
})

test('a held lead only a time window, a different place, a closed opening or a failed required check holds is never "review the source to confirm timing"', () => {
  const db = setup()
  job(db, 'A', 'jh', 'Dental practices in New York', 90)
  lead(db, 'jh', 'h1', { machine: true })                                     // undated under the window
  lead(db, 'jh', 'h2', { review: null, confirmedFrom: 'location_mismatch', date: recent })
  finish(db, 'jh')
  const [c] = listCampaigns(db, 'A')
  assert.equal(c.qualification.held, 2); assert.equal(c.qualification.heldResearch, 2)
  assert.doesNotMatch(c.next.label, /review|confirm timing/i)
  assert.equal(c.next.label, '2 research-only leads: checking them cannot make them ready. Change the search')
})

test('the shared verdict: malformed reasons and window flags fail closed to research; Home and every other page agree on every known reason', () => {
  for (const r of [null, undefined, '', 'constructor', '__proto__', 'toString', 42, true, ['quote_unconfirmed'], { r: 1 }, 'QUOTE_UNCONFIRMED', 'quote_unconfirmed ', 'x'.repeat(10_000), '\uFFFD\uD800'])
    assert.equal(reviewIsActionable({ review_reason: r }), false, `reason ${JSON.stringify(r)?.slice(0, 40)}`)
  for (const w of [true, 1, 'yes', {}, []]) assert.equal(reviewIsActionable({ review_reason: 'quote_unconfirmed', window_held: w }), false, `window_held ${JSON.stringify(w)}`)
  for (const w of [false, 0, null, undefined, '']) assert.equal(reviewIsActionable({ review_reason: 'quote_unconfirmed', window_held: w }), true)
  const known = ['quote_unconfirmed', 'blocked_by_site', 'needs_javascript', 'login_required', 'location_unconfirmed', 'no_event_evidence', 'no_sales_hiring_evidence', 'source_review_required', 'self_description', 'trial_budget_reached', 'legacy_currentness_review', 'event_timing_unconfirmed', 'event_date_bad_date', 'event_date_future_date', 'event_date_stale', 'first_party_signal', 'outside_window', 'outside_window_undated', 'counterparty_signal', 'location_mismatch', 'job_closed', 'sales_hiring_check_failed']
  for (const r of known) for (const w of [false, true]) {
    const home = heldState({ id: 'x', review_reason: r, window_held: w, quarantined_at: null } as never)?.state === 'review'
    assert.equal(reviewIsActionable({ review_reason: r, window_held: w }), home, `${r} window=${w}`)
    assert.equal(currentQual([{ evidence_excerpt: null, confidence: null, human_confirmed_at: null, review_reason: r, quarantined_at: null, window_held: w }]).needsReview, home ? 1 : 0, `campaign page ${r} window=${w}`)
  }
})

// Hermes-PC review at a3b64f05, findings 1 and 2: for ONE held source-checked lead, every surface tells the same story -
// the Campaigns card's run pill and label, its funnel next step and Qualification stage, the campaign page's tag, label and
// rows, and Home's plays. (1) a window-held, undated, machine-verified lead; (2) the London Test B shape: a sales-hiring
// request, a dated machine-verified lead, no gate pass record (DEFAULT-DENY).
async function agree(db: Database.Database, jobId: string, query: string) {
  const rec = { id: jobId, status: 'done', error: null, candidates: 5, verified: 1, needs_review: 0, dropped: 4, lead_count: 1 } as never
  const [c] = listCampaigns(db, 'A')
  const card = campaignStatus(c, rec)
  const d = (await campaignDetail(sqliteDb(db), 'A', jobId))!
  const page = currentRun(runStatusOf(rec), currentQual(d.leads), query)
  assert.equal(card.run?.tag, page.tag, 'card pill = campaign page tag')
  assert.equal(card.run?.label, page.label, 'card label = campaign page label')
  assert.equal(page.tag, 'Research only')
  assert.equal(page.label, '1 lead found: 0 source-checked, 0 confirmed by you, 0 need your review, 1 research only, 0 rejected')
  assert.match(card.next.label, /^1 research-only lead: checking it cannot make it ready\. Change the search$/)
  const [value, detail] = qualificationLines(c.qualification, c.discovery.leads)
  assert.equal(value, '0 source-checked, 0 confirmed by you, 0 to review'); assert.match(detail ?? '', /, 1 research only, /)
  assert.deepEqual(d.leads.map(l => leadStatus(l, []).text), ['Research only - checking the source cannot make it ready'])
  const [play] = recentPlays([{ id: jobId, status: 'done', error: null, query, csv_domain: null, created_at: 1, lead_count: 1, candidates: 5, verified: 1, needs_review: 0, dropped: 4 }], 1, [{ ...c, id: jobId }])
  assert.match(play.outcome, /^0 source-checked, 0 need your review, 1 research-only$/)
}

test('#683 review finding 1: a window-held source-checked lead reads research only on the card pill, its label, the funnel, the campaign page and Home', async () => {
  const db = setup()
  job(db, 'A', 'jw', NYC, 90)
  lead(db, 'jw', 'w1', { machine: true })   // machine-verified, undated: the 90-day window holds it
  finish(db, 'jw')
  assert.equal(currentnessHeld(db, 'A', 'w1'), true, 'the draft gate holds it')
  await agree(db, 'jw', NYC)
})

test('#683 review finding 2: a DEFAULT-DENY required-gate hold (London Test B shape) reads research only on every surface', async () => {
  const db = setup()
  const LONDON = 'Find London UK companies hiring sales account executives.'
  job(db, 'A', 'jl', LONDON, null)
  lead(db, 'jl', 'l1', { machine: true, date: recent })   // dated, machine-verified, no gate pass record
  finish(db, 'jl')
  assert.equal(requiredGateHeld(db, 'A', 'l1'), 'sales_hiring_check_failed'); assert.equal(currentnessHeld(db, 'A', 'l1'), true)
  await agree(db, 'jl', LONDON)
})
