// #380: the typed query plan. Pure; invented companies; no network.
import test from 'node:test'
import assert from 'node:assert/strict'
import { compilePlan, describePlan, evaluatePlan, widenOptions, type Proof } from '../lib/scan/query-plan.ts'

const NOW = new Date('2026-10-20T12:00:00Z')
const ids = (p: ReturnType<typeof compilePlan>) => { const out: { id: string; kind: string; window: number | null }[] = []; const w = (x: any): void => { if (x.op === 'fact') out.push({ id: x.id, kind: x.kind, window: x.window_days }); else if (x.op === 'not') w(x.of); else x.of.forEach(w) }; w(p.hard); return out }
const proof = (date: string | null, o: Partial<Proof> = {}): Proof => ({ url: 'https://news.example/a', quote: 'Acme raised a seed round of 3m this month', date, entity_bound: true, ...o })
const T = (date: string | null, o: Partial<Proof> = {}) => ({ state: 'true' as const, proof: proof(date, o) })

test('"funding OR hiring" is an OR; "funding AND hiring" is an AND; the plan is visible', () => {
  const or = compilePlan('Find London startups that raised a seed round or are hiring sales staff')
  assert.equal(or.hard.op, 'or'); assert.equal(describePlan(or.hard), 'raised a seed round OR are hiring sales staff')
  const and = compilePlan('Find London startups that raised a seed round and are hiring sales staff')
  assert.equal(and.hard.op, 'and'); assert.deepEqual(ids(and).map(x => x.kind), ['funding', 'hiring'])
  const f = (state: 'true' | 'false' | 'unknown', date = '2026-10-10') => ({ state, proof: state === 'true' ? proof(date) : undefined })
  const ent = { name: 'Acme' }
  assert.equal(evaluatePlan(or, { c1: f('true'), c2: f('unknown') }, ent, NOW).state, 'true', 'either is enough')
  assert.equal(evaluatePlan(or, { c1: f('false'), c2: f('unknown') }, ent, NOW).state, 'unknown', 'one false and one unknown is not false: nothing broadened, nothing refuted')
  assert.equal(evaluatePlan(and, { c1: f('true'), c2: f('unknown') }, ent, NOW).state, 'unknown', 'both are required: one unchecked leaves it unknown')
  assert.equal(evaluatePlan(and, { c1: f('true'), c2: f('false') }, ent, NOW).state, 'false')
  assert.equal(evaluatePlan(and, { c1: f('true'), c2: f('true') }, ent, NOW).state, 'true')
})

test('separate clocks: "seed within 90 days AND first VP hired within 30 days"', () => {
  const p = compilePlan('Find startups that raised seed funding within 90 days and hired a first VP of Sales within 30 days')
  assert.deepEqual(ids(p).map(x => [x.kind, x.window]), [['funding', 90], ['leadership_hire', 30]])
  const ent = { name: 'Acme' }
  const ok = evaluatePlan(p, { c1: T('2026-08-15'), c2: T('2026-10-05') }, ent, NOW)
  assert.equal(ok.state, 'true')
  // The funding date is fine for 90 days but the hire is 45 days old: its own 30-day clock fails it (stale = false, not unknown).
  const late = evaluatePlan(p, { c1: T('2026-08-15'), c2: T('2026-09-05') }, ent, NOW)
  assert.equal(late.state, 'false'); assert.deepEqual(late.clauses.map(c => [c.id, c.state, c.missing]), [['c1', 'true', null], ['c2', 'false', 'older than 30 days']])
})

test('exclusions stay hard: an excluded competitor is false whatever its events say', () => {
  const p = compilePlan('Find dental practices that opened a new location, excluding Smile Direct and Aspen Dental')
  assert.deepEqual(p.exclude, ['Smile Direct', 'Aspen Dental'])
  assert.equal(evaluatePlan(p, { c1: T('2026-10-10') }, { name: 'Aspen Dental of Ohio' }, NOW).state, 'false')
  assert.equal(evaluatePlan(p, { c1: T('2026-10-10') }, { name: 'Harbor Dental' }, NOW).excluded, null)
})

test('clause-by-clause proof or the missing condition; unknown stays unknown and is never read as true or false', () => {
  const p = compilePlan('Find startups that raised seed funding within 90 days and are hiring sales staff')
  const e = evaluatePlan(p, { c1: T('2026-10-10') }, { name: 'Acme' }, NOW)
  assert.equal(e.state, 'unknown'); assert.deepEqual(e.clauses.map(c => [c.id, c.state, c.missing]), [['c1', 'true', null], ['c2', 'unknown', 'not checked or not found yet']])
  // A "true" without a usable proof is not true: no quote, not tied to the company, or no date inside the clause's window.
  for (const bad of [T('2026-10-10', { quote: 'short' }), T('2026-10-10', { url: '' }), T('2026-10-10', { entity_bound: false }), T(null), T('2026-10-25')]) {
    const r = evaluatePlan(p, { c1: bad, c2: T(null) }, { name: 'Acme' }, NOW)
    assert.notEqual(r.clauses[0].state, 'true'); assert.equal(r.state === 'true', false)
  }
})

test('non-hiring use cases and a place: a launch OR a tech switch; geography semantics', () => {
  const p = compilePlan('Find SaaS companies that launched a new product within 60 days or switched their billing platform', { where: ['Toronto'] })
  assert.equal(p.hard.op, 'or'); assert.deepEqual(ids(p).map(x => x.kind), ['launch', 'tech_switch']); assert.equal(p.geography.semantics, 'city')
  assert.equal(compilePlan('Find dental practices that opened a new location', { where: ['United States'], country: true }).geography.semantics, 'country')
  assert.equal(compilePlan('Find practices that opened a new location').geography.semantics, 'none')
})

test('adversarial / ambiguous requests are flagged, not guessed; widening is only suggested', () => {
  assert.match(compilePlan('Find startups that raised and/or are hiring').ambiguities[0], /and\/or/)
  assert.equal(compilePlan('Find nice companies').hard.op === 'and' && (compilePlan('Find nice companies').hard as any).of.length === 0, true)
  assert.match(compilePlan('Find nice companies').ambiguities[0], /No event condition/)
  const p = compilePlan('Find startups that raised seed funding within 90 days and are hiring sales staff', { where: ['London'] })
  const before = JSON.stringify(p), opts = widenOptions(p)
  assert.ok(opts.some(o => /from 90 days to 180 days/.test(o)) && opts.some(o => /either/.test(o)) && opts.some(o => /wider region/.test(o)))
  assert.equal(JSON.stringify(p), before, 'suggesting never changes the plan'); assert.equal(p.widening, 'user_choice')
})
