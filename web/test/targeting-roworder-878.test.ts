// #878 follow-up (PR #1022 review finding F2): a hiring condition measured relative to another event ("within 30 days of the raise")
// must check EVERY dated posting against that gap, not only the first one read. lead_enrichments is read with no ORDER BY, so before this
// fix a valid lead passed or was held depending on storage order. Also F6: two separate sources that share a calendar date are two
// sources; one source written two ways is one. Pure proof tests, invented companies, no network, no model, no provider.
import test from 'node:test'
import assert from 'node:assert/strict'
import { compileTargeting, evaluatePlan, planConditions, type QueryPlan } from '../lib/scan/targeting.ts'
import { conditionProof, planProofs, type ProofLead, type ProofRow } from '../lib/scan/targeting-proof.ts'

const NOW = Date.parse('2026-10-28T12:00:00Z')
const ago = (d: number) => new Date(NOW - d * 86_400_000).toISOString().slice(0, 10)
const conds = (p: QueryPlan) => planConditions(p.root).map(x => x.cond)
const ctx = { query: 'x', icp: null, salesGatePassed: false, competitors: null, now: NOW }
const NEWS = 'https://news.example/brightloop-seed'
const lead = (quote: string, date: string | null, url = NEWS): ProofLead => ({ company: 'Brightloop', company_domain: 'brightloop.example', evidence_excerpt: quote, signal: null, source_url: url, event_date: date })
const RAISE = 'Brightloop raised a 3m seed round led by Example Ventures.'
const posting = (id: string, date: string, url = `https://boards.example/brightloop/${id}`): ProofRow => ({ connector: 'signals:greenhouse-gtm', kind: 'hiring', value: `SDR - ${id} - posted ${date}`, source_url: url, source_date: date })   // the stored shape of a dated posting row (signals/ats-gtm.ts postingEvidence)
// every ordering of a small list
const perms = <T>(xs: T[]): T[][] => xs.length <= 1 ? [xs] : xs.flatMap((x, i) => perms([...xs.slice(0, i), ...xs.slice(i + 1)]).map(r => [x, ...r]))

// The re-check's exact reproduction: raise 40 days ago; posting A 1 day old (39 days after the raise), posting B 20 days old (20 days after).
const QUERY = 'startups that raised seed funding within 60 days and are hiring SDRs within 30 days of the raise'

test('the plan reads as expected: C2 is a hiring clock relative to the C1 raise', () => {
  const [seed, hiring] = conds(compileTargeting(QUERY))
  assert.deepEqual([seed.id, seed.kind, hiring.kind, hiring.relative_to, hiring.within_days], ['C1', 'funding', 'hiring', 'C1', 30])
})

test('F2: a posting inside the gap passes whatever order the postings are read in (it was held when the out-of-gap one came first)', () => {
  const p = compileTargeting(QUERY)
  const A = posting('a', ago(1)), B = posting('b', ago(20))
  for (const rows of [[A, B], [B, A]]) {
    const pr = planProofs(p, lead(RAISE, ago(40)), rows, ctx)
    const order = rows.map(r => r.value).join(' then ')
    assert.equal(pr.C1.truth, 'pass', order)
    assert.equal(pr.C2.truth, 'pass', `${order}: posting B is 20 days after the raise (got: ${pr.C2.reason})`)
    assert.equal(pr.C2.date, ago(20), `${order}: the proof is the posting inside the gap`)
    assert.equal(pr.C2.source_url, B.source_url)
    assert.match(pr.C2.reason, /20 days after C1/)
    assert.equal(evaluatePlan(p, pr).truth, 'pass', order)
  }
})

test('F2: the same through conditionProof directly, both orders, with and without the anchor source', () => {
  const hiring = conds(compileTargeting(QUERY))[1]
  const A = posting('a', ago(1)), B = posting('b', ago(20))
  for (const rows of [[A, B], [B, A]]) {
    for (const sources of [{}, { C1: NEWS }]) {
      const r = conditionProof(hiring, lead('', null), rows, ctx, { C1: ago(40) }, sources)
      assert.deepEqual([r.truth, r.date], ['pass', ago(20)], JSON.stringify({ rows: rows.map(x => x.value), sources }))
    }
  }
})

test('order never decides: every permutation of mixed rows gives the identical proof, pass or held', () => {
  const p = compileTargeting(QUERY)
  const noise: ProofRow[] = [
    { connector: 'sitecrawl', kind: 'email', value: 'x@brightloop.example', source_url: 'https://brightloop.example/', source_date: ago(3) },
    posting('old', ago(200)), // outside the hiring now-clock
    posting('pre', ago(45)), // before the raise
  ]
  const inGap = [posting('a', ago(1)), posting('b', ago(20)), posting('c', ago(15))]
  const seen = new Set<string>()
  for (const rows of perms([...noise, ...inGap])) {
    const pr = planProofs(p, lead(RAISE, ago(40)), rows, ctx)
    seen.add(JSON.stringify(pr.C2))
    assert.equal(pr.C2.truth, 'pass')
  }
  assert.equal(seen.size, 1, 'one proof whatever the order (the newest posting inside the gap)')
  assert.equal(JSON.parse([...seen][0]).date, ago(15))
  // no posting inside the gap: held in every order, with the same reason
  const held = new Set<string>()
  for (const rows of perms([...noise, posting('a', ago(1)), posting('z', ago(2))])) {
    const pr = planProofs(p, lead(RAISE, ago(40)), rows, ctx)
    assert.equal(pr.C2.truth, 'unknown')
    assert.match(pr.C2.reason, /not within 30 days after C1/)
    held.add(JSON.stringify(pr.C2))
  }
  assert.equal(held.size, 1)
})

test('a plain (non-relative) hiring clock is unchanged in truth and is now order-independent too', () => {
  const c = conds(compileTargeting('startups hiring SDRs within 30 days'))[0]
  assert.equal(c.relative_to, undefined)
  const rows = [posting('a', ago(1)), posting('b', ago(20)), posting('old', ago(45))]
  const out = new Set(perms(rows).map(r => JSON.stringify(conditionProof(c, lead('', null), r, ctx))))
  assert.equal(out.size, 1)
  assert.deepEqual([JSON.parse([...out][0]).truth, JSON.parse([...out][0]).date], ['pass', ago(1)])
  assert.equal(conditionProof(c, lead('', null), [posting('old', ago(45))], ctx).truth, 'unknown')
})

test('F6: a posting on its own source dated the same day as the raise is a separate source (gap 0 passes)', () => {
  const p = compileTargeting(QUERY)
  const pr = planProofs(p, lead(RAISE, ago(10)), [posting('a', ago(10))], ctx)
  assert.deepEqual([pr.C1.truth, pr.C2.truth], ['pass', 'pass'], pr.C2.reason)
  assert.match(pr.C2.reason, /0 days after C1/)
})

test('F6: one source written two ways is still one source, and one quote never dates both events', () => {
  const p = compileTargeting(QUERY)
  for (const url of [NEWS, 'http://news.example/brightloop-seed/', 'https://WWW.News.Example/brightloop-seed?utm=x#top', ` ${NEWS} `]) {
    const pr = planProofs(p, lead(RAISE, ago(10)), [posting('same', ago(10), url)], ctx)
    assert.equal(pr.C1.truth, 'pass')
    assert.equal(pr.C2.truth, 'unknown', url)
    assert.match(pr.C2.reason, /not dated on separate sources/, url)
  }
  // the raise and the hiring both shown by the lead's own quote (one source): never a relative proof, even with no posting at all
  const both = planProofs(p, lead('Brightloop raised a 3m seed round and is hiring SDRs to build its outbound team.', ago(10)), [], ctx)
  assert.notEqual(both.C2.truth, 'pass')
  // the same posting row on a different URL form than the anchor but on a later date: still one source
  const later = planProofs(p, lead(RAISE, ago(20)), [posting('same', ago(10), 'http://www.news.example/brightloop-seed/')], ctx)
  assert.equal(later.C2.truth, 'unknown')
  // legacy callers with no source map keep the date rule: same date is not separate
  const hiring = conds(p)[1]
  assert.equal(conditionProof(hiring, lead('', null), [posting('a', ago(10))], ctx, { C1: ago(10) }).truth, 'unknown')
})

test('malformed rows and anchors never throw, never pass, and never change the result for the valid rows', () => {
  const p = compileTargeting(QUERY)
  const hiring = conds(p)[1]
  const bad = [
    { connector: 'signals:greenhouse-gtm', kind: 'hiring', value: null, source_url: 'https://boards.example/x', source_date: ago(20) },
    { connector: 'signals:greenhouse-gtm', kind: 'hiring', value: 'SDR', source_url: null, source_date: ago(20) },
    { connector: 'signals:greenhouse-gtm', kind: 'hiring', value: 'SDR', source_url: 'https://boards.example/y', source_date: 20261018 },
    { connector: 'signals:greenhouse-gtm', kind: 'hiring', value: 'SDR', source_url: 'https://boards.example/z', source_date: '2026-13-45' },
    { connector: 'signals:greenhouse-gtm', kind: 'hiring', value: ['SDR'], source_url: {}, source_date: null },
    { connector: 'signals:greenhouse-gtm', kind: 'hiring', value: 'x'.repeat(100_000), source_url: '', source_date: '' },
  ] as unknown as ProofRow[]
  for (const rows of [bad, [...bad, posting('b', ago(20))], [posting('b', ago(20)), ...bad]]) {
    let pr: ReturnType<typeof planProofs> | undefined
    assert.doesNotThrow(() => { pr = planProofs(p, lead(RAISE, ago(40)), rows, ctx) })
    assert.equal(pr!.C2.truth, rows.length > bad.length ? 'pass' : 'unknown')
    if (pr!.C2.truth === 'pass') assert.equal(pr!.C2.date, ago(20))
  }
  for (const anchor of [undefined, '', 'garbage', '2026-02-30', 20261018, null, {}] as unknown as string[]) {
    for (const src of [undefined, '', null, 42, NEWS] as unknown as string[]) {
      let r: ReturnType<typeof conditionProof> | undefined
      assert.doesNotThrow(() => { r = conditionProof(hiring, lead('', null), [posting('b', ago(20))], ctx, { C1: anchor }, { C1: src }) })
      assert.equal(r!.truth, 'unknown', `${JSON.stringify(anchor)} / ${JSON.stringify(src)}`)
    }
  }
})
