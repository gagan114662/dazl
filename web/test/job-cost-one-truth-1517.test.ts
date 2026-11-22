// #1517: the cost a finished scan's page shows and the cost its job record carries are one number. Found on prod run 679a7354:
// the page said "at least $0.56 ... reserved $0.68" while the job record said $1.36 - exactly twice the reservation, because the
// record added the run-budget guard's column (spend_reserved_usd) to the per-scan cap ledger's column (spend_cap_reserved_usd),
// and both hold THE SAME paid calls, each settled to the cost the provider reported (spend-guard.ts settleAll, spend-cap.ts
// settle). The per-call ledger (scan_spend_calls) is the truth: settled calls at their reported cost, a call without a reported
// cost at the most it could cost.
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
import { historyJobs } from '../lib/scan/history-jobs.ts'
import { campaignDetail } from '../lib/outreach/campaign-detail.ts'
import { bothEngines } from './helpers/engines.ts'

const JOB = 'a1517b000000000000000001'
const api = 'https://api.anthropic.com/v1/messages'
const query = 'Find commercial roofers expanding in Utrecht, Netherlands'
const item = 'https://northsideroofsystems.example/news/second-warehouse'
const quote = 'Northside Roof Systems commercial roofers in Utrecht open a second warehouse'
const estimate = JSON.stringify({ total: { min: 0.05, max: 1.5 }, rows: [{ id: 'model', label: 'AI research', kind: 'model', usd: { min: 0.05, max: 1.5 }, unit_usd: '', note: '', provider: 'anthropic' }], payer: 'user', cap: null })
const ledgerTotal = (db: Database.Database) => (db.prepare(`SELECT coalesce(sum(CASE status WHEN 'settled' THEN actual_usd WHEN 'refused' THEN 0 ELSE reserve_usd END), 0) AS t
  FROM scan_spend_calls WHERE scan_job_id = ?`).get(JOB) as { t: number }).t
const cents = (n: number) => `$${n.toFixed(2)}`

test('#1517: a finished run\'s page and its job record show the same final cost, the per-call ledger total, never the two guards added', async () => {
  const db = new Database(':memory:')
  const master = randomBytes(32)
  const env = { DAZL_MASTER_KEY: master.toString('base64'), DAZL_SCAN_CAP_CAD: '5', DAZL_SCAN_CAP_FX_CAD_PER_USD: '1.50', NEWS_SEARCH_ENABLED: '0', LEAD_ENGINE: '', TINYFISH_API_KEY: '' }
  const old = Object.fromEntries(Object.keys(env).map(k => [k, process.env[k]]))
  Object.assign(process.env, env)
  const previousFetch = globalThis.fetch
  try {
    migrateAllSqlite(db)
    saveKey(db, 'workspace', 'anthropic', 'sk-ant-native-test', master)
    // a run budget (max_usd) puts the run's own guard on every model call, beside the per-scan cap ledger
    const budget = qaClaudeOnlyBudget(JSON.stringify({ max_usd: 2, first5: true, paid_fallback: false, credit_enrichment: false }), false)
    const job = db.transaction(() => {
      createQueryJob(db, 'workspace', { id: JOB, query, runBudget: budget, sources: JSON.stringify({ adapters: ['rss'], feeds: ['https://feeds.northside.example/news.xml'] }),
        icp: JSON.stringify({ summary: 'Commercial roofers', who: ['owner'], industries: ['commercial roofing'], sizes: [], where: ['Utrecht, Netherlands'], signals: ['warehouse expansion'], exclude: [] }) })
      db.prepare('UPDATE scan_jobs SET estimate = ? WHERE id = ?').run(estimate, JOB)
      return pinAdmittedStrictJob(db, 'workspace', JOB, budget)
    }).immediate()
    const io: typeof fetch = async (input, init) => {
      const target = String(input)
      assert.ok(target === api || target === api + '/count_tokens', 'fixture rejects off-provider requests')
      if (target.endsWith('/count_tokens')) return Response.json({ input_tokens: 100 })
      const prompt = String(JSON.parse(String(init?.body ?? '{}')).messages?.[0]?.content ?? '')
      const text = prompt.includes(item) && !prompt.startsWith('You are grading') && !prompt.startsWith('You check one claim')
        ? JSON.stringify([{ name: '', company: 'Northside Roof Systems', contact: null, signal: 'Opened a second warehouse', source_url: item, excerpt: quote, event_date: null, score: 90 }])
        : '[]'
      return Response.json({ model: CLAUDE_SEARCH_MODEL, content: [{ type: 'text', text }], usage: { input_tokens: 4000, output_tokens: 300 } })
    }
    globalThis.fetch = io
    await runJob(db, job, { master, fetchImpl: io, ground: false, crawlGet: async () => null,
      sourceHttp: (async (u: string) => ({ status: 200, finalUrl: u, body: `<?xml version="1.0"?><rss version="2.0"><channel><title>n</title><item><title>${quote}</title><link>${item}</link><pubDate>Mon, 16 Nov 2026 09:00:00 GMT</pubDate></item></channel></rss>` })) as never,
      fetchPage: async u => u === item ? { title: 'Northside Roof Systems', text: (quote + '. ').repeat(6), retrievedAt: 1795300000 } : null,
    })
    const cols = db.prepare('SELECT status, spend_reserved_usd AS run, spend_cap_reserved_usd AS cap FROM scan_jobs WHERE id = ?').get(JOB) as { status: string; run: number; cap: number }
    const truth = ledgerTotal(db)
    const why = JSON.stringify({ cols, truth })
    // precondition: the run finished and both guards hold the same paid calls (the prod shape)
    assert.ok(cols.status === 'done' || cols.status === 'failed', why)
    assert.ok(truth > 0 && cols.run > 0 && cols.cap > 0, why)
    const status = await readScanStatus(sqliteDb(db), 'workspace', JOB) as unknown as { cost: { actual: { final_usd: number | null; summary: string } | null } | null }
    const history = (await historyJobs(sqliteDb(db), 'workspace')).find(j => j.id === JOB) as { spend_usd?: number }
    const campaign = await campaignDetail(sqliteDb(db), 'workspace', JOB)
    // one source of truth: every surface carries the ledger total
    assert.ok(Math.abs(Number(history.spend_usd) - truth) < 1e-9, JSON.stringify({ history: history.spend_usd, truth, cols }))
    assert.ok(Math.abs(Number(campaign?.job.spend_usd) - truth) < 1e-9, JSON.stringify({ campaign: campaign?.job.spend_usd, truth }))
    assert.ok(status.cost?.actual, why)
    assert.ok(Math.abs(Number(status.cost.actual.final_usd) - truth) < 1e-9, JSON.stringify({ page: status.cost.actual.final_usd, truth }))
    // the page says that number as the final cost, plainly
    assert.match(status.cost.actual.summary, new RegExp(`^Final cost ${cents(truth).replace('$', '\\$')}\\.`))
    assert.doesNotMatch(status.cost.actual.summary, /a reservation, not a settled charge/)
  } finally {
    globalThis.fetch = previousFetch
    for (const [k, v] of Object.entries(old)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
    db.close()
  }
})

// The prod shape on both engines (Postgres returns NUMERIC/REAL columns as strings): $0.68 held in each column for the same calls.
bothEngines('#1517: the prod shape (0.68 in both columns) reads as $0.68 on the history and campaign records, never $1.36', async ({ db }) => {
  await db.run("INSERT INTO scan_jobs (id, user_id, business_name, industry, location, query, status, spend_reserved_usd, spend_cap_reserved_usd, created_at, finished_at) VALUES (?, 'T', 'x', 'i', 'l', 'q', 'done', 0.68, 0.68, 1795300000, 1795300100)", [JOB])
  await db.run("INSERT INTO scan_jobs (id, user_id, business_name, industry, location, query, status, spend_reserved_usd, spend_cap_reserved_usd, created_at, finished_at) VALUES ('a1517b000000000000000009', 'U', 'x', 'i', 'l', 'q', 'done', 0.5, 0.5, 1795300000, 1795300100)")
  const h = (await historyJobs(db, 'T')).find(j => j.id === JOB) as { spend_usd?: number | string }
  assert.equal(Number(h.spend_usd), 0.68)
  const c = await campaignDetail(db, 'T', JOB)
  assert.equal(Number(c?.job.spend_usd), 0.68)
  // a job from before the per-scan cap ledger existed holds its spend only in the run-budget column: that amount is its cost
  await db.run("UPDATE scan_jobs SET spend_cap_reserved_usd = 0, spend_reserved_usd = 0.41 WHERE id = ?", [JOB])
  assert.equal(Number(((await historyJobs(db, 'T')).find(j => j.id === JOB) as { spend_usd?: number }).spend_usd), 0.41)
  // owner-scoped: another tenant's job is never read
  assert.equal((await historyJobs(db, 'T')).some(j => j.id === 'a1517b000000000000000009'), false)
})
