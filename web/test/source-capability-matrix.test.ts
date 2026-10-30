// #388: the source-capability matrix is complete, honest, and enforced. Pure; no network.
import test from 'node:test'
import assert from 'node:assert/strict'
import { MATRIX, byId, availability, advertisable, defaultEligible, coverage, sourceStatusLine, type Capability } from '../lib/sources/capability-matrix.ts'
import { ADAPTERS } from '../lib/sources/index.ts'
import { ADV_PLATFORMS } from '../lib/advanced/config.ts'

test('every registered adapter has a matrix entry, and no shipped entry is without an adapter or worker', () => {
  for (const id of Object.keys(ADAPTERS)) assert.ok(byId(id), `adapter ${id} has no capability entry`)
  for (const c of MATRIX.filter(c => c.status === 'shipped' && !c.worker && c.id !== 'sec-form-d')) assert.ok(ADAPTERS[c.id], `matrix says ${c.id} is shipped but no adapter exists`)
  assert.ok(ADV_PLATFORMS.length > 0 && byId('adv:social')!.worker === 'advanced')
})

test('entries are complete: markets, languages, refresh, proofs, access, license, failure reporting', () => {
  const ids = new Set<string>()
  for (const c of MATRIX) {
    assert.ok(!ids.has(c.id), `duplicate ${c.id}`); ids.add(c.id)
    for (const k of ['label', 'refresh', 'license', 'failureReporting'] as const) assert.ok(c[k].length > 0, `${c.id}.${k}`)
    assert.ok(c.signals.length && c.markets.length && c.languages.length, c.id)
    assert.ok(['open_api', 'public_pages', 'official_registry', 'authorized_worker'].includes(c.access), c.id)
    if (c.status === 'shipped') assert.notEqual(c.identityProof, 'none', `${c.id} is shipped and must say how identity is proven`)
  }
})

test('the planned gaps are listed and not built: they claim no coverage', () => {
  for (const id of ['registry-funding-regional', 'local-openings-permits', 'procurement-rfp', 'leadership-changes', 'first-party-careers', 'authorized-engagement']) {
    const c = byId(id)!; assert.equal(c.status, 'planned'); assert.equal(availability(c, { workers: new Set(['advanced']) }), 'not_built'); assert.equal(advertisable(c), false)
    assert.match(sourceStatusLine(c, 'not_built'), /not built yet - no coverage claimed/)
  }
})

test('a disconnected worker is unavailable - never reported as zero opportunity', () => {
  const w = byId('adv:social')!
  assert.equal(availability(w, { workers: new Set() }), 'unavailable'); assert.equal(availability(w, { workers: new Set(['advanced']) }), 'available')
  assert.match(sourceStatusLine(w, 'unavailable'), /unavailable.*not "no opportunities"/)
  assert.match(sourceStatusLine(byId('rss')!, 'available', { status: 'timeout', evidence: null }), /failure to read, not as an empty market/)
  assert.match(sourceStatusLine(byId('rss')!, 'available', { status: 'empty', evidence: 0 }), /empty, 0 items/)
})

test('nothing is advertised or default-enabled without live source-to-lead evidence, negative fixtures and a measured positive yield', () => {
  assert.deepEqual(MATRIX.filter(advertisable).map(c => c.id), [], 'no source has live source-to-qualified-lead evidence yet')
  assert.equal(coverage().signals.size, 0); assert.equal(coverage().markets.size, 0)
  const base: Capability = { ...byId('rss')!, evidence: { liveSourceToLead: true, negativeFixtures: true, incrementalYield: null } }
  assert.equal(advertisable(base), true); assert.equal(defaultEligible(base), false, 'unmeasured yield is not enough')
  assert.equal(defaultEligible({ ...base, evidence: { ...base.evidence, incrementalYield: 0 } }), false)
  assert.equal(defaultEligible({ ...base, evidence: { ...base.evidence, incrementalYield: 0.12 } }), true)
  assert.equal(defaultEligible({ ...base, evidence: { liveSourceToLead: true, negativeFixtures: false, incrementalYield: 0.5 } }), false)
})

test('markets: non-US / non-English coverage is only what is really built (V2EX zh/CN), the rest is a stated gap', () => {
  const shipped = MATRIX.filter(c => c.status === 'shipped')
  assert.deepEqual(shipped.filter(c => !c.markets.includes('*') && !c.markets.includes('US')).map(c => c.id), ['v2ex'])
  assert.ok(MATRIX.filter(c => c.status === 'planned').some(c => c.markets.includes('GB') || c.markets.includes('DE')))
})
