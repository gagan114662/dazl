// Qualified / actionable yield for the exact reviewed ICP (London UK B2B SaaS, seed within 90 days AND hiring sales), measured apart from source-checked counts.
// Through the real runJob with stubbed pages: invented companies, no network, no paid enrichment. Obsero-shaped negative controls + one positive fixture.
import test from 'node:test'
import assert from 'node:assert/strict'
import { runFixture, daysAgo, type Fixture } from './helpers/acceptance-harness.ts'

// CI runs with SITECRAWL_ENABLED=0 (npm test). These fixtures need their STUBBED crawl (an injected crawlGet, no network) to establish the lead's domain, so the crawl is
// switched on for the duration of one fixture run only and restored; the domain gate itself is unchanged.
async function runCrawl(f: Fixture) {
  const saved = process.env.SITECRAWL_ENABLED; process.env.SITECRAWL_ENABLED = '1'
  try { return await runFixture(f) } finally { if (saved === undefined) delete process.env.SITECRAWL_ENABLED; else process.env.SITECRAWL_ENABLED = saved }
}
const REQUEST = 'Find London UK B2B SaaS startups with 10-50 employees that announced seed funding within the past 90 days and are hiring sales staff. Exclude agencies and recruiters. Include founder contacts and dated evidence.'
const ICP = { summary: 'London seed-funded B2B SaaS hiring sales', who: ['Founder'], industries: ['SaaS'], sizes: ['10-50'], where: ['London, UK'], signals: ['announced seed funding', 'hiring sales staff'], exclude: ['agencies', 'recruiters'], country: 'GB', language: 'en', window_days: 90 }
const NEWS = 'https://sifted.example/brightloop-raises-seed'
const pad = (s: string) => `${s} ${'More about the company and its people. '.repeat(15)}`
const QUOTE = 'Brightloop, a London B2B SaaS startup with 24 employees, raised a 3m GBP seed round this month'
const resp = (body: string, url: string) => ({ status: 200, body, finalUrl: url })
const nf = (url: string) => ({ status: 404, body: '', finalUrl: url })

interface Site { home?: string; team?: string; careers?: string; contact?: string; job?: string }
const scoringProviders = (fit: number, extraction: unknown[]) => {
  const reply = (p: string, maxTokens?: number) => p.includes('LEAD <n> | fit') ? `LEAD 1 | fit ${fit} | intent 4 | action 4 | match yyyy | signals seed_round | why London seed-funded SaaS.` : maxTokens === 300 ? JSON.stringify(['London SaaS startup seed round']) : JSON.stringify(extraction)
  const p = { research: async () => ({ text: '[]', citedUrls: [] }), complete: async (_k: string, pr: string, _f?: typeof fetch, mt?: number) => reply(pr, mt), completeDetailed: async (_k: string, pr: string, _f?: typeof fetch, mt?: number) => ({ text: reply(pr, mt), model: 'stub', usage: { input_tokens: 10, output_tokens: 1 } }), configuredModel: () => 'stub' }
  return { anthropic: p, openai: { research: async () => ({ text: '', citedUrls: [] }) } } as never
}
function fixture(opts: { fit?: number; extraction?: unknown[]; quote?: string; company?: string; articleLinks?: string | null; site?: Site | null }): Fixture {
  const company = opts.company ?? 'Brightloop', quote = opts.quote ?? QUOTE, fit = opts.fit ?? 5
  const page = { title: `${company} raises seed round`, text: pad(`Published ${daysAgo(12)}. ${quote}.`) }
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
    request: REQUEST, modelIcp: ICP, modelQueries: ['London SaaS startup seed round'], hits: [{ url: NEWS, title: page.title, snippet: quote, date: daysAgo(12) }], tfPages: { [NEWS]: page }, own: { [NEWS]: page },
    extraction: [{ company, signal: 'raised a seed round', source_url: NEWS, excerpt: quote, event_date: daysAgo(12) }],
    // scoring ON: the actionable yield requires a graded fit >= 4, so the stub grades the lead (fit 5) when asked and answers everything else like the harness
    deps: { score: true, providers: scoringProviders(fit, opts.extraction ?? [{ company, signal: 'raised a seed round', source_url: NEWS, excerpt: quote, event_date: daysAgo(12) }]), crawlGet: crawl as never, fetchImpl: (async (u: RequestInfo | URL) => { const k = String(u); return k.includes('greenhouse.io') || k.includes('lever.co') || k.includes('ashbyhq.com') ? new Response('nope', { status: 404 }) : globalThis.fetch(u, undefined) }) as never },
  }
}
const HOME = pad('<html><body><h1>Brightloop</h1> <p>London SaaS platform at 1 Old Street, London EC1V 9HX.</p> <a href="/team">Team</a> <a href="/careers">Careers</a> <a href="/contact">Contact</a>')
const TEAM = pad('<html><body><p>Brightloop is a London software company building sales tooling for retailers across the UK and beyond.</p><div class="card"><h3>Jane Doe</h3><p>Chief Executive Officer</p></div>')
const CONTACT = '<html><body><p>Say hello to the team at Brightloop in London.</p><a href="mailto:hello@brightloop.io">hello@brightloop.io</a></body></html>'
const JOBPAGE = '<html><body><h1>Account Executive - London</h1><p>Join Brightloop in London as our Account Executive.</p><a href="/careers/apply">Apply</a></body></html>'
const CAREERS = '<html><body><h1>Careers at Brightloop</h1><p>Join Brightloop in London.</p><h2>Open roles</h2><ul><li>Backend Engineer</li><li><a href="/careers/ae">Account Executive - London</a> <a href="/careers/ae">Apply</a></li></ul></body></html>'

const lead = (r: Awaited<ReturnType<typeof runCrawl>>) => r.db.prepare("SELECT id, review_reason, confidence, company_domain FROM leads").get() as { id: string; review_reason: string | null; confidence: number | null; company_domain: string | null } | undefined
const report = (r: Awaited<ReturnType<typeof runCrawl>>) => JSON.parse((r.db.prepare('SELECT report FROM scan_run_report ORDER BY attempt DESC LIMIT 1').get() as { report: string }).report) as { yield: { source_checked: number; verified: number; actionable: number; missing: Record<string, number> }; enrichment: { stage: string; status: string; reason: string | null }[]; funnel: { verified: number; needs_review: number } }
const actionRow = (r: Awaited<ReturnType<typeof runCrawl>>) => (r.db.prepare("SELECT value, label FROM lead_enrichments WHERE connector = 'scan:actionable'").get() as { value: string; label: string | null } | undefined)

test('POSITIVE exact-ICP fixture: seed evidence + an open sales role on the own careers page + the real domain + a listed founder with a published contact = ACTIONABLE; report and card agree', async () => {
  const r = await runCrawl(fixture({ site: { home: HOME, team: TEAM, careers: CAREERS, contact: CONTACT } }))
  const l = lead(r)!
  assert.equal(l.company_domain, 'brightloop.io'); assert.equal(l.review_reason, null); assert.ok(l.confidence !== null)
  const vac = r.db.prepare("SELECT value, label, source_url, confidence FROM lead_enrichments WHERE connector = 'signals:careers-gtm'").get() as { value: string; label: string; source_url: string; confidence: number }
  assert.match(vac.value, /Account Executive - London/); assert.equal(vac.source_url, 'https://brightloop.io/careers/ae'); assert.match(vac.label, /Account Executive/)
  const rep = report(r)
  assert.deepEqual([rep.yield.source_checked, rep.yield.verified, rep.yield.actionable], [1, 1, 1], JSON.stringify(rep.yield))
  assert.match(actionRow(r)!.value, /^Actionable:/); assert.match(actionRow(r)!.label!, /Jane Doe, Chief Executive Officer - email: hello@brightloop\.io/)
  assert.deepEqual(r.db.prepare('SELECT verified, needs_review FROM scan_jobs').get(), { verified: 1, needs_review: 0 })
  assert.equal(rep.funnel.verified, 1)
  for (const s of ['crawl', 'signals', 'paid_enrichment', 'people_search', 'sales_hiring_gate']) assert.ok(rep.enrichment.some(x => x.stage === s), `stage ${s} is recorded: ${JSON.stringify(rep.enrichment.map(x => x.stage))}`)
})

test('OBSERO-SHAPED negative: seed article that talks about engineering growth and GTM plans, no company site linked, no vacancy, no contact -> held, zero actionable, and the trace says what ran', async () => {
  const quote = 'Brightloop, a London B2B SaaS startup, raised a 1m EUR seed round to double engineering and accelerate its go-to-market'
  const r = await runCrawl(fixture({ quote, articleLinks: null, site: null }))
  const l = lead(r)!
  assert.equal(l.review_reason, 'no_sales_hiring_evidence', JSON.stringify(l)); assert.equal(l.confidence, null); assert.equal(l.company_domain, null)
  const rep = report(r)
  assert.equal(rep.yield.actionable, 0); assert.equal(rep.yield.verified, 0); assert.equal(rep.yield.source_checked, 1)
  assert.deepEqual(r.db.prepare('SELECT verified, needs_review FROM scan_jobs').get(), { verified: 0, needs_review: 1 }); assert.equal(rep.funnel.verified, 0)
  const crawl = rep.enrichment.find(s => s.stage === 'crawl')!; assert.equal(crawl.status, 'attempted_no_result'); assert.ok(crawl.reason, 'the crawl says why it found nothing')
  assert.equal(rep.enrichment.find(s => s.stage === 'sales_hiring_gate')!.status, 'ok')
})

test('negative controls that DO get a real domain: no vacancy / closed / engineering-only careers page -> held; vacancy but no listed founder or only a support inbox -> verified but NOT actionable (missing parts named)', async () => {
  const site = (careers: string, team = TEAM, contact = CONTACT): Site => ({ home: HOME, team, careers, contact })
  for (const [name, careers] of [['engineering only', '<html><body><h1>Careers at Brightloop</h1><p>Join Brightloop in London.</p><h2>Open roles</h2><li>Backend Engineer</li> Apply</body></html>'], ['closed', '<html><body><h2>Careers at Brightloop</h2><p>There are no open positions right now.</p></body></html>'], ['GTM plans, no role', '<html><body><p>Brightloop in London is accelerating our go-to-market and doubling engineering.</p> Apply</body></html>']] as const) {
    const r = await runCrawl(fixture({ site: site(careers) }))
    assert.equal(lead(r)!.review_reason, 'no_sales_hiring_evidence', name); assert.equal(report(r).yield.actionable, 0, name)
  }
  const noPerson = await runCrawl(fixture({ site: site(CAREERS, pad('<html><body><p>Brightloop is a London software company.</p>')) }))
  assert.equal(lead(noPerson)!.review_reason, null); let rep = report(noPerson)
  assert.deepEqual([rep.yield.verified, rep.yield.actionable], [1, 0]); assert.equal(rep.yield.missing.no_contact_person, 1); assert.match(actionRow(noPerson)!.value, /^Not actionable yet: .*no contact person/)
  const support = await runCrawl(fixture({ site: site(CAREERS, TEAM, '<html><body><p>Brightloop support in London.</p><a href="mailto:support@brightloop.io">support@brightloop.io</a> <a href="mailto:careers@brightloop.io">careers@brightloop.io</a></body></html>') }))
  rep = report(support); assert.deepEqual([rep.yield.verified, rep.yield.actionable], [1, 0]); assert.equal(rep.yield.missing.no_published_contact, 1)
  assert.match(actionRow(support)!.value, /no published contact/)
})

// ---- Instinct review of eff8d49: a REQUIRED gate that errors is a fail, never a pass ----
test('FAIL-CLOSED: the required sales-hiring gate throws in the full runner -> the lead is unverified and NOT actionable, the trace records the failure, the report and the lead agree; the same fixture with a working gate is actionable', async () => {
  const site: Site = { home: HOME, team: TEAM, careers: CAREERS, contact: CONTACT }
  // control: the real gate succeeds -> verified and actionable
  const okRun = await runCrawl(fixture({ site }))
  assert.equal(lead(okRun)!.review_reason, null); assert.equal(report(okRun).yield.actionable, 1)
  // the gate throws
  const failing = fixture({ site }); failing.deps = { ...(failing.deps as object), salesHiringGate: async () => { throw new Error('boom: gate unavailable') } } as never
  const r = await runCrawl(failing)
  const l = lead(r)!
  assert.equal(l.review_reason, 'sales_hiring_check_failed', JSON.stringify(l)); assert.equal(l.confidence, null)
  assert.deepEqual(r.db.prepare('SELECT verified, needs_review FROM scan_jobs').get(), { verified: 0, needs_review: 1 })
  const rep = report(r) as ReturnType<typeof report> & { candidates: { company: string; fate: string }[] }
  assert.deepEqual([rep.yield.verified, rep.yield.actionable], [0, 0]); assert.equal(rep.funnel.verified, 0)
  assert.equal(rep.candidates.find(c => c.company === 'Brightloop')!.fate, 'review:sales_hiring_check_failed')
  const gate = rep.enrichment.find(s => s.stage === 'sales_hiring_gate')!; assert.equal(gate.status, 'failed'); assert.match(gate.reason ?? '', /boom: gate unavailable.*held as sales_hiring_check_failed/)
  assert.match((r.db.prepare('SELECT why FROM leads').get() as { why: string }).why, /^Sales-hiring check failed \(boom: gate unavailable\): not verified\./)
  assert.equal(actionRow(r), undefined, 'a held lead is not in the actionable classification at all')
})

test('FAIL-CLOSED when the recovery write is rejected too: the gate\u2019s normal write AND the recovery write both fail -> still held in memory: actionable 0, trace and final result agree on the reason (fails on fb68548)', async () => {
  const site: Site = { home: HOME, team: TEAM, careers: '<html><body><h1>Careers at Brightloop</h1><p>No open roles.</p></body></html>', contact: CONTACT }   // the real gate would demote: no sales proof
  const f = fixture({ site })
  // every later attempt to move a lead into review is rejected by the store: the gate's demotion AND failClosedSalesHiring's write
  f.onVerify = db => { db.exec("CREATE TRIGGER reject_review BEFORE UPDATE OF review_reason ON leads WHEN NEW.review_reason IS NOT NULL BEGIN SELECT RAISE(ABORT, 'write rejected'); END") }
  const r = await runCrawl(f)
  // the stored row could not be changed (it still reads verified), but nothing may infer "passed" from it
  assert.equal(lead(r)!.review_reason, null, 'precondition: the write really was rejected')
  const rep = report(r) as ReturnType<typeof report> & { candidates: { company: string; fate: string }[] }
  assert.deepEqual([rep.yield.verified, rep.yield.actionable], [0, 0], JSON.stringify(rep.yield)); assert.equal(rep.yield.missing.sales_hiring_check_failed, 1)
  const gate = rep.enrichment.find(s => s.stage === 'sales_hiring_gate')!; assert.equal(gate.status, 'failed'); assert.match(gate.reason ?? '', /write rejected.*1 write\(s\) rejected: held in memory/)
  assert.equal(rep.candidates.find(c => c.company === 'Brightloop')!.fate, 'review:sales_hiring_check_failed', 'the report shows the final result')
  assert.equal(rep.funnel.verified, 0)
  assert.match(actionRow(r)!.value, /^Not actionable yet: sales hiring check failed/)
})
