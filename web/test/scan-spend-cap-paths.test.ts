// Every paid host and transport a scan can reach, and proof that each one reserves on the scan's hard spend cap BEFORE
// its request (lib/scan/spend-cap.ts, #377 / #533). Two halves:
//  1. a static inventory: every API endpoint literal and every env-configured endpoint in lib/ and app/ is classified
//     here as PAID (with the one gated module allowed to call it) or FREE (with the reason). A new host, a new endpoint
//     variable, or a paid endpoint called from a second module fails this test until it is classified and gated;
//  2. each PAID transport, called inside a scan with stubbed fetch: the reservation row exists when the request is
//     made, and a scan at its cap makes no request at all (the refusal is recorded). No network: every fetch is a stub.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import Database from 'better-sqlite3'
import { sqliteDb } from '../lib/db/client.ts'
import { migrateAllSqlite } from '../lib/db/sqlite-migrations.ts'
import { anthropicProvider, openaiProvider } from '../lib/llm/provider.ts'
import { SpendRefused } from '../lib/llm/spend-guard.ts'
import { tfFetch, tfSearch, resetTinyfishState } from '../lib/search/tinyfish.ts'
import { apolloOrgEnrich, apolloPeopleSearch } from '../lib/enrich/apollo.ts'
import { pdlPeopleSearch } from '../lib/enrich/pdl.ts'
import { renderViaService } from '../lib/scan/fetch-page.ts'
import { outsideScanSpend, runWithScanSpend, scanCapConfig, scanSpendCalls, scanSpendContext, SPEND_KINDS, type SpendKind } from '../lib/scan/spend-cap.ts'
import { runValidation, RUN_RECORD_CONTRACT, type RunDeps } from '../lib/evals/judge-validation-run.ts'
import type { JudgeCorpus } from '../lib/evals/judge.ts'

const ROOT = new URL('..', import.meta.url).pathname
// PAID: endpoint -> the only module that may call it, and the kind it reserves.
const PAID: Record<string, { file: string; kind: SpendKind[] }> = {
  'https://api.anthropic.com/v1/messages': { file: 'lib/llm/provider.ts', kind: ['llm.anthropic'] },
  'https://api.openai.com/v1/responses': { file: 'lib/llm/provider.ts', kind: ['llm.openai'] },
  'https://api.search.tinyfish.ai': { file: 'lib/search/tinyfish.ts', kind: ['tinyfish.search'] },
  'https://api.fetch.tinyfish.ai': { file: 'lib/search/tinyfish.ts', kind: ['tinyfish.fetch'] },
  'https://api.apollo.io': { file: 'lib/enrich/apollo.ts', kind: ['apollo.org', 'apollo.people'] },
  'https://api.peopledatalabs.com': { file: 'lib/enrich/pdl.ts', kind: ['pdl.people'] },
  'env:SCAN_RENDER_URL': { file: 'lib/scan/fetch-page.ts', kind: ['render'] },
}
// Files that may NAME a paid endpoint without calling it (labels, not requests).
const NAMES_ONLY: Record<string, string> = {
  'lib/evals/trace.ts': 'maps recorded request URLs to labels for trace capture; makes no request',
}
// A paid endpoint also called by a SEPARATE, narrowly-scoped runner that is never scan work and is never routed through
// the scan spend cap: it has its own pre-send reservation, a persisted ledger and an owner-approved one-run claim gate
// (#396, reviewer contract on #626/#640). Scoped to exactly one (endpoint, file) pair each: a second file naming the
// same endpoint still falls through to `misplaced` below, and the test under "claim-gated runner" asserts the file
// still shows its own guard and never piggybacks on reserveScanSpend.
const CLAIM_GATED: Record<string, { file: string }> = {
  'https://api.anthropic.com/v1/messages': { file: 'lib/evals/judge-validation-run.ts' },
}
// FREE: endpoints with no per-call charge to dazl or the tenant, or not on any scan path.
const FREE: Record<string, string> = {
  'https://api.anthropic.com/v1/messages/count_tokens': 'Anthropic token counting is free (docs: token-counting)',
  'https://api.anthropic.com/v1/models': 'key check (model list): free',
  'https://api.openai.com/v1/models': 'key check (model list): free',
  'https://api.gdeltproject.org/api/v2/doc/doc': 'GDELT news search: free public API',
  'https://api.github.com/search/repositories': 'GitHub search: free, rate-limited',
  'https://api.ashbyhq.com/posting-api/job-board/': 'public job board API: free',
  'https://api.lever.co/v0/postings/': 'public job board API: free',
  'https://boards-api.greenhouse.io/v1/boards/': 'public job board API: free',
  'https://r.jina.ai': 'Jina Reader without a key: free (lib/scrape/jina.ts)',
  'https://r.jina.ai/': 'Jina Reader without a key: free (lib/sources/jina.ts)',
  'https://www.googleapis.com/youtube/v3/search': 'YouTube Data API: quota units, no per-call charge',
  'https://api.stripe.com/v1/': 'billing, not a scan path',
  'https://api.stripe.com/v1/subscriptions/': 'billing, not a scan path',
  'https://api.hubapi.com/account-info/v3/details': 'CRM push, not a scan path; no per-call charge',
  'https://api.hubapi.com/crm/v3/objects/contacts': 'CRM push, not a scan path; no per-call charge',
  'https://api.hubapi.com/crm/v3/objects/contacts/': 'CRM push, not a scan path; no per-call charge',
  'https://api.pipedrive.com/v1/persons': 'CRM push, not a scan path; no per-call charge',
  'https://api.pipedrive.com/v1/persons/': 'CRM push, not a scan path; no per-call charge',
  'https://api.pipedrive.com/v1/users/me': 'CRM key check: free',
  'https://gmail.googleapis.com/gmail/v1/users/me/': 'Gmail: free, the tenant mailbox',
  'https://gmail.googleapis.com/gmail/v1/users/me/messages': 'Gmail: free, the tenant mailbox',
  'https://gmail.googleapis.com/gmail/v1/users/me/messages/send': 'Gmail send: free, not a scan path',
  'https://oauth2.googleapis.com/revoke': 'Google OAuth: free',
  'https://oauth2.googleapis.com/token': 'Google OAuth: free',
  'https://www.googleapis.com/auth/gmail.readonly': 'an OAuth scope name, not a request',
  'https://www.googleapis.com/auth/gmail.send': 'an OAuth scope name, not a request',
  'https://www.googleapis.com/oauth2/v3/certs': 'Google OAuth keys: free',
  'env:CRAWL4AI_URL': 'the operator-run crawler container: no per-call charge',
  'env:ADVANCED_WORKER_URL': "the operator-run advanced-sources worker, carrying the tenant's own session: no per-call charge",
  'env:DATABASE_URL': 'the store, not a provider',
  'env:SYSTEM_MAIL_SMTP_URL': "dazl's own account mail (SMTP), not a scan path",
  'env:JINA_READER_URL': 'Jina Reader endpoint override: free reader',
  'env:PUBLIC_BASE_URL': "dazl's own public URL, not a provider",
}

function files(dir: string): string[] {
  return readdirSync(dir).flatMap(n => {
    const p = join(dir, n)
    if (n === 'node_modules' || n.startsWith('.')) return []
    return statSync(p).isDirectory() ? files(p) : /\.(ts|tsx|mts)$/.test(n) ? [p] : []
  })
}
const SOURCES = [...files(join(ROOT, 'lib')), ...files(join(ROOT, 'app'))].map(p => ({ rel: relative(ROOT, p).split('\\').join('/'), text: readFileSync(p, 'utf8') }))
const ENDPOINT = /https:\/\/[a-z0-9.-]*(?:api[a-z0-9.-]*|googleapis\.com|r\.jina\.ai)[^'"`\s?$)]*/g
const ENV_ENDPOINT = /\benv\.([A-Z0-9_]*(?:URL|ENDPOINT|BASE|HOST)[A-Z0-9_]*)/g

// Pure so the narrow-scoping (a second, unexpected file naming a CLAIM_GATED endpoint must still fail) can be proved
// against a synthetic source list, not only read off whatever happens to be on disk today.
function classify(sources: { rel: string; text: string }[]): { unknown: string[]; misplaced: string[] } {
  const unknown: string[] = []
  const misplaced: string[] = []
  for (const { rel, text } of sources) {
    const found = [...new Set([...[...text.matchAll(ENDPOINT)].map(m => m[0]), ...[...text.matchAll(ENV_ENDPOINT)].map(m => `env:${m[1]}`)])]
    for (const e of found) {
      if (rel === 'lib/scan/spend-cap.ts') continue // the gate's own documentation
      if (PAID[e]) { if (PAID[e].file !== rel && CLAIM_GATED[e]?.file !== rel && !NAMES_ONLY[rel]) misplaced.push(`${e} in ${rel}`) }
      else if (!FREE[e]) unknown.push(`${e} in ${rel}`)
    }
  }
  return { unknown, misplaced }
}

test('inventory: every API endpoint and env-configured endpoint in lib/ and app/ is classified as paid (gated) or free', () => {
  const { unknown, misplaced } = classify(SOURCES)
  assert.deepEqual(unknown, [], 'classify each new endpoint here: PAID needs a reserveScanSpend gate in its transport')
  assert.deepEqual(misplaced, [], 'a paid endpoint may only be called from its one gated module, or its one claim-gated runner')
})

test('inventory: a claim-gated endpoint stays narrowly scoped - a second, unexpected file naming it still fails', () => {
  for (const [e, c] of Object.entries(CLAIM_GATED)) {
    const { misplaced } = classify([{ rel: c.file, text: e }, { rel: 'lib/evals/some-other-module.ts', text: e }])
    assert.deepEqual(misplaced, [`${e} in lib/evals/some-other-module.ts`], `${e} is allowed only in ${c.file} and its one scan-cap module`)
  }
})

// Behavioral proof, not a source-text grep: a text match for "checkClaims(" would survive a bypass that calls it and
// ignores the result, or a dead/unreachable call. This instead runs the real runValidation with a real (but empty)
// claims record and a transport that FAILS the test if it is ever invoked - so a removed, ignored or bypassed claim
// check turns this red by making a network call, not by a missing string in the file.
test('inventory: the judge-validation runner is claim-gated, not scan-cap-gated - a missing claim refuses before any network call', async () => {
  const CORPUS = JSON.parse(readFileSync(join(ROOT, 'test/fixtures/evals/judges/corpus.synthetic.json'), 'utf8')) as JudgeCorpus
  for (const c of Object.values(CLAIM_GATED)) {
    const src = SOURCES.find(s => s.rel === c.file)!.text
    assert.ok(!/reserveScanSpend\(/.test(src), `${c.file} is not scan work and must never reserve on the scan spend cap`)
    const stateDir = mkdtempSync(join(tmpdir(), 'dazl-inv-claim-'))
    const recordPath = join(stateDir, 'runs.json')
    writeFileSync(recordPath, JSON.stringify({ contract: RUN_RECORD_CONTRACT, note: 'inventory test: no claim recorded', claims: [] }))
    let called = 0
    const deps: RunDeps = {
      transport: async () => { called++; throw new Error('the judge-validation runner called the network with no recorded claim') },
      secrets: [`sk-ant-dummy-not-a-secret-${'k'.repeat(24)}`], corpus: CORPUS, now: () => new Date('2026-11-04T12:00:00Z'),
      hostClaim: join(stateDir, 'host-claim'), machineFingerprint: () => 'fp-inventory-test', runRecord: recordPath,
    }
    const inputs = { runId: 'inv-check', model: 'claude-sonnet-4-5', capUsd: 3, fxCadPerUsd: 1.4, fxDate: '2026-11-03', fxSource: 'https://www.bankofcanada.ca/rates/exchange/daily-exchange-rates/', feeRate: 0.13, feeBasis: 'inventory test', stateDir }
    const result = await runValidation(inputs, deps)
    assert.equal(called, 0, 'no network call was made without a valid claim')
    assert.equal(result.status, 'refused', `expected a refusal, got ${result.status}: ${JSON.stringify(result.problems)}`)
  }
})

test('inventory: each gated module reserves its kind before its request, and dazl sends no cache_control', () => {
  for (const [e, p] of Object.entries(PAID)) {
    const src = SOURCES.find(s => s.rel === p.file)!.text
    assert.ok(src.includes("from '../scan/spend-cap.ts'") || src.includes("from './spend-cap.ts'"), `${p.file} imports the gate`)
    for (const k of p.kind) assert.ok(SPEND_KINDS.includes(k), k)
    assert.ok(/reserveScanSpend\(/.test(src), `${p.file} (${e}) reserves on the scan cap`)
  }
  assert.deepEqual(SOURCES.filter(s => s.rel !== 'lib/scan/spend-cap.ts' && /cache_control/.test(s.text)).map(s => s.rel), [], 'a cache write would be billed above the reserved input price')
  assert.deepEqual([...new Set(Object.values(PAID).flatMap(p => p.kind))].sort(), [...SPEND_KINDS].sort(), 'every spend kind has a transport')
  // the runner opens the scan's context around the whole attempt, and autopilot (outreach, own guards) runs outside it
  const runner = SOURCES.find(s => s.rel === 'lib/scan/runner.ts')!.text
  assert.match(runner, /return runWithScanSpend\(\{ db, jobId: job\.id, tenantId: job\.user_id, attempt: job\.attempts, cap: scanCapConfig\(\), requestMaxUsd \}, \(\) => runJobCapped\(db, job, deps\)\)/)
  assert.equal([...runner.matchAll(/\(deps\.autopilot \?\? runAutopilot\)\(/g)].length, 1)
  assert.match(runner, /outsideScanSpend\(\(\) => \(deps\.autopilot \?\? runAutopilot\)\(/)
  assert.match(SOURCES.find(s => s.rel === 'lib/enrich/index.ts')!.text, /runWithJobSpend\(db, tenantId, lead\.scan_job_id, \(\) => enrichLeadContacts\(/, 'the owner retry draws on its scan')
})

test("outsideScanSpend: work started inside a scan but not the scan's spend sees no scan context", async () => {
  const s = scan()
  const seen = await runWithScanSpend({ db: s.db, jobId: 'j1', tenantId: A, attempt: 1, cap: scanCapConfig({}) }, async () => [scanSpendContext()?.jobId, await outsideScanSpend(async () => scanSpendContext()?.jobId ?? null)])
  assert.deepEqual(seen, ['j1', null])
})

// ---- behaviour: each paid transport inside a scan ----

const A = 'a'.repeat(32)
function scan(): { raw: Database.Database; db: ReturnType<typeof sqliteDb> } {
  const raw = new Database(':memory:'); migrateAllSqlite(raw)
  raw.prepare("INSERT INTO scan_jobs (id, user_id, business_name, industry, location, status, attempts) VALUES ('j1', ?, 'B', 'i', 'l', 'running', 1)").run(A)
  return { raw, db: sqliteDb(raw) }
}
type Call = (f: typeof fetch, raw: Database.Database) => Promise<unknown>
const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 })
const TF_ENV = { TINYFISH_API_KEY: 'tf-test' }
const TRANSPORTS: { name: string; kind: SpendKind; call: Call; reply: () => Response }[] = [
  { name: 'anthropic completion', kind: 'llm.anthropic', call: f => anthropicProvider.completeDetailed!('sk-test', 'hello', f, 50), reply: () => ok({ id: 'm', model: 'claude-sonnet-4-5-20250929', content: [{ type: 'text', text: 'hi' }], usage: { input_tokens: 5, output_tokens: 2 } }) },
  { name: 'openai completion', kind: 'llm.openai', call: f => openaiProvider.completeDetailed!('sk-test', 'hello', f, 50), reply: () => ok({ id: 'r', model: 'gpt-4.1-2025-04-14', output: [{ type: 'message', content: [{ type: 'output_text', text: 'hi' }] }], usage: { input_tokens: 5, output_tokens: 2 } }) },
  { name: 'tinyfish search', kind: 'tinyfish.search', call: (f, raw) => tfSearch(raw, A, 'payroll hiring', {}, { searches: 0 }, { env: TF_ENV, fetchImpl: f }), reply: () => ok({ results: [] }) },
  { name: 'tinyfish fetch', kind: 'tinyfish.fetch', call: (f, raw) => tfFetch(raw, A, ['https://jobs.example/a'], { fetches: 0 }, { env: TF_ENV, fetchImpl: f }), reply: () => ok({ results: [] }) },
  { name: 'apollo org', kind: 'apollo.org', call: f => apolloOrgEnrich('ap-test', { domain: 'acme.example', name: 'Acme' }, f), reply: () => ok({ organization: null }) },
  { name: 'apollo people', kind: 'apollo.people', call: f => apolloPeopleSearch('ap-test', { domain: 'acme.example', name: 'Acme' }, f, 5), reply: () => ok({ people: [] }) },
  { name: 'pdl people', kind: 'pdl.people', call: f => pdlPeopleSearch('pdl-test', 'Acme', f, 5), reply: () => ok({ data: [{ full_name: 'Pat Lee' }, { full_name: 'Sam Roe' }] }) },
  { name: 'render', kind: 'render', call: f => renderViaService('https://93.184.216.34/page', f), reply: () => new Response('<html>ok</html>', { status: 200 }) },
]

for (const t of TRANSPORTS) {
  test(`${t.name}: the reservation is durable when the request is sent; at the cap nothing is sent and the refusal is recorded`, async () => {
    resetTinyfishState()
    process.env.SCAN_RENDER_URL = 'https://render.example'
    try {
      // room under the cap: at the moment of the request, this call's reservation row already exists
      const s = scan()
      const seen: { url: string; reserved: number }[] = []
      const f = (async (u: string | URL) => {
        seen.push({ url: String(u), reserved: (s.raw.prepare("SELECT count(*) AS n FROM scan_spend_calls WHERE kind = ? AND status = 'reserved'").get(t.kind) as { n: number }).n })
        return t.reply()
      }) as unknown as typeof fetch
      await runWithScanSpend({ db: s.db, jobId: 'j1', tenantId: A, attempt: 1, cap: scanCapConfig({}) }, () => t.call(f, s.raw))
      assert.equal(seen.length, 1, 'one request')
      assert.equal(seen[0].reserved, 1, 'reserved before the request')
      const calls = await scanSpendCalls(s.db, 'j1', A)
      assert.deepEqual(calls.map(c => c.kind), [t.kind])
      assert.notEqual(calls[0].status, 'reserved', 'settled (or kept) after the request')
      // a scan at its cap: the request is never sent
      const s2 = scan()
      s2.raw.prepare("UPDATE scan_jobs SET spend_cap_usd = 0.000001, spend_cap_reserved_usd = 0.000001 WHERE id = 'j1'").run()
      const sent: string[] = []
      const f2 = (async (u: string | URL) => { sent.push(String(u)); return t.reply() }) as unknown as typeof fetch
      // a render with a nonzero price, so a full ledger refuses it (TinyFish inside its free allowance costs 0 and is
      // refused through a stated price instead)
      const priced = t.kind.startsWith('tinyfish') ? { ...TF_ENV, DAZL_SCAN_PRICE_TINYFISH_SEARCH_USD: '0.01', DAZL_SCAN_PRICE_TINYFISH_FETCH_USD: '0.01' } : null
      const callAtCap = priced
        ? (fx: typeof fetch, raw: Database.Database) => (t.kind === 'tinyfish.search' ? tfSearch(raw, A, 'payroll hiring', {}, { searches: 0 }, { env: priced, fetchImpl: fx }) : tfFetch(raw, A, ['https://jobs.example/a'], { fetches: 0 }, { env: priced, fetchImpl: fx }))
        : t.call
      let threw: unknown = null
      let out: unknown
      try { out = await runWithScanSpend({ db: s2.db, jobId: 'j1', tenantId: A, attempt: 1, cap: scanCapConfig({}) }, () => callAtCap(f2, s2.raw)) } catch (e) { threw = e }
      assert.deepEqual(sent, [], 'no request at the cap')
      if (t.kind === 'render') assert.equal(out, null, 'a refused render renders nothing')
      else if (t.kind.startsWith('tinyfish')) assert.deepEqual(out, { ok: false, reason: 'cap' })
      else assert.ok(threw instanceof SpendRefused && threw.reason === 'over_cap', String(threw))
      assert.deepEqual((await scanSpendCalls(s2.db, 'j1', A)).map(c => [c.kind, c.status, c.reason]), [[t.kind, 'refused', 'over_cap']])
    } finally { delete process.env.SCAN_RENDER_URL }
  })
}

test('pdl: the reservation for the size asked for settles to the profiles returned; a 404 is not billed', async () => {
  const by: unknown[] = []
  const r6 = (v: number | null) => (v === null ? null : Math.round(v * 1e6) / 1e6)
  for (const reply of [ok({ data: [{ full_name: 'Pat Lee' }, { full_name: 'Sam Roe' }] }), new Response('{}', { status: 404 }), new Response('{}', { status: 500 }), new Response('not json', { status: 200 }), ok({ data: 'x' })]) {
    const s = scan()
    await runWithScanSpend({ db: s.db, jobId: 'j1', tenantId: A, attempt: 1, cap: scanCapConfig({}) }, () => pdlPeopleSearch('pdl-test', 'Acme', (async () => reply) as unknown as typeof fetch, 5)).catch(() => null)
    by.push(...(await scanSpendCalls(s.db, 'j1', A)).map(c => [r6(c.reserve_usd), c.status, r6(c.actual_usd)]))
  }
  assert.deepEqual(by, [[1.4, 'settled', 0.56], [1.4, 'settled', 0], [1.4, 'kept', null], [1.4, 'kept', null], [1.4, 'kept', null]])
})

test('model completions: an unlisted configured model is refused before any request; outside a scan the transport is unchanged', async () => {
  const s = scan()
  const sent: string[] = []
  const f = (async (u: string | URL) => { sent.push(String(u)); return ok({ id: 'm', model: 'x', content: [] }) }) as unknown as typeof fetch
  const prev = process.env.DAZL_ANTHROPIC_MODEL
  process.env.DAZL_ANTHROPIC_MODEL = 'claude-unlisted-model'
  try {
    await assert.rejects(runWithScanSpend({ db: s.db, jobId: 'j1', tenantId: A, attempt: 1, cap: scanCapConfig({}) }, () => anthropicProvider.completeDetailed!('sk-test', 'hi', f, 10)), (e: unknown) => e instanceof SpendRefused && e.reason === 'model_unpriced')
    assert.deepEqual(sent, [])
    assert.deepEqual((await scanSpendCalls(s.db, 'j1', A)).map(c => [c.status, c.reason]), [['refused', 'model_unpriced']])
    await anthropicProvider.completeDetailed!('sk-test', 'hi', f, 10) // no scan context: no gate here (other paths keep their own guards)
    assert.equal(sent.length, 1)
  } finally { if (prev === undefined) delete process.env.DAZL_ANTHROPIC_MODEL; else process.env.DAZL_ANTHROPIC_MODEL = prev }
})
