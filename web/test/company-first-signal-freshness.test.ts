import test from 'node:test'
import assert from 'node:assert/strict'
import { isRecentCompanyFirstSignal } from '../lib/company-first/company-first-signal-freshness.ts'

test('company-first accepts today and the 45th UTC day but not day 46 or tomorrow', () => {
  const now = Date.parse('2026-11-20T23:59:59.999Z')
  assert.equal(isRecentCompanyFirstSignal('2026-11-20', now), true)
  assert.equal(isRecentCompanyFirstSignal('2026-10-06', now), true)
  assert.equal(isRecentCompanyFirstSignal('2026-10-05', now), false)
  assert.equal(isRecentCompanyFirstSignal('2026-11-21', now), false)
})

test('company-first never treats missing, malformed or impossible dates as fresh', () => {
  const now = Date.parse('2026-03-01T00:01:00Z')
  for (const date of [null, 'active', '2026-02-29', '2026-02-31', '2026-03-01T00:00:00Z']) {
    assert.equal(isRecentCompanyFirstSignal(date, now), false)
  }
  assert.equal(isRecentCompanyFirstSignal('2026-03-01', NaN), false)
})
