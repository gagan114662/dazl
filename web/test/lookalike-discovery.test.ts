// #386: lookalike discovery from supplied customer outcomes. Fully synthetic cohort; pure, no search/model/network.
import test from 'node:test'
import assert from 'node:assert/strict'
import { deriveModel, validate, discover, lookalikeQueries, compareToBaseline, entityKey, split, scoreCandidate, type Example, type Candidate } from '../lib/scan/lookalike-discovery.ts'

const cust = (i: number): Example => ({ kind: i % 7 === 0 ? 'won' : 'customer', name: `Bright Smile ${i} Dental`, domain: `brightsmile${i}.example`, industry: 'Dental clinics', size: '11-50', location: 'New York', description: 'orthodontic invisalign family practice' })
const neg = (i: number): Example => ({ kind: i % 5 === 0 ? 'competitor' : 'negative', name: `Other ${i} Works`, domain: `other${i}.example`, industry: i % 2 ? 'Manufacturing' : 'Legal services', size: i % 3 ? '1000+' : '2-10', location: i % 2 ? 'Ohio' : 'Texas', description: i % 2 ? 'industrial fabrication machining' : 'litigation counsel firm' })
const ALL = [...Array.from({ length: 24 }, (_, i) => cust(i)), ...Array.from({ length: 24 }, (_, i) => neg(i))]
const cand = (name: string, extra: Partial<Candidate> = {}): Candidate => ({ name, domain: `${name.toLowerCase().replace(/ /g, '')}.example`, industry: 'Dental clinics', size: '11-50', location: 'New York', description: 'orthodontic family practice', ...extra })

test('positives alone are not enough: negatives are required, and so is a minimum number of customers', () => {
  assert.equal(validate(ALL.filter(e => e.kind === 'customer' || e.kind === 'won')).state, 'needs_negatives')
  assert.equal(validate(ALL.slice(0, 3)).state, 'needs_positives')
})

test('derives explainable discriminating features and validates them on a held-out split', () => {
  const d = validate(ALL)
  assert.equal(d.state, 'ready', d.why); assert.ok(d.heldOut!.lift > 1)
  const feats = d.model!.discriminators.map(x => `${x.feature.dimension}:${x.feature.value}`)
  assert.ok(feats.includes('industry:dental clinics') && feats.includes('keyword:orthodontic'))
  assert.ok(!feats.some(f => /manufacturing|legal/.test(f)), 'negative-only features are not discriminators')
  const sp = split(ALL); assert.ok(sp.test.length > 0 && sp.train.length > sp.test.length)
})

test('a cold account gets NEW similar companies with feature-level reasons; no recycled customers or competitors', () => {
  const candidates = [cand('Maple Row Dental'), cand('Harbor Orthodontics', { domain: 'harborortho.example' }), cust(3) as Candidate, { ...cand('Rival Smiles'), domain: 'other5.example' }, { name: 'Steel Fab', domain: 'steelfab.example', industry: 'Manufacturing', location: 'Ohio', description: 'industrial machining' }]
  const r = discover(ALL, candidates)
  assert.equal(r.discovery.state, 'ready')
  const names = r.ranked.map(x => x.candidate.name); assert.ok(names.includes('Maple Row Dental')); assert.ok(!names.includes('Steel Fab'))
  assert.ok(!names.includes('Bright Smile 3 Dental')); assert.ok(r.excluded.some(e => e.why === 'already a customer')); assert.ok(r.excluded.some(e => e.why === 'competitor'))
  for (const x of r.ranked) assert.ok(x.reasons.length > 0 && x.reasons.every(s => /customers,.*x vs non-customers/.test(s)))
})

test('lookalike fit is a separate label from verified intent: no event is never ready-to-buy', () => {
  const r = discover(ALL, [cand('Maple Row Dental'), cand('Elm Street Dental', { verifiedEvent: { date: '2026-10-01', source_url: 'https://news.example/elm' } })])
  const by = Object.fromEntries(r.ranked.map(x => [x.candidate.name, x]))
  assert.equal(by['Maple Row Dental'].readiness, 'lookalike_only'); assert.match(by['Maple Row Dental'].label, /no verified current intent/i)
  assert.equal(by['Elm Street Dental'].readiness, 'lookalike_with_event')
  assert.ok(!r.ranked.some(x => /ready.to.buy/i.test(x.label)))
})

test('features that do not beat chance on the held-out set claim nothing', () => {
  const noise: Example[] = Array.from({ length: 40 }, (_, i) => ({ kind: i < 20 ? 'customer' : 'negative', name: `N${i}`, domain: `n${i}.example`, industry: 'Same', location: 'Same', description: 'identical words everywhere' }))
  const r = discover(noise, [cand('X')])
  assert.notEqual(r.discovery.state, 'ready'); assert.deepEqual(r.ranked, [])
})

test('queries for net-new accounts come from the discriminating features', () => {
  const m = deriveModel(ALL.filter(e => e.kind === 'customer' || e.kind === 'won'), ALL.filter(e => e.kind === 'negative' || e.kind === 'competitor'))
  const q = lookalikeQueries(m); assert.ok(q.length > 0); assert.ok(q.every(s => !/manufacturing|legal/.test(s))); assert.ok(q.some(s => /dental clinics/.test(s)))
})

test('measured against ordinary ICP retrieval on identical labelled candidates: precision@k and lift', () => {
  const labelled = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map((id, i) => ({ id, good: i < 4 }))
  const c = compareToBaseline(labelled, ['a', 'b', 'c', 'x', 'y'], ['x', 'a', 'y', 'z', 'b'], 5)
  assert.deepEqual([c.lookalike, c.icp], [0.6, 0.4]); assert.ok(Math.abs(c.lift! - 1.5) < 1e-9)
  assert.equal(compareToBaseline(labelled, ['a'], ['x'], 5).lift, null)
})

test('entity keys are spelling-independent; scoring needs the features, not the name', () => {
  assert.equal(entityKey({ name: 'Bright Smile Dental, Inc.', domain: 'https://www.brightsmile.example/x' }), entityKey({ name: 'Other', domain: 'brightsmile.example' }))
  const m = deriveModel(ALL.filter(e => e.kind === 'customer' || e.kind === 'won'), ALL.filter(e => e.kind === 'negative' || e.kind === 'competitor'))
  assert.ok(scoreCandidate(m, cand('Z')).fit > scoreCandidate(m, { name: 'Z', industry: 'Manufacturing', location: 'Ohio' }).fit)
})
