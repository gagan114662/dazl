// #378: the scoreboard's "qualified" is the product's own "actionable" (lib/scan/actionable.ts classifyLeads), not a
// second definition. Through the real runJob with stubbed pages and a stubbed crawl: invented companies, no network, no
// paid calls. A lead the product would not act on never counts; the positive control does, and the scoreboard count
// equals the run report's.
import test from 'node:test'
import assert from 'node:assert/strict'
import { runFixture, daysAgo, type Fixture } from './helpers/acceptance-harness.ts'
import { scoreJob as scoreRows } from '../lib/scan/scoreboard.ts'
import { scoreboardInputs } from '../lib/scan/actionable.ts'
import type Database from 'better-sqlite3'
const scoreJob = (db: Database.Database, j: { id: string; user_id: string; query: string | null; icp: string | null }) => scoreRows(scoreboardInputs(db, j), j)

async function runCrawl(f: Fixture) {
  const saved = process.env.SITECRAWL_ENABLED; process.env.SITECRAWL_ENABLED = '1'
  try { return await runFixture(f) } finally { if (saved === undefined) delete process.env.SITECRAWL_ENABLED; else process.env.SITECRAWL_ENABLED = saved }
}
const REQUEST = (days: number) => `Find London UK B2B SaaS startups with 10-50 employees that announced seed funding within the past ${days} days and are hiring sales staff. Exclude agencies and recruiters. Include founder contacts and dated evidence.`
const ICP = (days: number) => ({ summary: 'London seed-funded B2B SaaS hiring sales', who: ['Founder'], industries: ['SaaS'], sizes: ['10-50'], where: ['London, UK'], signals: ['announced seed funding', 'hiring sales staff'], exclude: ['agencies', 'recruiters'], country: 'GB', language: 'en', window_days: days })
const NEWS = 'https://sifted.example/brightloop-raises-seed'
const pad = (s: string) => `${s} ${'More about the company and its people. '.repeat(15)}`
const QUOTE = 'Brightloop, a London B2B SaaS startup with 24 employees, raised a 3m GBP seed round'
const resp = (body: string, url: string) => ({ status: 200, body, finalUrl: url })
const nf = (url: string) => ({ status: 404, body: '', finalUrl: url })

interface Site { home?: string; team?: string; careers?: string; contact?: string; job?: string }
const scoringProviders = (fit: number, extraction: unknown[]) => {
  const reply = (p: string, maxTokens?: number) => p.includes('LEAD <n> | fit') ? `LEAD 1 | fit ${fit} | intent 4 | action 4 | match yyyy | signals seed_round | why London seed-funded SaaS.` : maxTokens === 300 ? JSON.stringify(['London SaaS startup seed round']) : JSON.stringify(extraction)
  const p = { research: async () => ({ text: '[]', citedUrls: [] }), complete: async (_k: string, pr: string, _f?: typeof fetch, mt?: number) => reply(pr, mt), completeDetailed: async (_k: string, pr: string, _f?: typeof fetch, mt?: number) => ({ text: reply(pr, mt), model: 'stub', usage: { input_tokens: 10, output_tokens: 1 } }), configuredModel: () => 'stub' }
  return { anthropic: p, openai: { research: async () => ({ text: '', citedUrls: [] }) } } as never
}
function fixture(opts: { fit?: number; extraction?: unknown[]; quote?: string; company?: string; articleLinks?: string | null; site?: Site | null; age?: number; window?: number }): Fixture {
  const company = opts.company ?? 'Brightloop', quote = opts.quote ?? QUOTE, fit = opts.fit ?? 5, age = opts.age ?? 12, win = opts.window ?? 90
  const page = { title: `${company} raises seed round`, text: pad(`Published ${daysAgo(age)}. ${quote}.`) }
  const crawl = async (url: string) => {
    const u = new URL(url)
    if (u.hostname === 'sifted.example') return resp(`<html><body>${opts.articleLinks === null ? '' : opts.articleLinks ?? '<a href="https://brightloop.io/">Brightloop</a> '}${page.text}</body></html>`, url)
    if (u.hostname === 'brightloop.io' && opts.site) {
      if (u.pathname === '/robots.txt') return resp('User-agent: *\nAllow: /', url)
      const map: Record<string, string | undefined> = { '/': opts.site.home, '/team': opts.site.team, '/careers': opts.site.careers, '/contact': opts.site.contact, '/careers/ae': opts.site.job ?? JOBPAGE }
      return map[u.pathname] !== undefined ? resp(map[u.pathname]!, url) : nf(url)
    }
    return null
  }
  return {
    request: REQUEST(win), modelIcp: ICP(win), modelQueries: ['London SaaS startup seed round'], hits: [{ url: NEWS, title: page.title, snippet: quote, date: daysAgo(age) }], tfPages: { [NEWS]: page }, own: { [NEWS]: page },
    extraction: [{ company, signal: 'raised a seed round', source_url: NEWS, excerpt: quote, event_date: daysAgo(age) }],
    // scoring ON: the actionable yield requires a graded fit >= 4, so the stub grades the lead (fit 5) when asked and answers everything else like the harness
    deps: { score: true, providers: scoringProviders(fit, opts.extraction ?? [{ company, signal: 'raised a seed round', source_url: NEWS, excerpt: quote, event_date: daysAgo(age) }]), crawlGet: crawl as never, fetchImpl: (async (u: RequestInfo | URL) => { const k = String(u); return k.includes('greenhouse.io') || k.includes('lever.co') || k.includes('ashbyhq.com') ? new Response('nope', { status: 404 }) : globalThis.fetch(u, undefined) }) as never },
  }
}
const HOME = pad('<html><body><h1>Brightloop</h1> <p>London SaaS platform at 1 Old Street, London EC1V 9HX.</p> <a href="/team">Team</a> <a href="/careers">Careers</a> <a href="/contact">Contact</a>')
const TEAM = pad('<html><body><p>Brightloop is a London software company building sales tooling for retailers across the UK and beyond.</p><div class="card"><h3>Jane Doe</h3><p>Chief Executive Officer</p></div>')
const CONTACT = '<html><body><p>Say hello to the team at Brightloop in London.</p><a href="mailto:hello@brightloop.io">hello@brightloop.io</a></body></html>'
const JOBPAGE = '<html><body><h1>Account Executive - London</h1><p>Join Brightloop in London as our Account Executive.</p><a href="/careers/apply">Apply</a></body></html>'
const CAREERS = '<html><body><h1>Careers at Brightloop</h1><p>Join Brightloop in London.</p><h2>Open roles</h2><ul><li>Backend Engineer</li><li><a href="/careers/ae">Account Executive - London</a> <a href="/careers/ae">Apply</a></li></ul></body></html>'


type Run = Awaited<ReturnType<typeof runCrawl>>
const job = (r: Run) => r.db.prepare('SELECT id, user_id, query, icp FROM scan_jobs').get() as { id: string; user_id: string; query: string | null; icp: string | null }
const reportYield = (r: Run) => (JSON.parse((r.db.prepare('SELECT report FROM scan_run_report ORDER BY attempt DESC LIMIT 1').get() as { report: string }).report) as { yield: { actionable: number } }).yield
const leadRow = (r: Run) => r.db.prepare('SELECT id, review_reason, contact FROM leads').get() as { id: string; review_reason: string | null; contact: string | null }
const SITE: Site = { home: HOME, team: TEAM, careers: CAREERS, contact: CONTACT }

test('POSITIVE control: the product calls it actionable, so the scoreboard qualifies it; the count equals the run report', async () => {
  const r = await runCrawl(fixture({ site: SITE }))
  const { score, leads } = scoreJob(r.db, job(r))
  assert.deepEqual(score, { leads: 1, source_checked: 1, fit: 1, current_event: 1, right_person: 1, reachable: 1, email_ready: 1, phone_only: 0, qualified: 1 })
  assert.equal(score.qualified, reportYield(r).actionable)
  assert.deepEqual([leads[0].qualified, leads[0].route, leads[0].missing], [true, 'email', []])
})

test('a generic hiring / support inbox is not a route: not reachable, not qualified (the old scoreboard counted any email)', async () => {
  const r = await runCrawl(fixture({ site: { ...SITE, contact: '<html><body><p>Brightloop support in London.</p><a href="mailto:support@brightloop.io">support@brightloop.io</a> <a href="mailto:careers@brightloop.io">careers@brightloop.io</a></body></html>' } }))
  const { score, leads } = scoreJob(r.db, job(r))
  assert.deepEqual([score.source_checked, score.right_person, score.reachable, score.qualified], [1, 1, 0, 0])
  assert.deepEqual(leads[0].missing, ['no_published_contact'])
  assert.equal(score.qualified, reportYield(r).actionable)
})

test('no named person with the requested role: not the right person, not qualified', async () => {
  const r = await runCrawl(fixture({ site: { ...SITE, team: pad('<html><body><p>Brightloop is a London software company.</p>') } }))
  const { score } = scoreJob(r.db, job(r))
  assert.deepEqual([score.source_checked, score.right_person, score.qualified], [1, 0, 0])
})

test('a contact merely attached to the lead (another company\'s address) never makes it qualified', async () => {
  const r = await runCrawl(fixture({ site: { ...SITE, contact: '<html><body><p>Brightloop in London.</p></body></html>' } }))
  r.db.prepare("UPDATE leads SET contact = 'pat@rival.example'").run()   // the old scoreboard: "any email on the lead" = reachable
  const { score } = scoreJob(r.db, job(r))
  assert.deepEqual([score.reachable, score.qualified], [0, 0])
})

test('a quarantined lead is not qualified, whatever else it has', async () => {
  const r = await runCrawl(fixture({ site: SITE }))
  r.db.prepare('UPDATE leads SET quarantined_at = 1').run()
  const { score, leads } = scoreJob(r.db, job(r))
  assert.deepEqual([score.qualified, score.right_person, score.reachable, leads[0].missing], [0, 0, 0, ['quarantined']])
})

test('the request\'s own window: a 60-day-old raise is held on a 30-day request and qualifies on a 180-day one', async () => {
  const short = await runCrawl(fixture({ site: SITE, age: 60, window: 30 }))
  assert.notEqual(leadRow(short).review_reason, null)
  assert.deepEqual([scoreJob(short.db, job(short)).score.source_checked, scoreJob(short.db, job(short)).score.qualified], [0, 0])
  const long = await runCrawl(fixture({ site: SITE, age: 60, window: 180 }))
  const s = scoreJob(long.db, job(long)).score
  assert.deepEqual([s.current_event, s.qualified], [1, 1])                    // not the old fixed 90 days: 60 <= 180
  assert.equal(s.qualified, reportYield(long).actionable)
})

test('a claim whose own quote names an old year is held: never qualified', async () => {
  const r = await runCrawl(fixture({ site: SITE, quote: 'Brightloop, a London B2B SaaS startup with 24 employees, raised a 3m GBP seed round in 2023' }))
  assert.equal(leadRow(r).review_reason, 'event_date_stale')
  assert.equal(scoreJob(r.db, job(r)).score.qualified, 0)
})
