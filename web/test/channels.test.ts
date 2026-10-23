import test from 'node:test'
import assert from 'node:assert/strict'
import { CHANNELS } from '../lib/channels.ts'
import { ADAPTERS } from '../lib/sources/index.ts'
import { ADV_PLATFORMS } from '../lib/advanced/config.ts'

test('channel registry is honest about what runs', () => {
  assert.equal(CHANNELS.length, 14)
  assert.equal(new Set(CHANNELS.map(c => c.id)).size, 14)
  for (const c of CHANNELS) {
    if (c.id === 'github' || c.id === 'rss' || c.id === 'hn') assert.ok(ADAPTERS[c.id], c.id)
    if (c.status === 'worker') assert.ok(c.platform && (ADV_PLATFORMS as readonly string[]).includes(c.platform), c.id)
    if (c.status === 'soon') assert.ok(!c.platform, c.id) // no connect flow for unbuilt channels
  }
  assert.ok(!JSON.stringify(CHANNELS).toLowerCase().includes('hunter'))
})
