import { test } from 'node:test'
import assert from 'node:assert/strict'
import { companyFirstTargetStep } from '../lib/scan/runner.ts'

// Qodo High on #1511 and its follow-up on #1521: at the raw candidate target an OR request with a funding branch must still reach its only
// funding-announcement pass - from ANY earlier pass, not only when funding is the very next one. Board passes after the target are skipped.
test('at the target, an earlier board pass is skipped so the funding pass still runs; without a funding pass ahead the loop stops', () => {
  assert.equal(companyFirstTargetStep(8, 8, false, true), 'skip', 'board pass 2 at the target, funding still ahead: skip to funding')
  assert.equal(companyFirstTargetStep(8, 8, true, true), 'run', 'the funding pass itself runs at the target')
  assert.equal(companyFirstTargetStep(8, 8, false, false), 'stop', 'no funding pass ahead: stop as before')
  assert.equal(companyFirstTargetStep(7, 8, false, true), 'run')
  assert.equal(companyFirstTargetStep(7, 8, false, false), 'run')
})
