import { test } from 'node:test'
import assert from 'node:assert/strict'
import { displayablePlayOffer } from '../app/app/play-offer-display.ts'

test('old clipped offer is not available for display or one-click selection', () => {
  for (const saved of ['Copper (copper', 'Technical service (including setup', 'Platform (with (special) options']) {
    assert.equal(displayablePlayOffer(saved), null)
  }
})

test('full offers retain the exact saved value without inventing or removing a qualifier', () => {
  for (const saved of ['Copper', 'Copper (copper.example)', 'Platform (with (special) options)', '1) Remote setup', 'Support & Training']) {
    assert.equal(displayablePlayOffer(saved), saved)
  }
  assert.equal(displayablePlayOffer(null), null)
})
