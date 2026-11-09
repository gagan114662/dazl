// #380 / #204 Test B ("seed funding OR first sales hire"): the three steps BEFORE the gate follow the compiled OR plan (salesGateOr), within the same budgets.
// - extraction prompt (halves.ts): either fact qualifies a company on its own;
// - fetch / extraction ordering (runner.ts fetchRankFor): a job page proves the hiring branch, so it is not ranked behind every event page;
// - extra searches (corroborate.ts): the slots the AND rule spends on funding searches for board postings go to candidates whose own quote proves neither branch,
//   searched for the branch they claim (funding OR sales hiring). Never more searches than the AND rule would make.
// The AND wording, the ambiguous "and/or" and Test A are pinned to a snapshot recorded on #643's head (1b39c7a8 on main; same tree as da52cca1).
// Synthetic pages, stubbed model / TinyFish / news / boards; invented companies; no network, no key, no credits.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { buildSourcePrompt } from '../lib/sources/index.ts'
import { compoundHalves, halvesBlock } from '../lib/scan/halves.ts'
import { corroborationTargets, MAX_CORROBORATE } from '../lib/scan/corroborate.ts'
import { fetchRankFor } from '../lib/scan/runner.ts'
import { salesGateOr } from '../lib/scan/sales-hiring-required.ts'
import { runFixture, daysAgo, type Fixture, type Cand } from './helpers/acceptance-harness.ts'
import type { SafeGet } from '../lib/sources/types.ts'

const OR_B = 'London B2B SaaS startups that raised seed funding or made their first sales hire in the last 90 days'
const AND_B = 'Find London UK B2B SaaS startups that announced seed funding within the past 90 days and are hiring sales staff.'
const ANDOR_B = 'London B2B SaaS startups that raised seed funding and/or made their first sales hire in the last 90 days'
const TEST_A = 'Find independent dental practices in New York, NY that opened a new location or are hiring a front desk receptionist in the last 90 days. We sell dental appointment and reminder software.'
const ICP_B = { summary: 'London B2B SaaS startups', who: ['Founder', 'Head of Sales'], industries: ['SaaS'], sizes: [], where: ['London, UK'], signals: ['raised seed funding in the last 90 days', 'made their first sales hire in the last 90 days'], exclude: ['agencies'], country: 'GB', language: 'en', window_days: 90 }
const ICP_A = { summary: 'Independent dental practices in New York', who: ['Practice owner', 'Office manager'], industries: ['Dental'], sizes: [], where: ['New York, NY'], signals: ['opened a new location', 'hiring a front desk receptionist'], exclude: [], country: 'US', language: 'en', window_days: 90 }
const filler = ' More about the company, its product and its people.'.repeat(10)

// ---- the scan fixture ----
const HIRECO = 'https://hireco.example/careers/sales-account-executive'   // a company careers page (isJobPage), not an ATS board
const BOARDCO = 'https://boards.greenhouse.io/boardco/jobs/1'
const PASTCO = 'https://pastco-news.example/first-sales-hire'
const FUNDCO = 'https://fundco-news.example/seed'
const PASTCO_PRESS = 'https://press.example/pastco-hiring'
const BOARDCO_PRESS = 'https://press.example/boardco-seed'
const Q = {
  hireco: 'Hireco, a London B2B SaaS startup, is hiring its first Sales Account Executive in London to sell to UK fintechs. Join the sales team',
  boardco: 'Boardco is hiring an Account Executive in London to sell to UK fintechs. Join the sales team',
  pastco: 'Pastco, a London B2B SaaS startup, made its first sales hire, appointing a Head of Sales',
  fundco: 'Fundco, a London B2B SaaS startup, raised a 2m GBP seed round led by Example Ventures',
  press: 'Pastco is hiring a Sales Account Executive in London to sell to UK fintechs. Join the sales team',
  boardcoPress: 'Boardco, a London B2B SaaS startup, raised a 1m GBP seed round led by Example Capital',
}
const CANDS: Cand[] = [
  { company: 'Hireco', signal: 'is hiring a sales account executive', source_url: HIRECO, excerpt: Q.hireco, event_date: daysAgo(9) },
  { company: 'Boardco', signal: 'is hiring a sales account executive', source_url: BOARDCO, excerpt: Q.boardco, event_date: daysAgo(9) },
  { company: 'Pastco', signal: 'made its first sales hire', source_url: PASTCO, excerpt: Q.pastco, event_date: daysAgo(11) },
  { company: 'Fundco', signal: 'raised a seed round', source_url: FUNDCO, excerpt: Q.fundco, event_date: daysAgo(12) },
  { company: 'Pastco', signal: 'is hiring a sales account executive', source_url: PASTCO_PRESS, excerpt: Q.press, event_date: daysAgo(8) },
  { company: 'Boardco', signal: 'raised a seed round', source_url: BOARDCO_PRESS, excerpt: Q.boardcoPress, event_date: daysAgo(14) },
]
const ms = (n: number) => Date.now() - n * 86_400_000
const GH = { jobs: [{ id: 1, title: 'Sales Account Executive', location: { name: 'London, UK' } }] }
const GHD = { id: 1, title: 'Sales Account Executive', first_published: new Date(ms(9)).toISOString(), absolute_url: BOARDCO, location: { name: 'London, UK' }, content: `&lt;p&gt;${Q.boardco}.&lt;/p&gt;` }
// Dated, in-window news results that carry no candidate. The first search returns the 4 candidate pages among 6 of them; every later search returns 10 new ones.
// Over the scan that is well past the 16 fetch slots and the 30-item extraction cap, so the fetch ranking decides whether the careers page is read at all.
const FILL = Array.from({ length: 80 }, (_, i) => ({ url: `https://n${i}.example/story`, title: `Story ${i}`, snippet: `London startup roundup number ${i}: product news and events this week`, date: daysAgo(5) }))

interface Calls { news: string[] }
function scan(request: string, icp: object): { f: Fixture; calls: Calls } {
  const calls: Calls = { news: [] }
  const dated = (u: string, t: string, d: string) => ({ title: u, text: `On ${d}, ${t}.${filler}` })
  const hits = [FILL[0], { url: HIRECO, title: 'Sales Account Executive at Hireco', snippet: Q.hireco, date: daysAgo(9) }, { url: BOARDCO, title: 'Account Executive', snippet: Q.boardco, date: daysAgo(9) },
    { url: PASTCO, title: 'Pastco makes first sales hire', snippet: Q.pastco, date: daysAgo(11) }, { url: FUNDCO, title: 'Fundco raises seed', snippet: Q.fundco, date: daysAgo(12) }, ...FILL.slice(1, 6)]
  const hitsFor = (n: number) => n === 0 ? hits : FILL.slice(6 + 10 * (n - 1), 16 + 10 * (n - 1))
  const pages: Record<string, { title: string; text: string }> = {
    [HIRECO]: dated(HIRECO, Q.hireco, daysAgo(9)), [BOARDCO]: dated(BOARDCO, Q.boardco, daysAgo(9)), [PASTCO]: dated(PASTCO, Q.pastco, daysAgo(11)),
    [FUNDCO]: dated(FUNDCO, Q.fundco, daysAgo(12)), [PASTCO_PRESS]: dated(PASTCO_PRESS, Q.press, daysAgo(8)), [BOARDCO_PRESS]: dated(BOARDCO_PRESS, Q.boardcoPress, daysAgo(14)),
  }
  const sourceHttp: SafeGet = async url => {
    if (url === 'https://boards-api.greenhouse.io/v1/boards/boardco/jobs') return { status: 200, body: JSON.stringify(GH) }
    if (url === 'https://boards-api.greenhouse.io/v1/boards/boardco/jobs/1') return { status: 200, body: JSON.stringify(GHD) }
    return { status: 404, body: '' }
  }
  // GDELT stub: a search naming Pastco finds the dated press page about its open sales role, one naming Boardco finds its seed article (so the AND path spends its
  // corroboration extraction too: the call counts compare full budgets, not a search that happened to find nothing); every other news search answers with nothing.
  const art = (u: string, t: string, d: string) => [{ url: u, title: t, seendate: `${d.replace(/-/g, '')}T100000Z` }]
  const newsHttp: SafeGet = async url => {
    const q = new URL(url).searchParams.get('query') ?? ''; calls.news.push(q)
    return { status: 200, body: JSON.stringify({ articles: /Pastco/.test(q) ? art(PASTCO_PRESS, 'Pastco is hiring', daysAgo(8)) : /Boardco/.test(q) ? art(BOARDCO_PRESS, 'Boardco raises seed', daysAgo(14)) : [] }) }
  }
  // The stub extractor returns a candidate exactly when its page is one of the prompt's items (what the model can see).
  const extractionFn = (prompt: string) => CANDS.filter(c => prompt.includes(c.source_url))
  return { calls, f: { request, modelIcp: icp, reviewedIcp: icp, icpReviewed: true, modelQueries: ['london saas startup seed round', 'london b2b saas first sales hire', 'london saas startup hiring account executive', 'london startup news'], hits, hitsFor, tfPages: pages, own: pages, extraction: [], extractionFn, deps: { sourceHttp, newsHttp } } }
}
const fate = (x: Awaited<ReturnType<typeof runFixture>>, company: string) => {
  const ls = x.db.prepare('SELECT review_reason FROM leads WHERE company = ?').all(company) as { review_reason: string | null }[]
  return ls.length === 0 ? 'none' : ls.map(l => l.review_reason === null ? 'verifier-passed' : `held:${l.review_reason}`).join(',')
}
// Everything the providers were asked, in order: model prompts, TinyFish searches and fetch batches, news searches, the verifier's own fetches. Dates normalised (the fixture is relative to today).
async function record(request: string, icp: object) {
  const { f, calls } = scan(request, icp)
  const x = await runFixture(f)
  const d = (s: string) => s.replace(/\d{4}-?\d{2}-?\d{2}(T\d{6}Z)?/g, '<date>')
  const trace = { prompts: x.calls.prompts.map(d), searches: x.calls.searches.map(d), afters: x.calls.afters.map(a => a === null ? null : '<date>'), tfFetchBatches: x.calls.tfFetchBatches, news: calls.news.map(d), ownFetch: x.calls.ownFetch }
  const providerCalls = trace.prompts.length + trace.searches.length + trace.tfFetchBatches.length + trace.news.length
  return { x, trace, providerCalls }
}

const SNAP = new URL('./fixtures/or-upstream-snapshot.json', import.meta.url)
// Recorded once on #643's head with OR_UPSTREAM_SNAPSHOT_WRITE=1 (see the PR); the AND / and-or / Test A traces must stay byte-identical, the OR call count is the ceiling.
if (process.env.OR_UPSTREAM_SNAPSHOT_WRITE === '1') {
  test('write the snapshot (baseline only)', async () => {
    const out: Record<string, unknown> = {}
    for (const [k, q, icp] of [['AND_B', AND_B, ICP_B], ['ANDOR_B', ANDOR_B, ICP_B], ['TEST_A', TEST_A, ICP_A], ['OR_B', OR_B, ICP_B]] as const) { const r = await record(q, icp); out[k] = { trace: r.trace, providerCalls: r.providerCalls } }
    writeFileSync(SNAP, JSON.stringify(out, null, 1) + '\n')
  })
} else {
  const snap = JSON.parse(readFileSync(SNAP, 'utf8')) as Record<string, { trace: unknown; providerCalls: number }>
  let orRun: ReturnType<typeof record> | undefined
  const orB = () => orRun ??= record(OR_B, ICP_B)   // one Test B scan, read by the three tests below

  test('(1) TEST B OR wording, through the real runner: the hire-only careers-page candidate is fetched, extracted and reaches the gate as a hiring-branch candidate', async t => {
    const { x, trace } = await orB()
    t.diagnostic(`Hireco: ${fate(x, 'Hireco')}; Pastco: ${fate(x, 'Pastco')}; Fundco: ${fate(x, 'Fundco')}; Boardco: ${fate(x, 'Boardco')}`)
    assert.ok(trace.tfFetchBatches.flat().includes(HIRECO), 'the job page gets a fetch slot')
    assert.ok(x.extractionPrompt.includes(HIRECO), 'the job page survives the 30-item extraction cap')
    assert.notEqual(fate(x, 'Hireco'), 'none', 'Hireco reached the gate')
    assert.doesNotMatch(fate(x, 'Hireco'), /no_event_evidence/, 'not held because the OTHER branch (funding) is missing')
    assert.match(x.extractionPrompt, /accepts EITHER of two facts/); assert.doesNotMatch(x.extractionPrompt, /needs TWO facts/)
  })
  test('(1) TEST B OR wording: the extra search goes to the hiring branch (Pastco: a completed-hire article, its own quote proves neither branch), not to a funding search for a board posting that already proves hiring', async () => {
    const { x, trace } = await orB()
    assert.ok(trace.news.some(q => /"Pastco" hiring sales/.test(q)), JSON.stringify(trace.news))
    assert.ok(!trace.news.some(q => /"Boardco" raised/.test(q)), 'no funding search for a hire-proven board posting')
    assert.ok(trace.ownFetch.includes(PASTCO_PRESS), 'the hiring search result is fetched and verified')
    assert.match(fate(x, 'Pastco'), /verifier-passed/, fate(x, 'Pastco'))
    assert.equal(fate(x, 'Fundco'), 'verifier-passed', 'the funding branch still passes on its own')
  })
  test('(3) provider calls per scan under Test B are no greater than on #643\'s head', async t => {
    const { providerCalls, trace } = await orB()
    t.diagnostic(`provider calls: ${providerCalls} (prompts ${trace.prompts.length}, searches ${trace.searches.length}, fetch batches ${trace.tfFetchBatches.length}, news ${trace.news.length}); #643 head: ${snap.OR_B.providerCalls}`)
    assert.ok(providerCalls <= snap.OR_B.providerCalls, `${providerCalls} > ${snap.OR_B.providerCalls}`)
  })
  for (const [k, q, icp] of [['AND_B', AND_B, ICP_B], ['ANDOR_B', ANDOR_B, ICP_B], ['TEST_A', TEST_A, ICP_A]] as const) {
    test(`(2) ${k}: prompts, queries, news searches, fetch batches and verifier fetch order are byte-identical to #643's head`, async () => {
      const { trace, providerCalls } = await record(q, icp)
      assert.deepEqual(trace, snap[k].trace); assert.equal(providerCalls, snap[k].providerCalls)
    })
  }
}

// ---- unit level: the three steps and the fall-back to AND ----
const items = [{ source: 'x', url: 'https://a.example/1', title: 't', quote: 'q', date: null }]
const icpB = JSON.stringify(ICP_B)
const boardLead = { company: 'Boardco', excerpt: Q.boardco, signal: 'is hiring a sales account executive' }
const others = [{ company: 'Pastco', excerpt: Q.pastco, signal: 'made its first sales hire' }, { company: 'Fundco', excerpt: Q.fundco, signal: 'raised a seed round' }, { company: 'Seedly', excerpt: 'Seedly, a London startup, is closing in on a seed', signal: 'raising a seed round' }, { company: 'Vague', excerpt: 'Vague is a London B2B SaaS startup', signal: 'London SaaS' }]

test('halves: OR gets the either-fact block; AND, and/or and Test A keep the two-fact block byte for byte', () => {
  assert.deepEqual(compoundHalves(OR_B, ICP_B), { event: 'a COMPLETED seed funding round (not plans, talks or a raise by another company)', or: true, done: true })
  for (const q of [AND_B, ANDOR_B]) assert.deepEqual(compoundHalves(q, ICP_B), { event: 'a COMPLETED seed funding round (not plans, talks or a raise by another company)' })
  assert.equal(halvesBlock({ event: 'E' }), `
This request needs TWO facts about the SAME company: (1) E, and (2) the company is hiring sales / go-to-market staff. One item almost never shows both (a funding article does not list job openings; a job posting does not mention funding).
Return a company when an item shows EITHER fact for it. In "signal" say plainly which fact THIS item shows (for example "raised a seed round" or "is hiring a sales account executive") and never claim the other fact. The "excerpt" must show the fact you name.
The other fact is checked separately, from other sources: do not guess it and do not copy it from anywhere else.`)
  const or = buildSourcePrompt(OR_B, ICP_B, items); assert.match(or, /accepts EITHER of two facts about a company: \(1\) a COMPLETED seed funding round .*, or \(2\) the company MADE a sales/); assert.match(or, /One fact on its own qualifies the company/); assert.doesNotMatch(or, /TWO facts/)
  assert.match(buildSourcePrompt(AND_B, ICP_B, items), /needs TWO facts/); assert.match(buildSourcePrompt(ANDOR_B, ICP_B, items), /needs TWO facts/)
})
test('fetch rank: OR ranks a job page with the event pages; AND keeps job pages behind them', () => {
  const by = new Map([[HIRECO, { date: daysAgo(9) }], [FUNDCO, { date: daysAgo(12) }]])
  const and = fetchRankFor(by, 90, true), flat = fetchRankFor(by, 90, false)
  assert.equal(and(HIRECO), 2); assert.equal(and(FUNDCO), 0); assert.equal(flat(HIRECO), 0); assert.equal(flat(FUNDCO), 0)
})
test('corroborate: OR spends the AND rule\'s slots (never more) on each unproven candidate\'s own branch; a candidate claiming neither is not searched', () => {
  const job = { query: OR_B, icp: icpB }
  assert.deepEqual(corroborationTargets(job, [boardLead], others), [{ company: 'Pastco', branch: 'hiring', query: '"Pastco" hiring sales' }], 'one AND slot -> one OR search')
  const three = corroborationTargets(job, ['B1', 'B2', 'B3', 'B4'].map(c => ({ ...boardLead, company: `Boardco ${c}`, excerpt: Q.boardco.replace('Boardco', `Boardco ${c}`) })), others)
  assert.deepEqual(three, [{ company: 'Pastco', branch: 'hiring', query: '"Pastco" hiring sales' }, { company: 'Seedly', branch: 'event', query: '"Seedly" raised seed funding round' }])
  assert.ok(three.length <= MAX_CORROBORATE)
  assert.deepEqual(corroborationTargets(job, [], others), [], 'no AND slot -> no OR search (no new spend)')
  // AND and and/or: the 'others' list is never read; byte-identical to the two-argument call.
  for (const q of [AND_B, ANDOR_B]) { const j = { query: q, icp: icpB }; assert.deepEqual(corroborationTargets(j, [boardLead], others), corroborationTargets(j, [boardLead])); assert.deepEqual(corroborationTargets(j, [boardLead]), [{ company: 'Boardco', query: '"Boardco" raised seed funding round' }]) }
  assert.deepEqual(corroborationTargets({ query: TEST_A, icp: JSON.stringify(ICP_A) }, [boardLead], others), [], 'Test A asks no funding')
})
test('(4) malformed plans fall back to AND in all three steps', () => {
  // An unreadable or non-object profile: salesGateOr has no plan, so every step is AND (the gate does the same).
  for (const icp of ['not json', '{"signals": [', '[1,2]', 'null', '42', '"str"', 'true']) {
    assert.equal(salesGateOr(OR_B, icp), null, icp)
    const j = { query: OR_B, icp }
    const t = corroborationTargets(j, [boardLead], others)
    assert.ok(t.every(x => x.branch === undefined), `${icp}: ${JSON.stringify(t)}`)
    assert.deepEqual(t, corroborationTargets(j, [boardLead]))
    assert.equal(compoundHalves(OR_B, icp)?.or, undefined, icp)
  }
  // A readable object with odd fields: the steps follow exactly what the gate's plan says (never a different reading upstream).
  for (const icp of ['{"signals": 5}', '{"signals": [null, {}, 3]}', '{}', '{' + '"a":{'.repeat(2000) + '}'.repeat(2000) + '}']) {
    const gateOr = !!salesGateOr(OR_B, icp)
    assert.equal(corroborationTargets({ query: OR_B, icp }, [boardLead], others).some(x => x.branch !== undefined), gateOr, icp.slice(0, 30))
    assert.equal(compoundHalves(OR_B, icp)?.or === true, gateOr && compoundHalves(OR_B, icp) !== null, icp.slice(0, 30))
  }
  // A third branch, a negated branch or a non-sales role: not the two-branch OR, so AND.
  for (const q of ['London B2B SaaS startups that raised seed funding or made their first sales hire or opened an office in the last 90 days', 'London B2B SaaS startups that raised seed funding or made their first engineering hire in the last 90 days']) {
    assert.equal(compoundHalves(q, ICP_B)?.or, undefined, q); assert.ok(corroborationTargets({ query: q, icp: icpB }, [boardLead], others).every(x => x.branch === undefined), q)
  }
  for (const q of [null, undefined, '']) assert.deepEqual(corroborationTargets({ query: q, icp: icpB }, [boardLead], others), corroborationTargets({ query: q, icp: icpB }, [boardLead]))
  // Hostile lead fields: quotes and newlines in names are stripped from the query; huge names are capped at 150 characters; empty names are skipped.
  const hostile = [{ company: 'Pa"st\nco', excerpt: 'made its first sales hire', signal: 'made its first sales hire' }, { company: 'X'.repeat(500), excerpt: 'hired a rep', signal: 'hired' }, { company: '', excerpt: 'raised seed', signal: 'raised seed' }]
  const h = corroborationTargets({ query: OR_B, icp: icpB }, ['B1', 'B2', 'B3'].map(c => ({ ...boardLead, company: `Boardco ${c}`, excerpt: Q.boardco.replace('Boardco', `Boardco ${c}`) })), hostile)
  assert.equal(h.length, 2); assert.equal(h[0].query, '"Pa st co" hiring sales'); assert.ok(h[1].query.length <= 150)
})
