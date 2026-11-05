// #381 adaptive discovery through the real runner (isolated in-memory DB, stub provider, stub TinyFish, stub page
// fetch; no live provider, no spend). Round one extracts a candidate the verifier refuses, so the scan has zero
// actionable leads: ONE more bounded round asks a genuinely different query (an unused profile signal, the profile's
// geography kept), reads only pages round one never saw, and its candidate passes the same verifier. Skips are
// recorded with their reason, and a query round one already asked is never sent (or billed) again.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import Database from 'better-sqlite3'
import { migrateKeys, saveKey } from '../lib/llm/key-store.ts'
import { migrateScan, createQueryJob } from '../lib/scan/store.ts'
import { migratePlans } from '../lib/plans.ts'
import { migrateConnectors } from '../lib/connectors/store.ts'
import { migrateEvents } from '../lib/events/store.ts'
import type { Provider } from '../lib/llm/provider.ts'
import { resetTinyfishState } from '../lib/search/tinyfish.ts'
import { ADAPTIVE_FETCHES, ADAPTIVE_SEARCHES, claimKeyedJob, runJob, type RunDeps } from '../lib/scan/runner.ts'

const master = randomBytes(32)
process.env.DAZL_MASTER_KEY = master.toString('base64')
const KEY = 'sk-ant-test-AAAA'
const recent = new Date(Date.now() - 20 * 86_400_000).toISOString().slice(0, 10)
const REQUEST = 'Find Ohio companies with 10 to 100 employees that recently posted a payroll, HR or office manager job'
const A = { url: 'https://jobs.example/a', company: 'Harbor Freight Supply', quote: 'Harbor Freight Supply of Columbus Ohio is hiring a payroll specialist to manage biweekly payroll' }
const B = { url: 'https://jobs.example/b', company: 'Lakeview Dental Group', quote: 'Lakeview Dental Group in Dayton Ohio is hiring an office manager to run the front desk and billing' }
const MODEL_Q = ['small company hiring payroll specialist', 'complaints about payroll software small business']

type Opts = { signals?: string[]; aVerifies?: boolean; deps?: Partial<RunDeps> }
async function scan(o: Opts = {}) {
  resetTinyfishState()
  const icp = { summary: 'Ohio SMBs hiring', who: ['Controller'], industries: [], sizes: ['10-100 employees'], where: ['Ohio'], signals: o.signals ?? ['payroll job', 'new front desk coordinator position posted'], exclude: [] }
  const db = new Database(':memory:')
  migrateScan(db); migrateKeys(db); migratePlans(db); migrateConnectors(db); migrateEvents(db)
  saveKey(db, 'A', 'anthropic', KEY, master)
  createQueryJob(db, 'A', { query: REQUEST, icp: JSON.stringify(icp) })
  const job = claimKeyedJob(db)!
  const searched: string[] = [], fetchBatches: string[][] = [], extractions: string[] = []
  const fetchImpl = (async (u: string, init?: RequestInit) => {
    if (u.startsWith('https://api.search.tinyfish.ai')) {
      const q = new URL(u).searchParams.get('query') ?? ''
      if (q.startsWith('site:linkedin.com/in ')) return new Response(JSON.stringify({ results: [] }), { status: 200 }) // post-scan people search: not discovery
      searched.push(q)
      // round one's queries find page A; the front-desk query finds B (and A again, which must not be re-read)
      const hits = /front desk/i.test(q) ? [B, A] : [A]
      return new Response(JSON.stringify({ results: hits.map(h => ({ url: h.url, title: 'Job', snippet: h.quote, date: recent })) }), { status: 200 })
    }
    if (u.startsWith('https://api.fetch.tinyfish.ai')) {
      const urls = (JSON.parse(String(init?.body ?? '{}')) as { urls?: string[] }).urls ?? []
      fetchBatches.push(urls)
      return new Response(JSON.stringify({ results: urls.map(x => { const h = x === B.url ? B : A; return { url: h.url, title: 'Job', text: h === A && !o.aVerifies ? 'This position has been removed.' : `Posted ${recent}. ${h.quote}. Apply now.` } }) }), { status: 200 })
    }
    return new Response('{}', { status: 200 })
  }) as typeof fetch
  const draft = (h: typeof A) => ({ name: '', company: h.company, contact: null, signal: 'Hiring for the role', source_url: h.url, score: 80, excerpt: h.quote, event_date: recent })
  const providers: Record<'anthropic' | 'openai', Provider> = {
    anthropic: {
      research: async () => ({ text: '', citedUrls: [] }),
      complete: async (_k: string, prompt: string, _f?: typeof fetch, maxTokens?: number) => {
        if (maxTokens === 300) return JSON.stringify(MODEL_Q)
        extractions.push(prompt)
        return JSON.stringify(prompt.includes(B.url) ? [draft(B)] : [draft(A)])
      },
    },
    openai: { research: async () => ({ text: '', citedUrls: [] }) },
  }
  // the verifier's own read: page A no longer carries the quote (round one verifies nothing), page B does
  const page = async (u: string) => ({ text: u === A.url && !o.aVerifies ? 'This position has been removed.' : `Posted ${recent}. ${(u === B.url ? B : A).quote}. Apply now.`, title: 'Job', retrievedAt: Math.floor(Date.now() / 1000) })
  const realFetch = globalThis.fetch
  globalThis.fetch = fetchImpl
  process.env.TINYFISH_API_KEY = 'test-tinyfish-key'
  try {
    const r = await runJob(db, job, { providers, master, fetchPage: page, fetchImpl, score: false, judge: null, ...o.deps })
    const runs = db.prepare('SELECT collector, status, candidate_count, verified_count FROM scan_source_runs ORDER BY collector').all() as { collector: string; status: string; candidate_count: number | null; verified_count: number | null }[]
    const leads = db.prepare("SELECT company, source_url, review_reason FROM leads WHERE scan_job_id = ? ORDER BY rowid").all(job.id) as { company: string; source_url: string; review_reason: string | null }[]
    const jobRow = db.prepare('SELECT status, error, verified FROM scan_jobs WHERE id = ?').get(job.id) as { status: string; error: string | null; verified: number }
    return { r, searched, fetchBatches, extractions, runs, leads, jobRow, adaptive: runs.find(x => x.collector === 'search:adaptive') }
  } finally { globalThis.fetch = realFetch; delete process.env.TINYFISH_API_KEY }
}

test('#381 zero actionable after round one: one different, bounded round on unseen pages finds a lead the same verifier accepts', async () => {
  const s = await scan()
  assert.equal(s.r, 'done')
  const roundTwo = s.searched.filter(q => /front desk/i.test(q))
  assert.equal(roundTwo.length, 1, `one new query from the unused signal: ${JSON.stringify(s.searched)}`)
  assert.match(roundTwo[0], /ohio/i, 'the profile geography is kept, never widened')
  assert.equal(new Set(s.searched).size, s.searched.length, 'no query is sent twice')
  assert.ok(s.searched.length - roundTwo.length <= 8 && roundTwo.length <= ADAPTIVE_SEARCHES)
  const last = s.fetchBatches.at(-1)!
  assert.deepEqual(last, [B.url], 'round two reads only the page round one never saw')
  assert.ok(last.length <= ADAPTIVE_FETCHES)
  assert.equal(s.adaptive?.status, 'ok'); assert.equal(s.adaptive?.candidate_count, 1)
  assert.ok(s.leads.some(l => l.company === B.company && l.source_url === B.url && l.review_reason === null), JSON.stringify(s.leads))
  assert.ok(!s.leads.some(l => l.company === A.company && l.review_reason === null), 'round one\'s refused candidate stays refused')
  assert.ok(s.jobRow.verified >= 1, JSON.stringify(s.jobRow))
})

test('#381 round one verified a lead: no adaptive round, no extra search', async () => {
  const s = await scan({ aVerifies: true })
  assert.equal(s.r, 'done'); assert.equal(s.adaptive, undefined)
  assert.ok(!s.searched.some(q => /front desk/i.test(q)))
})

test('#381 no unused signal: skipped with the reason, and no query round one asked is sent again', async () => {
  const s = await scan({ signals: ['payroll job'] })
  assert.equal(s.adaptive?.status, 'skipped:no_new_signal')
  assert.equal(new Set(s.searched).size, s.searched.length)
  assert.equal(s.extractions.length, 1, 'no second extraction call')
})

test('#381 bounds: a run that disabled paid steps, or with too little of its time budget left, skips visibly (never "nothing found")', async () => {
  let s = await scan({ deps: { paidFallback: false } })
  assert.equal(s.adaptive?.status, 'skipped:paid_steps_off'); assert.ok(!s.searched.some(q => /front desk/i.test(q)))
  let calls = 0
  s = await scan({ deps: { jobBudgetMs: 200_000, clock: () => (calls++ === 0 ? 0 : 100_000) } })
  assert.equal(s.adaptive?.status, 'skipped:time_budget'); assert.ok(!s.searched.some(q => /front desk/i.test(q)))
})
