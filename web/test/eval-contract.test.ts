// The lead-evaluation contract (#394, lib/evals/contract.ts): per-field verdicts with pass / fail / unknown / contradicted,
// cumulative tiers, unknowns in every denominator, missing constraints never inferred, and evaluators that cannot change
// the targeting. Every World here is SYNTHETIC.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadCase, type Case } from '../lib/evals/case.ts'
import type { World } from '../lib/evals/world.ts'
import type { ReplayResult } from '../lib/evals/result.ts'
import { replayCase } from './helpers/eval-replay.ts'
import { scoreCase, SCAN_EVALUATORS, type Evaluator } from '../lib/evals/evaluators.ts'
import { checkBrief, LEAD_CONTRACT, type LeadEvaluation } from '../lib/evals/contract.ts'

const DIR = new URL('./fixtures/evals/cases/', import.meta.url).pathname
const memo = new Map<string, { kase: Case; world: World; result: ReplayResult }>()
async function replayed(id: string) {
  if (!memo.has(id)) { const { kase, world } = loadCase(`${DIR}${id}.case.json`); memo.set(id, { kase, world, result: await replayCase(kase, world) }) }
  return structuredClone(memo.get(id)!)
}
const lead = (leads: LeadEvaluation[], company: string) => leads.find(l => l.lead.company === company)!
const statuses = (e: LeadEvaluation) => Object.fromEntries(Object.entries(e.fields).map(([f, v]) => [f, v.status]))

test('a source-checked London lead: fields, tiers and the scorer versions that produced them', async () => {
  const ctx = await replayed('scan-london-seed-traps')
  const s = scoreCase(ctx)
  assert.deepEqual(s.leads.map(l => l.lead.company), ['Querix'])        // only verified leads are claimed
  const q = lead(s.leads, 'Querix')
  assert.equal(q.contract, LEAD_CONTRACT); assert.equal(q.as_of, ctx.world.as_of)
  assert.deepEqual(statuses(q), { evidence: 'pass', event_date: 'pass', place: 'pass', fit: 'unknown', contact: 'pass', consent: 'unknown', outcome: 'unknown' })
  assert.deepEqual(q.tiers, { source_checked: 'pass', plausible_buyer: 'unknown', actionable_opportunity: 'unknown', outcome_qualified: 'unknown' })
  assert.equal(q.tier, 'source_checked')
  assert.deepEqual(q.fields.event_date.by.sort(), ['event_date_in_window', 'event_date_on_page'])
  assert.ok(q.fields.evidence.evidence.includes('https://news.example/london/querix-seed'))
  for (const e of SCAN_EVALUATORS) assert.equal(q.scorer[e.id], e.version)
  // unknowns stay in the denominator: 1 claimed, 1 source-checked, 0 validated above it
  assert.deepEqual(s.tiers.by_tier.source_checked, { pass: 1, fail: 0, unknown: 0, validated_rate: 1, unknown_rate: 0 })
  assert.deepEqual(s.tiers.by_tier.plausible_buyer, { pass: 0, fail: 0, unknown: 1, validated_rate: 0, unknown_rate: 1 })
  assert.equal(s.tiers.claimed, 1)
  assert.deepEqual(s.brief, { ok: true, problems: [] })
})

test('the Toronto traps in contract terms: a publication-only date is not source-checked; a recruiting inbox can never be actionable', async () => {
  const s = scoreCase(await replayed('scan-toronto-office-traps'))
  const nl = lead(s.leads, 'Northern Lights Agency'), lk = lead(s.leads, 'Lakeshore Creative'), ml = lead(s.leads, 'Maple Leaf Marketing')
  assert.equal(nl.fields.event_date.status, 'unknown'); assert.match(nl.fields.event_date.rationale, /publication date/)
  assert.equal(nl.tiers.source_checked, 'unknown'); assert.equal(nl.tier, null)
  assert.equal(lk.fields.contact.status, 'fail'); assert.match(lk.fields.contact.rationale, /recruiting inbox/)
  assert.deepEqual(lk.tiers, { source_checked: 'pass', plausible_buyer: 'unknown', actionable_opportunity: 'fail', outcome_qualified: 'fail' })
  assert.equal(ml.tiers.source_checked, 'pass')
  assert.deepEqual(s.tiers.by_tier.source_checked, { pass: 2, fail: 0, unknown: 1, validated_rate: 2 / 3, unknown_rate: 1 / 3 })
})

test('fit, contradiction and the run gates decide tiers; a tier is never better than the one below it', async () => {
  const base = await replayed('scan-london-seed-traps')
  const withFit = (fit: number | null) => { const c = structuredClone(base); c.result.leads = c.result.leads.map(l => l.company === 'Querix' ? { ...l, fit } : l); return lead(scoreCase(c).leads, 'Querix') }
  assert.equal(withFit(4).tiers.plausible_buyer, 'pass')
  assert.equal(withFit(4).tiers.actionable_opportunity, 'unknown')         // consent is unknown in a scan replay
  assert.equal(withFit(2).tiers.plausible_buyer, 'fail')
  assert.equal(withFit(2).tiers.actionable_opportunity, 'fail')
  // a contradicted field fails its tier and every tier above
  const late = structuredClone(base); late.result.leads = late.result.leads.map(l => l.company === 'Querix' ? { ...l, event_date: '2026-11-30' } : l)
  const ql = lead(scoreCase(late).leads, 'Querix')
  assert.equal(ql.fields.event_date.status, 'contradicted')
  assert.deepEqual(Object.values(ql.tiers), ['fail', 'fail', 'fail', 'fail']); assert.equal(ql.tier, null)
  // a tenant leak fails every tier; a world miss validates nothing
  const leaked = structuredClone(base); leaked.result.canaryIntact = false
  assert.deepEqual(Object.values(lead(scoreCase(leaked).leads, 'Querix').tiers), ['fail', 'fail', 'fail', 'fail'])
  const missed = structuredClone(base); missed.result.misses = [{ kind: 'page', key: 'https://x.example' }]
  assert.equal(lead(scoreCase(missed).leads, 'Querix').tiers.source_checked, 'unknown')
})

test('missing or invalid constraints are reported and never inferred', async () => {
  assert.deepEqual(checkBrief({ window_days: 90, where: ['London, UK'], signals: ['raised a seed round'] }), { ok: true, problems: [] })
  assert.deepEqual(checkBrief({}).problems, ['window_days missing', 'signals missing: no event predicate to judge against'])
  assert.deepEqual(checkBrief({ window_days: 'ninety', where: 'London', signals: [] }).problems, ['window_days invalid ("ninety")', 'where must be a list of places', 'signals missing: no event predicate to judge against'])
  assert.deepEqual(checkBrief({ signals: ['x'] }, 30), { ok: true, problems: [] })   // the case's own window counts
  const c = await replayed('scan-london-seed-traps')
  delete (c.kase.input.icp as { window_days?: number }).window_days
  const s = scoreCase(c)
  assert.deepEqual(s.brief, { ok: false, problems: ['window_days missing'] })
  const q = lead(s.leads, 'Querix')
  assert.equal(q.fields.event_date.status, 'unknown'); assert.match(q.fields.event_date.rationale, /never inferred/)
  assert.equal(q.tiers.source_checked, 'unknown')
  // a brief that asks for no place makes no place demand
  const nowhere = await replayed('scan-london-seed-traps'); (nowhere.kase.input.icp as { where: string[] }).where = []
  assert.equal(lead(scoreCase(nowhere).leads, 'Querix').fields.place.status, 'pass')
})

test('evaluators cannot change the targeting: they get a frozen copy, and the caller\'s case is untouched', async () => {
  const c = await replayed('scan-london-seed-traps')
  const before = JSON.stringify(c.kase)
  const sneaky: Evaluator = { id: 'sneaky', version: 1, kind: 'deterministic', critical: false, evaluate({ kase }) { (kase.input.icp as { where: string[] }).where.push('Paris, France'); return [] } }
  assert.throws(() => scoreCase(c, [...SCAN_EVALUATORS, sneaky]), TypeError)
  const widen: Evaluator = { id: 'widen', version: 1, kind: 'deterministic', critical: false, evaluate({ kase }) { (kase.expect as { window_days?: number }).window_days = 3650; return [] } }
  assert.throws(() => scoreCase(c, [widen, ...SCAN_EVALUATORS]), TypeError)
  assert.equal(JSON.stringify(c.kase), before)
  assert.equal(scoreCase(c).status, 'pass')
})
