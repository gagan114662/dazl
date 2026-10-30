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
import { SpendGuard } from '../lib/llm/spend-guard.ts'
import { claimKeyedJob, runJob } from '../lib/scan/runner.ts'
import { describeRunBudget, normalizeScanBudget, MAX_BUDGET_USD } from '../lib/scan/run-budget.ts'

// Per-run cost control on the ordinary scan route (STATUS "Next" 1; #204 cost-control comment). Stubs only: no network, no
// key, no price. The disclosure rows are pinned to what the runner really does. A max_usd is a reservation limit computed
// from what dazl sends, never a vendor-guaranteed ceiling.
const master = randomBytes(32); process.env.DAZL_MASTER_KEY = master.toString('base64')
const recent = new Date(Date.now() - 20 * 86_400_000).toISOString().slice(0, 10)
const QUOTE = 'Harbor Freight Supply of Columbus Ohio is hiring a payroll specialist to manage biweekly payroll'
const REQUEST = 'Find Ohio companies with 10 to 100 employees that recently posted a payroll, HR or office manager job'
const ICP = { summary: 'Ohio SMBs hiring payroll', who: ['Controller'], industries: [], sizes: ['10-100 employees'], where: ['Ohio'], signals: ['payroll job'], exclude: [] }
const LEAD = { company: 'Harbor Freight Supply', name: 'Pat Lee', contact: null, signal: 'Hiring a payroll specialist', score: 80, excerpt: QUOTE, source_url: 'https://jobs.example/hf', event_date: recent }

test('normalizeScanBudget: strict, can only narrow, max_usd bounded; absent = no budget', () => {
  assert.deepEqual(normalizeScanBudget(undefined, false), { ok: true, value: null, budget: null })
  assert.deepEqual(normalizeScanBudget({ max_usd: 2, judge: false }, true), { ok: true, value: '{"max_usd":2,"judge":false}', budget: { max_usd: 2, judge: false } })
  for (const bad of [null, undefined, [], 'x', 3, {}, { max_usd: 0 }, { max_usd: -1 }, { max_usd: NaN }, { max_usd: MAX_BUDGET_USD + 1 }, { max_usd: '1' }, { judge: true }, { judge: 0 }, { x: false }])
    assert.equal(normalizeScanBudget(bad, true).ok, false, JSON.stringify(bad))
})

test('disclosure: no budget bounds nothing and says so; max_usd refuses research and enrichment; flags switch their own surface off', () => {
  const none = describeRunBudget(null)
  assert.equal(none.bounded, false); assert.match(none.ceiling, /not dollar-bounded/)
  assert.equal(none.surfaces.find(s => s.surface === 'fallback_research')!.status, 'allowed')
  const cap = describeRunBudget({ max_usd: 1 })
  assert.equal(cap.surfaces.find(s => s.surface === 'fallback_research')!.status, 'refused'); assert.equal(cap.surfaces.find(s => s.surface === 'credit_enrichment')!.status, 'off')
  assert.match(cap.surfaces.find(s => s.surface === 'fallback_research')!.note, /NOT the same search behaviour/)
  assert.equal(describeRunBudget({ paid_fallback: false }).surfaces.find(s => s.surface === 'fallback_research')!.status, 'refused')
  assert.equal(describeRunBudget({ judge: false }).surfaces.find(s => s.surface === 'judge')!.status, 'off')
  assert.equal(describeRunBudget({ credit_enrichment: false }).surfaces.find(s => s.surface === 'credit_enrichment')!.status, 'off')
  assert.equal(describeRunBudget({ judge: false }).surfaces.find(s => s.surface === 'judge')!.note, 'judge=false')
})

test('SpendGuard: starts from what was already reserved, reports every reservation, and a refusal reserves nothing', () => {
  const g = new SpendGuard(0.01, 0.0099); const seen: number[] = []; g.persist = v => { seen.push(v) }
  assert.throws(() => g.reserve('claude-sonnet-4-5', 100, 100), /spend_refused:over_limit/)
  assert.equal(seen.length, 0); assert.equal(g.reservedUsd, 0.0099)
  const f = new SpendGuard(5); f.persist = v => { seen.push(v) }; f.reserve('claude-sonnet-4-5', 100, 100); f.reserve('claude-sonnet-4-5', 100, 100)
  assert.equal(seen.length, 2); assert.ok(seen[1] > seen[0] && seen[0] > 0)
  assert.equal(new SpendGuard(1, -5).reservedUsd, 0); assert.equal(new SpendGuard(1, NaN).reservedUsd, 0)
})

type Counts = { research: number; judge: number; complete: number }
async function run(budget: string | null, opts: { reserved?: number; model?: string; tinyfish?: boolean; leads?: boolean; beforeRun?: (db: Database.Database, id: string) => void; onFirstComplete?: (db: Database.Database, id: string) => void } = {}) {
  resetTinyfishState()
  const db = new Database(':memory:'); migrateScan(db); migrateKeys(db); migratePlans(db); migrateConnectors(db); migrateEvents(db)
  saveKey(db, 'A', 'anthropic', 'sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', master)
  const id = createQueryJob(db, 'A', { query: REQUEST, icp: JSON.stringify(ICP), runBudget: budget })
  if (opts.reserved !== undefined) db.prepare('UPDATE scan_jobs SET spend_reserved_usd = ? WHERE id = ?').run(opts.reserved, id)
  const job = claimKeyedJob(db, id)!
  opts.beforeRun?.(db, id)
  const c: Counts = { research: 0, judge: 0, complete: 0 }
  const fetchImpl = (async (u: string) => {
    if (u.startsWith('https://api.search.tinyfish.ai')) return new Response(JSON.stringify({ results: opts.tinyfish ? [{ url: 'https://jobs.example/hf', title: 'Payroll specialist', snippet: QUOTE, date: recent }] : [] }), { status: 200 })
    if (u.startsWith('https://api.fetch.tinyfish.ai')) return new Response(JSON.stringify({ results: [{ url: 'https://jobs.example/hf', title: 'Payroll specialist', text: `Posted ${recent}. ${QUOTE}. Apply now.` }] }), { status: 200 })
    if (u === 'https://api.anthropic.com/v1/messages/count_tokens') return new Response(JSON.stringify({ input_tokens: 1000 }), { status: 200 })
    return new Response('{}', { status: 404 })
  }) as unknown as typeof fetch
  const anth: Provider = {
    research: async () => { c.research++; return { text: opts.leads ? JSON.stringify([LEAD]) : '[]', citedUrls: opts.leads ? [LEAD.source_url] : [] } },
    complete: async (_k, p, _f, maxTokens) => { c.complete++; if (c.complete === 1) opts.onFirstComplete?.(db, id); if (p.startsWith('You check one claim')) { c.judge++; return 'supports' } return maxTokens === 300 ? '["payroll specialist Ohio"]' : JSON.stringify([LEAD]) },
    ...(opts.model ? { configuredModel: () => opts.model! } : {}),
  }
  const providers: Record<'anthropic' | 'openai', Provider> = { anthropic: anth, openai: { research: async () => ({ text: '', citedUrls: [] }) } }
  const page = async () => ({ text: `Posted ${recent}. ${QUOTE}. Apply now.`, title: 'Jobs', retrievedAt: 1 })
  const realFetch = globalThis.fetch; globalThis.fetch = fetchImpl; if (opts.tinyfish) process.env.TINYFISH_API_KEY = 'tf-test'
  try {
    const r = await runJob(db, job, { providers, master, fetchPage: page, fetchImpl, score: false, ground: false })
    return { r, c, db, id, row: db.prepare('SELECT status, error, attempts, spend_reserved_usd FROM scan_jobs WHERE id = ?').get(id) as { status: string; error: string | null; attempts: number; spend_reserved_usd: number | null } }
  } finally { globalThis.fetch = realFetch; delete process.env.TINYFISH_API_KEY }
}

test('paid_fallback=false on a QUERY job (previously ignored): research is not called and the run ends budget_stopped; control without the flag calls it', async () => {
  const off = await run('{"paid_fallback":false}')
  assert.equal(off.c.research, 0); assert.equal(off.row.error, 'budget_stopped'); assert.equal(off.row.status, 'failed')
  const control = await run(null)
  assert.equal(control.c.research, 1); assert.notEqual(control.row.error, 'budget_stopped')
})

test('judge=false on a QUERY job (previously ignored) switches the judge off; the control judges', async () => {
  const off = await run('{"judge":false}', { leads: true })
  assert.equal(off.c.judge, 0)
  const control = await run(null, { leads: true })
  assert.ok(control.c.judge >= 1, 'fixture precondition: without the flag the judge runs')
})

test('max_usd refuses research (disclosed as refused) and a budget stop is distinct from zero leads', async () => {
  const x = await run('{"max_usd":5}', { model: 'claude-sonnet-4-5' })
  assert.equal(x.c.research, 0); assert.equal(x.row.error, 'budget_stopped')
  const nothing = await run(null) // no budget, research returns nothing: "nothing found", not a budget stop
  assert.equal(nothing.row.error, 'no_candidates')
})

test('the job reservation is saved after every reserved call and a re-run continues from it, so it cannot spend the limit again', async () => {
  const first = await run('{"max_usd":5}', { model: 'claude-sonnet-4-5', tinyfish: true })
  assert.ok(first.c.complete >= 2, 'fixture precondition: query writing and extraction were reserved and ran')
  assert.ok(first.row.spend_reserved_usd! > 0, 'reservation saved on the job row')
  // The same job after a restart/re-claim: the row says the limit is already used, so the first paid call is refused.
  const used = await run('{"max_usd":5}', { model: 'claude-sonnet-4-5', tinyfish: true, reserved: 4.9999999 })
  assert.equal(used.c.complete + used.c.research, 0, 'zero provider calls: the saved reservation counts')
  assert.equal(used.row.error, 'budget_stopped')
  // and a stale attempt cannot overwrite the reservation of the attempt that owns the job
  const { db, id } = first
  const before = (db.prepare('SELECT spend_reserved_usd v FROM scan_jobs WHERE id = ?').get(id) as { v: number }).v
  assert.equal(db.prepare('UPDATE scan_jobs SET spend_reserved_usd = 0 WHERE id = ? AND user_id = ? AND attempts = ?').run(id, 'A', 99).changes, 0)
  assert.equal((db.prepare('SELECT spend_reserved_usd v FROM scan_jobs WHERE id = ?').get(id) as { v: number }).v, before)
})

// Instinct #216 review (0a0876d): saving the reservation failed open - the paid call still ran. Now the reservation must be
// SAVED, by the current attempt of a running job, before the provider call is allowed.
test('reservation cannot be saved (storage error): ZERO provider calls, budget_stopped, the saved reservation is unchanged', async () => {
  const x = await run('{"max_usd":5}', { model: 'claude-sonnet-4-5', tinyfish: true, reserved: 1.25, beforeRun: db => db.exec("CREATE TRIGGER fail_save BEFORE UPDATE OF spend_reserved_usd ON scan_jobs BEGIN SELECT RAISE(ABORT, 'SQLITE_FULL'); END") })
  assert.equal(x.c.complete + x.c.research, 0, 'no paid provider call without a saved reservation')
  assert.equal(x.row.error, 'budget_stopped'); assert.equal(x.row.status, 'failed'); assert.equal(x.row.spend_reserved_usd, 1.25)
})

test('ownership lost BEFORE the first reservation (job re-claimed by a newer attempt): zero provider calls and the new owner\'s reservation is untouched', async () => {
  const x = await run('{"max_usd":5}', { model: 'claude-sonnet-4-5', tinyfish: true, reserved: 0.5, beforeRun: (db, id) => { db.prepare('UPDATE scan_jobs SET attempts = attempts + 1 WHERE id = ?').run(id) } })
  assert.equal(x.c.complete + x.c.research, 0)
  assert.equal(x.row.spend_reserved_usd, 0.5, 'the current owner\'s saved reservation is unchanged')
  assert.equal(x.row.status, 'running', 'the stale attempt does not finish, fail or re-queue the newer attempt\'s job'); assert.equal(x.row.attempts, 2)
})

test('ownership lost BETWEEN calls (reaped and re-claimed while the first call ran): exactly one provider call happened, no further call, owner\'s reservation unchanged', async () => {
  let afterFirst: number | null = null
  const x = await run('{"max_usd":5}', { model: 'claude-sonnet-4-5', tinyfish: true, onFirstComplete: (db, id) => {
    afterFirst = (db.prepare('SELECT spend_reserved_usd v FROM scan_jobs WHERE id = ?').get(id) as { v: number }).v
    db.prepare("UPDATE scan_jobs SET attempts = attempts + 1, spend_reserved_usd = ? WHERE id = ?").run(afterFirst + 1, id) // the newer attempt owns the job now and has its own total
  } })
  assert.equal(x.c.complete, 1, 'the first call was reserved and saved by the then-current owner; the next one is refused')
  assert.ok(afterFirst! > 0)
  assert.equal(x.row.spend_reserved_usd, afterFirst! + 1, 'the stale attempt did not overwrite the current owner\'s reservation')
  assert.equal(x.row.attempts, 2); assert.equal(x.row.status, 'running')
})

test('a job that is no longer running cannot reserve either (finished/cancelled elsewhere)', async () => {
  const x = await run('{"max_usd":5}', { model: 'claude-sonnet-4-5', tinyfish: true, beforeRun: (db, id) => { db.prepare("UPDATE scan_jobs SET status = 'failed' WHERE id = ?").run(id) } })
  assert.equal(x.c.complete + x.c.research, 0)
})

test('SpendGuard.reserve: a failed save refuses with reservation_not_saved and leaves the in-memory total unchanged', () => {
  const g = new SpendGuard(5, 1); g.persist = () => { throw new Error('SQLITE_FULL') }
  assert.throws(() => g.reserve('claude-sonnet-4-5', 100, 100), /spend_refused:reservation_not_saved/)
  assert.equal(g.reservedUsd, 1); assert.equal(g.calls, 0)
})
