// "Seed funding AND hiring sales": the extraction returns each HALF as its own candidate (a funding article, a job posting) and the two are JOINED BY COMPANY in code. Stubbed pages, boards and a
// model whose reply depends on the prompt it is given (so the prompt change is what is tested); invented-or-public company names only as labels. No network, no key, no credits; no gate is relaxed.
import test from 'node:test'
import assert from 'node:assert/strict'
import { buildSourcePrompt } from '../lib/sources/index.ts'
import { compoundHalves, halvesBlock, HALVES_ENV } from '../lib/scan/halves.ts'
import { runFixture, daysAgo, type Fixture, type Cand } from './helpers/acceptance-harness.ts'
import { runReportFor } from '../lib/scan/run-report.ts'

const REQUEST = 'Find London UK B2B SaaS startups that announced seed funding within the past 90 days and are hiring sales staff.'
const ICP = { summary: 'London seed B2B SaaS', who: ['Founder'], industries: ['SaaS'], sizes: [], where: ['London, UK'], signals: ['Announced seed funding within the past 90 days AND is currently hiring sales staff'], exclude: [], country: 'GB', language: 'en', window_days: 90 }
const filler = ' More about the company, its product and its people.'.repeat(10)

test('the prompt: a seed + sales request splits into two facts; any other request is unchanged; the kill switch restores the single prompt', () => {
  const items = [{ source: 'x', url: 'https://a.example/1', title: 't', quote: 'q', date: null }]
  const on = buildSourcePrompt(REQUEST, ICP, items)
  assert.match(on, /needs TWO facts about the SAME company: \(1\) a COMPLETED seed funding round/); assert.match(on, /Return a company when an item shows EITHER fact/); assert.match(on, /never claim the other fact/)
  assert.ok(on.indexOf('Do not invent anything.') < on.indexOf('TWO facts') && on.indexOf('TWO facts') < on.indexOf('Reply with ONLY a JSON array'), 'the block sits between the selection rule and the reply format')
  const plain = buildSourcePrompt('Find London UK startups that announced seed funding.', { ...ICP, signals: ['announced seed funding'] }, items); assert.doesNotMatch(plain, /TWO facts/)
  assert.doesNotMatch(buildSourcePrompt('Find London UK startups hiring sales staff.', { ...ICP, signals: ['hiring sales staff'] }, items), /TWO facts/)
  assert.equal(compoundHalves(REQUEST, ICP, { [HALVES_ENV]: '0' }), null); assert.doesNotMatch((() => { const saved = process.env[HALVES_ENV]; process.env[HALVES_ENV] = '0'; try { return buildSourcePrompt(REQUEST, ICP, items) } finally { if (saved === undefined) delete process.env[HALVES_ENV]; else process.env[HALVES_ENV] = saved } })(), /TWO facts/)
  assert.match(halvesBlock({ event: 'the event' }), /checked separately, from other sources: do not guess it/)
})

// ---- through the real runJob: the stub "model" returns what the prompt asks for ----
const FUND = (c: string) => `${c}, a London B2B SaaS startup, raised a 3m GBP seed round this month`, HIRE = (c: string) => `${c} is hiring a Sales Account Executive in London to sell to UK fintechs. Join the sales team`
const funding = (c: string): { url: string; text: string; cand: Cand } => ({ url: `https://news.example/${c.toLowerCase()}-raises-seed`, text: FUND(c), cand: { company: c, signal: 'raised a seed round', source_url: `https://news.example/${c.toLowerCase()}-raises-seed`, excerpt: FUND(c), event_date: daysAgo(12) } })
const posting = (c: string): { url: string; text: string; cand: Cand } => ({ url: `https://boards.greenhouse.io/${c.toLowerCase()}/jobs/1`, text: HIRE(c), cand: { company: c, signal: 'is hiring a sales account executive', source_url: `https://boards.greenhouse.io/${c.toLowerCase()}/jobs/1`, excerpt: HIRE(c), event_date: daysAgo(9) } })
const page = (p: { url: string; text: string; cand?: Cand }) => ({ title: p.url, text: `On ${p.cand?.event_date ?? daysAgo(10)}, ${p.text}.${filler}` })   // the page states the candidate's own event day
// The stub extractor: BEFORE (no split in the prompt) it returns an item only when it shows BOTH facts; AFTER it returns an item when it shows EITHER, as the prompt now asks.
const extractor = (cands: Cand[]) => (prompt: string): Cand[] => {
  const split = /Return a company when an item shows EITHER fact/.test(prompt)
  return cands.filter(c => (/raised .*seed round/.test(c.excerpt) && /is hiring/.test(c.excerpt)) || (split && (/raised .*seed round/.test(c.excerpt) || /is hiring/.test(c.excerpt))))
}
function scan(pages: { url: string; text: string; cand: Cand }[]): Fixture {
  return { request: REQUEST, modelIcp: ICP, modelQueries: ['london saas startup seed round'], hits: pages.map(p => ({ url: p.url, title: p.url, snippet: p.text, date: daysAgo(10) })), tfPages: Object.fromEntries(pages.map(p => [p.url, page(p)])), own: Object.fromEntries(pages.map(p => [p.url, page(p)])),
    extraction: [], extractionFn: extractor(pages.map(p => p.cand)) }
}
const fate = (x: Awaited<ReturnType<typeof runFixture>>, company: string) => { const l = x.db.prepare('SELECT review_reason, confidence FROM leads WHERE company = ?').get(company) as { review_reason: string | null; confidence: number | null } | undefined; return !l ? 'none' : l.review_reason === null ? 'verifier-passed' : `held:${l.review_reason}` }
const PAGES = [funding('Lette'), posting('Lette'), funding('SpaceAm'), posting('Orbitly')]

test('BEFORE the split: only an item showing BOTH facts becomes a candidate, so a funding article and a job posting for the same company produce nothing', async () => {
  const saved = process.env[HALVES_ENV]; process.env[HALVES_ENV] = '0'
  try { const x = await runFixture(scan(PAGES)); assert.equal((x.db.prepare('SELECT count(*) AS n FROM leads').get() as { n: number }).n, 0) } finally { if (saved === undefined) delete process.env[HALVES_ENV]; else process.env[HALVES_ENV] = saved }
})
test('AFTER the split, joined by company in code: Lette (funding article + sales posting) is VERIFIER-PASSED (not scoreboard-qualified: no contact or fit grade); SpaceAm (funding only) is held for no sales-hiring evidence; Orbitly (posting only) is held for no event evidence', async () => {
  const x = await runFixture(scan(PAGES))
  assert.equal(fate(x, 'Lette'), 'verifier-passed'); assert.equal(fate(x, 'SpaceAm'), 'held:no_sales_hiring_evidence'); assert.equal(fate(x, 'Orbitly'), 'held:no_event_evidence')
  assert.equal((x.db.prepare('SELECT count(*) AS n FROM leads WHERE company = ?').get('Lette') as { n: number }).n, 1, 'the two halves are ONE lead')
  const why = (x.db.prepare("SELECT why FROM leads WHERE company = 'Lette'").get() as { why: string | null }).why ?? ''; assert.match(why, /Hiring sales: named in a verified source/)
  const rep = (runReportFor(x.db, 'A', (x.db.prepare('SELECT id FROM scan_jobs').get() as { id: string }).id) as { extraction?: { returned: number } }[])[0]; assert.equal(rep.extraction?.returned, 4)
})
test('IDENTITY / GATES still hold across the join: a posting for a DIFFERENT company, a stale funding date, or a negated hiring sentence never completes a company', async () => {
  const other = posting('Zenith'); other.cand.company = 'Zenith'
  const x1 = await runFixture(scan([funding('Lette'), other])); assert.equal(fate(x1, 'Lette'), 'held:no_sales_hiring_evidence'); assert.equal(fate(x1, 'Zenith'), 'held:no_event_evidence')
  const stale = funding('Mintly'); stale.cand.event_date = daysAgo(200)
  const x2 = await runFixture(scan([stale, posting('Mintly')])); assert.notEqual(fate(x2, 'Mintly'), 'verifier-passed', 'a 200-day-old funding date cannot complete the pair')
  const neg = posting('Pennyloop'); neg.text = 'Pennyloop is not hiring any sales staff right now and is hiring engineers'; neg.cand.excerpt = neg.text
  const x3 = await runFixture(scan([funding('Pennyloop'), neg])); assert.notEqual(fate(x3, 'Pennyloop'), 'verifier-passed')
})
