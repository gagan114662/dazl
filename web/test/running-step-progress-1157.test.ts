// #1157 part 2 (proof on main): while a scan runs, what the page polls says which step it is on and when it last made progress.
// Read through the real status reader (readScanStatus, the GET /api/scan/status payload) from INSIDE the paid Claude search call
// of a real runJob - the step that can now run for a minute or more. The page builds its stepper from `status` ('running' ->
// "Search and read sources"), its live source list from `progress`, its "Searching... N min" from running_since and its
// "Last activity N s ago" from last_progress_at (app/app/leads/leads-client.tsx; copy in lib/scan/progress.ts).
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import test from 'node:test'
import Database from 'better-sqlite3'
import { CLAUDE_SEARCH_MODEL } from '../lib/llm/claude-web-search.ts'
import { saveKey } from '../lib/llm/key-store.ts'
import { migrateAllSqlite } from '../lib/db/sqlite-migrations.ts'
import { sqliteDb } from '../lib/db/client.ts'
import { qaClaudeOnlyBudget } from '../lib/scan/qa-provider-policy.ts'
import { runJob } from '../lib/scan/runner.ts'
import { createQueryJob, pinAdmittedStrictJob } from '../lib/scan/store.ts'
import { readScanStatus } from '../lib/scan/status-read-service.ts'
import { lastActivityNote } from '../lib/scan/progress.ts'
import { asStreaming } from './helpers/claude-sse.ts'

const query = 'Find commercial roofers expanding in Utrecht, Netherlands'
const url = 'https://northsideroofsystems.example/announcement'
const api = 'https://api.anthropic.com/v1/messages'
const JOB = 'a1157b000000000000000002'

test('#1157 part 2: during the paid search call the polled status names the running step, the live source and its last progress', async () => {
  const db = new Database(':memory:')
  const master = randomBytes(32)
  const env = { DAZL_MASTER_KEY: master.toString('base64'), DAZL_SCAN_CAP_CAD: '5', DAZL_SCAN_CAP_FX_CAD_PER_USD: '1.50', NEWS_SEARCH_ENABLED: '0', LEAD_ENGINE: '', TINYFISH_API_KEY: '' }
  const old = Object.fromEntries(Object.keys(env).map(k => [k, process.env[k]]))
  Object.assign(process.env, env)
  const previousFetch = globalThis.fetch
  let during: Awaited<ReturnType<typeof readScanStatus>> | null = null
  let reservedAt: number | null = null
  try {
    migrateAllSqlite(db)
    saveKey(db, 'workspace', 'anthropic', 'sk-ant-native-test', master)
    const budget = qaClaudeOnlyBudget(JSON.stringify({ first5: true, paid_fallback: false, credit_enrichment: false }), true)
    const job = db.transaction(() => {
      createQueryJob(db, 'workspace', { id: JOB, query, runBudget: budget, icp: JSON.stringify({ summary: 'Commercial roofers', who: ['owner'], industries: ['commercial roofing'], sizes: [], where: ['Utrecht, Netherlands'], signals: ['warehouse expansion'], exclude: [] }) })
      return pinAdmittedStrictJob(db, 'workspace', JOB, budget)
    }).immediate()
    const io: typeof fetch = asStreaming(async (input, init) => {
      const target = String(input)
      assert.ok(target === api || target === api + '/count_tokens', 'fixture rejects off-provider requests')
      const body = JSON.parse(String(init?.body ?? '{}'))
      if (target.endsWith('/count_tokens')) return Response.json({ input_tokens: 100 })
      if (Array.isArray(body.tools)) {
        // the paid search is in flight now: read what the page would poll
        during = await readScanStatus(sqliteDb(db), 'workspace', JOB)
        reservedAt = (db.prepare("SELECT max(created_at) AS t FROM scan_spend_calls WHERE scan_job_id = ? AND status = 'reserved'").get(JOB) as { t: number | null }).t
        return Response.json({ model: CLAUDE_SEARCH_MODEL, stop_reason: 'end_turn', content: [{ type: 'web_search_tool_result', content: [{ type: 'web_search_result', url }] }],
          usage: { input_tokens: 8000, output_tokens: 200, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, server_tool_use: { web_search_requests: 1, web_fetch_requests: 0 } } })
      }
      return Response.json({ model: CLAUDE_SEARCH_MODEL, content: [{ type: 'text', text: '[]' }], usage: { input_tokens: 100, output_tokens: 15 } })
    })
    globalThis.fetch = io
    await runJob(db, job, { master, fetchImpl: io, ground: false, crawlGet: async () => null, fetchPage: async () => null })
  } finally {
    globalThis.fetch = previousFetch
    for (const [k, v] of Object.entries(old)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
    db.close()
  }
  const s = during as unknown as { status: string; progress: { source: string; state: string; status: string }[]; last_progress_at: number | null; running_since: number | null }
  assert.ok(s, 'the paid search call was reached')
  assert.equal(s.status, 'running')                                          // stepper: "Search and read sources"
  const live = s.progress.find(p => p.source === 'search:anthropic_web')
  assert.ok(live, JSON.stringify(s.progress))                                 // the live source list names the search step
  assert.equal(live!.status, 'running')
  assert.ok(reservedAt !== null && s.last_progress_at !== null && s.last_progress_at >= reservedAt, 'last progress is the search call itself (its reservation), never older')
  assert.ok(typeof s.running_since === 'number' && s.running_since <= s.last_progress_at!)
  assert.match(lastActivityNote(s.last_progress_at! + 12, s.last_progress_at)!.text, /^Last activity 12 s ago$/)
})
