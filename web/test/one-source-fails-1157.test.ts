// #1157 part 4 (proof on main): one failing source does not end the run. Through the real runJob in the Claude-only lane:
// the paid search step fails before anything is sent (its token count errors, so nothing is billed) and one picked public
// source (GitHub) errors, while another picked source (an RSS feed) answers. The run must keep going: the feed's evidence is
// extracted and its page is read for verification, every source keeps its own status, and the scan never stops as
// source_error / no_candidates because of the two failures. Spend rule unchanged: an unknown charge still stops paid work
// (claude-search-stall-1157 / scan-progress cover that); here nothing was sent, so nothing is held.
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import test from 'node:test'
import Database from 'better-sqlite3'
import { CLAUDE_SEARCH_MODEL } from '../lib/llm/claude-web-search.ts'
import { saveKey } from '../lib/llm/key-store.ts'
import { migrateAllSqlite } from '../lib/db/sqlite-migrations.ts'
import { qaClaudeOnlyBudget } from '../lib/scan/qa-provider-policy.ts'
import { runJob } from '../lib/scan/runner.ts'
import { createQueryJob, pinAdmittedStrictJob } from '../lib/scan/store.ts'
import { asStreaming } from './helpers/claude-sse.ts'

const JOB = 'a1157b000000000000000004'
const api = 'https://api.anthropic.com/v1/messages'
const feed = 'https://feeds.northside.example/news.xml'
const item = 'https://northsideroofsystems.example/news/second-warehouse'
const quote = 'Northside Roof Systems commercial roofers in Utrecht open a second warehouse'
const query = 'Find commercial roofers expanding in Utrecht, Netherlands'

test('#1157 part 4: a failed paid search and an erroring source do not end the run; the working source is extracted and verified', async () => {
  const db = new Database(':memory:')
  const master = randomBytes(32)
  const env = { DAZL_MASTER_KEY: master.toString('base64'), DAZL_SCAN_CAP_CAD: '5', DAZL_SCAN_CAP_FX_CAD_PER_USD: '1.50', NEWS_SEARCH_ENABLED: '0', LEAD_ENGINE: '', TINYFISH_API_KEY: '' }
  const old = Object.fromEntries(Object.keys(env).map(k => [k, process.env[k]]))
  Object.assign(process.env, env)
  const previousFetch = globalThis.fetch
  const sent: string[] = [], prompts: string[] = [], sourceAsked: string[] = [], pagesRead: string[] = []
  let end: unknown, rows: unknown, spend: unknown
  try {
    migrateAllSqlite(db)
    saveKey(db, 'workspace', 'anthropic', 'sk-ant-native-test', master)
    const budget = qaClaudeOnlyBudget(JSON.stringify({ first5: true, paid_fallback: false, credit_enrichment: false }), true)
    const job = db.transaction(() => {
      createQueryJob(db, 'workspace', { id: JOB, query, runBudget: budget, sources: JSON.stringify({ adapters: ['rss', 'github'], feeds: [feed] }),
        icp: JSON.stringify({ summary: 'Commercial roofers', who: ['owner'], industries: ['commercial roofing'], sizes: [], where: ['Utrecht, Netherlands'], signals: ['warehouse expansion'], exclude: [] }) })
      return pinAdmittedStrictJob(db, 'workspace', JOB, budget)
    }).immediate()
    const io: typeof fetch = asStreaming(async (input, init) => {
      const target = String(input)
      assert.ok(target === api || target === api + '/count_tokens', 'fixture rejects off-provider requests')
      const body = JSON.parse(String(init?.body ?? '{}'))
      const prompt = String(body.messages?.[0]?.content ?? '')
      if (target.endsWith('/count_tokens')) {
        // the paid search's preflight count fails: the search is never sent
        if (prompt.startsWith('Find public company or publisher pages')) return Response.json({ type: 'error', error: { type: 'api_error', message: 'fixture' } }, { status: 500 })
        return Response.json({ input_tokens: 100 })
      }
      sent.push(Array.isArray(body.tools) ? 'native-search' : 'model')
      prompts.push(prompt)
      const text = prompt.includes(item) && !prompt.startsWith('You are grading') && !prompt.startsWith('You check one claim')
        ? JSON.stringify([{ name: '', company: 'Northside Roof Systems', contact: null, signal: 'Opened a second warehouse', source_url: item, excerpt: quote, event_date: null, score: 90 }])
        : '[]'
      return Response.json({ model: CLAUDE_SEARCH_MODEL, content: [{ type: 'text', text }], usage: { input_tokens: 100, output_tokens: 15 } })
    })
    globalThis.fetch = io
    await runJob(db, job, { master, fetchImpl: io, ground: false, crawlGet: async () => null,
      sourceHttp: (async (u: string) => {
        sourceAsked.push(u)
        if (u === feed) return { status: 200, finalUrl: u, body: `<?xml version="1.0"?><rss version="2.0"><channel><title>Northside news</title><item><title>${quote}</title><link>${item}</link><pubDate>Mon, 16 Nov 2026 09:00:00 GMT</pubDate></item></channel></rss>` }
        throw new Error('fixture: this source is down')
      }) as never,
      fetchPage: async u => { pagesRead.push(u); return u === item ? { title: 'Northside Roof Systems', text: (quote + '. ').repeat(6), retrievedAt: 1795300000 } : null },
    })
    end = db.prepare('SELECT status, error FROM scan_jobs WHERE id = ?').get(JOB)
    rows = Object.fromEntries((db.prepare('SELECT collector, status FROM scan_source_runs WHERE job_id = ?').all(JOB) as { collector: string; status: string }[]).map(r => [r.collector, r.status]))
    spend = db.prepare("SELECT count(*) AS n FROM scan_spend_calls WHERE scan_job_id = ? AND kind = 'llm.anthropic.web_search' AND status IN ('reserved', 'settled', 'kept')").get(JOB)
  } finally {
    globalThis.fetch = previousFetch
    for (const [k, v] of Object.entries(old)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
    db.close()
  }
  const why = JSON.stringify({ end, rows, sent, sourceAsked, pagesRead })
  // the paid search failed and was never sent (nothing billed, nothing held)
  assert.ok(!sent.includes('native-search'), why)
  assert.deepEqual(spend, { n: 0 }, why)
  const r = rows as Record<string, string>
  assert.match(r['search:anthropic_web'] ?? '', /^error/, why)
  // both picked sources were still asked; each keeps its own status
  assert.equal(r['adapter:github'], 'error', why)
  assert.equal(r['adapter:rss'], 'ok', why)
  // the run kept going: the working source's evidence was extracted and its page read for verification
  assert.ok(prompts.some(p => p.includes(item)), why)
  assert.ok(pagesRead.includes(item), why)
  const { error } = end as { status: string; error: string | null }
  assert.ok(!['source_error', 'no_candidates', 'no_discovery'].includes(String(error)), why)
})
