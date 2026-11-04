// Fixture for test/gate-check.test.ts only. Never run by npm test or by the real gate (fixtures/ is not scanned).
import { test } from 'node:test'
import assert from 'node:assert/strict'
test('#4201 the reported scenario now passes', () => { assert.equal(1, 1) })
test('an untagged neighbour also passes', () => {})
