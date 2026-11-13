// #381 adaptive discovery through the real runner (isolated in-memory DB, stub provider, stub TinyFish, stub page
// fetch; no live provider, no spend). Round one extracts a candidate the verifier refuses, so the scan has zero
// actionable leads: ONE more bounded round asks a genuinely different query (an unused profile signal, the profile's
// geography kept), reads only pages round one never saw, and its candidate passes the same verifier. Skips are
// recorded with their reason, and a query round one already asked is never sent (or billed) again.
import { mock, test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import Database from 'better-sqlite3'
import { migrateKeys, saveKey } from '../lib/llm/key-store.ts'
import { migrateScan, createQueryJob, cancelJob } from '../lib/scan/store.ts'
import { migratePlans } from '../lib/plans.ts'
import { migrateConnectors } from '../lib/connectors/store.ts'
import { migrateEvents } from '../lib/events/store.ts'
import { migrateFeedback } from '../lib/scan/feedback.ts'
import { companyKey } from '../lib/scan/evidence.ts'
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

type Opts = {
  fundedByTrial?: boolean
  seedReservedUsd?: number
  runBudget?: string
  adaptiveOff?: boolean
  adaptiveFlag?: string
  onAdaptiveSearch?: (db: Database.Database, jobId: string) => void
  signals?: string[]; aVerifies?: boolean; rejectCompanyB?: boolean; deps?: Partial<RunDeps> }
async function scan(o: Opts = {}) {
  resetTinyfishState()
  const icp = { summary: 'Ohio SMBs hiring', who: ['Controller'], industries: [], sizes: ['10-100 employees'], where: ['Ohio'], signals: o.signals ?? ['payroll job', 'new front desk coordinator position posted'], exclude: [] }
  const db = new Database(':memory:')
  migrateScan(db); migrateKeys(db); migratePlans(db); migrateConnectors(db); migrateEvents(db); migrateFeedback(db)
  if (o.rejectCompanyB) db.prepare("INSERT INTO lead_feedback (id, tenant_id, version, verdict, level, reason, company_key, created_at) VALUES ('fb-b', 'A', 1, 'reject', 'account', 'not_useful', ?, ?)").run(companyKey(B.company), Date.now())
  saveKey(db, 'A', 'anthropic', KEY, master)
  const jid = createQueryJob(db, 'A', { query: REQUEST, icp: JSON.stringify(icp), ...(o.runBudget ? { runBudget: o.runBudget } : {}) })
  if (o.fundedByTrial) db.prepare("UPDATE scan_jobs SET funded_by = 'trial', spend_reserved_usd = ? WHERE id = ?").run(o.seedReservedUsd ?? 0, jid)
  const job = claimKeyedJob(db)!
  const searched: string[] = [], fetchBatches: string[][] = [], extractions: string[] = [], pageReads: string[] = []
  const fetchImpl = (async (u: string, init?: RequestInit) => {
    if (u.startsWith('https://api.search.tinyfish.ai')) {
      const q = new URL(u).searchParams.get('query') ?? ''
      if (q.startsWith('site:linkedin.com/in ')) return new Response(JSON.stringify({ results: [] }), { status: 200 }) // post-scan people search: not discovery
      searched.push(q)
      // round one's queries find page A; the front-desk query finds B (and A again, which must not be re-read)
      if (/front desk/i.test(q)) o.onAdaptiveSearch?.(db, job.id)
      const hits = /front desk/i.test(q) ? [B, A] : [A]
      return new Response(JSON.stringify({ results: hits.map(h => ({ url: h.url, title: 'Job', snippet: h.quote, date: recent })) }), { status: 200 })
    }
    if (u.includes('/count_tokens')) return new Response(JSON.stringify({ input_tokens: 10 }), { status: 200 }) // the budget guard's token counter
    if (u.startsWith('https://api.fetch.tinyfish.ai')) {
      const urls = (JSON.parse(String(init?.body ?? '{}')) as { urls?: string[] }).urls ?? []
      fetchBatches.push(urls)
      return new Response(JSON.stringify({ results: urls.map(x => { const h = x === B.url ? B : A; return { url: h.url, title: 'Job', text: h === A && !o.aVerifies ? 'This position has been removed.' : `Posted ${recent}. ${h.quote}. Apply now.` } }) }), { status: 200 })
    }
    return new Response('{}', { status: 200 })
  }) as typeof fetch
  const draft = (h: typeof A) => ({ name: '', company: h.company, contact: null, signal: 'Hiring for the role', source_url: h.url, score: 80, excerpt: h.quote, event_date: recent })
  const complete = async (_k: string, prompt: string, _f?: typeof fetch, maxTokens?: number) => {
    if (maxTokens === 300) return JSON.stringify(MODEL_Q)
    extractions.push(prompt)
    return JSON.stringify(prompt.includes(B.url) ? [draft(B)] : [draft(A)])
  }
  const providers: Record<'anthropic' | 'openai', Provider> = {
    anthropic: {
      configuredModel: () => 'claude-sonnet-4-5',
      research: async () => ({ text: '', citedUrls: [] }),
      complete: async (k: string, prompt: string, f?: typeof fetch, maxTokens?: number) => complete(k, prompt, f, maxTokens),
      // A real provider reports usage; a guarded run settles to it. Without usage the guard stops after one call (#850).
      completeDetailed: async (k: string, prompt: string, f?: typeof fetch, maxTokens?: number) => ({ text: await complete(k, prompt, f, maxTokens), model: 'claude-sonnet-4-5', usage: { input_tokens: 1000, output_tokens: 100 } }),
    },
    openai: { research: async () => ({ text: '', citedUrls: [] }) },
  }
  // the verifier's own read: page A no longer carries the quote (round one verifies nothing), page B does
  const page = async (u: string) => { pageReads.push(u); return { text: u === A.url && !o.aVerifies ? 'This position has been removed.' : `Posted ${recent}. ${(u === B.url ? B : A).quote}. Apply now.`, title: 'Job', retrievedAt: Math.floor(Date.now() / 1000) } }
  const realFetch = globalThis.fetch
  globalThis.fetch = fetchImpl
  process.env.TINYFISH_API_KEY = 'test-tinyfish-key'
  if (o.adaptiveOff) delete process.env.DAZL_ADAPTIVE_DISCOVERY_ENABLED; else process.env.DAZL_ADAPTIVE_DISCOVERY_ENABLED = o.adaptiveFlag ?? '1'
  try {
    const r = await runJob(db, job, { providers, master, fetchPage: page, fetchImpl, score: false, judge: null, ...o.deps })
    const runs = db.prepare('SELECT collector, status, candidate_count, verified_count FROM scan_source_runs ORDER BY collector').all() as { collector: string; status: string; candidate_count: number | null; verified_count: number | null }[]
    const leads = db.prepare("SELECT company, source_url, review_reason FROM leads WHERE scan_job_id = ? ORDER BY rowid").all(job.id) as { company: string; source_url: string; review_reason: string | null }[]
    const jobRow = db.prepare('SELECT status, error, verified FROM scan_jobs WHERE id = ?').get(job.id) as { status: string; error: string | null; verified: number }
    return { db, jobId: job.id, r, searched, fetchBatches, extractions, pageReads, runs, leads, jobRow, adaptive: runs.find(x => x.collector === 'search:adaptive') }
  } finally { globalThis.fetch = realFetch; delete process.env.TINYFISH_API_KEY; delete process.env.DAZL_ADAPTIVE_DISCOVERY_ENABLED }
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

test('#381 policy lock: a trial scan near its reserve ceiling never enters the paid adaptive round (skipped:paid_steps_off, no adaptive call, never empty)', async () => {
  // Trial policy (runner: a trial gets paidFallback=false) keeps the paid adaptive round OFF for trial scans;
  // the reserve is a reservation ledger, not a proven vendor-invoice cap. The re-review's trial-refusal scenario
  // cannot occur under this policy: the round is skipped before any call exists to refuse. This test locks that.
  const saved = { ...process.env }
  Object.assign(process.env, {
    DAZL_TRIAL_ANTHROPIC_KEY: 'sk-ant-trial-fixture', DAZL_TRIAL_SCAN_RESERVE_USD: '0.30', DAZL_TRIAL_ACCOUNT_TOTAL_USD: '1',
    DAZL_TRIAL_GLOBAL_DAILY_USD: '10', DAZL_TRIAL_TINYFISH_SEARCH_USD: '0.05', DAZL_TRIAL_TINYFISH_FETCH_USD: '0.01',
  })
  try {
    // Round one (4 searches, 1 fetched page, the guarded model calls) reserves about $0.27; the $0.015 prior
    // reservation leaves less than one $0.05 search inside the $0.30 reserve - and still no adaptive call is made.
    const s = await scan({ fundedByTrial: true, seedReservedUsd: 0.015 })
    assert.equal(s.r, 'done')
    assert.equal(s.adaptive?.status, 'skipped:paid_steps_off', JSON.stringify(s.adaptive))
    assert.ok(!s.searched.some(q => /front desk/i.test(q)), `no adaptive search was sent: ${JSON.stringify(s.searched)}`)
    assert.deepEqual(s.fetchBatches, [[A.url]], 'no adaptive fetch')
    assert.equal(s.extractions.length, 1, 'no adaptive extraction')
    const reserved = (s.db.prepare('SELECT spend_reserved_usd AS s FROM scan_jobs WHERE id = ?').get(s.jobId) as { s: number }).s
    assert.ok(reserved <= 0.30 + 1e-9, `reserved ${reserved} stays within the $0.30 trial reserve`)
    assert.ok(!s.leads.some(l => l.company === B.company), 'nothing from a round that never ran is kept')
  } finally { process.env = saved }
})

test('#381 budget near-exhausted (non-trial, own max_usd): the adaptive round\'s first search is refused before it is sent (visible status, never empty)', async () => {
  // The non-trial funded path for the re-review's refusal scenario: the scan's own run_budget.max_usd lowers the
  // per-scan spend cap (lib/scan/spend-cap.ts); every TinyFish call reserves against it before it is sent.
  const saved = { ...process.env }
  Object.assign(process.env, { DAZL_SCAN_PRICE_TINYFISH_SEARCH_USD: '0.05', DAZL_SCAN_PRICE_TINYFISH_FETCH_USD: '0.01' })
  try {
    // Round one: 4 searches + 1 fetched page = $0.21 of the $0.25 budget; the first $0.05 adaptive search would pass it.
    const s = await scan({ runBudget: '{"max_usd":0.25}' })
    assert.equal(s.r, 'done')
    assert.equal(s.adaptive?.status, 'budget_stopped', `a money refusal is budget_stopped, never the count-cap status: ${JSON.stringify(s.adaptive)}`)
    assert.ok(!s.searched.some(q => /front desk/i.test(q)), `the refused search was never sent: ${JSON.stringify(s.searched)}`)
    assert.ok(!s.fetchBatches.some(b => b.includes(B.url)), 'no adaptive fetch after the refusal')
    assert.ok(!s.extractions.some(p => p.includes(B.url)), 'no adaptive extraction after the refusal')
    const refusals = (s.db.prepare('SELECT spend_cap_refusals AS n FROM scan_jobs WHERE id = ?').get(s.jobId) as { n: number }).n
    assert.ok(refusals >= 1, 'the refusal is recorded on the scan spend ledger (a budget refusal, not a count cap)')
    assert.ok(!s.leads.some(l => l.company === B.company), 'nothing from a round that never ran is kept')
  } finally { process.env = saved }
})

test('#381 tenant daily cap exhausted by round one: the adaptive round stops with a visible status and makes no provider call', async () => {
  const saved = process.env.TINYFISH_TENANT_DAILY
  process.env.TINYFISH_TENANT_DAILY = '4' // exactly round one's four searches
  try {
    const s = await scan()
    assert.equal(s.r, 'done')
    assert.equal(s.searched.length, 4, `round one used the whole tenant/day cap: ${JSON.stringify(s.searched)}`)
    assert.equal(s.adaptive?.status, 'search_cap', JSON.stringify(s.adaptive))
    assert.ok(!s.searched.some(q => /front desk/i.test(q)), 'the capped search was never sent')
    assert.ok(!s.fetchBatches.some(b => b.includes(B.url)), 'no adaptive fetch batch')
    assert.ok(!s.extractions.some(p => p.includes(B.url)), 'no adaptive extraction')
    assert.ok(!s.leads.some(l => l.company === B.company), 'nothing from the capped round is kept')
  } finally { if (saved === undefined) delete process.env.TINYFISH_TENANT_DAILY; else process.env.TINYFISH_TENANT_DAILY = saved }
})

test('#381 cancellation inside the adaptive round: ScanStopped and ScanTimedOut propagate, and no ok is recorded', async () => {
  // a stop requested while the adaptive round's search is in flight
  let s = await scan({ onAdaptiveSearch: (db, id) => { cancelJob(db, 'A', id) } })
  assert.equal(s.r, 'done', 'ScanStopped: the stop owns the row')
  assert.equal(s.jobRow.status, 'failed'); assert.equal(s.jobRow.error, 'cancelled')
  assert.notEqual(s.adaptive?.status, 'ok', `never ok: ${JSON.stringify(s.adaptive)}`)
  assert.ok(!s.leads.some(l => l.company === B.company), 'nothing from the interrupted round is kept')
  // the run's deadline passes while the adaptive round's search is in flight
  let t = 0
  s = await scan({ deps: { jobBudgetMs: 200_000, clock: () => t }, onAdaptiveSearch: () => { t = 250_000 } })
  assert.equal(s.r, 'failed'); assert.equal(s.jobRow.error, 'scan_timeout')
  assert.notEqual(s.adaptive?.status, 'ok', `never ok: ${JSON.stringify(s.adaptive)}`)
  assert.ok(!s.leads.some(l => l.company === B.company), 'nothing from the timed-out round is kept')
})

test('#381 gate: the adaptive round is OFF by default - a zero-verified scan behaves exactly as without the feature (no round, no calls, no row)', async () => {
  const s = await scan({ adaptiveOff: true })
  assert.equal(s.r, 'done')
  assert.equal(s.adaptive, undefined, `no search:adaptive row at all: ${JSON.stringify(s.runs)}`)
  assert.ok(!s.searched.some(q => /front desk/i.test(q)), `no adaptive search: ${JSON.stringify(s.searched)}`)
  assert.deepEqual(s.fetchBatches, [[A.url]], 'no adaptive fetch')
  assert.equal(s.extractions.length, 1, 'no adaptive extraction')
  assert.equal(s.jobRow.status, 'done')
})

test('#381 gate: only the literal "1" enables the round - "0", "true", "" and " 1" all stay off', async () => {
  for (const v of ['0', 'true', '', ' 1']) {
    const s = await scan({ adaptiveFlag: v })
    assert.equal(s.adaptive, undefined, `flag ${JSON.stringify(v)} must stay off: ${JSON.stringify(s.runs)}`)
    assert.ok(!s.searched.some(q => /front desk/i.test(q)), `flag ${JSON.stringify(v)}: no adaptive search`)
    assert.equal(s.extractions.length, 1, `flag ${JSON.stringify(v)}: no adaptive extraction`)
  }
})

test('#381 D2 feedback before fetch: a company in feedback memory returned by round two costs no verification fetch and is dropped before verify', async () => {
  const s = await scan({ rejectCompanyB: true })
  assert.equal(s.r, 'done')
  assert.ok(!s.pageReads.includes(B.url), `round two never re-read the rejected company's page: ${JSON.stringify(s.pageReads)}`)
  assert.ok(s.pageReads.includes(A.url), 'round one still verified its own candidate')
  assert.ok(!s.leads.some(l => l.company === B.company), 'the rejected company is never a lead')
  assert.equal(s.adaptive?.status, 'empty', `round two ran, found only a rejected company, and says so: ${JSON.stringify(s.adaptive)}`)
})

test('#381 D3 round equivalence: a lead of the same shape persists the same gate-derived fields whether it came through round one or round two', async () => {
  // #655: freeze the wall clock (Date only; real timers keep running) so both scans read the same second: retrieved_at
  // and every other time-derived column must not differ across a one-second boundary between the two runs.
  mock.timers.enable({ apis: ['Date'], now: Date.now() })
  try {
  const r1 = await scan({ aVerifies: true }) // A verified in round one
  const r2 = await scan() // A refused in round one, B verified in round two
  const cols = (r1.db.prepare("SELECT name FROM pragma_table_info('leads')").all() as { name: string }[]).map(c => c.name)
  const row1 = r1.db.prepare('SELECT * FROM leads WHERE scan_job_id = ?').get(r1.jobId) as Record<string, unknown>
  const row2 = r2.db.prepare('SELECT * FROM leads WHERE scan_job_id = ?').get(r2.jobId) as Record<string, unknown>
  assert.ok(row1 && row2, 'both scans persisted their lead')
  // identity and content-derived columns legitimately differ; every gate-derived column must match exactly
  const exempt = new Set(['id', 'scan_job_id', 'company', 'dedup_key', 'source_url', 'created_at', 'evidence_excerpt']) // only genuinely varying identity; timing, copy/origin and every gate column are compared
  const diffs: string[] = []
  for (const c of cols) {
    if (exempt.has(c)) continue
    if (String(row1[c] ?? null) !== String(row2[c] ?? null)) diffs.push(`${c}: round1=${JSON.stringify(row1[c] ?? null)} round2=${JSON.stringify(row2[c] ?? null)}`)
  }
  assert.ok(Math.abs(Number(row1.retrieved_at) - Number(row2.retrieved_at)) <= 5, 'retrieved_at semantics: both are a fresh read time')
  assert.equal(row1.evidence_excerpt, A.quote); assert.equal(row2.evidence_excerpt, B.quote) // each excerpt is its own page's quote
  assert.equal(row1.source_url, A.url); assert.equal(row2.source_url, B.url) // attribution to the page that was read
  assert.equal(r1.pageReads.includes(A.url) && r2.pageReads.includes(B.url), true, 'own fetch succeeded in both: no held-copy fallback (copy/origin columns null in both, compared above)')
  assert.deepEqual(diffs, [], `gate-derived columns differ between rounds:\n${diffs.join('\n')}`)
  // the evidence excerpt (what the verifier read) is present in both; a held-copy hash exists only on the
  // blocked-own-fetch fallback path, which neither lead took here - so presence of the excerpt, not the copy, is the invariant
  for (const [tag, row] of [['round1', row1], ['round2', row2]] as const) {
    assert.ok(typeof row.evidence_excerpt === 'string' && row.evidence_excerpt.length > 0, `${tag} lead carries its evidence excerpt`)
  }
  const src1 = r1.db.prepare("SELECT status, candidate_count, verified_count FROM scan_source_runs WHERE collector = 'search:tinyfish'").get() as { status: string; candidate_count: number; verified_count: number }
  const src2 = r2.db.prepare("SELECT status, candidate_count, verified_count FROM scan_source_runs WHERE collector = 'search:adaptive'").get() as { status: string; candidate_count: number; verified_count: number }
  assert.deepEqual(src2, src1, 'the round-two source row records the same shape of stats as round one')
  } finally { mock.timers.reset() }
})

test('#381 D3 provenance: round-two TinyFish text URLs reach the end-of-run verify_provenance summary', async () => {
  const lines: string[] = []
  const orig = console.error
  console.error = (...a: unknown[]) => { lines.push(a.map(String).join(' ')); }
  let s
  try { s = await scan() } finally { console.error = orig }
  assert.equal(s.r, 'done')
  const prov = lines.map(l => { try { return JSON.parse(l) as { verify_provenance?: { verifier_ok_tinyfish_had_text: number; candidates: number } } } catch { return null } }).find(x => x?.verify_provenance)?.verify_provenance
  assert.ok(prov, 'verify_provenance was emitted')
  assert.ok(prov.verifier_ok_tinyfish_had_text >= 1, `round two's page (B) counted as TinyFish-had-text: ${JSON.stringify(prov)}`)
})
