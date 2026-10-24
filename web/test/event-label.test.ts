import test from 'node:test'
import assert from 'node:assert/strict'
import { eventTypeLabel } from '../lib/events/labels.ts'

test('hiring_surge is shown as a board snapshot, other types keep their name', () => {
  assert.equal(eventTypeLabel('hiring_surge'), 'open roles (board snapshot, growth not measured)')
  assert.equal(eventTypeLabel('funding_round'), 'funding round')
  assert.equal(eventTypeLabel('tech_stack'), 'tech stack')
})
