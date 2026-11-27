import test from 'node:test'
import assert from 'node:assert/strict'
import { userMessage } from '../lib/discover/agent.ts'
import { requestTarget } from '../lib/scan/request-target.ts'

// The final discovery consumer must receive negatives, not just store them.
test('fresh request carries every explicit exclusion as mandatory even with a background profile', () => {
  const negative = 'Do not contact Existing Fixture Company'
  const p = requestTarget('Guitar schools in Lisbon', {
    summary: 'Old buyers', who: [], industries: [], sizes: [], where: ['Old city'], signals: [], exclude: [], carry_exclude: [negative],
  }, false)!
  const message = userMessage({ query: 'Guitar schools in Lisbon', profile: p, profileCarried: true }, '2026-11-25', 5)
  assert.ok(message.includes(negative), 'carried exclusions reach the actual discovery message')
  assert.ok(message.includes('Mandatory exclusions'), 'negative constraints are never optional background')
  assert.ok(!message.includes('Old city'))
})
