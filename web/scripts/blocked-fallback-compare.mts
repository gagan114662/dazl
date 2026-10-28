// Before/after for a candidate whose OWN page blocks us (Clera, scan 7), on the STUBBED scenario set. A candidate whose OWN page blocks us (Clera, scan 7) is looked up on sources that do not need the blocked page: other press (same extraction + verifier) and the public ATS boards by company
// name. Stubbed pages, news, boards and model through the real runJob; invented companies. No network, no key, no credits; no gate is relaxed.
import { runFixture, daysAgo, type Fixture, type Cand } from '../test/helpers/acceptance-harness.ts'
import { sourceRuns } from '../lib/scan/source-runs.ts'
import { runReportFor } from '../lib/scan/run-report.ts'
import type { SafeGet } from '../lib/sources/types.ts'

const ms = (n: number) => Date.now() - n * 86_400_000
const REQUEST = 'Find London UK B2B SaaS startups that announced seed funding within the past 90 days and are hiring sales staff.'
const ICP = { summary: 'London seed B2B SaaS', who: ['Founder'], industries: ['SaaS'], sizes: [], where: ['London, UK'], signals: ['announced seed funding', 'hiring sales staff'], exclude: [], country: 'GB', language: 'en', window_days: 90 }
const filler = ' More about the company, its product and its people.'.repeat(10)
const BLOG = 'https://clera.example/blog/seed-round', PRESS = 'https://sifted.example/clera-raises-seed', JOB = 'https://boards.greenhouse.io/clera/jobs/1'
const FUND = 'Clera, a London B2B SaaS startup, raised a 3m GBP seed round this month'
const HIRE = 'Clera is hiring a Sales Account Executive in London to sell to UK fintechs. Join the sales team'
const seedCand: Cand = { company: 'Clera', signal: 'raised a seed round', source_url: BLOG, excerpt: FUND, event_date: daysAgo(10) }
const pressCand: Cand = { company: 'Clera', signal: 'raised a seed round', source_url: PRESS, excerpt: FUND, event_date: daysAgo(10) }
const jobCand: Cand = { company: 'Clera', signal: 'hiring a sales account executive', source_url: JOB, excerpt: HIRE, event_date: daysAgo(9) }
const gdelt = (urls: string[]) => JSON.stringify({ articles: urls.map(u => ({ url: u, title: 'Clera raises seed round', seendate: '20261016T100000Z' })) })
const board: Record<string, unknown> = {
  'https://boards-api.greenhouse.io/v1/boards/clera/jobs': { jobs: [{ id: 1, title: 'Sales Account Executive', location: { name: 'London, UK' } }] },
  'https://boards-api.greenhouse.io/v1/boards/clera/jobs/1': { id: 1, title: 'Sales Account Executive', first_published: new Date(ms(9)).toISOString(), absolute_url: JOB, location: { name: 'London, UK' }, content: `&lt;p&gt;${HIRE}.&lt;/p&gt;` },
}
interface Opt { press?: boolean; board?: boolean; otherCompany?: boolean; paid?: boolean }
function scenario(o: Opt) {
  const newsCalls: string[] = []
  const press = o.press !== false
  const newsHttp: SafeGet = async url => { newsCalls.push(url); return { status: 200, body: gdelt(press ? [PRESS] : []) } }
  const sourceHttp: SafeGet = async url => (new URL(url).hostname !== 'hn.algolia.com' && o.board && board[url] !== undefined ? { status: 200, body: JSON.stringify(board[url]) } : { status: 404, body: '' })
  const pressText = o.otherCompany ? 'Orbitly, a London B2B SaaS startup, raised a 2m GBP seed round this month' : FUND
  const f: Fixture = { request: REQUEST, modelIcp: ICP, modelQueries: ['london saas startup seed round'], hits: [{ url: BLOG, title: 'Clera raises seed', snippet: FUND, date: daysAgo(10) }], tfPages: {},
    own: { [BLOG]: 'blocked', [PRESS]: { title: 'Clera raises seed round', text: `Published ${daysAgo(10)}. ${pressText}.${filler}` }, [JOB]: { title: 'Sales Account Executive at Clera', text: `Posted ${daysAgo(9)}. ${HIRE}.${filler}` } },
    extraction: [seedCand, o.otherCompany ? { ...pressCand, company: 'Orbitly', excerpt: pressText } : pressCand, jobCand], deps: { sourceHttp, newsHttp, ...(o.paid === false ? { paidFallback: false } : {}) } }
  return { f, newsCalls }
}
async function run(o: Opt) {
  const { f, newsCalls } = scenario(o); const x = await runFixture(f)
  const jobId = (x.db.prepare('SELECT id FROM scan_jobs').get() as { id: string }).id
  const lead = x.db.prepare("SELECT id, review_reason, confidence, source_url FROM leads WHERE company = 'Clera'").get() as { id: string; review_reason: string | null; confidence: number | null; source_url: string } | undefined
  const rows = sourceRuns(x.db, 'A', jobId) as { collector: string; status: string }[]
  const fb = lead ? x.db.prepare("SELECT value, source_url FROM lead_enrichments WHERE lead_id = ? AND connector = 'scan:fallback'").get(lead.id) as { value: string; source_url: string } | undefined : undefined
  const res = (runReportFor(x.db, 'A', jobId) as { resolution?: { leads: { company: string; reasons: string[]; fallbacks: string[] }[] } }[]).findLast(r => r.resolution)?.resolution?.leads.find(l => l.company === 'Clera')
  return { x, lead, rows, fb, res, newsCalls }
}
const state = (l?: { review_reason: string | null }) => (!l ? 'none' : l.review_reason === null ? 'qualified' : `held:${l.review_reason}`)


const rows: [string, string, string][] = []
const label = async (name: string, before: Opt, after: Opt) => { const b = await run(before), a = await run(after); rows.push([name, state(b.lead) + (b.res ? '' : ''), state(a.lead)]) }
await label('own site blocked; other press + public ATS board exist', { press: false, board: false }, { board: true })
await label('own site blocked; other press exists, no public board', { press: false, board: false }, { board: false })
await label('own site blocked; nothing elsewhere', { press: false, board: false }, { press: false, board: false })
await label("own site blocked; press is about another company", { press: false, board: false }, { otherCompany: true, board: false })
const w = Math.max(...rows.map(r => r[0].length))
console.log(`${'scenario'.padEnd(w)}  before (no fallback sources)            after`)
for (const [n, b, a] of rows) console.log(`${n.padEnd(w)}  ${b.padEnd(36)} ${a}`)
console.log(`\nqualified: before ${rows.filter(r => r[1] === 'qualified').length} / ${rows.length}, after ${rows.filter(r => r[2] === 'qualified').length} / ${rows.length}`)
