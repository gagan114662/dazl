import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import test from 'node:test'
import Database from 'better-sqlite3'
import { CLAUDE_SEARCH_MODEL, claudeSearchEstimate } from '../lib/llm/claude-web-search.ts'
import { saveKey } from '../lib/llm/key-store.ts'
import { migrateAllSqlite } from '../lib/db/sqlite-migrations.ts'
import { NATIVE_SEARCH_FIRST5_CLAUDE_ONLY_MODE, PINNED_FIRST5_CLAUDE_ONLY_MODE, qaClaudeOnlyBudget } from '../lib/scan/qa-provider-policy.ts'
import { runJob } from '../lib/scan/runner.ts'
import { createQueryJob, pinAdmittedStrictJob } from '../lib/scan/store.ts'

const master = randomBytes(32)
const count = 1500
const q = 'Find commercial roofers in London, UK'
const url = 'https://public.example/official-company-page'
const api = 'https://api.anthropic.com/v1/messages'
const v3 = NATIVE_SEARCH_FIRST5_CLAUDE_ONLY_MODE
const v2 = PINNED_FIRST5_CLAUDE_ONLY_MODE

async function simulate({ mode = v3, trial = false, first5 = true, cap = '5', overage = false, interrupted = false }: { mode?: string; trial?: boolean; first5?: boolean; cap?: string; overage?: boolean; interrupted?: boolean } = {}) {
  const db = new Database(':memory:')
  const env = {
    DAZL_MASTER_KEY: master.toString('base64'),
    DAZL_SCAN_CAP_CAD: cap,
    DAZL_SCAN_CAP_FX_CAD_PER_USD: '1.50',
    NEWS_SEARCH_ENABLED: '0',
    LEAD_ENGINE: '',
    DAZL_TRIAL_ANTHROPIC_KEY: 'sk-ant-trial-fixture',
    DAZL_TRIAL_SCAN_RESERVE_USD: '0.30',
    DAZL_TRIAL_ACCOUNT_TOTAL_USD: '1',
    DAZL_TRIAL_GLOBAL_DAILY_USD: '10',
    TINYFISH_API_KEY: '',
  }
  const old = Object.fromEntries(Object.keys(env).map(k => [k, process.env[k]]))
  Object.assign(process.env, env)
  const previousFetch = globalThis.fetch
  const sequence: string[] = []
  const messages: { url: string; body: Record<string, unknown>; key: string | null }[] = []
  const denied: string[] = []
  try {
    migrateAllSqlite(db)
    saveKey(db, 'workspace', 'anthropic', 'sk-ant-workspace-fixture', master)
    const raw = qaClaudeOnlyBudget(JSON.stringify({ first5, paid_fallback: false, credit_enrichment: false }), mode)
    const job = db.transaction(() => {
      createQueryJob(db, 'workspace', { id: 'job', query: q, runBudget: raw, icp: JSON.stringify({ summary: q, who: [], industries: ['Roofing'], sizes: [], where: ['London, UK'], signals: [], exclude: [] }) })
      if (trial) db.exec("UPDATE scan_jobs SET funded_by='trial' WHERE id='job'")
      return pinAdmittedStrictJob(db, 'workspace', 'job', raw)
    }).immediate()
    const io: typeof fetch = async (input, init) => {
      const target = String(input)
      if (target !== api && target !== api + '/count_tokens') { denied.push(target); throw Error('offline fixture refused network') }
      const body = JSON.parse(String(init?.body ?? '{}'))
      messages.push({ url: target, body, key: new Headers(init?.headers).get('x-api-key') })
      const native = Array.isArray(body.tools) || String(body.messages?.[0]?.content ?? '').startsWith('Find public company or publisher pages')
      if (target.endsWith('/count_tokens')) assert.equal('tools' in body, false, 'Anthropic count_tokens rejects server tools')
      sequence.push(native ? target.endsWith('/count_tokens') ? 'native-count' : 'native-send' : 'model')
      if (target.endsWith('/count_tokens')) return Response.json({ input_tokens: count })
      if (!native) return Response.json({ model: CLAUDE_SEARCH_MODEL, content: [{ type: 'text', text: '[]' }], usage: { input_tokens: 100, output_tokens: 15 } })
      const held = db.prepare("SELECT reserve_usd FROM scan_spend_calls WHERE scan_job_id='job' AND status='reserved'").all()
      assert.deepEqual(held, [{ reserve_usd: claudeSearchEstimate(count).estimatedUsd }], 'durable search reserve exists at time of send')
      if (interrupted) throw Error('offline fixture response dropped')
      return Response.json({
        model: CLAUDE_SEARCH_MODEL, stop_reason: 'end_turn',
        content: [{ type: 'web_search_tool_result', content: [{ type: 'web_search_result', url }] }],
        usage: { input_tokens: overage ? 100_000 : 8_000, output_tokens: 200, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, server_tool_use: { web_search_requests: 1, web_fetch_requests: 0 } },
      })
    }
    globalThis.fetch = io
    const status = await runJob(db, job, {
      master, fetchImpl: io, score: false, ground: false, judge: null,
      fetchPage: async page => { sequence.push('publisher-page'); assert.equal(page, url); return { title: 'Publisher page', retrievedAt: 1_700_000_000, text: 'Published evidence about a commercial roofing company. '.repeat(8) } },
    })
    const end = db.prepare('SELECT status, error FROM scan_jobs WHERE id=?').get(job.id)
    const ledger = db.prepare('SELECT status, reason, reserve_usd, actual_usd FROM scan_spend_calls WHERE scan_job_id=? ORDER BY rowid').all(job.id)
    const pool = db.prepare('SELECT period,reserved_usd,reported_usd FROM tenant_spend_pools WHERE tenant_id=? ORDER BY period').all('workspace')
    let second
    if (interrupted) {
      const id = 'next-play'
      const next = db.transaction(() => {
        createQueryJob(db, 'workspace', { id, query: q, runBudget: raw, icp: JSON.stringify({ summary: q, who: [], industries: ['Roofing'], sizes: [], where: ['London, UK'], signals: [], exclude: [] }) })
        return pinAdmittedStrictJob(db, 'workspace', id, raw)
      }).immediate()
      await runJob(db, next, { master, fetchImpl: io, score: false, ground: false, judge: null })
      second = db.prepare('SELECT status, error FROM scan_jobs WHERE id=?').get(id)
    }
    return { status, sequence, messages, denied, end, ledger, pool, second }
  } finally {
    globalThis.fetch = previousFetch
    for (const [k, v] of Object.entries(old)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
    db.close()
  }
}

test('pinned V3 uses one counted, budgeted native request with workspace key and validates publisher evidence afterward', async () => {
  const x = await simulate()
  const native = x.messages.filter(m => Array.isArray(m.body.tools) || (m.url.endsWith('/count_tokens') && JSON.stringify(m.body).includes('Find public company or publisher pages')))
  assert.equal(native.length, 2, JSON.stringify(x))
  assert.deepEqual(native.map(m => m.url), [api + '/count_tokens', api])
  assert.deepEqual(native.map(m => m.key), ['sk-ant-workspace-fixture', 'sk-ant-workspace-fixture'])
  assert.equal('tools' in native[0].body, false)
  assert.deepEqual(native[1].body, { ...native[0].body, max_tokens: 3000, tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 2 }] })
  assert.deepEqual(x.sequence.slice(0, 3), ['native-count', 'native-send', 'publisher-page'])
  assert.deepEqual(x.denied, [])
})

test('legacy V2, trial-funded V3 and V3 without strict first5 never request native web search', async () => {
  for (const options of [{ mode: v2 }, { trial: true }, { first5: false }]) {
    const x = await simulate(options)
    assert.equal(x.messages.some(m => Array.isArray(m.body.tools)), false, JSON.stringify(x))
    assert.deepEqual(x.denied, [])
  }
})

test('under the estimate, the scan refuses before the paid request and stays stopped', async () => {
  const x = await simulate({ cap: '0.15' })
  assert.deepEqual(x.sequence, ['native-count'], JSON.stringify(x))
  assert.deepEqual(x.end, { status: 'failed', error: 'budget_stopped' })
  assert.ok(x.ledger.some(row => (row as { status: string; reason: string }).status === 'refused' && (row as { reason: string }).reason === 'over_cap'))
})

test('known actual overage is settled in full and stops before any publisher or further model work', async () => {
  const x = await simulate({ overage: true })
  assert.deepEqual(x.sequence, ['native-count', 'native-send'], JSON.stringify(x))
  assert.deepEqual(x.end, { status: 'failed', error: 'native_search_estimate_exceeded' })
  const actual = (100_000 * 3 + 200 * 15) / 1e6 + 0.01
  assert.deepEqual(x.ledger, [{ status: 'settled', reason: null, reserve_usd: claudeSearchEstimate(count).estimatedUsd, actual_usd: actual }])
  assert.equal(x.pool.length, 2)
  for (const row of x.pool as { reserved_usd: number; reported_usd: number }[]) {
    assert.ok(Math.abs(row.reserved_usd - actual) < 1e-8)
    assert.ok(Math.abs(row.reported_usd - actual) < 1e-8)
  }
})

test('unknown native search billing stops the current run and refuses the next job for the same workspace', async () => {
  const x = await simulate({ interrupted: true })
  assert.deepEqual(x.end, { status: 'failed', error: 'accounting_uncertain' })
  assert.deepEqual(x.second, { status: 'failed', error: 'native_search_accounting_pending' })
  assert.deepEqual(x.sequence, ['native-count', 'native-send', 'native-count'])
  assert.deepEqual(x.ledger, [{ status: 'reserved', reason: null, reserve_usd: claudeSearchEstimate(count).estimatedUsd, actual_usd: null }])
})
