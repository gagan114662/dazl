// First 5, named people: a verified company gets a named decision-maker only from what the company's OWN website lists (free crawl), judged against the requested buyer role; a fit % only from a stored grade.
// Through the real runJob with stubbed news, pages, site and grader: invented company, no network, no key, no credits. Timings printed are STUB timings.
import test from 'node:test'
import assert from 'node:assert/strict'
import { runFixture, daysAgo, type Fixture } from './helpers/acceptance-harness.ts'
import { progressOf, outcomeInputs } from '../lib/scan/progress.ts'
import { scanOutcome } from '../lib/scan/scan-outcome.ts'
import { sourceRuns } from '../lib/scan/source-runs.ts'
import { runReportFor } from '../lib/scan/run-report.ts'
import { first5Of, verifiedLeads } from '../lib/scan/first5.ts'

const REQUEST = 'Find London UK B2B SaaS startups with 10-50 employees that announced seed funding within the past 90 days and are hiring sales staff. Include founder contacts and dated evidence.'
const ICP = { summary: 'London seed-funded B2B SaaS hiring sales', who: ['Founder'], industries: ['SaaS'], sizes: ['10-50'], where: ['London, UK'], signals: ['announced seed funding', 'hiring sales staff'], exclude: [], country: 'GB', language: 'en', window_days: 90 }
const NEWS = 'https://sifted.example/brightloop-raises-seed'
const pad = (s: string) => `${s} ${'More about the company and its people. '.repeat(15)}`
const QUOTE = 'Brightloop, a London B2B SaaS startup with 24 employees, raised a 3m GBP seed round this month'
const HOME = pad('<html><body><h1>Brightloop</h1> <p>London SaaS platform at 1 Old Street, London EC1V 9HX.</p> <a href="/team">Team</a> <a href="/careers">Careers</a> <a href="/contact">Contact</a>')
const team = (cards: string) => pad(`<html><body><p>Brightloop is a London software company building sales tooling for retailers across the UK and beyond.</p>${cards}`)
const CAREERS = '<html><body><h1>Careers at Brightloop</h1><p>Join Brightloop in London.</p><h2>Open roles</h2><ul><li><a href="/careers/ae">Account Executive - London</a> <a href="/careers/ae">Apply</a></li></ul></body></html>'
const JOB = '<html><body><h1>Account Executive - London</h1><p>Join Brightloop in London as our Account Executive.</p><a href="/careers/apply">Apply</a></body></html>'
const resp = (body: string, url: string) => ({ status: 200, body, finalUrl: url }), nf = (url: string) => ({ status: 404, body: '', finalUrl: url })
const BUDGET = JSON.stringify({ first5: true, paid_fallback: false, credit_enrichment: false })
const page = { title: 'Brightloop raises seed round', text: pad(`Published ${daysAgo(12)}. ${QUOTE}.`) }
const cand = { company: 'Brightloop', signal: 'raised a seed round', source_url: NEWS, excerpt: QUOTE, event_date: daysAgo(12) }

function fx(teamHtml: string | undefined, fit = 5, over: Partial<Fixture> = {}): Fixture {
  const reply = (p: string, mt?: number) => p.includes('LEAD <n> | fit') ? `LEAD 1 | fit ${fit} | intent 4 | action 4 | match yyyy | signals seed_round | why London seed-funded SaaS.` : mt === 300 ? JSON.stringify(['London SaaS startup seed round']) : JSON.stringify([cand])
  const prov = { research: async () => ({ text: '[]', citedUrls: [] }), complete: async (_k: string, p: string, _f?: typeof fetch, mt?: number) => reply(p, mt), completeDetailed: async (_k: string, p: string, _f?: typeof fetch, mt?: number) => ({ text: reply(p, mt), model: 'stub', usage: { input_tokens: 1, output_tokens: 1 } }), configuredModel: () => 'stub' }
  const crawl = async (url: string) => {
    const u = new URL(url)
    if (u.hostname === 'sifted.example') return resp(`<html><body><a href="https://brightloop.io/">Brightloop</a> ${page.text}</body></html>`, url)
    if (u.hostname !== 'brightloop.io') return null
    if (u.pathname === '/robots.txt') return resp('User-agent: *\nAllow: /', url)
    const map: Record<string, string | undefined> = { '/': HOME, '/team': teamHtml, '/careers': CAREERS, '/careers/ae': JOB }
    return map[u.pathname] !== undefined ? resp(map[u.pathname]!, url) : nf(url)
  }
  return { request: REQUEST, modelIcp: ICP, modelQueries: ['London SaaS startup seed round'], hits: [], tfPages: {}, own: { [NEWS]: page }, extraction: [cand], runBudget: BUDGET,
    deps: { score: true, providers: { anthropic: prov, openai: { research: async () => ({ text: '', citedUrls: [] }) } } as never, crawlGet: crawl as never,
      newsHttp: async () => ({ status: 200, body: JSON.stringify({ articles: [{ url: NEWS, title: page.title, seendate: '20261016T100000Z' }] }) }), fetchImpl: (async () => new Response('{}', { status: 200 })) as never }, ...over }
}
async function run(f: Fixture) {
  const saved = process.env.SITECRAWL_ENABLED; process.env.SITECRAWL_ENABLED = '1'
  try {
    const t0 = Date.now(); const r = await runFixture(f); const ms = Date.now() - t0
    const jobId = (r.db.prepare('SELECT id FROM scan_jobs').get() as { id: string }).id
    const rows = sourceRuns(r.db, 'A', jobId) as Record<string, unknown>[]; const rep = (runReportFor(r.db, 'A', jobId) ?? []).at(-1) ?? null
    const job = r.db.prepare('SELECT id, status, error, candidates, verified, needs_review, dropped FROM scan_jobs').get() as Record<string, unknown>
    const view = (status: string) => first5Of({ status, leads: verifiedLeads(r.db, 'A', jobId), progress: progressOf(rows, status), outcome: scanOutcome({ ...job, ...outcomeInputs(rep, rows, status) } as never) })
    return { r, ms, jobId, view, rep }
  } finally { if (saved === undefined) delete process.env.SITECRAWL_ENABLED; else process.env.SITECRAWL_ENABLED = saved }
}
const FOUNDER = '<div class="card"><h3>Jane Doe</h3><p>Chief Executive Officer</p></div>'

test('POSITIVE: a verified company whose own site lists its CEO -> the view names Jane Doe, with her title, the page it came from and the fit % from the stored grade; no profile search ran', async () => {
  const { r, ms, view, rep } = await run(fx(team(FOUNDER)))
  const v = view('done'); assert.equal(v.state, 'partial', JSON.stringify(v)); const l = v.leads[0]
  assert.equal(l.company, 'Brightloop'); assert.deepEqual([l.person?.name, l.person?.title, l.person_state, l.provisional], ['Jane Doe', 'Chief Executive Officer', 'found', false], JSON.stringify(l))
  assert.match(l.person!.source_url, /^https:\/\/brightloop\.io\/team/); assert.match(l.person!.basis, /company's own website/); assert.equal(l.fit_pct, 100)
  const ps = (rep as { enrichment: { stage: string; status: string }[] }).enrichment.find(x => x.stage === 'people_search')!; assert.equal(ps.status, 'skipped', 'TinyFish profile search is not free: not run under first5')
  assert.equal(r.calls.searches.length, 0)
  console.log(`# stub timing: sign-in-less first5 job, website crawl and people lookup included: ${ms} ms (stubbed network and model, NOT live latency)`)
})
test('while the post-finish stage runs the leads are PROVISIONAL (the sales-hiring check can still hold one) and a missing person reads "looking", then "none_published" at the end', async () => {
  const { view } = await run(fx(undefined))
  const mid = view('enriching'); assert.deepEqual([mid.state, mid.verified, mid.found, mid.enriching, mid.leads[0].provisional, mid.leads[0].person_state], ['finding', 0, 1, true, true, 'looking'], JSON.stringify(mid))
  const end = view('done'); assert.deepEqual([end.leads[0].person, end.leads[0].person_state], [null, 'none_published'])
})
test('A person who is not the requested buyer, or whose title is contradicted, is never named: listed_not_buyer / none, never a guess', async () => {
  const fac = await run(fx(team('<div class="card"><h3>Pat Smith</h3><p>Head of Facilities</p></div>'))); const a = fac.view('done').leads[0]
  assert.equal(a.person, null); assert.ok(['listed_not_buyer', 'none_published'].includes(a.person_state), a.person_state)
  const ex = await run(fx(team('<div class="card"><h3>Sam Lee</h3><p>Former Chief Executive Officer</p></div>'))); assert.equal(ex.view('done').leads[0].person, null)
})
test('fit % exists only when a grade is stored (null otherwise), and a low-fit lead is not shown', async () => {
  const ungraded = await run(fx(team(FOUNDER), 5, { deps: { ...fx(team(FOUNDER)).deps, score: false } })); assert.equal(ungraded.view('done').leads[0].fit_pct, null)
  const low = await run(fx(team(FOUNDER), 1)); assert.equal(low.view('done').leads.length, 0, 'fit <= 1 is hidden, as on the leads page')
})
test('SCOPE: another tenant sees no person and no lead', async () => {
  const { r, jobId } = await run(fx(team(FOUNDER))); assert.equal(verifiedLeads(r.db, 'B', jobId).length, 0)
})
