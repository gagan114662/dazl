// #385: reasoned feedback. Synthetic accounts; both engines for the store, pure for the rest. No network, no credits.
import test from 'node:test'
import assert from 'node:assert/strict'
import { bothEngines } from './helpers/engines.ts'
import { accountKey, personKey, eventKey, recordFeedback, revertFeedback, activeFeedback, heldBy, rejectedPeople, filterRejected, sourceYield, rankAdjustment, proposeProfileImprovements, FeedbackError, type FeedbackRow } from '../lib/scan/feedback.ts'

const L = { company: 'Harbor Dental Inc.', company_domain: 'https://www.harbordental.example/about' }
const rej = (reason: any, extra: object = {}) => ({ entity_kind: 'account' as const, entity_key: accountKey(L), account_key: accountKey(L), polarity: 'reject' as const, reason, ...extra })

test('canonical keys: the same account is the same key however it is spelled', () => {
  assert.equal(accountKey(L), 'd:harbordental.example'); assert.equal(accountKey({ company: 'HARBOR Dental, Inc', company_domain: 'harbordental.example' }), accountKey(L))
  assert.equal(accountKey({ company: 'The Harbor Dental Co.' }), accountKey({ company: 'harbor dental' }))
  assert.notEqual(personKey(L, 'Fay Buyer'), personKey(L, 'Bob Other'))
})

bothEngines('reject a wrong-fit account once: it is held later, explained, and tenant-isolated', async ({ db }) => {
  const fb = await recordFeedback(db, 't1', rej('wrong_industry', { note: 'they are a lab', source: 'search:tinyfish' }))
  const mine = await activeFeedback(db, 't1')
  const h = heldBy(mine, { company: 'Harbor Dental', company_domain: 'harbordental.example' })
  assert.ok(h); assert.equal(h!.row.id, fb.id); assert.match(h!.explanation, /wrong_industry.*account level.*they are a lab.*revert/)
  assert.equal(heldBy(await activeFeedback(db, 't2'), L), null, 'another tenant never sees it')
  assert.equal(await revertFeedback(db, 't2', fb.id), false, 'another tenant cannot revert it')
})

bothEngines('versioned and reversible: revert releases the account and keeps the row', async ({ db }) => {
  const a = await recordFeedback(db, 't1', rej('wrong_industry')); const b = await recordFeedback(db, 't1', { ...rej('not_useful'), entity_key: 'd:other.example', account_key: 'd:other.example' })
  assert.deepEqual([a.version, b.version], [1, 2])
  assert.equal(await revertFeedback(db, 't1', a.id), true); assert.equal(await revertFeedback(db, 't1', a.id), false)
  assert.equal(heldBy(await activeFeedback(db, 't1'), L), null)
  const raw = await db.get<{ n: number }>('SELECT COUNT(*) AS n FROM lead_feedback WHERE tenant_id = ?', ['t1']); assert.equal(Number(raw!.n), 2)
})

bothEngines('validation: a reject needs a listed reason; a passive opt-out is never a positive; an accept carries no reason', async ({ db }) => {
  await assert.rejects(recordFeedback(db, 't1', rej(undefined)), FeedbackError); await assert.rejects(recordFeedback(db, 't1', rej('because')), FeedbackError)
  await assert.rejects(recordFeedback(db, 't1', { ...rej(null), polarity: 'accept', origin: 'passive_optout' }), FeedbackError)
  await assert.rejects(recordFeedback(db, 't1', { ...rej('not_useful'), polarity: 'accept' }), FeedbackError)
})

test('only a timing rejection lifts, and only for a DIFFERENT newly surfaced event; other reasons hold until reset', () => {
  const e1 = { date: '2026-06-01', source_url: 'https://news.example/a' }, e2 = { date: '2026-10-01', source_url: 'https://news.example/b' }  // e2 is a LATER day
  const row = (reason: string): FeedbackRow => ({ id: 'x', entity_kind: reason === 'wrong_timing' ? 'event' : 'account', entity_key: reason === 'wrong_timing' ? eventKey(L, e1) : accountKey(L), account_key: accountKey(L), polarity: 'reject', reason: reason as any, origin: 'explicit', source: null, query_key: null, event_key: eventKey(L, e1), note: null, version: 1, created_at: 1, reverted_at: null })
  assert.ok(heldBy([row('wrong_timing')], L, { event: e1 }), 'same event stays held')
  assert.equal(heldBy([row('wrong_timing')], L, { event: e2 }), null, 'a new relevant event lifts a timing rejection')
  for (const r of ['wrong_industry', 'competitor', 'existing_relationship', 'wrong_location', 'not_useful']) assert.ok(heldBy([row(r)], L, { event: e2 }), `${r} holds despite a new event`)
  assert.ok(heldBy([row('wrong_timing')], L), 'no event context: stays held')
})

test('person-level rejection strips that person, it does not hold the account', () => {
  const r: FeedbackRow = { id: 'p', entity_kind: 'person', entity_key: personKey(L, 'Bob Other'), account_key: accountKey(L), polarity: 'reject', reason: 'wrong_person', origin: 'explicit', source: null, query_key: null, event_key: null, note: null, version: 1, created_at: 1, reverted_at: null }
  assert.equal(rejectedPeople([r], L, ['Bob Other']).length, 1); assert.equal(rejectedPeople([r], L, ['Fay Buyer']).length, 0); assert.equal(heldBy([r], L), null, 'the company is not held for a wrong person')
})

test('filterRejected splits a batch with a reason for each held lead', () => {
  const r: FeedbackRow = { id: 'a', entity_kind: 'account', entity_key: accountKey(L), account_key: accountKey(L), polarity: 'reject', reason: 'competitor', origin: 'explicit', source: null, query_key: null, event_key: null, note: null, version: 1, created_at: 1, reverted_at: null }
  const out = filterRejected([r], [{ company: 'Harbor Dental', company_domain: 'harbordental.example' }, { company: 'Other Co', company_domain: 'other.example' }])
  assert.equal(out.kept.length, 1); assert.equal(out.held.length, 1); assert.match(out.held[0].why, /competitor/)
})

const mk = (o: Partial<FeedbackRow>): FeedbackRow => ({ id: Math.random().toString(36), entity_kind: 'account', entity_key: 'd:x', account_key: 'd:x', polarity: 'accept', reason: null, origin: 'explicit', source: 'search:a', query_key: 'q1', event_key: null, note: null, version: 1, created_at: 1, reverted_at: null, ...o })
test('source/query yield learns from outcomes; passive opt-outs never train a positive cohort; few outcomes give no rate', () => {
  const rows = [mk({}), mk({}), mk({}), mk({ polarity: 'reject', reason: 'not_useful', source: 'search:b', query_key: 'q2' }), mk({ polarity: 'reject', reason: 'not_useful', source: 'search:b', query_key: 'q2' })]
  const y = sourceYield(rows)
  assert.equal(y.find(r => r.source === 'search:a')!.rate, 1); assert.equal(y.find(r => r.source === 'search:b')!.rate, null)
  const optouts = Array.from({ length: 10 }, () => mk({ polarity: 'reject', origin: 'passive_optout', reason: 'not_useful', source: 'search:c' }))
  assert.equal(sourceYield(optouts).length, 0, 'opt-outs do not count either way')
  assert.deepEqual(rankAdjustment(y, 'search:a', 'q1').delta, 1); assert.equal(rankAdjustment(y, 'search:b', 'q2').delta, 0); assert.equal(rankAdjustment(y, 'unknown').delta, 0)
  const bad = sourceYield([1, 2, 3].map(() => mk({ polarity: 'reject', reason: 'wrong_industry', source: 'search:d', query_key: null })))
  assert.equal(rankAdjustment(bad, 'search:d').delta, -1)
})

test('profile improvements are proposed from repeated explicit reasons, versioned, and never applied', () => {
  const rows = [1, 2, 3].map(i => mk({ polarity: 'reject', reason: 'competitor', account_key: `d:c${i}.example`, source: 's' }))
  const p = proposeProfileImprovements(rows, 7)
  assert.ok(p.some(x => x.kind === 'add_exclusion' && x.version === 7 && x.evidence.length === 3))
  assert.deepEqual(proposeProfileImprovements(rows.slice(0, 2), 7).filter(x => x.kind === 'add_exclusion'), [])
  assert.deepEqual(proposeProfileImprovements([1, 2, 3].map(() => mk({ polarity: 'reject', reason: 'competitor', origin: 'passive_optout' })), 1), [])
})
