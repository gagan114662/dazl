// New-board discovery through the real runner (isolated in-memory DB, stub providers, stub HTTP, no network, no model).
// Local fixture, not live proof and not product yield. Sources of boards: raw TinyFish search hit URLs (not only the
// candidates that became leads) and the monthly Hacker News "Who is hiring" thread (public Algolia API), state-matched.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import Database from 'better-sqlite3'
import { migrateKeys, saveKey } from '../lib/llm/key-store.ts'
import { migrateScan, createQueryJob, listLeads } from '../lib/scan/store.ts'
import { migratePlans } from '../lib/plans.ts'
import { migrateConnectors } from '../lib/connectors/store.ts'
import { migrateEvents } from '../lib/events/store.ts'
import type { Provider } from '../lib/llm/provider.ts'
import type { SafeGet } from '../lib/sources/types.ts'
import { claimKeyedJob, runJob } from '../lib/scan/runner.ts'
import { resetTinyfishState } from '../lib/search/tinyfish.ts'

const master = randomBytes(32)
process.env.DAZL_MASTER_KEY = master.toString('base64')
const day = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString()
const ago = (n: number) => day(n).slice(0, 10)
const HFQ = 'Harbor Freight Supply of Columbus Ohio is hiring a payroll specialist to manage biweekly payroll'
const REQUEST = 'Find Ohio companies hiring payroll roles'
const ICP = { summary: 'Ohio SMBs hiring payroll', who: ['Controller'], industries: [], sizes: [], where: ['Ohio'], signals: ['payroll job'], exclude: [] }
const BODY: Record<string, string> = {
  beta: 'Beta Logistics needs a payroll specialist to run weekly payroll for its Dayton warehouse.',
  gamma: 'Gamma Dental is hiring a payroll coordinator to manage payroll for ten clinics in Ohio.',
  delta: 'Delta Tools in Austin is hiring a payroll analyst for its Texas plant.',
}
const requested: string[] = []
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const now = new Date()
const monthTitle = (offset: number) => { const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset, 2)); return { title: `Ask HN: Who is hiring? (${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()})`, created_at_i: Math.floor(d.getTime() / 1000) } }
let stories = [monthTitle(0), monthTitle(-1)]
const commentPages: string[] = []
function boardHttp(hnComments: { text: string; reply?: boolean }[], hnOn = true): SafeGet {
  return async url => {
    requested.push(url)
    const u = new URL(url); const j = (o: unknown) => ({ status: 200, body: JSON.stringify(o) })
    if (u.hostname === 'hn.algolia.com') {
      if (!hnOn) return null
      if (u.pathname === '/api/v1/search_by_date') return j({ hits: [{ objectID: '49922568', title: stories[0].title.replace('is hiring', 'wants to be hired'), created_at_i: stories[0].created_at_i }, ...stories.map((t, i) => ({ objectID: `111${i}`, ...t }))] })
      if (u.pathname === '/api/v1/search') { commentPages.push(u.searchParams.get('page') ?? '0'); return j({ hits: (u.searchParams.get('page') ?? '0') === '0' ? hnComments.map((c, i) => ({ objectID: `c${i}`, comment_text: c.text, story_id: 1110, parent_id: c.reply ? 5 : 1110 })) : [] }) }
      return null
    }
    const list = url.match(/^https:\/\/boards-api\.greenhouse\.io\/v1\/boards\/(\w+)\/jobs$/)
    if (list) return j({ jobs: [{ id: 7, title: 'Payroll Specialist', location: { name: list[1] === 'delta' || list[1] === 'epsilon' ? 'Austin, TX' : 'Dayton, OH' } }] })
    const det = url.match(/^https:\/\/boards-api\.greenhouse\.io\/v1\/boards\/(\w+)\/jobs\/7$/)
    if (det) return j({ id: 7, title: 'Payroll Specialist', first_published: day(6), content: `&lt;p&gt;${BODY[det[1]]}&lt;/p&gt;`, location: { name: 'Dayton, OH' }, absolute_url: `https://boards.greenhouse.io/${det[1]}/jobs/7` })
    return null
  }
}
async function run(extraHitUrls: string[], sourceHttp: SafeGet, sources: unknown = { adapters: ['jobboards'], feeds: [] }) {
  requested.length = 0
  resetTinyfishState() // the TinyFish rate limiter is process-wide; each run starts clean
  const db = new Database(':memory:')
  migrateScan(db); migrateKeys(db); migratePlans(db); migrateConnectors(db); migrateEvents(db)
  saveKey(db, 'A', 'anthropic', 'sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', master)
  createQueryJob(db, 'A', { query: REQUEST, icp: JSON.stringify(ICP), sources: JSON.stringify(sources) } as never)
  const job = claimKeyedJob(db)!
  const fetchImpl = (async (u: string) => {
    if (u.startsWith('https://api.search.tinyfish.ai')) return new Response(JSON.stringify({ results: [{ url: 'https://jobs.example/hf', title: 'Payroll specialist', snippet: HFQ, date: ago(20) }, ...extraHitUrls.map(x => ({ url: x, title: 'Careers', snippet: 'jobs', date: ago(20) }))] }), { status: 200 })
    if (u.startsWith('https://api.fetch.tinyfish.ai')) return new Response(JSON.stringify({ results: [{ url: 'https://jobs.example/hf', title: 'Payroll specialist', text: `Posted ${ago(20)}. ${HFQ}. Apply now.` }] }), { status: 200 })
    return new Response('{}', { status: 200 })
  }) as typeof fetch
  const hf = { name: '', company: 'Harbor Freight Supply', contact: null, signal: 'hiring payroll', source_url: 'https://jobs.example/hf', score: 80, excerpt: HFQ, event_date: ago(20) }
  const lead = (k: string) => ({ name: '', company: k, contact: null, signal: 'hiring payroll', source_url: `https://boards.greenhouse.io/${k}/jobs/7`, score: 80, excerpt: BODY[k], event_date: ago(6) })
  const providers: Record<'anthropic' | 'openai', Provider> = {
    anthropic: { research: async () => ({ text: '', citedUrls: [] }), complete: async (_k: string, p: string, _f?: typeof fetch, maxTokens?: number) => maxTokens === 300 ? JSON.stringify(['small company hiring payroll specialist']) : p.includes('PAGE') || p.includes('Beta Logistics') || p.includes('Gamma Dental') ? JSON.stringify(['beta', 'gamma'].filter(k => p.includes(BODY[k])).map(lead)) : p.startsWith('You check one claim') ? 'supports' : JSON.stringify([hf]) },
    openai: { research: async () => ({ text: '', citedUrls: [] }) },
  }
  const page = async (url: string) => {
    const k = url.match(/greenhouse\.io\/(\w+)\/jobs/)?.[1]
    return k ? { text: `Payroll Specialist\nDayton, OH\n${BODY[k]} Apply today.`, title: 'Job', retrievedAt: 1_700_000_000 } : { text: `Posted ${ago(20)}. ${HFQ}. Apply now.`, title: 'Payroll specialist', retrievedAt: 1_700_000_000 }
  }
  process.env.TINYFISH_API_KEY = 'test-tinyfish-key'
  const realFetch = globalThis.fetch; globalThis.fetch = fetchImpl
  try { const r = await runJob(db, job, { providers, master, fetchPage: page as never, fetchImpl, sourceHttp, score: false, judge: null }); return { r, rows: listLeads(db, 'A', job.id) as unknown as { company: string; source_url: string; event_date: string | null; review_reason: string | null }[] } }
  finally { globalThis.fetch = realFetch; delete process.env.TINYFISH_API_KEY }
}
const verified = (rows: { company: string; review_reason: string | null }[]) => rows.filter(r => r.review_reason === null).map(r => r.company).sort()

test('a board that appears only as a RAW search hit (never a candidate) is discovered and its Ohio posting lands verified', async () => {
  const { r, rows } = await run(['https://boards.greenhouse.io/beta/jobs/3'], boardHttp([], false))
  assert.equal(r, 'done')
  assert.ok(verified(rows).includes('beta'), JSON.stringify(rows))
  assert.equal(rows.find(x => x.company === 'beta')!.event_date, ago(6))
})

test('HN Who-is-hiring: only comments that name the state contribute boards; the Texas comment board is never requested', async () => {
  const hn = [
    { text: 'Gamma Dental | Columbus, Ohio | payroll<p>Apply: &lt;a href=&quot;https:&#x2F;&#x2F;boards.greenhouse.io&#x2F;gamma&quot;&gt;https:&#x2F;&#x2F;boards.greenhouse.io&#x2F;gamma&lt;&#x2F;a&gt;' },
    { text: 'Delta Tools | Austin, Texas | payroll<p>https:&#x2F;&#x2F;boards.greenhouse.io&#x2F;delta' },
  ]
  const { rows } = await run([], boardHttp(hn))
  assert.ok(verified(rows).includes('gamma'), JSON.stringify(rows))
  assert.ok(!requested.some(u => u.includes('/boards/delta/')))
  assert.ok(requested.some(u => u.includes('/boards/gamma/jobs')))
  const hnReq = requested.filter(u => new URL(u).hostname === 'hn.algolia.com')
  assert.ok(hnReq.length >= 2 && hnReq.length <= 3, String(hnReq.length)) // story lookup + one comments page, bounded
})

test('HN: only the CURRENT month thread is used: an older month or a future month contributes nothing', async () => {
  const hn = [{ text: 'Gamma Dental | Columbus, Ohio | https:&#x2F;&#x2F;boards.greenhouse.io&#x2F;gamma' }]
  for (const bad of [[monthTitle(-1)], [monthTitle(1)]]) {
    stories = bad
    const { rows } = await run([], boardHttp(hn))
    assert.ok(!verified(rows).includes('gamma'), JSON.stringify(bad))
    assert.ok(!requested.some(u => u.includes('/boards/gamma/')))
  }
  stories = [monthTitle(0), monthTitle(-1)]
})

test('HN: a title naming this month but a creation time in another month is rejected (date and title must agree)', async () => {
  stories = [{ ...monthTitle(0), created_at_i: monthTitle(-1).created_at_i }]
  const { rows } = await run([], boardHttp([{ text: 'Gamma Dental | Ohio | https:&#x2F;&#x2F;boards.greenhouse.io&#x2F;gamma' }]))
  assert.ok(!verified(rows).includes('gamma'))
  stories = [monthTitle(0), monthTitle(-1)]
})

test('HN: replies are ignored, only top-level comments (parent is the thread) contribute boards', async () => {
  await run([], boardHttp([{ text: 'Reply: we are in Ohio too https:&#x2F;&#x2F;boards.greenhouse.io&#x2F;gamma', reply: true }]))
  assert.ok(!requested.some(u => u.includes('/boards/gamma/')))
})

test('HN: a comment that names the state but whose posting is in another state never becomes a lead (state is verified on the posting)', async () => {
  const { rows } = await run([], boardHttp([{ text: 'Epsilon Corp | HQ near Ohio, jobs in Austin | https:&#x2F;&#x2F;boards.greenhouse.io&#x2F;epsilon' }]))
  assert.ok(requested.some(u => u.includes('/boards/epsilon/jobs')))
  assert.ok(!requested.some(u => u.includes('/boards/epsilon/jobs/7')))
  assert.ok(!rows.some(r => r.company === 'epsilon'))
})

test('HN: two comment pages are requested (the thread is larger than one page), total HN requests are exactly 3', async () => {
  await run([], boardHttp([{ text: 'x | Ohio | https:&#x2F;&#x2F;boards.greenhouse.io&#x2F;gamma' }]))
  commentPages.length = 0
  await run([], boardHttp([{ text: 'x | Ohio | https:&#x2F;&#x2F;boards.greenhouse.io&#x2F;gamma' }]))
  assert.deepEqual(commentPages, ['0', '1'])
  assert.equal(requested.filter(u => new URL(u).hostname === 'hn.algolia.com').length, 3)
})

test('network cap: with 30 board links in the thread the adapter makes at most 3 HN + 10 board lists + 3 details per board', async () => {
  const links = Array.from({ length: 30 }, (_, i) => `https:&#x2F;&#x2F;boards.greenhouse.io&#x2F;b${i}`).join(' ')
  await run([], boardHttp([{ text: `Many | Ohio | ${links}` }]))
  const lists = requested.filter(u => /\/jobs$/.test(u)).length
  assert.ok(lists <= 10, String(lists))
  assert.ok(requested.length <= 3 + 10 * (1 + 3), String(requested.length))
})

test('raw-hit discovery does not depend on the stats flag: stats on gives the same verified set as stats off', async () => {
  const off = await run(['https://boards.greenhouse.io/beta/jobs/3'], boardHttp([], false))
  process.env.DAZL_SOURCE_STATS = '1'; process.env.DAZL_SOURCE_STATS_USERS = 'A'
  try {
    const on = await run(['https://boards.greenhouse.io/beta/jobs/3'], boardHttp([], false))
    assert.deepEqual(verified(on.rows), verified(off.rows))
    assert.ok(verified(on.rows).includes('beta'))
  } finally { delete process.env.DAZL_SOURCE_STATS; delete process.env.DAZL_SOURCE_STATS_USERS }
})

test('without the jobboards source selected, no HN or board request is made', async () => {
  await run(['https://boards.greenhouse.io/beta/jobs/3'], boardHttp([]), { adapters: ['rss'], feeds: [] })
  assert.deepEqual(requested.filter(u => /algolia|greenhouse/.test(u)), [])
})

// Pin (passes today: not a red test): job boards and the HN thread are requested ONLY when the scan's own source
// selection names jobboards. A default scan (no sources) and a scan that selected other sources make no board/HN request.
test('no job-board or HN request unless the scan selected jobboards', async () => {
  const BOARD_HOSTS = /boards-api\.greenhouse\.io|api\.ashbyhq\.com|hn\.algolia\.com/
  for (const sources of [null, { adapters: ['github'], feeds: [] }, { adapters: [], feeds: [], advanced: [] }]) {
    const { r } = await run(['https://boards.greenhouse.io/beta/jobs/3'], boardHttp([{ text: 'Gamma Dental | Columbus, Ohio | payroll<p>https:&#x2F;&#x2F;boards.greenhouse.io&#x2F;gamma' }], true), sources)
    assert.equal(r, 'done')
    assert.deepEqual(requested.filter(u => BOARD_HOSTS.test(u)), [], `unexpected board/HN request for sources=${JSON.stringify(sources)}: ${requested.join(' ')}`)
  }
  const { r } = await run(['https://boards.greenhouse.io/beta/jobs/3'], boardHttp([], false))
  assert.equal(r, 'done')
  assert.ok(requested.some(u => BOARD_HOSTS.test(u)), 'control: when jobboards IS selected the boards are requested')
})
