// Before/after yield for the ATS job-board source, on the STUBBED scenario set (the same fixtures the tests use; no network, no keys): each scenario is run twice through the real runJob -
// "before" = the public job boards unavailable (every board request 404s), "after" = the boards answer. Prints verifier-passed / held (needs review) per scenario and the totals.
//   node --experimental-strip-types --no-warnings --import ./test/helpers/net-fence.ts scripts/ats-yield-compare.mts
import { runFixture, daysAgo, type Fixture, type Cand } from '../test/helpers/acceptance-harness.ts'
import type { SafeGet } from '../lib/sources/types.ts'

const ms = (n: number) => Date.now() - n * 86_400_000
const REQUEST = 'Find London UK B2B SaaS startups that announced seed funding within the past 90 days and are hiring sales staff.'
const ICP = { summary: 'London seed B2B SaaS', who: ['Founder'], industries: ['SaaS'], sizes: [], where: ['London, UK'], signals: ['announced seed funding', 'hiring sales staff'], exclude: [], country: 'GB', language: 'en', window_days: 90 }
const filler = ' More about the company, its product and its people.'.repeat(10)
const board = (host: string, over: { title?: string; loc?: string; age?: number; body?: string } = {}): Record<string, unknown> => {
  const t = over.title ?? 'Sales Account Executive', loc = over.loc ?? 'London, UK', url = `https://boards.greenhouse.io/${host}/jobs/1`
  return {
    [`https://boards-api.greenhouse.io/v1/boards/${host}/jobs`]: { jobs: [{ id: 1, title: t, location: { name: loc } }] },
    [`https://boards-api.greenhouse.io/v1/boards/${host}/jobs/1`]: { id: 1, title: t, first_published: new Date(ms(over.age ?? 9)).toISOString(), absolute_url: url, location: { name: loc }, content: over.body ?? `&lt;p&gt;${host[0].toUpperCase() + host.slice(1)} is hiring a Sales Account Executive in London to sell to UK fintechs. Join the sales team.&lt;/p&gt;` },
  }
}
const httpOf = (boards: Record<string, unknown> | null): SafeGet => async url => (new URL(url).hostname === 'hn.algolia.com' || !boards || boards[url] === undefined ? { status: 404, body: '' } : { status: 200, body: JSON.stringify(boards[url]) })
interface Scenario { name: string; company: string; boards: Record<string, unknown> | null }
const SCENARIOS: Scenario[] = [
  { name: 'seed-only, dated London sales posting on its board', company: 'Brightloop', boards: board('brightloop') },
  { name: 'seed-only, no public board', company: 'Querio', boards: null },
  { name: "seed-only, board belongs to another company", company: 'Orbitly', boards: board('orbitly', { body: '&lt;p&gt;Initech is hiring a Sales Account Executive in London.&lt;/p&gt;' }) },
  { name: 'seed-only, board posting is in another city', company: 'Cloudmint', boards: board('cloudmint', { loc: 'Austin, TX' }) },
  { name: 'seed-only, board posting is stale (300 days)', company: 'Pennyloop', boards: board('pennyloop', { age: 300 }) },
  { name: 'seed-only, board role is not sales', company: 'Rackhive', boards: board('rackhive', { title: 'Backend Engineer' }) },
]
async function run(s: Scenario, withBoards: boolean) {
  const slug = s.company.toLowerCase()
  const NEWS = `https://sifted.example/${slug}-raises-seed`, JOB = `https://boards.greenhouse.io/${slug}/jobs/1`
  const fund = `${s.company}, a London B2B SaaS startup, raised a 3m GBP seed round this month`, job = `${s.company} is hiring a Sales Account Executive in London to sell to UK fintechs. Join the sales team`
  const seed: Cand = { company: s.company, signal: 'raised a seed round', source_url: NEWS, excerpt: fund, event_date: daysAgo(12) }
  const jobCand: Cand = { company: s.company, signal: 'hiring a sales account executive', source_url: JOB, excerpt: job, event_date: daysAgo(9) }
  const f: Fixture = { request: REQUEST, modelIcp: ICP, modelQueries: ['london saas startup seed round'], hits: [{ url: NEWS, title: `${s.company} raises seed round`, snippet: fund, date: daysAgo(12) }], tfPages: {},
    own: { [NEWS]: { title: `${s.company} raises seed round`, text: `Published ${daysAgo(12)}. ${fund}.${filler}` }, [JOB]: { title: `Sales Account Executive at ${s.company}`, text: `Posted ${daysAgo(9)}. ${job}.${filler}` } },
    extraction: [seed, jobCand], deps: { sourceHttp: httpOf(withBoards ? s.boards : null) } }
  const x = await runFixture(f)
  const l = x.db.prepare('SELECT review_reason FROM leads WHERE company = ?').get(s.company) as { review_reason: string | null } | undefined
  return l ? (l.review_reason === null ? 'verifier-passed' : `held:${l.review_reason}`) : 'none'
}
const rows: [string, string, string][] = []
for (const s of SCENARIOS) rows.push([s.name, await run(s, false), await run(s, true)])
const w = Math.max(...rows.map(r => r[0].length))
console.log(`${'scenario'.padEnd(w)}  before (boards off)            after (boards on)`)
for (const [n, b, a] of rows) console.log(`${n.padEnd(w)}  ${b.padEnd(30)} ${a}`)
const q = (i: 1 | 2) => rows.filter(r => r[i] === 'verifier-passed').length
console.log(`\nverifier-passed (no contact / fit grade, NOT scoreboard-qualified): before ${q(1)} / ${rows.length}, after ${q(2)} / ${rows.length}; held: before ${rows.filter(r => r[1].startsWith('held')).length}, after ${rows.filter(r => r[2].startsWith('held')).length}`)
