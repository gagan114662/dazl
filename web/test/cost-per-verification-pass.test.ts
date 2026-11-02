import test from 'node:test'
import assert from 'node:assert/strict'
import { costPerVerificationPass, COST_PER_PASS_SCOPE } from '../lib/scan/cost-per-verification-pass.ts'

test('ended scan with recorded cost and passes: exact ratio', () => {
  const r = costPerVerificationPass({ verified: 4, model_usd: 0.42, scanEnded: true })
  assert.equal(r.unavailable, null)
  assert.ok(r.usd_per_pass !== null && Math.abs(r.usd_per_pass - 0.105) < 1e-12)
  assert.equal(r.basis, 'leads that passed verification')
  assert.match(COST_PER_PASS_SCOPE, /not included/)
})

test('zero passes: no ratio, named reason, spend NOT hidden', () => {
  const r = costPerVerificationPass({ verified: 0, model_usd: 0.42, scanEnded: true })
  assert.equal(r.usd_per_pass, null)
  assert.equal(r.unavailable, 'no leads passed verification')
  assert.equal(r.model_usd, 0.42) // the spend is still shown beside the missing ratio
})

test('running scan: unavailable regardless of numbers', () => {
  const r = costPerVerificationPass({ verified: 4, model_usd: 0.42, scanEnded: false })
  assert.equal(r.usd_per_pass, null)
  assert.equal(r.unavailable, 'scan still running')
})

test('unrecorded cost and unrecorded count stay unknown, never zero', () => {
  const a = costPerVerificationPass({ verified: 4, model_usd: null, scanEnded: true })
  assert.equal(a.unavailable, 'model cost not recorded'); assert.equal(a.usd_per_pass, null)
  const b = costPerVerificationPass({ verified: null, model_usd: 0.42, scanEnded: true })
  assert.equal(b.unavailable, 'verified count not recorded'); assert.equal(b.usd_per_pass, null)
  // non-finite defensively refused
  const c = costPerVerificationPass({ verified: 4, model_usd: Number.NaN, scanEnded: true })
  assert.equal(c.unavailable, 'model cost not recorded')
})
