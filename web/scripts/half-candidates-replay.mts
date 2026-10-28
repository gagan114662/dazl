// Offline replay of the scan-7-shaped input (30 evidence items: 3 funding articles, 19 ATS sales postings, 8 other pages) through the REAL runJob, once with the single combined-signal prompt
// (DAZL_COMPOUND_HALVES=0) and once with the two-halves prompt, printing scripts/scan-dropoff.mts-style stage tables for each. Page text is invented; company names are labels.
// The "model" is a deterministic stub keyed on the prompt: before, it returns an item only if it shows BOTH facts (what live scan 7 showed: 1 of 30); after, EITHER fact, as the prompt now asks.
// It measures the code path (prompt -> candidates -> join -> gates), NOT the live model: only a live scan shows what the real model returns.
// usage: node --experimental-strip-types --no-warnings --import ./test/helpers/net-fence.ts scripts/half-candidates-replay.mts
import { runFixture, daysAgo, type Cand } from '../test/helpers/acceptance-harness.ts'
import { runReportFor } from '../lib/scan/run-report.ts'
import { dropoffOf, formatDropoff } from '../lib/scan/dropoff.ts'

const REQUEST = 'Find London UK B2B SaaS startups that announced seed funding within the past 90 days and are hiring sales staff.'
const ICP = { summary: 'London seed B2B SaaS', who: ['Founder'], industries: ['SaaS'], sizes: [], where: ['London, UK'], signals: ['Announced seed funding within the past 90 days AND is currently hiring sales staff'], exclude: [], country: 'GB', language: 'en', window_days: 90 }
const filler = ' More about the company, its product and its people.'.repeat(10)
type P = { url: string; text: string; cand?: Cand }
const FUND = (c: string) => `${c}, a London B2B SaaS startup, raised a 3m GBP seed round this month`
const HIRE = (c: string) => `${c} is hiring a Sales Account Executive in London to sell to UK fintechs. Join the sales team`
const funding = (c: string): P => { const url = `https://news.example/${c.toLowerCase()}-raises-seed`; return { url, text: FUND(c), cand: { company: c, signal: 'raised a seed round', source_url: url, excerpt: FUND(c), event_date: daysAgo(12) } } }
const posting = (c: string): P => { const url = `https://boards.greenhouse.io/${c.toLowerCase()}/jobs/1`; return { url, text: HIRE(c), cand: { company: c, signal: 'is hiring a sales account executive', source_url: url, excerpt: HIRE(c), event_date: daysAgo(9) } } }
const other = (i: number): P => ({ url: `https://blog.example/post-${i}`, text: `A general post number ${i} about London startups and nothing that names a funding round or a sales role` })
const pages: P[] = [funding('Lette'), funding('SpaceAm'), funding('Skwky'), posting('Lette'), ...Array.from({ length: 18 }, (_, i) => posting(`Boardco${i + 1}`)), ...Array.from({ length: 8 }, (_, i) => other(i + 1))]
const cands = pages.flatMap(p => p.cand ? [p.cand] : [])

async function run(halves: boolean) {
  if (halves) delete process.env.DAZL_COMPOUND_HALVES; else process.env.DAZL_COMPOUND_HALVES = '0'
  const pg = (p: P) => ({ title: p.url, text: `Published ${daysAgo(10)}. ${p.text}.${filler}` })
  const x = await runFixture({ request: REQUEST, modelIcp: ICP, modelQueries: ['london saas startup seed round'], hits: pages.map(p => ({ url: p.url, title: p.url, snippet: p.text, date: daysAgo(10) })),
    tfPages: Object.fromEntries(pages.map(p => [p.url, pg(p)])), own: Object.fromEntries(pages.map(p => [p.url, pg(p)])), extraction: [],
    extractionFn: (prompt: string) => { const split = /Return a company when an item shows EITHER fact/.test(prompt); return cands.filter(c => (/raised .*seed round/.test(c.excerpt) && /is hiring/.test(c.excerpt)) || (split && (/raised .*seed round/.test(c.excerpt) || /is hiring/.test(c.excerpt)))) } })
  const jobId = (x.db.prepare('SELECT id FROM scan_jobs').get() as { id: string }).id
  const rep = (runReportFor(x.db, 'A', jobId) as Record<string, unknown>[])[0]
  const rows = x.db.prepare('SELECT company, review_reason FROM leads').all() as { company: string; review_reason: string | null }[]
  console.log(formatDropoff(dropoffOf(rep)))
  console.log(`verifier-passed (not scoreboard-qualified: no contact or fit grade in the replay): ${rows.filter(r => !r.review_reason).map(r => r.company).join(', ') || 'none'}`)
  const held: Record<string, number> = {}; for (const r of rows) if (r.review_reason) held[r.review_reason] = (held[r.review_reason] ?? 0) + 1
  console.log(`held for review: ${JSON.stringify(held)}\n`)
}
console.log('== BEFORE (single combined-signal prompt, DAZL_COMPOUND_HALVES=0)'); await run(false)
console.log('== AFTER (two-halves prompt, joined by company in code)'); await run(true)
process.exit(0)
