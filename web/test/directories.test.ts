import test from 'node:test'
import assert from 'node:assert/strict'
import { DIRECTORIES } from '../lib/seo/directories.ts'

// The list was verified live URL-by-URL when built (2026-10-21). These invariants keep it honest:
// https only, no duplicates, no tracking params, real notes, roughly 50 entries.
test('directories: https only, unique, no tracking params, ~50 entries', () => {
  assert.ok(DIRECTORIES.length >= 45 && DIRECTORIES.length <= 60)
  const urls = DIRECTORIES.map(d => d.url)
  assert.equal(new Set(urls).size, urls.length)
  for (const d of DIRECTORIES) {
    assert.ok(/^https:\/\/[^\s]{4,200}$/.test(d.url), d.url)
    assert.ok(!d.url.includes('utm_'), d.url)
    assert.ok(d.name.length >= 2 && d.note.length >= 10, d.name)
    assert.ok(['Launch', 'Software review', 'AI tools', 'Business & local'].includes(d.category), d.name)
  }
})
