import { test } from 'node:test'
import assert from 'node:assert/strict'
import { companyFirstTargetStop } from '../lib/scan/runner.ts'

// Qodo High on #1511: an OR request with a funding branch put its only funding search third, and the company-first loop stopped at the
// raw candidate target after the two board passes - so a funding prospect was never searched for. The target never skips that pass.
test('the candidate target never skips the OR request\'s only funding pass; it still stops other passes', () => {
  assert.equal(companyFirstTargetStop(8, 8, true), false, 'funding pass next: runs even at the target')
  assert.equal(companyFirstTargetStop(12, 8, true), false)
  assert.equal(companyFirstTargetStop(8, 8, false), true, 'any other pass: stops at the target as before')
  assert.equal(companyFirstTargetStop(7, 8, false), false)
})
