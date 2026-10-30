// #381: adaptive discovery driven by actionable yield. Pure planner + persistence on both engines. Synthetic funnels and queries; no search, no spend.
import test from 'node:test'
import assert from 'node:assert/strict'
import { bothEngines } from './helpers/engines.ts'
import { diagnose, failedQueryKeys, loadRounds, nextRound, queryKey, recordRound, type Funnel, type RoundRecord } from '../lib/scan/discovery-rounds.ts'

const ICP = { signals: ['opened a second dental office', 'hiring a front desk coordinator', 'announced a new clinic location'], where: ['Brooklyn, NY'] }
const Q = 'Dental practices in Brooklyn that opened a new office in the past 90 days'
const F = (o: Partial<Funnel> = {}): Funnel => ({ candidates: 0, verified: 0, fit_ok: 0, timed: 0, identified: 0, actionable: 0, ...o })
const spent = (o = {}) => ({ searches: 4, pages: 8, ms: 20_000, ...o })

test('diagnosis names where the funnel lost the candidates', () => {
  assert.equal(diagnose(F()), 'extraction'); assert.equal(diagnose(F({ candidates: 6 })), 'extraction')
  assert.equal(diagnose(F({ candidates: 6, verified: 4 })), 'fit'); assert.equal(diagnose(F({ candidates: 6, verified: 4, fit_ok: 3 })), 'timing')
  assert.equal(diagnose(F({ candidates: 6, verified: 4, fit_ok: 3, timed: 2 })), 'identity'); assert.equal(diagnose(F({ candidates: 6, verified: 4, fit_ok: 3, timed: 2, identified: 2 })), 'contact')
})

test('zero actionable from the first batch: a DIFFERENT source and unseen queries are chosen, within bounds, with the diagnosis logged', () => {
  const history: RoundRecord[] = [{ round: 1, source: 'search:tinyfish', query: ICP.signals[0] + ' Brooklyn', outcome: 'ok', new_pages: 9, actionable_after: 0 }]
  const d = nextRound({ query: Q, icp: ICP, funnel: F({ candidates: 5 }), history, spent: spent() })
  assert.equal(d.action, 'search'); if (d.action !== 'search') return
  assert.equal(d.source, 'adapter:jobboards', 'the first untried source, not the same one again'); assert.equal(d.diagnosis, 'extraction'); assert.ok(d.queries.length >= 1 && d.queries.length <= 3)
  assert.ok(d.queries.every(q => /brooklyn/i.test(q)), 'the geography stays fixed')
  assert.ok(!d.queries.some(q => queryKey(q) === queryKey(ICP.signals[0] + ' Brooklyn')), 'a query already tried is not repeated')
})

test('failed / empty queries are never billed again, here or from an earlier run', () => {
  const all = nextRound({ query: Q, icp: ICP, funnel: F(), history: [], spent: spent({ searches: 0 }) })
  assert.equal(all.action, 'search'); if (all.action !== 'search') return
  const failedKeys = new Set(all.queries.map(queryKey))
  const again = nextRound({ query: Q, icp: ICP, funnel: F(), history: [], spent: spent({ searches: 0 }), failedKeys })
  assert.ok(again.action === 'stop' ? again.reason === 'no_new_queries' : again.action === 'search' && again.queries.every(q => !failedKeys.has(queryKey(q))))
  const viaHistory = nextRound({ query: Q, icp: ICP, funnel: F(), history: all.queries.map((q, i) => ({ round: 1, source: all.source, query: q, outcome: 'failed' as const, new_pages: 0, actionable_after: 0 })), spent: spent({ searches: 0 }) })
  assert.ok(viaHistory.action === 'stop' ? viaHistory.reason === 'no_new_queries' : viaHistory.action === 'search' && viaHistory.queries.every(q => !failedKeys.has(queryKey(q))))
})

test('stop reasons are honest: target met; time / budget / rounds are LIMITS, not market exhaustion; coverage exhaustion needs several quiet sources', () => {
  const hist = (n: number, pages: number): RoundRecord[] => Array.from({ length: n }, (_, k) => ({ round: k + 1, source: ['search:tinyfish', 'adapter:jobboards', 'search:news'][k % 3], query: `q${k}`, outcome: 'empty' as const, new_pages: pages, actionable_after: 0 }))
  const stop = (o: Partial<Parameters<typeof nextRound>[0]> = {}) => nextRound({ query: Q, icp: ICP, funnel: F({ candidates: 3, verified: 2 }), history: [], spent: spent(), ...o })
  assert.deepEqual(stop({ funnel: F({ actionable: 5 }) }), { action: 'stop', reason: 'target_met', detail: '5 actionable leads (target 5).' })
  const t = stop({ spent: spent({ ms: 95_000 }) }); assert.ok(t.action === 'stop' && t.reason === 'time_exhausted' && /not market exhaustion/.test(t.detail))
  const s = stop({ spent: spent({ searches: 8 }) }); assert.ok(s.action === 'stop' && s.reason === 'budget_exhausted' && /not market exhaustion/.test(s.detail))
  const r = stop({ history: hist(3, 4) }); assert.ok(r.action === 'stop' && r.reason === 'max_rounds' && /not market exhaustion/.test(r.detail))
  const c = stop({ history: hist(2, 0).concat([{ round: 3, source: 'search:news', query: 'q9', outcome: 'empty', new_pages: 0, actionable_after: 0 }]), budget: { maxRounds: 9 } })
  assert.ok(c.action === 'stop' && c.reason === 'coverage_exhausted')
  assert.notEqual((stop({ history: hist(2, 0), budget: { maxRounds: 9 } }) as { reason?: string }).reason, 'coverage_exhausted', 'two sources is not enough to call the market exhausted')
})

test('losses after discovery (identity, contact) are not solved by more searching; constraints are never widened', () => {
  const d = nextRound({ query: Q, icp: ICP, funnel: F({ candidates: 6, verified: 4, fit_ok: 3, timed: 3, identified: 0 }), history: [], spent: spent() })
  assert.deepEqual([d.action, (d as { diagnosis?: string }).diagnosis], ['enrich', 'identity'])
  const e = nextRound({ query: Q, icp: ICP, funnel: F({ candidates: 6, verified: 4, fit_ok: 3, timed: 3, identified: 3 }), history: [], spent: spent() })
  assert.deepEqual([e.action, (e as { diagnosis?: string }).diagnosis], ['enrich', 'contact'])
  const s = nextRound({ query: Q, icp: { ...ICP, where: ['Brooklyn, NY'] }, funnel: F(), history: [], spent: spent({ searches: 0 }) })
  assert.ok(s.action === 'search' && s.queries.every(q => /brooklyn/i.test(q) && !/\b(?:new york state|queens|manhattan|nationwide)\b/i.test(q)))
})

bothEngines('rounds persist per job, are tenant-scoped, and a failed query stays remembered across jobs', async ({ db }) => {
  for (const [id, user] of [['j1'.padEnd(24, '1'), 'A'], ['j2'.padEnd(24, '2'), 'A'], ['j3'.padEnd(24, '3'), 'B']]) await db.run("INSERT INTO scan_jobs (id, user_id, business_name, industry, location) VALUES (?, ?, 'S', 'x', 'y')", [id, user])
  const [j1, j2, j3] = ['j1'.padEnd(24, '1'), 'j2'.padEnd(24, '2'), 'j3'.padEnd(24, '3')]
  await recordRound(db, j1, { round: 1, source: 'search:tinyfish', query: 'Opened a Second Dental office, Brooklyn!', outcome: 'empty', new_pages: 0, actionable_after: 0, why: 'first batch' }, 1_800_000_000)
  await recordRound(db, j1, { round: 1, source: 'search:tinyfish', query: 'opened a second dental office brooklyn', outcome: 'failed', new_pages: 0, actionable_after: 0 }, 1_800_000_000)   // same key: one row
  await recordRound(db, j1, { round: 2, source: 'adapter:jobboards', query: 'hiring front desk brooklyn', outcome: 'ok', new_pages: 7, actionable_after: 2 }, 1_800_000_100)
  await recordRound(db, j3, { round: 1, source: 'search:tinyfish', query: 'tenant b private query', outcome: 'failed', new_pages: 0, actionable_after: 0 }, 1_800_000_000)
  assert.deepEqual((await loadRounds(db, 'A', j1)).map(r => [r.round, r.source, r.outcome, r.new_pages, r.actionable_after]), [[1, 'search:tinyfish', 'empty', 0, 0], [2, 'adapter:jobboards', 'ok', 7, 2]])
  assert.deepEqual(await loadRounds(db, 'B', j1), [], 'another tenant cannot read this job\'s rounds')
  assert.deepEqual([...await failedQueryKeys(db, 'A', 1_700_000_000)].sort(), ['opened a second dental office brooklyn'], 'a later job of the same tenant sees what already failed')
  assert.deepEqual([...await failedQueryKeys(db, 'A', 1_900_000_000)], [], 'only since the cut-off')
  assert.ok(!(await failedQueryKeys(db, 'A', 0)).has('tenant b private query'))
  void j2
})
