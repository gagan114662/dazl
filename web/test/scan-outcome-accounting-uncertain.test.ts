import test from 'node:test'
import assert from 'node:assert/strict'
import { scanOutcome } from '../lib/scan/scan-outcome.ts'

// #1157 line 3: an accounting_uncertain stop says exactly what is uncertain, and on a free scan that the free-scan count was not used
// (lib/billing/trial-budget.ts releasedBeforeCost gives the attempt back).

test('#1157 AC-1: a free (trial) scan stopped as accounting_uncertain says the free scan was not used up', () => {
  for (const failed_sources of [undefined, ['search:tinyfish']]) {
    const o = scanOutcome({ id: 'j', status: 'failed', error: 'accounting_uncertain', funded_by: 'trial', trial_attempt_restored: true, failed_sources } as never)
    assert.match(o.detail ?? '', /This free scan does not count toward your free scans\./)
  }
})

test('#1157 AC-2: an accounting_uncertain stop gives a definite answer: the interrupted step is counted as billed at the amount reserved for it', () => {
  for (const funded_by of ['trial', 'user']) {
    const o = scanOutcome({ id: 'j', status: 'failed', error: 'accounting_uncertain', funded_by } as never)
    assert.match(o.detail ?? '', /it is counted as billed at the amount reserved for it/)
    assert.doesNotMatch(o.detail ?? '', /cannot tell|may (already )?have been billed/)
  }
})

test('#1157 AC-3: a scan on your own AI key makes no free-scan claim', () => {
  const o = scanOutcome({ id: 'j', status: 'failed', error: 'accounting_uncertain', funded_by: 'user' } as never)
  assert.doesNotMatch(o.detail ?? '', /free scan/i)
})
