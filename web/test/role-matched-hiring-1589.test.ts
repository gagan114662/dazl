// #1589: a hiring-feed lead's role match is a named signal kind. The issue calls it role_matched_hiring; the taxonomy's
// id for that exact meaning is hiring_relevant_role (lib/scan/score.ts SIGNALS), already served by isHiringTrigger,
// isHiringSignal and HIRING_KINDS, so the lane emits the existing id instead of a synonym. The lane only ever saves
// postings whose title contains the request's own role words (matchRoles), so the kind states what the lane already
// proved; the signal stays "hiring signal only", review stays required, and no date or contact changes hands.
// Everything here runs on invented postings; no feed is read.
import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { migrateScan } from '../lib/scan/store.ts'
import { migrateOutreach } from '../lib/outreach/store.ts'
import { migrateConnectors } from '../lib/connectors/store.ts'
import { createHiringFeedIntake } from '../lib/scan/job-feed.ts'
import { isHiringTrigger } from '../lib/scan/scoreboard.ts'
import { SIGNALS, primarySignalKind } from '../lib/scan/score.ts'
import { isHiringSignal, hiringTimingLine, HIRING_NOT_BUYING } from '../lib/signals/hiring-timing-line.ts'
import { alertKindOf, HIRING_KINDS } from '../lib/play-alerts.ts'
import type { Get } from '../lib/connectors/sitecrawl.ts'

const XML = `<rss><channel><item><title>Acmeco: Sales Development Representative</title><pubDate>Fri, 23 Oct 2026 09:48:36 +0000</pubDate><guid>https://weworkremotely.com/remote-jobs/acmeco-sdr</guid><description>&lt;p&gt;&lt;strong&gt;URL:&lt;/strong&gt; &lt;a href="https://acmeco.example"&gt;x&lt;/a&gt;&lt;/p&gt;</description></item></channel></rss>`
const pages: Record<string, string> = {
  '/remote-jobs/acmeco-sdr': '<html><body>Acmeco is hiring <a href="https://acmeco.example/">Acmeco</a></body></html>',
  '/robots.txt': 'User-agent: *\nAllow: /',
  '/': '<html><body>Acmeco</body></html>',
}
const get: Get = async url => { const p = pages[new URL(url).pathname]; return p !== undefined ? { status: 200, body: p, finalUrl: url } : { status: 404, body: '', finalUrl: url } }
const deps = {
  fetchFeed: async () => XML,
  get, gapMs: 0, env: {}, now: 1800000000,
  fetchPage: async () => ({ title: 'Remote Sales Development Representative at Acmeco', text: 'Remote Sales Development Representative at Acmeco', retrievedAt: 1800000000 }),
}

test('a posting the request\u2019s role words matched is saved with the role-matched hiring kind', async () => {
  const db = new Database(':memory:'); migrateScan(db); migrateOutreach(db); migrateConnectors(db)
  const r = await createHiringFeedIntake(db, 'A', 'sales-and-marketing', 'sales development', deps)
  await r.crawl
  assert.equal(r.leads.length, 1)
  const l = db.prepare('SELECT signal_kind, source_kind, signal, review_reason, date_status, event_date, confidence FROM leads').get() as Record<string, unknown>
  assert.equal(l.signal_kind, 'hiring_relevant_role', 'the kind names the role match the lane already proved (#1589 role_matched_hiring)')
  assert.equal(l.source_kind, 'hiring_feed')
  assert.match(String(l.signal), /hiring signal only: not buying intent, fit or current need/)
  assert.equal(l.review_reason, 'source_review_required', 'still unconfirmed until the user reviews it')
  assert.equal(l.date_status, 'unverified')
  assert.equal(l.confidence, null)
})

test('the kind is the taxonomy\u2019s own id and behaves as a hiring event everywhere', () => {
  assert.ok((SIGNALS as readonly string[]).includes('hiring_relevant_role'), 'the taxonomy owns the id the lane writes')
  assert.equal(primarySignalKind(JSON.stringify(['hiring_relevant_role'])), 'hiring_relevant_role')
  assert.equal(isHiringTrigger('anything', 'hiring_relevant_role'), true, 'a board-dated role match supports timing')
  assert.equal(isHiringSignal('anything', 'hiring_relevant_role'), true)
  assert.equal(hiringTimingLine('anything', 'hiring_relevant_role'), HIRING_NOT_BUYING, 'the card still says hiring is not buying')
  assert.equal(alertKindOf({ signal_kind: 'hiring_relevant_role', event_date_proof: null }), 'hiring_relevant_role')
  assert.ok(HIRING_KINDS.has('hiring_relevant_role'), 'a holder alerted on a hiring-type label matches this event')
})

test('a posting outside the request\u2019s role words never reaches the lead, so nothing else claims the kind', async () => {
  const db = new Database(':memory:'); migrateScan(db); migrateOutreach(db); migrateConnectors(db)
  const r = await createHiringFeedIntake(db, 'A', 'sales-and-marketing', 'head of design', deps)
  assert.equal(r.job_id, null)
  assert.match(r.note ?? '', /No postings matched those role words/)
  assert.equal((db.prepare('SELECT count(*) c FROM leads').get() as { c: number }).c, 0)
})
