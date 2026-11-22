// #1517: the cost a finished scan's page shows and the cost its job record carries are one number. Found on a prod run (#1517):
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
import { recordedJobCostUsd } from '../lib/scan/job-cost.ts'

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

// Council: the page's final-cost line on both engines (Postgres returns the columns as strings). A paid call that never reported
// a cost is in the final cost at the amount reserved for it, and the line says how many such steps there are.
bothEngines('#1517: the page states the same final cost as the record, naming a step counted at its reservation', async ({ db }) => {
  await db.run("INSERT INTO scan_jobs (id, user_id, business_name, industry, location, query, status, estimate, spend_reserved_usd, spend_cap_reserved_usd, created_at, finished_at) VALUES (?, 'T', 'x', 'i', 'l', 'q', 'done', ?, 0.68, 0.68, 1795300000, 1795300100)", [JOB, estimate])
  const ins = "INSERT INTO scan_spend_calls (id, user_id, scan_job_id, attempt, kind, reserve_usd, actual_usd, status, reason, created_at, settled_at) VALUES (?, 'T', ?, 1, 'llm.anthropic', ?, ?, ?, NULL, 1795300010, ?)"
  await db.run(ins, ['c1', JOB, 0.5, 0.48, 'settled', 1795300020])
  await db.run(ins, ['c2', JOB, 0.2, null, 'kept', 1795300030])
  await db.run(ins, ['c3', JOB, 0.05, null, 'refused', null])   // refused before sending: never in the cost
  const s = await readScanStatus(db, 'T', JOB) as unknown as { cost: { actual: { final_usd: number | null; summary: string } } }
  const h = (await historyJobs(db, 'T')).find(j => j.id === JOB) as { spend_usd?: number | string }
  assert.equal(Number(s.cost.actual.final_usd), Number(h.spend_usd))
  assert.equal(Number(h.spend_usd), 0.68)
  assert.match(s.cost.actual.summary, /^Final cost \$0\.68, including one paid step counted as billed at the amount reserved for it\. /)
  assert.doesNotMatch(s.cost.actual.summary, /a reservation, not a settled charge|may have been/)
})

test('#1517: a spend column that is not an amount makes the cost unknown, never $0', () => {
  assert.equal(recordedJobCostUsd('abc', null), null)
  assert.equal(recordedJobCostUsd(null, 'NaN'), null)
  assert.equal(recordedJobCostUsd(null, null), 0)
  assert.equal(recordedJobCostUsd('0.68', '0.68'), 0.68)
  assert.equal(recordedJobCostUsd(0.41, 0), 0.41)
  assert.equal(recordedJobCostUsd('1e+0', 0), 1)
  assert.equal(recordedJobCostUsd(-0.2, null), null)
  assert.equal(recordedJobCostUsd('0x1A', 0), null)
})

// Council: a free trial's run guard keeps each call's worst case (it never settles down) and an unknown-cost call exhausts a
// guard to its full limit; neither is a cost. The cap ledger, settled to what the provider reported, is.
bothEngines('#1517: when the run guard holds a worst case above the settled ledger (trial / exhausted guard), the cost is the ledger', async ({ db }) => {
  await db.run("INSERT INTO scan_jobs (id, user_id, business_name, industry, location, query, status, estimate, spend_reserved_usd, spend_cap_reserved_usd, created_at, finished_at) VALUES (?, 'T', 'x', 'i', 'l', 'q', 'done', ?, 0.3, 0.0412, 1795300000, 1795300100)", [JOB, estimate])
  await db.run("INSERT INTO scan_spend_calls (id, user_id, scan_job_id, attempt, kind, reserve_usd, actual_usd, status, reason, created_at, settled_at) VALUES ('t1', 'T', ?, 1, 'llm.anthropic', 0.2, 0.0412, 'settled', NULL, 1795300010, 1795300020)", [JOB])
  const s = await readScanStatus(db, 'T', JOB) as unknown as { cost: { actual: { final_usd: number | null; summary: string } } }
  assert.equal(Number(s.cost.actual.final_usd), 0.0412)
  assert.equal(Number(((await historyJobs(db, 'T')).find(j => j.id === JOB) as { spend_usd?: number | string }).spend_usd), 0.0412)
  assert.equal(Number((await campaignDetail(db, 'T', JOB))?.job.spend_usd), 0.0412)
  assert.match(s.cost.actual.summary, /^Final cost \$0\.04\. /)
})

// Council: a call stranded 'reserved' (a crash before its settle) is in the final cost at the amount reserved for it and the
// line says so - counted as billed (#1157), never re-run, never a hedge. When the spend row cannot be read, no final cost.
bothEngines('#1517: a stranded reserved call is named in the final cost; an unread spend row states no final cost', async ({ db }) => {
  await db.run("INSERT INTO scan_jobs (id, user_id, business_name, industry, location, query, status, error, estimate, spend_reserved_usd, spend_cap_reserved_usd, created_at, finished_at) VALUES (?, 'T', 'x', 'i', 'l', 'q', 'failed', 'accounting_uncertain', ?, 0, 0.35, 1795300000, 1795300100)", [JOB, estimate])
  const ins = "INSERT INTO scan_spend_calls (id, user_id, scan_job_id, attempt, kind, reserve_usd, actual_usd, status, reason, created_at, settled_at) VALUES (?, 'T', ?, 1, 'llm.anthropic', ?, ?, ?, NULL, 1795300010, ?)"
  await db.run(ins, ['r1', JOB, 0.1, 0.05, 'settled', 1795300020])
  await db.run(ins, ['r2', JOB, 0.15, null, 'reserved', null])
  await db.run(ins, ['r3', JOB, 0.15, null, 'reserved', null])
  const s = await readScanStatus(db, 'T', JOB) as unknown as { cost: { actual: { final_usd: number | null; summary: string } } }
  assert.equal(Number(s.cost.actual.final_usd), 0.35)
  assert.match(s.cost.actual.summary, /^Final cost \$0\.35, including 2 paid steps counted as billed at the amount reserved for them\. /)
  const unread = { ...db, get: (async (sql: string, p?: unknown[]) => { if (/spend_reserved_usd, spend_cap_reserved_usd FROM scan_jobs/.test(sql)) throw new Error('db down'); return db.get(sql, p as never) }) as never } as typeof db
  const u = await readScanStatus(unread, 'T', JOB) as unknown as { cost: unknown; outcome: unknown }
  assert.equal(u.cost, null)   // nothing read: no cost line at all, never a stated final cost
  assert.doesNotMatch(JSON.stringify(u), /Final cost|Nothing was charged/)
  // the held-step count cannot be read: the cost is not stated as final (the reservation sentence stands instead)
  const heldUnread = { ...db, get: (async (sql: string, p?: unknown[]) => { if (/status IN \('reserved', 'kept'\)/.test(sql)) throw new Error('db down'); return db.get(sql, p as never) }) as never } as typeof db
  const h = await readScanStatus(heldUnread, 'T', JOB) as unknown as { cost: { actual: { final_usd: number | null; summary: string } } }
  assert.equal(h.cost.actual.final_usd, null)
  assert.doesNotMatch(h.cost.actual.summary, /Final cost/)
  assert.match(h.cost.actual.summary, /Reserved under this run's spend cap: \$0\.35/)
})

// Council: an unreadable spend column is unknown on every surface - never $0, so never "Nothing was charged".
test('#1517: an unreadable spend column makes no charge claim on the history list, the campaign record or the page', async () => {
  const db = new Database(':memory:')
  migrateAllSqlite(db)
  db.prepare("INSERT INTO scan_jobs (id, user_id, business_name, industry, location, query, status, error, funded_by, spend_reserved_usd, spend_cap_reserved_usd, created_at, finished_at) VALUES (?, 'T', 'x', 'i', 'l', 'q', 'failed', 'budget_stopped', 'trial', 'abc', 0, 1795300000, 1795300100)").run(JOB)
  const h = (await historyJobs(sqliteDb(db), 'T')).find(j => j.id === JOB) as Record<string, unknown>
  assert.equal('spend_usd' in h, false)
  assert.equal((await campaignDetail(sqliteDb(db), 'T', JOB))?.job.spend_usd, null)
  const s = await readScanStatus(sqliteDb(db), 'T', JOB) as unknown as { outcome: { label: string } }
  assert.doesNotMatch(s.outcome.label, /Nothing was charged/)
  db.close()
})

// Qodo (#1535): the page's status read must judge the STORED value with the same reader as history and campaign. Number()
// first would turn '0x1A' into 26 and '' into 0 (a "Nothing was charged" claim) before the reader could call it unknown.
for (const stored of ['0x1A', '']) {
  test(`#1517: a stored spend of ${JSON.stringify(stored)} is unknown on the page too: no final cost, no "Nothing was charged"`, async () => {
    const db = new Database(':memory:')
    migrateAllSqlite(db)
    db.prepare("INSERT INTO scan_jobs (id, user_id, business_name, industry, location, query, status, error, funded_by, estimate, spend_reserved_usd, spend_cap_reserved_usd, created_at, finished_at) VALUES (?, 'T', 'x', 'i', 'l', 'q', 'failed', 'budget_stopped', 'trial', ?, ?, 0, 1795300000, 1795300100)").run(JOB, estimate, stored)
    const h = (await historyJobs(sqliteDb(db), 'T')).find(j => j.id === JOB) as Record<string, unknown>
    assert.equal('spend_usd' in h, false)
    const s = await readScanStatus(sqliteDb(db), 'T', JOB) as unknown as { outcome: { label: string }; cost: { actual: { final_usd: number | null; summary: string } | null } | null }
    assert.doesNotMatch(s.outcome.label, /Nothing was charged/)
    assert.equal(s.cost?.actual?.final_usd ?? null, null)
    assert.doesNotMatch(JSON.stringify(s.cost), /Final cost/)
    db.close()
  })
}
