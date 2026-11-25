import test from 'node:test'
import assert from 'node:assert/strict'
import { zeroResultReason, type ZeroResultInput, type ZeroResultReason } from '../lib/zero-result-reason.ts'

const validCodes = ['unsupported_region', 'non_saas_offer', 'signal_too_narrow', 'budget_spent', 'unknown'] as const
const base: ZeroResultInput = {
  stop: null, query: 'find software for appointment scheduling', searchesUsed: 1,
  searchAllowance: 5, candidates: 0, rejected: 0,
}
const result = (overrides: Partial<ZeroResultInput> = {}): ZeroResultReason => zeroResultReason({ ...base, ...overrides })

test('unsupported region copy', () => {
  assert.deepEqual(result({ stop: 'unsupported_region' }), {
    code: 'unsupported_region',
    reason: 'dazl covers the US and Canada for now.',
    nextStep: 'Search for companies in the US or Canada.',
  })
})
test('non-commercial offer copy and action', () => {
  assert.deepEqual(result({ offer: 'I need a poem for personal use, not a business.' }), {
    code: 'non_saas_offer',
    reason: "We couldn't find companies showing that signal for this kind of offer.",
    nextStep: "Name the buyer and a clear sign they need you, like 'dentists in Ohio opening a second office'.",
    action: { label: 'Edit search', href: '/app/leads' },
  })
})
test('narrow signal interpolates the candidate count', () => {
  const got = result({ candidates: 7, rejected: 7 })
  assert.equal(got.code, 'signal_too_narrow')
  assert.equal(got.reason, 'We found 7 companies, but none passed the checks.')
  assert.equal(got.nextStep, 'Try a wider area or drop one requirement.')
})
test('both exhausted allowance branches use approved budget copy', () => {
  const expected = {
    code: 'budget_spent',
    reason: 'This search used all 15 of its web searches before finding a lead that passed.',
    nextStep: 'Try a narrower request, like one city or one signal, and run it again.',
  }
  assert.deepEqual(result({ searchesUsed: 5, searchAllowance: 5 }), expected)
  assert.deepEqual(result({ stop: 'search_limit_reached' }), expected)
})
test('both unknown branches use approved copy', () => {
  const expected = {
    code: 'unknown',
    reason: "We couldn't find leads for this search.",
    nextStep: 'Try rewording it with a clear buyer and signal.',
  }
  assert.deepEqual(result(), expected)
  assert.deepEqual(result({ stop: 'provider_failed', candidates: 0 }), expected)
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
