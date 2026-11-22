import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import test from 'node:test'
import Database from 'better-sqlite3'
import { applyBuyerFitGate } from '../lib/scan/buyer-fit.ts'
import { nativeQueryIcpTextFor } from '../lib/scan/score.ts'
import { normalizeIcp } from '../lib/scan/icp.ts'
import { CLAUDE_SEARCH_MODEL } from '../lib/llm/claude-web-search.ts'
import { saveKey } from '../lib/llm/key-store.ts'
import { migrateAllSqlite } from '../lib/db/sqlite-migrations.ts'
import { qaClaudeOnlyBudget } from '../lib/scan/qa-provider-policy.ts'
import { runJob } from '../lib/scan/runner.ts'
import { createQueryJob, pinAdmittedStrictJob } from '../lib/scan/store.ts'
import { asStreaming } from './helpers/claude-sse.ts'

const query = 'Find commercial roofers expanding in Utrecht, Netherlands'
const savedSummary = 'Independent opticians in Zaragoza, Spain'
const company = 'Northside Roof Systems'
const url = 'https://northsideroofsystems.example/announcement'
const excerpt = 'Northside Roof Systems, a commercial roofer in Utrecht, opened a second warehouse.'
const signal = 'Northside Roof Systems expanded with a second warehouse'
const home = 'https://northsideroofsystems.example/'
const api = 'https://api.anthropic.com/v1/messages'

async function fixture(hiring = false) {
  const candidateSignal = hiring ? 'Northside Roof Systems is hiring warehouse staff' : signal
  const db = new Database(':memory:')
  const master = randomBytes(32)
  const env = { DAZL_MASTER_KEY: master.toString('base64'), DAZL_SCAN_CAP_CAD: '5',
    DAZL_SCAN_CAP_FX_CAD_PER_USD: '1.50', NEWS_SEARCH_ENABLED: '0', LEAD_ENGINE: '', TINYFISH_API_KEY: '' }
  const old = Object.fromEntries(Object.keys(env).map(k => [k, process.env[k]]))
  Object.assign(process.env, env)
  const previousFetch = globalThis.fetch
  const requests: string[] = []
  try {
    migrateAllSqlite(db)
    saveKey(db, 'workspace', 'anthropic', 'sk-ant-native-test', master)
    const budget = qaClaudeOnlyBudget(JSON.stringify({ first5: true, paid_fallback: false, credit_enrichment: false }), true)
    const job = db.transaction(() => {
      createQueryJob(db, 'workspace', { id: 'job', query, runBudget: budget, icp: JSON.stringify({
        summary: savedSummary, who: ['owner'], industries: ['commercial roofing'], sizes: ['small business'],
        where: ['Utrecht, Netherlands'], signals: ['warehouse expansion'], exclude: ['suppliers'],
      }) })
      return pinAdmittedStrictJob(db, 'workspace', 'job', budget)
    }).immediate()
    if (hiring) db.exec(`CREATE TEMP TRIGGER fixture_owned_home AFTER INSERT ON leads
      WHEN NEW.scan_job_id='job' BEGIN
        UPDATE leads SET company_domain='northsideroofsystems.example' WHERE id=NEW.id;
      END`) // independently supplied verified company domain for the post-crawl fixture
    const io: typeof fetch = asStreaming(async (input, init) => {
      const target = String(input)
      assert.ok(target === api || target === api + '/count_tokens', 'fixture rejects off-provider requests')
      const body = JSON.parse(String(init?.body ?? '{}'))
      const prompt = String(body.messages?.[0]?.content ?? '')
      if (target.endsWith('/count_tokens')) return Response.json({ input_tokens: 100 })
      requests.push(prompt)
      const event_date = null
      const plain = prompt.startsWith('You turn pre-collected') ? JSON.stringify([{ name: '', company, contact: null, signal: candidateSignal,
        source_url: url, excerpt, event_date, score: 95 }]) : prompt.startsWith('You check one claim') ? 'supports'
        : prompt.startsWith('You are grading sales leads') ?
          (hiring || (prompt.includes(query) && !prompt.includes(savedSummary))
            ? 'LEAD 1 | fit 5 | intent 3 | action 3 | match ?y?y | signals none | why The cited warehouse expansion fits the request.'
            : 'LEAD 1 | fit 0 | intent 3 | action 3 | match ?n?n | signals none | why Not an optician in Zaragoza.')
        : '[]'
      if (Array.isArray(body.tools)) return Response.json({ model: CLAUDE_SEARCH_MODEL, stop_reason: 'end_turn',
        content: [{ type: 'web_search_tool_result', content: [{ type: 'web_search_result', url }] }],
        usage: { input_tokens: 8000, output_tokens: 200, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, server_tool_use: { web_search_requests: 1, web_fetch_requests: 0 } } })
      return Response.json({ model: CLAUDE_SEARCH_MODEL, content: [{ type: 'text', text: plain }], usage: { input_tokens: 100, output_tokens: 15 } })
    })
    globalThis.fetch = io
    await runJob(db, job, { master, fetchImpl: io, ground: false, crawlGet: async () => null, now: new Date('2026-10-20T12:00:00Z'),
      fetchPage: async (u) => {
        assert.ok(u === url || (hiring && u === home))
        return { title: company, text: (excerpt + (hiring ? ' Northside Roof Systems is hiring warehouse staff for this facility. ' : ' This is the second regional facility of Northside Roof Systems. ')).repeat(4), retrievedAt: 1792497600 }
      } })
    const row = db.prepare("SELECT fit, confidence, review_reason, event_date, event_date_proof, why FROM leads WHERE scan_job_id='job'").get() as { fit: number; event_date: string | null; event_date_proof: string | null; why: string }
    const stored = (db.prepare("SELECT icp FROM scan_jobs WHERE id='job'").get() as { icp: string }).icp
    assert.ok(row, JSON.stringify([requests.map(p => p.slice(0, 85)), db.prepare('SELECT error FROM scan_jobs').all()]))
    let buyerFitPrompt = ''
    let isolatedGateWhy = ''
    if (hiring) {
      // The live pinned lane refuses post-terminal paid dispatch. Exercise the existing
      // homepage gate separately with a fake provider, never by bypassing spend guards in the runner.
      db.exec("UPDATE leads SET fit=5 WHERE scan_job_id='job'")
      await applyBuyerFitGate(db, 'job', {
        research: async () => ({ text: '', citedUrls: [] }),
        complete: async (_key, prompt) => {
          buyerFitPrompt = prompt
          return 'COMPANY 1 | fit yes | quote A made-up eligibility quote that is not on the company site'
        },
      }, 'no-provider', nativeQueryIcpTextFor(normalizeIcp(JSON.parse(stored)), query), {
        fetchPage: async u => {
          assert.equal(u, home)
          return { text: excerpt.repeat(4), title: company, retrievedAt: 1792497600 }
        },
      })
      isolatedGateWhy = (db.prepare("SELECT why FROM leads WHERE scan_job_id='job'").get() as { why: string }).why
    }
    return { requests, row, stored, buyerFitPrompt, isolatedGateWhy }
  } finally {
    globalThis.fetch = previousFetch
    for (const [k, v] of Object.entries(old)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
    db.close()
  }
}

function assertTarget(prompt: string) {
  assert.ok(prompt.includes(query))
  assert.ok(!prompt.includes(savedSummary))
  for (const constraint of ['buyers: owner', 'industries: commercial roofing', 'sizes: small business', 'where: Utrecht, Netherlands', 'intent signals: warehouse expansion', 'exclude: suppliers'])
    assert.ok(prompt.includes(constraint), constraint)
}

test('native runner grades the explicit play query without replacing structured constraints or saved prose', async () => {
  const { requests, row, stored } = await fixture()
  const grades = requests.filter(p => p.startsWith('You are grading sales leads'))
  assert.equal(grades.length, 1)
  assertTarget(grades[0])
  assert.equal(requests.filter(p => p.startsWith('You check one claim')).length, 1)
  assert.ok(row.fit >= 4)
  assert.equal(row.event_date, null)
  assert.equal(row.event_date_proof, null)
  assert.ok(stored.includes(savedSummary))
})

test('the native hiring hold stays fail-closed, and the homepage gate never accepts a made-up quote', async () => {
  const { requests, row, buyerFitPrompt, isolatedGateWhy } = await fixture(true)
  assert.equal(requests.filter(p => p.startsWith('You check whether companies fit')).length, 0)
  assert.ok(row.fit < 4)
  assert.match(row.why, /fit check returned no answer/)
  assert.equal(row.event_date_proof, null)
  assert.ok(buyerFitPrompt.startsWith('You check whether companies fit'))
  assertTarget(buyerFitPrompt)
  assert.match(isolatedGateWhy, /quoted fit evidence was not found/)
})
