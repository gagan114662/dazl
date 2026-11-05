// The hard per-scan spend cap through the real scan runner (lib/scan/runner.ts runJob -> lib/scan/spend-cap.ts), with the
// REAL Anthropic provider and TinyFish client over a stubbed fetch: every paid request is preceded by its durable
// reservation, and a scan whose cap is reached makes no further paid request and stops (budget_stopped), with the
// refusal recorded. Isolated in-memory DB, synthetic data, no network, no paid call.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import Database from 'better-sqlite3'
import { migrateKeys, saveKey } from '../lib/llm/key-store.ts'
import { migrateScan, createQueryJob } from '../lib/scan/store.ts'
import { migratePlans } from '../lib/plans.ts'
import { migrateConnectors } from '../lib/connectors/store.ts'
import { migrateEvents } from '../lib/events/store.ts'
import { resetTinyfishState } from '../lib/search/tinyfish.ts'
import { claimKeyedJob, runJob } from '../lib/scan/runner.ts'
import { poolRows } from '../lib/llm/spend-pool.ts'
import { scanSpendCalls, scanSpendRow, HARD_CAP_USD } from '../lib/scan/spend-cap.ts'

const master = randomBytes(32)
process.env.DAZL_MASTER_KEY = master.toString('base64')
const KEY = 'sk-ant-test-AAAA'
const recent = new Date(Date.now() - 20 * 86_400_000).toISOString().slice(0, 10)
const QUOTE = 'Harbor Freight Supply of Columbus Ohio is hiring a payroll specialist to manage biweekly payroll'
const ICP = { summary: 'Ohio SMBs hiring payroll', who: ['Controller'], industries: [], sizes: ['10-100 employees'], where: ['Ohio'], signals: ['payroll job'], exclude: [] }
const PAID = ['https://api.anthropic.com/v1/messages', 'https://api.search.tinyfish.ai', 'https://api.fetch.tinyfish.ai']
const isPaid = (u: string) => PAID.some(p => u === p || u.startsWith(`${p}?`) || (p !== PAID[0] && u.startsWith(p)))

async function run(env: Record<string, string | undefined>, usage: boolean | Record<string, unknown>, x: { served?: string; setup?: (db: Database.Database) => void } = {}) {
  resetTinyfishState()
  const db = new Database(':memory:')
  migrateScan(db); migrateKeys(db); migratePlans(db); migrateConnectors(db); migrateEvents(db); saveKey(db, 'A', 'anthropic', KEY, master)
  createQueryJob(db, 'A', { query: 'Find Ohio companies with 10 to 100 employees that recently posted a payroll job', icp: JSON.stringify(ICP) })
  const job = claimKeyedJob(db)!
  x.setup?.(db)
  const lead = { company: 'Harbor Freight Supply', name: 'Pat Lee', signal: 'Hiring a payroll specialist', excerpt: QUOTE, source_url: 'https://jobs.example/hf', event_date: recent }
  const paid: { url: string; liveReservations: number; nonRefused: number }[] = []
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const u = String(input)
    if (isPaid(u)) {
      const q = (s: string) => (db.prepare(`SELECT count(*) AS n FROM scan_spend_calls WHERE scan_job_id = ? AND ${s}`).get(job.id) as { n: number }).n
      paid.push({ url: u, liveReservations: q("status = 'reserved'"), nonRefused: q("status <> 'refused'") })
    }
    if (u.startsWith('https://api.search.tinyfish.ai')) return new Response(JSON.stringify({ results: [{ url: 'https://jobs.example/hf', title: 'Payroll specialist', snippet: QUOTE, date: recent }] }), { status: 200 })
    if (u.startsWith('https://api.fetch.tinyfish.ai')) return new Response(JSON.stringify({ results: [{ url: 'https://jobs.example/hf', title: 'Payroll specialist', text: `Posted ${recent}. ${QUOTE}. Apply now.` }] }), { status: 200 })
    if (u === 'https://api.anthropic.com/v1/messages/count_tokens') return new Response(JSON.stringify({ input_tokens: 400 }), { status: 200 }) // free token counter used by guarded runs
    if (u === 'https://api.anthropic.com/v1/messages') {
      const b = JSON.parse(String(init?.body ?? '{}')) as { max_tokens: number }
      const text = b.max_tokens === 300 ? JSON.stringify(['small company hiring payroll specialist Ohio']) : JSON.stringify([lead])
      return new Response(JSON.stringify({ id: 'msg', model: x.served ?? 'claude-sonnet-4-5-20250929', content: [{ type: 'text', text }], ...(usage ? { usage: typeof usage === 'object' ? usage : { input_tokens: 400, output_tokens: 60 } } : {}) }), { status: 200 })
    }
    return new Response('{}', { status: 404 })
  }) as unknown as typeof fetch
  const page = async () => ({ text: `Posted ${recent}. ${QUOTE}. Apply now.`, title: 'Payroll specialist', retrievedAt: 1_700_000_000 })
  const realFetch = globalThis.fetch
  const saved: Record<string, string | undefined> = {}
  const all = { TINYFISH_API_KEY: 'test-tinyfish-key', DAZL_ANTHROPIC_MODEL: undefined, ...env }
  for (const [k, v] of Object.entries(all)) { saved[k] = process.env[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v }
  globalThis.fetch = fetchImpl
  try {
    const r = await runJob(db, job, { master, fetchPage: page, fetchImpl, score: false, judge: null })
    const row = db.prepare('SELECT status, error FROM scan_jobs WHERE id = ?').get(job.id) as { status: string; error: string | null }
    return { db, r, row, paid, calls: await scanSpendCalls(db, job.id, 'A'), ledger: (await scanSpendRow(db, job.id, 'A'))!,
      inOrder: db.prepare('SELECT kind, status, reason, reserve_usd FROM scan_spend_calls WHERE scan_job_id = ? ORDER BY rowid').all(job.id) as { kind: string; status: string; reason: string | null; reserve_usd: number }[] }
  } finally {
    globalThis.fetch = realFetch
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
  }
}

test('runner: every paid request of an ordinary scan is preceded by its durable reservation, and the ledger stays under the cap', async () => {
  const x = await run({}, true)
  const models = x.paid.filter(p => p.url === 'https://api.anthropic.com/v1/messages')
  assert.ok(models.length >= 2, `the scan made model calls (${models.length})`)
  assert.ok(x.paid.some(p => p.url.startsWith('https://api.search.tinyfish.ai')), 'and a TinyFish search')
  x.paid.forEach((p, i) => {
    assert.ok(p.liveReservations >= 1, `paid request ${i} (${p.url}) had its reservation in the store when it was sent`)
    assert.ok(p.nonRefused >= i + 1, `paid request ${i}: one reservation per request so far`)
  })
  assert.equal(x.calls.filter(c => c.status !== 'refused').length, x.paid.length, 'exactly one reservation per paid request')
  assert.ok(x.calls.every(c => c.status === 'settled'), 'each settled to the vendor-reported cost')
  assert.equal(x.ledger.spend_cap_refusals, 0)
  assert.ok(x.ledger.spend_cap_reserved_usd <= HARD_CAP_USD)
  assert.ok(Math.abs(x.ledger.spend_cap_usd! - HARD_CAP_USD) < 1e-9, 'an ordinary scan runs under CAD 5 / 1.50')
  assert.equal(x.row.status, 'done', 'an ordinary scan is not broken by the cap')
})

test('runner: a scan at its cap makes no further paid request, stops budget_stopped, and records the refusal', async () => {
  // Measure the first two model reservations of this fixture, then cap the scan between one and two of them.
  const probe = await run({}, false)
  const llm = probe.inOrder.filter(c => c.kind === 'llm.anthropic')
  assert.ok(llm.length >= 2)
  const capUsd = llm[0].reserve_usd + llm[1].reserve_usd / 2
  const x = await run({ DAZL_SCAN_CAP_CAD: (capUsd * 1.5).toFixed(9) }, false)
  assert.equal(x.paid.filter(p => p.url === 'https://api.anthropic.com/v1/messages').length, 1, 'only the call that fit was sent')
  const refused = x.calls.filter(c => c.status === 'refused')
  assert.deepEqual(refused.map(c => [c.kind, c.reason]), [['llm.anthropic', 'over_cap']])
  assert.ok(x.ledger.spend_cap_reserved_usd <= capUsd + 1e-9, 'the cap held')
  assert.equal(x.ledger.spend_cap_refusals, 1)
  assert.deepEqual([x.r, x.row.status, x.row.error], ['failed', 'failed', 'budget_stopped'])
  // nothing paid after the refusal: it is the last ledger row, and every request had its own reservation
  assert.equal(x.inOrder.at(-1)!.status, 'refused')
  assert.equal(x.paid.length, x.calls.filter(c => c.status !== 'refused').length)
})

test('runner: a malformed cap setting refuses the first paid call; the scan stops without spending', async () => {
  const x = await run({ DAZL_SCAN_CAP_CAD: '5 CAD' }, true)
  assert.deepEqual(x.paid, [], 'no paid request at all')
  assert.ok(x.calls.length >= 1 && x.calls.every(c => c.status === 'refused' && c.reason === 'cap_config_invalid'))
  assert.deepEqual([x.row.status, x.row.error], ['failed', 'budget_stopped'])
})

// #363 runner settle: a scan under an owner pool (or a run budget) used to keep every model call's WORST-CASE reservation even
// though the vendor reported what the call really used. Now the pool and the job's reservation move to the reported cost.
test('runner under an owner pool: model calls settle to the vendor-reported usage, not their worst case', async () => {
  const x = await run({ DAZL_RUN_MAX_USD_USERS: 'A:5', DAZL_OWNER_MONTH_MAX_USD_USERS: 'A:20' }, true)
  const models = x.paid.filter(p => p.url === 'https://api.anthropic.com/v1/messages').length
  assert.ok(models >= 2, JSON.stringify({ r: x.r, row: x.row, paid: x.paid.map(p => p.url), calls: x.inOrder }))
  const perCall = (400 * 3 + 60 * 15) / 1e6 // reported usage 400 in / 60 out at 3 / 15 USD per M
  const pool = (await poolRows(x.db, 'A')).filter(r => r.period.startsWith('m:'))
  assert.equal(pool.length, 1)
  assert.ok(Math.abs(pool[0].reserved_usd - models * perCall) < 1e-6, `reserved ${pool[0].reserved_usd} = reported ${models * perCall}`)
  assert.ok(Math.abs(pool[0].reported_usd - models * perCall) < 1e-6, 'the reported total is recorded')
})

const OWNER = { DAZL_RUN_MAX_USD_USERS: 'A:5', DAZL_OWNER_MONTH_MAX_USD_USERS: 'A:20' }
const modelCalls = (x: Awaited<ReturnType<typeof run>>) => x.paid.filter(p => p.url === 'https://api.anthropic.com/v1/messages').length
const rowOf = async (x: Awaited<ReturnType<typeof run>>, k: 'm:' | 'd:') => (await poolRows(x.db, 'A')).find(r => r.period.startsWith(k))!
const monthRow = (x: Awaited<ReturnType<typeof run>>) => rowOf(x, 'm:')

// Failure classes of the settle (review of 97988fd5). Stubbed vendor, no network, no paid call.
test('runner settle: a SERVED model with no price counts the rest of the window as spent and the scan stops visibly', async () => {
  const x = await run(OWNER, true, { served: 'claude-unlisted-9' })
  assert.equal(modelCalls(x), 1, 'no model call after the unpriced one')
  assert.equal(x.row.error, 'budget_stopped', 'visible stop, not a silent empty result')
  assert.equal((await rowOf(x, 'd:')).reserved_usd, 5, 'the shortest window (the day, limit 5) counts as fully spent')
  assert.equal((await monthRow(x)).reserved_usd, 0.00894, 'the longer window keeps only the call worst case')
})
test('runner settle: a response with NO usage keeps the worst-case reservation and later calls are refused (budget_stopped)', async () => {
  const x = await run(OWNER, false)
  assert.equal(modelCalls(x), 1)
  assert.equal(x.row.error, 'budget_stopped')
  const m = await monthRow(x)
  assert.ok(m.reserved_usd > 0.005, `worst case stays reserved (${m.reserved_usd})`)
  assert.equal(m.reported_usd, 0, 'nothing is claimed as reported')
})
test('runner settle: invalid usage is unknown cost, not zero', async () => {
  const x = await run(OWNER, { input_tokens: -5, output_tokens: 60 })
  assert.equal(modelCalls(x), 1)
  assert.equal(x.row.error, 'budget_stopped')
  assert.equal((await rowOf(x, 'd:')).reserved_usd, 5, 'unknown cost: the shortest window counts as spent')
})
test('runner settle: a settle that cannot be saved withholds the result, makes no further paid request, and the job does not finish as done', async () => {
  const x = await run(OWNER, true, { setup: db => db.exec("CREATE TRIGGER fail_settle BEFORE UPDATE ON tenant_spend_pools WHEN NEW.reported_usd <> OLD.reported_usd BEGIN SELECT RAISE(ABORT, 'simulated store failure'); END") })
  assert.equal(modelCalls(x), 1, 'exactly one vendor request')
  assert.equal(x.row.status, 'failed'); assert.equal(x.row.error, 'budget_stopped', 'truthful stop, never done/empty')
  assert.ok((await monthRow(x)).reserved_usd > 0.005, 'the worst-case reservation stays counted')
})

// Pricing coverage (review of 97988fd5): the default Anthropic model is priced; anything else the runner could be
// configured with is NOT assumed priced - it is refused at reservation (visible stop), never settled as free.
test('pricing table: configured defaults and overrides', async () => {
  const { anthropicProvider, openaiProvider } = await import('../lib/llm/provider.ts')
  const { priceOf, callCostUsd, SpendRefused } = await import('../lib/llm/spend-guard.ts')
  const saved = { a: process.env.DAZL_ANTHROPIC_MODEL, o: process.env.DAZL_OPENAI_MODEL }
  try {
    delete process.env.DAZL_ANTHROPIC_MODEL; delete process.env.DAZL_OPENAI_MODEL
    assert.ok(priceOf(anthropicProvider.configuredModel!()), 'the default Anthropic model is priced')
    assert.equal(priceOf(openaiProvider.configuredModel!()), null, 'the default OpenAI model has no price in the table')
    assert.throws(() => callCostUsd(openaiProvider.configuredModel!(), 1000, 100), (e: unknown) => e instanceof SpendRefused && e.reason === 'model_unpriced')
    process.env.DAZL_ANTHROPIC_MODEL = 'some-arbitrary-override'
    assert.equal(priceOf(anthropicProvider.configuredModel!()), null, 'an arbitrary env override is not treated as priced')
    assert.throws(() => callCostUsd(anthropicProvider.configuredModel!(), 1000, 100), (e: unknown) => e instanceof SpendRefused && e.reason === 'model_unpriced')
  } finally {
    if (saved.a === undefined) delete process.env.DAZL_ANTHROPIC_MODEL; else process.env.DAZL_ANTHROPIC_MODEL = saved.a
    if (saved.o === undefined) delete process.env.DAZL_OPENAI_MODEL; else process.env.DAZL_OPENAI_MODEL = saved.o
  }
})
