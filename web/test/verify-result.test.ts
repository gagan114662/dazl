import test from 'node:test'
import assert from 'node:assert/strict'
import { verifyResult, verifyResultCopy } from '../app/verify/result.ts'

test('only successful responses show confirmed status', () => {
  assert.equal(verifyResult(200), 'done')
  assert.equal(verifyResult(410), 'unusable')
  assert.equal(verifyResult(429), 'limited')
  for (const status of [undefined, 400, 403, 500, 503]) assert.equal(verifyResult(status), 'uncertain')
})

test('a link already consumed does not say the email is unconfirmed or the link expired', () => {
  assert.doesNotMatch(verifyResultCopy.unusable, /expired|unconfirmed/i)
  assert.match(verifyResultCopy.uncertain, /couldn’t tell/)
})
