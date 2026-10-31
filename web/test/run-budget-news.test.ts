import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { migrateKeys, saveKey } from '../lib/llm/key-store.ts'
import { migrateScan, createQueryJob } from '../lib/scan/store.ts'
import { migratePlans } from '../lib/plans.ts'
import { migrateConnectors } from '../lib/connectors/store.ts'
import { migrateEvents } from '../lib/events/store.ts'
import type { Provider } from '../lib/llm/provider.ts'
import { resetTinyfishState } from '../lib/search/tinyfish.ts'
import { guardProvider, SpendGuard } from '../lib/llm/spend-guard.ts'
import { claimKeyedJob, runJob } from '../lib/scan/runner.ts'
import { describeRunBudget, normalizeScanBudget } from '../lib/scan/run-budget.ts'

// The per-run news switch (budget.news=false) and the cap premises it rests on. Stubs only: no network, no key.
const master = randomBytes(32); process.env.DAZL_MASTER_KEY = master.toString('base64')
const recent = new Date(Date.now() - 20 * 86_400_000).toISOString().slice(0, 10)
const QUOTE = 'Harbor Freight Supply of Columbus Ohio is hiring a payroll specialist to manage biweekly payroll'
const REQUEST = 'Find Ohio companies with 10 to 100 employees that recently posted a payroll, HR or office manager job'
const ICP = { summary: 'Ohio SMBs hiring payroll', who: ['Controller'], industries: [], sizes: ['10-100 employees'], where: ['Ohio'], signals: ['payroll job'], exclude: [] }

test('normalizeScanBudget: news is a narrowing-only flag and the empty-budget error names it', () => {
  assert.deepEqual(normalizeScanBudget({ news: false }, true), { ok: true, value: '{"news":false}', budget: { news: false } })
  const both = normalizeScanBudget({ max_usd: 2, news: false }, true); assert.ok(both.ok); if (both.ok) assert.deepEqual(both.budget, { max_usd: 2, news: false })
  for (const bad of [{ news: true }, { news: 0 }, { news: 'off' }]) assert.equal(normalizeScanBudget(bad, true).ok, false, JSON.stringify(bad))
  const empty = normalizeScanBudget({}, true); assert.ok(!empty.ok); if (!empty.ok) assert.match(empty.error, /\bnews\b/)
})

test('disclosure: news=false shows its own surface off, labelled as off - never a zero; default stays free and not dollar-bounded', () => {
  const on = describeRunBudget(null).surfaces.find(s => s.surface === 'news_search')!
  assert.equal(on.status, 'not_covered'); assert.match(on.note, /Free \(GDELT\)/)
  const off = describeRunBudget({ news: false }).surfaces.find(s => s.surface === 'news_search')!
  assert.equal(off.status, 'off'); assert.match(off.note, /labelled as off/); assert.match(off.note, /not a zero result/)
})

test('guardProvider: the reservation is floored at prompt BYTES - a low count-endpoint estimate cannot under-reserve', async () => {
  const prompt = 'x'.repeat(5000)
  const p: Provider = { research: async () => ({ text: '', citedUrls: [] }), complete: async () => 'ok', configuredModel: () => 'claude-sonnet-4-5' }
  // count-based reservation would be (12 + 1000) * 3e-6 + 1 * 15e-6 = 0.003051; bytes-based is (5000 + 1000) * 3e-6 + 15e-6 = 0.018015.
  // A limit between them must refuse only if bytes win.
  const count = async () => 10
  await assert.rejects(() => guardProvider(p, new SpendGuard(0.005), count).complete!('k', prompt, undefined, 1), /spend_refused:over_limit/)
  // No counter at all: bytes alone, same refusal.
  await assert.rejects(() => guardProvider(p, new SpendGuard(0.005)).complete!('k', prompt, undefined, 1), /spend_refused:over_limit/)
  // A limit above the bytes-based cost lets the same call through (the floor is a floor, not a block).
  assert.equal(await guardProvider(p, new SpendGuard(0.5), count).complete!('k', prompt, undefined, 1), 'ok')
})

test('cap premise: no guarded request enables prompt caching (no cache_control anywhere in lib/)', () => {
  const walk = (d: string): string[] => readdirSync(d).flatMap(n => { const f = join(d, n); const s = statSync(f); return s.isDirectory() ? walk(f) : f.endsWith('.ts') ? [f] : [] })
  const offenders = walk(join(import.meta.dirname, '..', 'lib')).filter(f => readFileSync(f, 'utf8').includes('cache_control'))
  assert.deepEqual(offenders, [])
})

async function run(budget: string | null) {
  resetTinyfishState()
  const db = new Database(':memory:'); migrateScan(db); migrateKeys(db); migratePlans(db); migrateConnectors(db); migrateEvents(db)
  saveKey(db, 'A', 'anthropic', 'sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', master)
  const id = createQueryJob(db, 'A', { query: REQUEST, icp: JSON.stringify(ICP), runBudget: budget })
  const job = claimKeyedJob(db, id)!
  let newsCalls = 0
  const newsHttp = (async () => { newsCalls++; throw new Error('news endpoint unreachable in test') }) as import('../lib/sources/types.ts').SafeGet
  const anth: Provider = {
    research: async () => ({ text: '[]', citedUrls: [] }),
    complete: async (_k, _p, _f, maxTokens) => maxTokens === 300 ? '["payroll specialist Ohio"]' : '[]',
  }
  const r = await runJob(db, job, { providers: { anthropic: anth, openai: { research: async () => ({ text: '', citedUrls: [] }) } }, master, fetchPage: async () => ({ text: '', title: '', retrievedAt: 1 }), newsHttp, score: false, ground: false })
  const sources = db.prepare('SELECT collector, status FROM scan_source_runs WHERE job_id = ?').all(id) as { collector: string; status: string }[]
  return { r, newsCalls, sources }
}

test('news=false: the news search is never contacted and its source row says skipped by the run, not empty or unavailable', async () => {
  const off = await run('{"news": false}')
  assert.equal(off.newsCalls, 0)
  const row = off.sources.find(s => s.collector === 'search:news')!
  assert.ok(row, 'a search:news ledger row exists')
  assert.match(row.status, /^skipped: the run disabled the news search/)
  // Control: without the flag the same run DOES contact the news endpoint (the flag, not the mock, suppresses it).
  const on = await run(null)
  assert.ok(on.newsCalls > 0, 'control run contacts news')
})
