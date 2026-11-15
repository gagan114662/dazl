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

import type { Candidate } from '../lib/research/types.ts'
import { wiredStages, MAX_REGISTRY_PAGES } from '../lib/research/wiring.ts'
import { researchStagesFor } from '../lib/research/scan-job.ts'
import type { Decider } from '../lib/research/decider.ts'

const ctx = (over: Record<string, unknown> = {}) => ({ db: {} as never, job: { id: 'j-wiring', user_id: 't', query: 'roofing contractors in Austin' }, icp: {} as never, key: 'k',
  model: () => ({ complete: async () => '' }) as never, isRefusal: () => false, ...over })
const reg = (i: number): Candidate => ({ url: `https://data.austintexas.gov/resource/3syk-w9eu.json?permit_number=2026-1000${String(i).padStart(2, '0')}+BP`, title: `r${i}`, snippet: '', date: '2026-11-01', triggerId: 'registry:roofing_permits', query: 'socrata-permits:austin roofing', via: 'registry', dated: 'registry' })
const plan = { persona: 'p', decisionMakerTitles: [], triggers: [], askingQueries: [], source: 'fallback' as const }

test('the wired filter lets registry records through without the web filter, up to MAX_REGISTRY_PAGES', async () => {
  let asked = 0
  const decider = { decide: async () => { asked++; return null } } as unknown as Decider
  const st = wiredStages(ctx(), { plan: async () => plan, hunt: async () => { throw new Error('unused') } }, { decider })
  const cands = Array.from({ length: MAX_REGISTRY_PAGES + 5 }, (_, i) => reg(i))
  const f = await st.filter!(C('Austin, Texas', 'roofing contractors'), plan, cands)
  assert.equal(f.keep.length, MAX_REGISTRY_PAGES); assert.ok(f.keep.every(x => x.dated === 'registry' && x.keep === true && x.dropped === null))
  assert.equal(f.all.filter(x => x.dropped === 'registry page budget').length, 5, 'records over the page budget are counted, not silently gone')
  assert.equal(asked, 0, 'no web-filter question is asked about a registry record')
})

test("the engine's hunt stage runs the registries inside the scan's deadline: a stalled public API is not waited for", async () => {
  const stalled = (() => new Promise(() => {})) as never
  const t0 = Date.now()
  const h = await researchStagesFor(ctx({ http: stalled, deadline: { at: Date.now() + 150, now: Date.now } }), { LEAD_ENGINE: 'research' }).hunt(C('Austin, Texas', 'roofing contractors'), plan)
  assert.ok(Date.now() - t0 < 3000, `returned at the deadline (${Date.now() - t0} ms)`)
  assert.equal(h.funnel.dropped.registry_registry_deadline, 1)
})
