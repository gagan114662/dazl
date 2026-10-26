import { seedOffers } from './helpers/seed-offer.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import Database from 'better-sqlite3'
import { migrateScan, createQueryJob } from '../lib/scan/store.ts'
import { migrateOutreach } from '../lib/outreach/store.ts'
import { migrateConnectors } from '../lib/connectors/store.ts'
import { createDraft } from '../lib/outreach/service.ts'
import { currentnessHeld, leadWindowHeld } from '../lib/outreach/currentness.ts'
import { confirmLeadReview } from '../lib/scan/review-confirm.ts'
import { windowStatus, splitByWindow, windowCutoff } from '../lib/scan/window.ts'
import { recencyAnchor } from '../lib/scan/runner.ts'

// #198 (Instinct's blocking reproduction): the user's recency window is a hard outreach gate. Ordinary source review
// (confirmLeadReview) must not make a stale, undated, invalid or future-dated lead draftable, and the date-only
// boundary must match what recencyAnchor tells the model.
const NOW = new Date('2026-10-26T12:00:00Z')

test('date-only, inclusive boundary agrees with recencyAnchor', () => {
  assert.equal(windowCutoff(90, NOW), '2026-07-28')
  assert.match(recencyAnchor(NOW, 90), /on or after 2026-07-28/)
  assert.equal(windowStatus('2026-07-28', 90, NOW), 'inside', 'the cutoff day itself is inside')
  assert.equal(windowStatus('2026-07-27', 90, NOW), 'stale')
  assert.equal(windowStatus('2026-10-26', 90, NOW), 'inside', 'today is inside')
  assert.equal(windowStatus('2026-10-27', 90, NOW), 'future')
  assert.equal(windowStatus('2026-02-30', 90, NOW), 'invalid')
  assert.equal(windowStatus('Oct 2026', 90, NOW), 'invalid')
  assert.equal(windowStatus(null, 90, NOW), 'undated')
  assert.equal(windowStatus('2020-01-01', null, NOW), 'inside', 'no window: this gate does not apply')
  const { inside, outside } = splitByWindow([{ event_date: '2026-07-28' }, { event_date: '2026-04-01' }, { event_date: null }], 90, NOW)
  assert.deepEqual(inside.map(l => l.event_date), ['2026-07-28', null])
  assert.deepEqual(outside.map(l => l.event_date), ['2026-04-01'])
})

const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10)

function setup() {
  const db = new Database(':memory:')
  migrateScan(db); migrateConnectors(db); migrateOutreach(db); seedOffers(db)
  return db
}
// Instinct's fixture: contact NULL, a crawled email on the company's own site with real evidence_own_domain provenance,
// machine-verified quote, graded fit 4 / intent 0.
function addLead(db: Database.Database, eventDate: string | null, icp: string | null = JSON.stringify({ summary: 's', who: [], industries: [], sizes: [], where: [], signals: [], exclude: [], window_days: 90 }), query = 'dental clinics that opened in the past 90 days') {
  const job = createQueryJob(db, 'A', { query, icp })
  db.prepare("UPDATE scan_jobs SET status = 'running' WHERE id = ?").run(job)
  const lead = randomBytes(12).toString('hex')
  db.prepare('INSERT INTO leads (id, scan_job_id, company, contact, signal, source_url, evidence_excerpt, confidence, fit, intent, event_date, review_reason, score) VALUES (?, ?, ?, NULL, ?, ?, ?, 90, 4, 0, ?, ?, 70)').run(
    lead, job, 'Fixture Company', 'Fixture Company opened a clinic', 'https://fixture-company.example/news', 'Fixture Company opened a clinic', eventDate,
    eventDate && eventDate < day(-90) ? 'outside_window' : null)
  const ins = db.prepare("INSERT INTO lead_enrichments (id, lead_id, tenant_id, connector, kind, value, label, source_url, source_date, retrieved_at) VALUES (?, ?, 'A', 'sitecrawl', ?, ?, ?, ?, '2026-10-20', 10)")
  ins.run(randomBytes(8).toString('hex'), lead, 'email', 'hello@fixture-company.example', null, 'https://fixture-company.example/contact')
  ins.run(randomBytes(8).toString('hex'), lead, 'domain', 'fixture-company.example|evidence_own_domain', 'domain-basis-v1:evidence_own_domain', 'https://fixture-company.example/news')
  return lead
}
const draftError = (db: Database.Database, lead: string): string | null => { try { createDraft(db, 'A', lead, 'Acme'); return null } catch (e) { return (e as { code?: string }).code ?? String(e) } }

test('control: an inside-window lead the user reviewed can be drafted (the gate is what blocks the others)', () => {
  const db = setup(); const lead = addLead(db, day(-10))
  assert.equal(confirmLeadReview(db, 'A', lead), true)
  assert.equal(leadWindowHeld(db, 'A', lead), false)
  assert.equal(draftError(db, lead), null)
})

for (const [name, date] of [['stale (Instinct repro: 2026-04-01 style, older than 90 days)', day(-200)], ['undated', null], ['invalid calendar date', '2026-02-30'], ['future date', day(5)]] as const) {
  test(`${name}: source review does not make it draftable; held at every gate`, () => {
    const db = setup(); const lead = addLead(db, date)
    assert.equal(currentnessHeld(db, 'A', lead), true)
    assert.equal(confirmLeadReview(db, 'A', lead), true, 'ordinary source review still succeeds')
    assert.equal(currentnessHeld(db, 'A', lead), true, 'and is not a window waiver')
    assert.equal(leadWindowHeld(db, 'A', lead), true, 'the page is told the hold survives review')
    assert.equal(draftError(db, lead), 'lead_currentness_unconfirmed')
    assert.equal((db.prepare('SELECT count(*) n FROM outreach_messages').get() as { n: number }).n, 0)
  })
}

test('window from the request text holds even when the stored profile lacks it; unreadable profile fails closed', () => {
  const db = setup()
  const noIcpWindow = addLead(db, day(-200), null, 'roofers hiring in the last 3 months')
  confirmLeadReview(db, 'A', noIcpWindow)
  assert.equal(draftError(db, noIcpWindow), 'lead_currentness_unconfirmed')
  const broken = addLead(db, day(-10), '{not json', 'roofers')
  confirmLeadReview(db, 'A', broken)
  assert.equal(currentnessHeld(db, 'A', broken), true)
})

test('no window anywhere: unchanged behaviour (review still releases the existing currentness hold)', () => {
  const db = setup(); const lead = addLead(db, '2025-01-01', JSON.stringify({ summary: 's', who: [], industries: [], sizes: [], where: [], signals: [], exclude: [] }), 'roofers in Ohio')
  assert.equal(currentnessHeld(db, 'A', lead), true)
  confirmLeadReview(db, 'A', lead)
  assert.equal(currentnessHeld(db, 'A', lead), false)
})

test('tenant boundary: another tenant never sees or drafts the lead', () => {
  const db = setup(); const lead = addLead(db, day(-10))
  assert.equal(currentnessHeld(db, 'B', lead), false, 'not found for B (callers reject unknown leads separately)')
  try { createDraft(db, 'B', lead, 'Acme'); assert.fail('drafted across tenants') } catch (e) { assert.equal((e as { code: string }).code, 'not_found') }
})

// Instinct #208 review: a malformed saved window_days must never disable the window. Stale 400-day-old and undated
// leads, saved window values 0, -5, 30.5, "90", {}, NaN-as-null and bad JSON; the original query says "past 90 days".
test('malformed persisted window_days recovers the query window or holds; never waives', () => {
  const base = { summary: 's', who: [], industries: [], sizes: [], where: [], signals: [], exclude: [] }
  for (const bad of [0, -5, 30.5, '90', {}, [], 400, true]) {
    for (const date of [day(-400), null]) {
      const db = setup()
      const lead = addLead(db, date, JSON.stringify({ ...base, window_days: bad }))
      assert.equal(currentnessHeld(db, 'A', lead), true, `window_days=${JSON.stringify(bad)} date=${date}`)
      confirmLeadReview(db, 'A', lead)
      assert.equal(currentnessHeld(db, 'A', lead), true, 'review does not lift it')
      assert.equal(leadWindowHeld(db, 'A', lead), true)
      assert.equal(draftError(db, lead), 'lead_currentness_unconfirmed')
    }
  }
  // corrupt window and a query with no window text: fail closed, even for a fresh-dated lead
  const db = setup()
  const noText = addLead(db, day(-5), JSON.stringify({ ...base, window_days: 0 }), 'dental clinics in Ohio')
  assert.equal(leadWindowHeld(db, 'A', noText), true)
  // corrupt window but the query recovers a valid 90-day window and the lead is inside it: not held
  const db2 = setup(); const recovered = addLead(db2, day(-5), JSON.stringify({ ...base, window_days: 0 }))
  assert.equal(leadWindowHeld(db2, 'A', recovered), false)
  // null / absent window and no query window = no constraint (unchanged)
  const db3 = setup(); const none = addLead(db3, day(-400), JSON.stringify(base), 'dental clinics in Ohio')
  assert.equal(leadWindowHeld(db3, 'A', none), false)
  // malformed JSON
  const db4 = setup(); const junk = addLead(db4, day(-5), '{not json')
  assert.equal(leadWindowHeld(db4, 'A', junk), true)
})
