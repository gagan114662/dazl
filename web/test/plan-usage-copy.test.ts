// Settings > Plan: the month counter excludes free-trial scans (lib/plans.ts), so on a trial account the line says that.
import assert from 'node:assert/strict'
import test from 'node:test'
import { usageLine } from '../lib/plan-usage-copy.ts'
import { SCANS_THIS_MONTH_SQL } from '../lib/plans.ts'

test('a keyed account (no trial block) keeps its exact wording', () => {
  assert.equal(usageLine({ scans_used: 3, scan_limit: 50, trial: null }), '3 of 50 scans used this month.')
  assert.equal(usageLine({ scans_used: 7, scan_limit: null, trial: null }), '7 scans this month, unlimited.')
})
test('a trial account is told free trial scans are counted separately; the plan count wording is unchanged', () => {
  const t = { funded: true, remaining: 2, cap: 3, blocked: null }
  assert.equal(usageLine({ scans_used: 0, scan_limit: 50, trial: t }), '0 of 50 scans used this month. Free trial scans are counted separately and do not use this.')
  assert.match(usageLine({ scans_used: 0, scan_limit: 50, trial: t }), /^0 of 50 scans used this month\./)
})
test('the line stays true: the plan count really excludes trial-funded scans', () => {
  assert.match(SCANS_THIS_MONTH_SQL, /funded_by != 'trial'/)
})
