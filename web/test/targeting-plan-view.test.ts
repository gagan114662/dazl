// #876 / #752: the compiled targeting plan said in plain words, before the search. Real compiler, no database, no provider, no model call.
// The completed-first-hire versus open-vacancy distinction is carried through the plan view, not only AND/OR.
import test from 'node:test'
import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'
import { compileTargeting, planView, type PlanViewNode } from '../lib/scan/targeting.ts'

const view = (q: string, icp: string | null = null) => planView(compileTargeting(q, icp))
const conds = (n: PlanViewNode | null): Extract<PlanViewNode, { op: 'cond' }>[] => !n ? [] : n.op === 'cond' ? [n] : (n.op === 'not' ? [n.of] : n.of).flatMap(conds)

test('funding OR hiring is either; funding AND hiring is both; each condition is said in words with its own clock', () => {
  const or = view('B2B SaaS startups that raised seed funding in the last 90 days or are hiring account executives')
  assert.equal(or.root?.op, 'or'); assert.deepEqual(conds(or.root).map(c => c.kind), ['funding', 'hiring'])
  assert.equal(conds(or.root)[0].means, 'a completed seed funding round'); assert.equal(conds(or.root)[0].window, 'within 90 days')
  const and = view('B2B SaaS startups that raised seed funding and are hiring account executives')
  assert.equal(and.root?.op, 'and'); assert.equal(and.explicit, true)
})
test('COMPLETED hire versus OPEN vacancy: the literal completed-hire wording is a hire_made fact (first flagged), the vacancy wording is an open role; the view words them differently', () => {
  const done = conds(view('Companies that hired their first VP of Sales within 30 days').root)[0]
  assert.equal(done.kind, 'hire_made'); assert.match(done.means, /^a completed first hire \(VP of Sales\): a source saying the hire was made, not a vacancy$/)
  const done2 = conds(view('Companies whose first sales rep was hired in the last 30 days').root)[0]
  assert.equal(done2.kind, 'hire_made'); assert.match(done2.means, /completed first hire/)
  for (const q of ['Companies hiring a first sales rep within 30 days', 'Companies that posted a job for a VP of Sales in the last 30 days', 'Companies with an open role for an account executive']) {
    const c = conds(view(q).root)[0]; assert.equal(c.kind, 'hiring', q); assert.match(c.means, /^an open role/, q); assert.doesNotMatch(c.means, /completed/, q)
  }
  // a completed hire is never worded as a vacancy, and a vacancy never as a completed hire, whatever else is in the request
  const both = conds(view('Companies that hired their first VP of Sales within 30 days and are hiring account executives').root)
  assert.deepEqual(both.map(c => c.kind), ['hire_made', 'hiring']); assert.match(both[0].means, /not a vacancy/); assert.match(both[1].means, /job posting/)
})
test('the view reports whatever the compiler compiled: every condition word comes from its kind, so a compiler change (e.g. the completed-hire reading of "made their first sales hire") flows through and is never contradicted here', () => {
  for (const q of ['Companies that made their first sales hire within 30 days', 'Companies hiring a first sales rep within 30 days', 'Companies that hired their first VP of Sales within 30 days']) {
    const p = compileTargeting(q, null), v = planView(p)
    for (const c of conds(v.root)) {
      if (c.kind === 'hire_made') assert.match(c.means, /^a completed .*hire.*not a vacancy$/, q)
      else if (c.kind === 'hiring') assert.match(c.means, /^an open role/, q)
      else assert.fail(`${q}: unexpected kind ${c.kind}`)
    }
  }
})
test('the fixture the rendered check uses is what the REAL compiler produces (same JSON file feeds test/ui/plan-view.ui.mjs)', () => {
  const f = JSON.parse(readFileSync(new URL('./helpers/plan-view-fixture.json', import.meta.url), 'utf8')) as { query: string; expect: { groups: string[]; kinds: string[]; windows: (string | null)[] } }
  const icp = JSON.stringify({ summary: 'x', who: ['Founder'], industries: [], sizes: [], where: [], signals: [], exclude: [] })
  const v = planView(compileTargeting(f.query, icp))
  const groups: string[] = []; const walk = (n: PlanViewNode | null) => { if (!n || n.op === 'cond') return; groups.push(n.op); (n.op === 'not' ? [n.of] : n.of).forEach(walk) }; walk(v.root)
  assert.deepEqual(groups, f.expect.groups); assert.deepEqual(conds(v.root).map(c => c.kind), f.expect.kinds); assert.deepEqual(conds(v.root).map(c => c.window), f.expect.windows)
})
test('separate clocks stay separate: seed within 90 days AND first VP hired within 30 days', () => {
  const c = conds(view('Companies that raised seed funding within 90 days and hired their first VP within 30 days').root)
  assert.deepEqual(c.map(x => [x.kind, x.window]), [['funding', 'within 90 days'], ['hire_made', 'within 30 days']])
})
test('an exclusion is a hard NOT in the view; a named exclusion lists the names', () => {
  const v = view('Seed-funded startups, excluding competitors')
  assert.ok(JSON.stringify(v.root).includes('"op":"not"')); assert.ok(conds(v.root).some(c => c.kind === 'competitor' && /saved competitor list/.test(c.means)))
})
test('ambiguity is shown with the narrow reading chosen; nothing is broadened', () => {
  for (const q of ['companies that raised a Series A and/or are hiring SDRs', 'companies that raised seed funding or hiring SDRs and opened a new office', 'companies that are not funded or hiring']) {
    const p = compileTargeting(q, null), v = planView(p)
    assert.ok(p.ambiguities.length > 0, `${q} is ambiguous`)
    assert.deepEqual(v.ambiguities, p.ambiguities, 'the same ambiguities the gates use, with the reading chosen')
    for (const a of v.ambiguities) assert.ok(a.text.length > 0 && a.readings.length >= 2 && a.chosen.length > 0, q)
  }
  assert.match(planView(compileTargeting('companies that raised a Series A and/or are hiring SDRs', null)).ambiguities[0].chosen, /both conditions/)
  assert.equal(planView(compileTargeting('startups that either raised seed funding or are hiring SDRs, and opened a new office', null)).ambiguities.length, 0, 'a grouped request is not ambiguous')
})
test('a request with no trigger it can read has an honest empty plan; non-hiring requests are not forced into hiring', () => {
  const e = view('Dentists in Ohio'); assert.equal(e.empty, e.filters.length === 0); assert.equal(e.root, null); assert.equal(e.explicit, false)
  const n = view('Retailers that opened a new location or launched a website in the last 60 days')
  assert.ok(conds(n.root).every(c => c.kind === 'event'), JSON.stringify(conds(n.root).map(c => c.kind)))
})
test('the view is plain data (JSON round-trips), pure and does not mutate the compiled plan', () => {
  const p = compileTargeting('Startups that raised seed funding or hired their first VP of Sales within 30 days', null)
  const before = JSON.stringify(p), v = planView(p)
  assert.equal(JSON.stringify(p), before); assert.deepEqual(JSON.parse(JSON.stringify(v)), v)
})
