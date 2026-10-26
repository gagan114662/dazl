import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { windowNotice } from '../lib/scan/window-notice.ts'

// Owner direction #204: when the user's own window excluded results, say so and offer an explicit change; never relax it
// quietly. Instinct (#206): counts must survive source review, separate undated from older, leave quarantined out, and
// the action must say what it does (fills the editor, runs nothing).
const NOW = new Date('2026-10-26T12:00:00Z')

test('no window, or nothing excluded: no notice', () => {
  assert.equal(windowNotice([{ event_date: '2020-01-01' }], null, NOW), null)
  assert.equal(windowNotice([{ event_date: '2026-10-01' }, { event_date: '2026-07-28' }], 90, NOW), null, 'the cutoff day itself is inside')
})

test('counts come from the dates, so a source-reviewed lead (review_reason cleared) still counts', () => {
  const n = windowNotice([{ event_date: '2026-04-01' }, { event_date: '2026-07-27' }, { event_date: '2026-10-01' }], 90, NOW)!
  assert.equal(n.older, 2)
  assert.equal(n.text, '2 results are older than your 90-day window. They are kept as research only: not drafted or sent, even after you review the source.')
  assert.equal(n.editTo, 180)
  assert.equal(n.editLabel, 'Edit window to 180 days')
  assert.match(n.editNote!, /Nothing runs until you press run/)
})

test('undated, invalid and future dates are counted apart and widening is not offered for them', () => {
  const n = windowNotice([{ event_date: null }, { event_date: '2026-02-30' }, { event_date: '2026-11-30' }], 90, NOW)!
  assert.equal(n.older, 0)
  assert.equal(n.noDate, 3)
  assert.equal(n.editTo, null)
  assert.equal(n.editLabel, null)
  assert.match(n.text, /^3 have no usable date \(missing, invalid or in the future\)\. They are kept as research only/)
  const both = windowNotice([{ event_date: null }, { event_date: '2026-01-01' }], 90, NOW)!
  assert.equal(both.text.startsWith('1 result is older than your 90-day window and 1 has no usable date'), true)
})

test('quarantined leads are left out; the widened window never exceeds 365 days', () => {
  assert.equal(windowNotice([{ event_date: '2026-01-01', quarantined_at: 5 }], 90, NOW), null)
  assert.equal(windowNotice([{ event_date: '2024-01-01' }], 200, NOW)!.editTo, 365)
  assert.equal(windowNotice([{ event_date: '2024-01-01' }], 365, NOW)!.editTo, null)
})

test('the page uses this rule and the action only fills the editor', () => {
  const src = readFileSync(new URL('../app/app/leads/leads-client.tsx', import.meta.url), 'utf8')
  assert.match(src, /windowNotice\(leads, icp\.icp\.window_days\)/)
  assert.match(src, /setDraft\(\{ \.\.\.icp\.icp, window_days: wn\.editTo! \}\)/)
  assert.doesNotMatch(src, /Widen to \{/)
})

test('an edited profile window wins over the window in the request text', () => {
  const runner = readFileSync(new URL('../lib/scan/runner.ts', import.meta.url), 'utf8')
  assert.match(runner, /if \(win && !icp\.window_days\)/)
})
