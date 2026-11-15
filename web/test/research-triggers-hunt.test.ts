// Research engine stages 1-2 (LEAD_ENGINE=research, MISSION v2 part A): the trigger plan and the hunt, with stubbed model and search.
import test from 'node:test'
import assert from 'node:assert/strict'
import { parsePlan, planResearch, fallbackPlan, cleanQuery, triggerPrompt } from '../lib/research/triggers.ts'
import { hunt, huntQueries, afterDate, urlKey } from '../lib/research/hunt.ts'
import type { Candidate, ResearchCase } from '../lib/research/types.ts'

const CASE: ResearchCase = { tenant: 't', jobId: 'j', query: 'Roofing contractors in Austin hiring estimators', offer: 'Estimating software for roofers', seller: 'RoofRun',
  where: 'Austin, Texas', category: 'roofing contractors', windowDays: 90, today: '2026-11-15' }
const PLAN_JSON = JSON.stringify({ persona: 'Owners of roofing firms.', decision_maker_titles: ['Owner', 'President', 'Owner'],
  triggers: [
    { id: 'x', name: 'Hiring an estimator', why_it_matters: 'more bids', how_it_shows_publicly: 'job posts', queries: ['Austin roofing company hiring estimator 2026', 'site:linkedin.com roofing Austin estimator', 'Austin roofing estimator job opening', 'Austin roofing company hiring estimator 2026', 'roofing estimator Round Rock hiring'] },
    { name: 'New office', queries: ['roofing company opens new office Austin'] },
    { name: 'no queries', queries: [] },
  ], asking_queries: ['Austin roofer looking for estimating software', 'site:facebook.com roofers Austin'] })

test('the plan: validated, unopenable site: queries dropped, duplicates dropped, ids rewritten, empty triggers skipped', () => {
  const p = parsePlan('Here you go:\n```json\n' + PLAN_JSON + '\n```')!
  assert.deepEqual(p.triggers.map(t => [t.id, t.name, t.queries.length]), [['t1', 'Hiring an estimator', 3], ['t2', 'New office', 1]])
  assert.ok(!p.triggers[0].queries.some(q => /linkedin/.test(q)))
  assert.deepEqual(p.decisionMakerTitles, ['Owner', 'President'])
  assert.deepEqual(p.askingQueries, ['Austin roofer looking for estimating software'])
  assert.equal(parsePlan('no json at all'), null)
  assert.equal(parsePlan(JSON.stringify({ triggers: [{ name: 'x', queries: [] }] })), null, 'no usable trigger')
  assert.equal(cleanQuery('one'), null); assert.equal(cleanQuery('site:indeed.com roofers Austin'), null); assert.equal(cleanQuery('  "Austin roofing news"  '), 'Austin roofing news')
  assert.match(triggerPrompt(CASE), /Today is 2026-11-15/); assert.doesNotMatch(triggerPrompt(CASE), /sonar/i)
})

test('planResearch: one retry on an unusable answer, the fallback when both fail, a spend refusal propagates', async () => {
  let n = 0
  const p = await planResearch(CASE, async () => (++n === 1 ? 'garbage' : PLAN_JSON))
  assert.equal(p.source, 'model'); assert.equal(n, 2)
  const f = await planResearch(CASE, async () => 'garbage')
  assert.equal(f.source, 'fallback'); assert.deepEqual(f, fallbackPlan(CASE))
  assert.ok(f.triggers[0].queries[0].includes('Austin'))
  const failed = await planResearch(CASE, async () => { throw new Error('timeout') })
  assert.equal(failed.source, 'fallback')
  class Refused extends Error {}
  await assert.rejects(planResearch(CASE, async () => { throw new Refused('spend') }, e => e instanceof Refused))
})

test('hunt: every query in trigger order inside the window, one candidate per URL (the earlier query keeps it), registry records win', async () => {
  const plan = { ...parsePlan(PLAN_JSON)!, source: 'model' as const }
  assert.deepEqual(huntQueries(plan).map(q => q.triggerId), ['t1', 't1', 't1', 't2', 'ask'])
  assert.equal(afterDate(CASE), '2026-08-17')
  const seen: string[] = []
  const r = await hunt(CASE, plan, async (q, after) => {
    seen.push(after)
    await new Promise(res => setTimeout(res, q.length % 3))   // answers arrive out of order
    return { ok: true, hits: [{ url: 'https://www.shared.test/a/?utm_source=x', title: 'shared', snippet: 's', date: '2026-10-01' }, { url: `https://news.test/${encodeURIComponent(q)}`, title: q, snippet: '', date: null }] }
  }, { extra: [{ url: 'https://shared.test/a', title: 'permit', snippet: '', date: '2026-10-02', triggerId: 'permits', query: 'austin permits', via: 'registry', dated: 'registry' } as Candidate] })
  assert.ok(seen.every(a => a === '2026-08-17'))
  assert.equal(r.candidates.length, 6)
  assert.equal(r.candidates.find(c => urlKey(c.url) === urlKey('https://shared.test/a'))!.via, 'registry', 'the dated record replaces the search hit')
  assert.equal(r.candidates.find(c => c.title === 'Austin roofing company hiring estimator 2026')!.triggerId, 't1')
  assert.equal(r.funnel.in, 5); assert.equal(r.funnel.out, 6); assert.equal(r.funnel.dropped.duplicate_url, 5)
})

test('hunt: a rate answer is retried after a pause, a cap stops every further query, other failures skip one query', async () => {
  const plan = { ...parsePlan(PLAN_JSON)!, source: 'model' as const }
  let calls = 0, waits = 0
  const r = await hunt(CASE, plan, async q => {
    calls++
    if (calls === 1) return { ok: false, reason: 'rate' }
    if (q.includes('Round Rock')) return { ok: false, reason: 'unavailable' }
    if (q.includes('new office')) return { ok: false, reason: 'cap' }
    return { ok: true, hits: [{ url: `https://x.test/${calls}`, title: '', snippet: '', date: null }] }
  }, { concurrency: 1, wait: async () => { waits++ } })
  assert.equal(waits, 1)
  assert.equal(r.stopped, 'cap'); assert.deepEqual(r.failed, { unavailable: 1, cap: 1 })
  assert.equal(calls, 5, 'the asking query after the cap is never sent')
  assert.equal(r.candidates.length, 2)
})
