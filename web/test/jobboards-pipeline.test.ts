// End to end through the real runner with stubbed providers and stubbed HTTP (no network, no model): a candidate that
// search found on a Greenhouse board makes the job-board adapter read that board; a different posting on the same board
// becomes a lead, and it only lands as verified if the verifier finds the quote on the page. Local fixture, not live proof.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import Database from 'better-sqlite3'
import { migrateKeys, saveKey } from '../lib/llm/key-store.ts'
import { migrateScan, createQueryJob, listLeads } from '../lib/scan/store.ts'
import { claimKeyedJob, runJob } from '../lib/scan/runner.ts'
import type { SafeGet } from '../lib/sources/types.ts'

const master = randomBytes(32)
const day = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString()
const ago = (n: number) => day(n).slice(0, 10)
const U1 = 'https://boards.greenhouse.io/acme/jobs/1'
const U5 = 'https://boards.greenhouse.io/acme/jobs/5'
const T5 = 'Acme Foods is looking for a Payroll Specialist to run bi-weekly payroll for our Columbus plant.'
const requested: string[] = []
const http: SafeGet = async url => {
  requested.push(url)
  if (url.startsWith('https://hn.algolia.com/')) return null
  const j = (o: unknown) => ({ status: 200, body: JSON.stringify(o) })
  if (url === 'https://boards-api.greenhouse.io/v1/boards/acme/jobs') return j({ jobs: [
    { id: 1, title: 'Payroll Clerk', location: { name: 'Columbus, OH' } },
    { id: 5, title: 'Payroll Specialist', location: { name: 'Columbus, OH' } },
    { id: 6, title: 'Payroll Lead', location: { name: 'Dallas, TX' } },
  ] })
  if (url === 'https://boards-api.greenhouse.io/v1/boards/acme/jobs/1') return j({ id: 1, title: 'Payroll Clerk', first_published: day(8), location: { name: 'Columbus, OH' }, absolute_url: U1 })
  if (url === 'https://boards-api.greenhouse.io/v1/boards/acme/jobs/5') return j({ id: 5, title: 'Payroll Specialist', first_published: day(11), updated_at: day(1), content: `&lt;p&gt;${T5}&lt;/p&gt;&lt;p&gt;Benefits include dental.&lt;/p&gt;`, location: { name: 'Columbus, OH' }, absolute_url: U5 })
  return null
}
const page = async (url: string) => ({ text: url === U5 ? `Payroll Specialist\nColumbus, OH\n${T5} Benefits include dental. Apply today.` : 'Acme Foods is hiring a Payroll Clerk in Columbus, OH. Apply today.', title: 'Acme Foods jobs', retrievedAt: 1_700_000_000 })
const lead = (url: string, excerpt: string, date: string) => ({ name: '', company: 'Acme Foods', contact: null, signal: 'hiring payroll', source_url: url, score: 85, excerpt, event_date: date })

async function run(research: unknown[], completeOut: (url?: string) => unknown[], feeds: string[] = ['https://boards.greenhouse.io/acme']) {
  requested.length = 0
  const db = new Database(':memory:'); migrateScan(db); migrateKeys(db); saveKey(db, 'A', 'anthropic', 'sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', master)
  const icp = JSON.stringify({ summary: 'x', who: [], industries: [], sizes: [], where: [], signals: [], exclude: [] })
  const id = createQueryJob(db, 'A', { query: 'ohio companies hiring payroll', icp, sources: JSON.stringify({ adapters: ['jobboards'], feeds }) } as never)
  const prov = {
    anthropic: { research: async () => ({ text: JSON.stringify(research), citedUrls: research.map((r: any) => r.source_url) }), complete: async (_k: string, p: string) => p.startsWith('You check one claim') ? 'supports' : JSON.stringify(completeOut()) },
    openai: { research: async () => ({ text: '[]', citedUrls: [] }), complete: async () => '[]' },
  }
  const res = await runJob(db, claimKeyedJob(db, id)!, { providers: prov as never, master, fetchPage: page as never, sourceHttp: http, score: false, now: new Date() })
  return { res, rows: listLeads(db, 'A', id) as unknown as { source_url: string; event_date: string | null; review_reason: string | null }[] }
}

test('a selected board is read through the real pipeline; the Ohio posting lands verified with the first_published date, the Texas posting is never fetched', async () => {
  const { res, rows } = await run([], () => [lead(U5, T5, ago(11))])
  assert.equal(res, 'done')
  const five = rows.find(r => r.source_url === U5)
  assert.ok(five, 'posting 5 became a lead')
  assert.equal(five!.review_reason, null)
  assert.equal(five!.event_date, ago(11))
  assert.ok(requested.includes('https://boards-api.greenhouse.io/v1/boards/acme/jobs'))
  assert.ok(!requested.some(u => u.endsWith('/jobs/6')))
  for (const u of requested) assert.ok(['boards-api.greenhouse.io', 'hn.algolia.com'].includes(new URL(u).hostname), u)
})

test('a quote that is not on the posting page is dropped by the verifier, never verified', async () => {
  const { rows } = await run([], () => [lead(U5, 'Acme Foods is hiring a Chief Payroll Wizard in Columbus, OH', ago(11))])
  assert.equal(rows.find(r => r.source_url === U5 && r.review_reason === null), undefined)
})

test('the evidence quote is the posting body text as published, not a join of title and location', async () => {
  const { collectEvidence } = await import('../lib/sources/index.ts')
  const ev = await collectEvidence({ adapters: ['jobboards'], feeds: ['https://boards.greenhouse.io/acme'], pages: [] }, 'ohio companies hiring payroll', http, 5000)
  const five = ev.find(e => e.url === U5)!
  assert.equal(five.quote, T5)
  assert.ok(!five.quote.includes('Columbus, OH'))
})

test('a posting with no body text yields no evidence (nothing invented from title and location)', async () => {
  const { collectEvidence } = await import('../lib/sources/index.ts')
  const ev = await collectEvidence({ adapters: ['jobboards'], feeds: ['https://boards.greenhouse.io/acme'], pages: [] }, 'ohio companies hiring clerk', http, 5000)
  assert.deepEqual(ev, []) // job 1 has no content in the fixture
})

test('the same employer is not counted twice: a search lead and a board posting for one company stay one lead (dedupe guard intact)', async () => {
  const { rows } = await run([lead(U1, 'Acme Foods is hiring a Payroll Clerk in Columbus, OH', ago(8))], () => [lead(U5, T5, ago(11))])
  assert.equal(rows.filter(r => r.review_reason === null).length, 1)
})

test('with no board selected the adapter requests nothing', async () => {
  const { rows } = await run([], () => [], [])
  assert.equal(rows.length, 0)
  assert.deepEqual(requested.filter(u => !u.startsWith('https://hn.algolia.com/')), []) // only the HN lookup, no board
})

// ---- the quote is chosen from what the posting PAGE actually says ----
import { collectEvidenceReport } from '../lib/sources/index.ts'
import { sourceRuns } from '../lib/scan/source-runs.ts'
const P1 = 'Acme Foods is a family company founded in 1950 and serving the whole Midwest region.'
const detailWith = (content: string) => ({ id: 5, title: 'Payroll Specialist', first_published: day(11), content, location: { name: 'Columbus, OH' }, absolute_url: U5 })
const boardHttp = (content: string): SafeGet => async url => {
  if (url.startsWith('https://hn.algolia.com/')) return { status: 200, body: JSON.stringify({ hits: [] }) }
  const j = (o: unknown) => ({ status: 200, body: JSON.stringify(o) })
  if (url === 'https://boards-api.greenhouse.io/v1/boards/acme/jobs') return j({ jobs: [{ id: 5, title: 'Payroll Specialist', location: { name: 'Columbus, OH' } }] })
  if (url === 'https://boards-api.greenhouse.io/v1/boards/acme/jobs/5') return j(detailWith(content))
  return null
}
const esc = (s: string) => `&lt;p&gt;${s}&lt;/p&gt;`
const S = { adapters: ['jobboards'], feeds: ['https://boards.greenhouse.io/acme'], pages: [] }

test('page-aware quote: the first body paragraph is not on the page, a later one is: that later paragraph becomes the quote', async () => {
  const page = async () => `Payroll Specialist Columbus, OH ${T5} Apply today.`
  const r = await collectEvidenceReport(S, 'ohio hiring payroll', boardHttp(esc(P1) + esc(T5)), 5000, [], page)
  assert.equal(r.items[0]?.quote, T5)
  assert.equal(r.runs[0].status, 'ok')
})

test('page-aware quote: no body paragraph appears on the page, so no evidence is produced (dropped before the model, not a partial)', async () => {
  const page = async () => 'Payroll Specialist Columbus, OH. Different words entirely.'
  const r = await collectEvidenceReport(S, 'ohio hiring payroll', boardHttp(esc(P1) + esc(T5)), 5000, [], page)
  assert.deepEqual(r.items, [])
  assert.equal(r.runs[0].status, 'empty')
})

test('page-aware quote: a page that cannot be fetched keeps the API quote for the verifier to decide, and reports partial (unreachable page)', async () => {
  const r = await collectEvidenceReport(S, 'ohio hiring payroll', boardHttp(esc(P1) + esc(T5)), 5000, [], async () => null)
  assert.equal(r.items[0]?.quote, P1)
  assert.equal(r.runs[0].status, 'partial'); assert.deepEqual(r.runs[0].notes, { page_unreachable: 1 })
})

test('runner: the scan hands the adapter its page fetcher; an off-page body never reaches the model and the scan finishes with no lead', async () => {
  const prompts: string[] = []
  requested.length = 0
  const db = new Database(':memory:'); migrateScan(db); migrateKeys(db); saveKey(db, 'A', 'anthropic', 'sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', master)
  const icp = JSON.stringify({ summary: 'x', who: [], industries: [], sizes: [], where: [], signals: [], exclude: [] })
  const id = createQueryJob(db, 'A', { query: 'ohio companies hiring payroll', icp, sources: JSON.stringify(S) } as never)
  const prov = { anthropic: { research: async () => ({ text: '[]', citedUrls: [] }), complete: async (_k: string, p: string) => { prompts.push(p); return '[]' } }, openai: { research: async () => ({ text: '[]', citedUrls: [] }), complete: async () => '[]' } }
  const res = await runJob(db, claimKeyedJob(db)!, { providers: prov as never, master, fetchPage: (async () => ({ text: 'Unrelated page text only.', title: 'x', retrievedAt: 1 })) as never, sourceHttp: boardHttp(esc(P1) + esc(T5)), score: false, now: new Date() })
  assert.equal(res, 'failed') // no candidates at all
  assert.ok(!prompts.some(p => p.includes(U5)), 'the off-page posting never reached the model')
})

test('ledger to API: a cut board lands as status "partial" with evidence_count 0 (not "empty", not null); a healthy empty board stays "empty"', async () => {
  const run = async (http: SafeGet) => {
    const db = new Database(':memory:'); migrateScan(db); migrateKeys(db); saveKey(db, 'A', 'anthropic', 'sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', master)
    const icp = JSON.stringify({ summary: 'x', who: [], industries: [], sizes: [], where: [], signals: [], exclude: [] })
    const jid = createQueryJob(db, 'A', { query: 'ohio companies hiring payroll', icp, sources: JSON.stringify(S) } as never)
    const prov = { anthropic: { research: async () => ({ text: '[]', citedUrls: [] }), complete: async () => '[]' }, openai: { research: async () => ({ text: '[]', citedUrls: [] }), complete: async () => '[]' } }
    await runJob(db, claimKeyedJob(db)!, { providers: prov as never, master, fetchPage: page as never, sourceHttp: http, score: false, now: new Date() })
    return (sourceRuns(db, 'A', jid) as { collector: string; status: string; evidence_count: number | null }[]).find(r => r.collector === 'adapter:jobboards')
  }
  const cut = await run(async url => url.startsWith('https://hn.algolia.com/') ? { status: 200, body: '{"hits":[]}' } : { status: 200, body: '{"jobs":[{"id":', truncated: true })
  assert.equal(cut?.status, 'partial'); assert.equal(cut?.evidence_count, 0)
  const empty = await run(async url => url.startsWith('https://hn.algolia.com/') ? { status: 200, body: '{"hits":[]}' } : { status: 200, body: '{"jobs":[]}' })
  assert.equal(empty?.status, 'empty'); assert.equal(empty?.evidence_count, 0)
})
