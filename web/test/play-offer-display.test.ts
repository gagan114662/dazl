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

test('drafting refuses a clipped saved offer instead of silently falling back', async () => {
  const { draftOffer } = await import('../lib/scan/play-offer-text.ts')
  for (const play of [{ offer:'Platform (including', seller:'Old valid offer' }, { seller:'Platform (including - https://seller.example' }]) {
    assert.deepEqual(draftOffer(play,'Current unrelated offer'),{offer:null,refuse:'offer_conflict'})
    assert.deepEqual(draftOffer({...play,offer:'Platform (including support)'},'Current unrelated offer'),{offer:'Platform (including support)',refuse:null})
  }
})
