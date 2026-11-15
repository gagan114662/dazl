// E (#1263) in the research engine: which cases ask which registry (lib/research/sources REGISTRY_SOURCES, used by hunt.ts huntWithRegistry in
// the base hunt stage), and that the wired filter lets registry records through without the web filter.
import test from 'node:test'
import assert from 'node:assert/strict'
import { REGISTRY_SOURCES } from '../lib/research/sources/index.ts'
import type { ResearchCase } from '../lib/research/types.ts'

const C = (where: string, category: string): ResearchCase => ({ tenant: 't', jobId: 'j', query: 'q', offer: 'o', where, category, windowDays: 90, today: '2026-11-15' })
const asked = (c: ResearchCase) => REGISTRY_SOURCES.filter(s => s.covers(c)).map(s => s.id)
test('a registry is asked only when the place is its city and region and the category is its category', () => {
  assert.deepEqual(asked(C('Austin, TX', 'Roofing contractors')), ['socrata-permits:austin'])
  assert.deepEqual(asked(C('Vancouver, British Columbia', 'Restaurants')), ['opendatasoft-licences:vancouver'])
  assert.deepEqual(asked(C('Chicago, Illinois', 'Law firms')), [])
  assert.deepEqual(asked(C('Austin, TX', 'Law firms')), [], 'right city, wrong category')
  assert.deepEqual(asked(C('North Austinville', 'roofing')), [], 'the city as a whole place')
  assert.deepEqual(asked(C('Austin, Texas', 'software startups')), ['sec-form-d'])
})
