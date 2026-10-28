import { test } from 'node:test'
import assert from 'node:assert/strict'
import { capScores } from '../lib/scan/evidence-caps.ts'

const NOW = Date.parse('2026-10-27T12:00:00Z'); const ago = (n: number) => new Date(NOW - n * 86_400_000).toISOString().slice(0, 10)
const top = { fit: 5, intent: 5, action: 5 }
test('quarantined / wrong-place leads can never be highly actionable, whatever their stored grade', () => {
  const q = capScores({ ...top, quarantined_at: 1, event_date: ago(209) }, NOW)
  assert.ok(q.fit <= 2 && q.intent! <= 1 && q.action === 0); assert.equal(q.stored_fit, 5); assert.ok(q.score_caps.includes('quarantined') && q.score_caps.some(c => /209 days old/.test(c)))
  const w = capScores({ ...top, review_reason: 'location_mismatch', event_date: ago(5) }, NOW); assert.equal(w.action, 0); assert.ok(w.fit! <= 2)
})
test('blocked, unconfirmed, closed and stale evidence cap action; timing-unconfirmed caps it at 2; no date caps at 3', () => {
  for (const r of ['blocked_by_site', 'needs_javascript', 'quote_unconfirmed', 'counterparty_signal']) assert.ok(capScores({ ...top, review_reason: r, event_date: ago(5) }, NOW).action! <= 1, r)
  for (const r of ['outside_window', 'job_closed', 'event_date_stale']) assert.ok(capScores({ ...top, review_reason: r }, NOW).action! <= 1, r)
  assert.equal(capScores({ ...top, review_reason: 'outside_window_undated' }, NOW).action, 2)
  assert.equal(capScores({ ...top }, NOW).action, 3, 'verified but undated')
  assert.equal(capScores({ ...top, event_date: ago(181) }, NOW).action, 1); assert.equal(capScores({ ...top, event_date: ago(179) }, NOW).action, 5)
  assert.equal(capScores({ ...top, event_date: '2099-01-01' }, NOW).action, 1, 'a future date')
})
test('it only ever lowers: fresh dated verified leads and ungraded leads are untouched; lower grades stay', () => {
  const f = capScores({ ...top, event_date: ago(10) }, NOW); assert.deepEqual([f.fit, f.intent, f.action, f.score_caps], [5, 5, 5, []])
  const u = capScores({ fit: null, intent: null, action: null, quarantined_at: 1 }, NOW); assert.deepEqual([u.fit, u.intent, u.action], [null, null, null])
  assert.equal(capScores({ fit: 1, intent: 0, action: 0, review_reason: 'blocked_by_site' }, NOW).action, 0)
})
