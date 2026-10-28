import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { dropoffOf, formatDropoff } from '../lib/scan/dropoff.ts'

test('the biggest drop-off and its top reason are named; absent stages print n/r, never a fabricated zero', () => {
  const d = dropoffOf({ search: { hits_unique_urls: 12 }, urls: Array.from({ length: 6 }, (_, i) => ({ url: `u${i}`, selected: i < 5, own_fetch: i < 3 ? 'blocked' : 'ok' })), extracted_candidates: 4, funnel: { candidates: 4, verified: 1, needs_review: 2, dropped: 1, review_reasons: { no_sales_hiring_evidence: 2 }, drop_reasons: { stale: 1 } } })
  assert.equal(d.biggest?.stage, 'search -> urls selected for reading'); assert.equal(d.biggest?.lost, 7)
  const own = d.stages.find(s => s.stage.startsWith('urls read'))!; assert.deepEqual([own.in, own.out, own.lost, own.reasons], [5, 2, 3, { 'own fetch blocked': 3 }])
  assert.deepEqual(dropoffOf(null).stages.map(s => s.lost), [null, null, null, null, null, null], 'a missing report records nothing')
  assert.match(formatDropoff(dropoffOf(null)), /no drop-off recorded/)
})
test('every saved scan fixture under test/fixtures/scan-runs replays offline', () => {
  const dir = new URL('./fixtures/scan-runs/', import.meta.url)
  for (const f of readdirSync(dir).filter(x => x.endsWith('.json'))) {
    const raw = JSON.parse(readFileSync(new URL(f, dir), 'utf8')); const d = dropoffOf(Array.isArray(raw) ? raw.at(-1) : raw)
    assert.ok(d.stages.length > 0 && formatDropoff(d).includes('final:'), f)
  }
})
test('SCAN 7 (live, London, exact criteria): the recorded run report shows where the 74 results went', () => {
  const raw = JSON.parse(readFileSync(new URL('./fixtures/scan-runs/scan7-london-live.json', import.meta.url), 'utf8')); const d = dropoffOf(raw.at(-1))
  const by = Object.fromEntries(d.stages.map(s => [s.stage, [s.in, s.out, s.lost]]))
  assert.deepEqual(by['search -> urls selected for reading'], [74, 16, 58]); assert.deepEqual(by['urls read -> own page fetched'], [16, 15, 1])
  assert.deepEqual(by['evidence offered to extraction -> candidates returned'], [30, 1, 29]); assert.deepEqual(by['candidates -> verified (identity / quote / date / sales-hiring gates)'], [1, 0, 1])
  assert.equal(d.biggest?.stage, 'search -> urls selected for reading'); assert.deepEqual([d.final.verified, d.final.needs_review, d.final.actionable], [0, 1, 0])
})
