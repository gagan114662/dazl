// Fixture for test/gate-check.test.ts only. Never run by npm test or by the real gate (fixtures/ is not scanned).
import { test } from 'node:test'
import assert from 'node:assert/strict'
test('#4205 tagged and failing', () => { assert.fail('the bug is still here') })
test('#4205 tagged and passing', () => {})
