// #385 controls from review: older event, mirror URL, unreadable store, version race, runner person context. Synthetic data, both engines where a store is involved, no network.
import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { bothEngines } from './helpers/engines.ts'
import { migrateFeedback, recordFeedback, activeFeedback, heldBy, applyFeedback, accountKey, personKey, eventKey, type FeedbackRow } from '../lib/scan/feedback.ts'

const L = { company: 'Harbor Dental', company_domain: 'harbordental.example' }
const timing = (date: string, url: string): FeedbackRow => ({ id: 't', entity_kind: 'event', entity_key: eventKey(L, { date, source_url: url }), account_key: accountKey(L), polarity: 'reject', reason: 'wrong_timing', origin: 'explicit', source: null, query_key: null, event_key: eventKey(L, { date, source_url: url }), note: null, version: 1, created_at: 1, reverted_at: null })

test('OLDER event: after rejecting the 2026-10-01 event, an older dated event and an undated one are still held; only a strictly later day passes', () => {
  const r = [timing('2026-10-01', 'https://news.example/a')]
  assert.ok(heldBy(r, L, { event: { date: '2026-06-01', source_url: 'https://news.example/old' } }), 'an older event is not a new reason')
  assert.ok(heldBy(r, L, { event: { date: null, source_url: 'https://news.example/x' } }), 'undated cannot be told apart: held')
  assert.ok(heldBy(r, L, { event: { date: '2026-10-01', source_url: 'https://news.example/a' } }))
  assert.equal(heldBy(r, L, { event: { date: '2026-10-20', source_url: 'https://news.example/new' } }), null, 'control: a later day lifts it')
})
test('MIRROR URL: the same story on another URL / a syndicated copy (same day) is the same event, so it stays held', () => {
  const r = [timing('2026-10-01', 'https://news.example/a')]
  for (const u of ['https://mirror.example/copy-of-a', 'https://www.news.example/a?utm=x', 'http://syndicate.example/harbor']) assert.ok(heldBy(r, L, { event: { date: '2026-10-01', source_url: u } }), u)
})

test('UNREADABLE store: a feedback table that cannot be read holds every candidate (feedback_unreadable); a MISSING table (older deploy) reads as no feedback', () => {
  const cand = (c: string) => ({ company: c, name: 'Fay', contact: 'fay@x.example', source_url: 'https://news.example/' + c, event_date: '2026-10-01' })
  const broken = new Database(':memory:'); broken.exec('CREATE TABLE lead_feedback (id TEXT)')            // exists but the columns are wrong: read throws
  const o1 = { leads: [cand('A'), cand('B')], review: [cand('C')], dropped: {} as Record<string, number> }
  applyFeedback(broken, 't', o1); assert.equal(o1.leads.length + o1.review.length, 0); assert.equal(o1.dropped['feedback_unreadable'], 3)
  const none = new Database(':memory:')                                                                    // no table at all
  const o2 = { leads: [cand('A')], review: [], dropped: {} as Record<string, number> }
  applyFeedback(none, 't', o2); assert.equal(o2.leads.length, 1); assert.deepEqual(o2.dropped, {})
})

test('RUNNER person context: a rejected person is stripped from the lead (name AND contact) by name or by address; the company stays and other people are untouched', async () => {
  const raw = new Database(':memory:'); migrateFeedback(raw)
  const { sqliteDb } = await import('../lib/db/client.ts'); const db = sqliteDb(raw)
  const mk = (lead: { company: string; company_domain: string }, who: string) => recordFeedback(db, 't', { entity_kind: 'person', entity_key: personKey(lead, who), account_key: accountKey(lead), polarity: 'reject', reason: 'wrong_person' })
  await mk(L, 'Bob Other'); await mk(L, 'bob@harbordental.example')
  const c = (name: string, contact: string | null) => ({ ...L, name, contact, source_url: 'https://news.example/h', event_date: '2026-10-01' })
  const o = { leads: [c('Bob Other', 'bob@harbordental.example'), c('Fay Buyer', 'fay@harbordental.example'), c('', 'bob@harbordental.example')], review: [c('Bob Other', null)], dropped: {} as Record<string, number> }
  applyFeedback(raw, 't', o)
  assert.deepEqual(o.leads.map(l => [l.name, l.contact]), [['', null], ['Fay Buyer', 'fay@harbordental.example'], ['', null]]); assert.deepEqual(o.review.map(l => [l.name, l.contact]), [['', null]])
  assert.equal(o.leads.length, 3, 'no company was dropped for a wrong person'); assert.deepEqual(o.dropped, {})
  const other = { leads: [{ company: 'Other Co', company_domain: 'other.example', name: 'Bob Other', contact: null, source_url: 'https://x.example/o', event_date: null }], review: [], dropped: {} as Record<string, number> }
  applyFeedback(raw, 't', other); assert.equal(other.leads[0].name, 'Bob Other', 'the same name at ANOTHER company is not the rejected person')
})

bothEngines('VERSION race: concurrent rejections get distinct, gapless versions (unique per tenant); another tenant has its own sequence', async ({ db }) => {
  const mk = (i: number, t = 't1') => recordFeedback(db, t, { entity_kind: 'account', entity_key: `d:c${i}.example`, account_key: `d:c${i}.example`, polarity: 'reject', reason: 'not_useful' })
  const rows = await Promise.all([1, 2, 3, 4, 5, 6, 7, 8].map(i => mk(i)))
  assert.deepEqual(rows.map(r => r.version).sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7, 8])
  assert.equal((await mk(9, 't2')).version, 1)
  assert.equal((await activeFeedback(db, 't1')).length, 8)
})
