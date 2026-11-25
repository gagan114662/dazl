import test from 'node:test'
import assert from 'node:assert/strict'
import { zeroResultReason, type ZeroResultInput, type ZeroResultReason } from '../lib/zero-result-reason.ts'

const validCodes = ['unsupported_region', 'non_saas_offer', 'signal_too_narrow', 'budget_spent', 'unknown'] as const
const base: ZeroResultInput = {
  stop: null, query: 'find software for appointment scheduling', searchesUsed: 1,
  searchAllowance: 5, candidates: 0, rejected: 0,
}
const result = (overrides: Partial<ZeroResultInput> = {}): ZeroResultReason => zeroResultReason({ ...base, ...overrides })

test('recognizes a supported out-of-region stop', () => {
  assert.equal(result({ stop: 'unsupported_region' }).code, 'unsupported_region')
})
test('recognizes a clearly non-commercial request', () => {
  assert.equal(result({ offer: 'I need a poem for personal use, not a business.' }).code, 'non_saas_offer')
})
test('all discovered candidates filtered means the signal was too narrow', () => {
  const got = result({ candidates: 3, rejected: 3 })
  assert.equal(got.code, 'signal_too_narrow')
  assert.equal(got.nextStep, 'Try a wider location or remove one requirement, then search again.')
})
test('recognizes exhausted allowance and a budget stop', () => {
  assert.equal(result({ searchesUsed: 5, searchAllowance: 5 }).code, 'budget_spent')
  assert.equal(result({ stop: 'search_limit_reached' }).code, 'budget_spent')
})
test('ambiguous evidence and an unrecognized stop stay unknown, not a no-results claim', () => {
  for (const got of [result(), result({ stop: 'provider_failed', candidates: 0 })]) {
    assert.equal(got.code, 'unknown')
    assert.doesNotMatch(got.reason, /found nothing|no results|nothing found/i)
  }
})
test('always returns an object with one allowed code and no raw internal code in reason', () => {
  const inputs: ZeroResultInput[] = [base, { ...base, stop: 'unsupported_region' }, { ...base, stop: 'search_limit_reached' }, { ...base, candidates: 1, rejected: 1 }, { ...base, offer: 'I need a poem for personal use, not a business.' }]
  for (const input of inputs) {
    const got = zeroResultReason(input)
    assert.ok(got && typeof got === 'object')
    assert.ok(validCodes.includes(got.code))
    assert.doesNotMatch(got.reason, /unsupported_region|non_saas_offer|signal_too_narrow|budget_spent|unknown/)
  }
})
