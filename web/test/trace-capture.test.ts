// Production trace capture (lib/evals/capture.ts): OFF by default; when on, the real runJob's external calls are recorded,
// redacted, size-capped and stored tenant-scoped in the app's own store, and purged after the configured retention.
// Every page, company, address and key here is SYNTHETIC.
import { test } from 'node:test'
import { randomBytes } from 'node:crypto'
import assert from 'node:assert/strict'
import { runFixture, daysAgo, type Fixture } from './helpers/acceptance-harness.ts'
import { bothEngines } from './helpers/engines.ts'
import Database from 'better-sqlite3'
import { migrateKeys, saveKey } from '../lib/llm/key-store.ts'
import { migrateScan } from '../lib/scan/store.ts'
import { migratePlans } from '../lib/plans.ts'
import { createBatch, migrateCsv, queuePendingRows } from '../lib/scan/csv-import.ts'
import { claimKeyedJob, runJob } from '../lib/scan/runner.ts'
import { getDb, sqliteDb, type Db } from '../lib/db/client.ts'
import { migrateAllSqlite } from '../lib/db/sqlite-migrations.ts'
import { beginScanTrace, capTrace, getTrace, listTraces, purgeExpiredTraces, traceCaptureConfig, DEFAULT_RETENTION_DAYS, MAX_STRING_CHARS, MAX_TRACE_BYTES } from '../lib/evals/capture.ts'
import { redactTrace } from '../lib/evals/redact.ts'
import { TraceRecorder, TRACE_VERSION, type Trace } from '../lib/evals/trace.ts'
import { worldFromTrace, validateWorld, WorldError } from '../lib/evals/world.ts'
import { replayCase } from './helpers/eval-replay.ts'
import type { Case } from '../lib/evals/case.ts'

const withEnv = async <T>(vars: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> => {
  const saved = Object.fromEntries(Object.keys(vars).map(k => [k, process.env[k]]))
  for (const [k, v] of Object.entries(vars)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
  try { return await fn() } finally { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v } }
}

const URL_ = 'https://news.example/london/querix-seed'
const PAGE_TEXT = (d: string) => `${d}. Querix, a London B2B SaaS startup, raised a 3m GBP seed round this month. Press: founders@querix.example or +44 20 7946 0958. ${'The company sells workflow software to finance teams in London. '.repeat(12)}`
function fixture(): Fixture {
  const d = daysAgo(10); const page = { title: 'Querix raises seed', text: PAGE_TEXT(d) }
  return {
    request: 'Find London UK B2B SaaS startups that announced seed funding within the past 90 days.',
    modelIcp: { summary: 's', who: ['Founder'], industries: ['B2B SaaS'], sizes: [], where: ['London, UK'], signals: ['raised a seed round'], exclude: [], country: 'GB', language: 'en', window_days: 90 },
    modelQueries: ['london saas seed'], hits: [{ url: URL_, title: page.title, snippet: 'Querix raised a seed round', date: d }], tfPages: { [URL_]: page }, own: { [URL_]: page },
    extraction: [{ name: 'Dana Synthetic', company: 'Querix', contact: 'founders@querix.example', signal: 'raised a seed round', source_url: URL_, excerpt: 'Querix, a London B2B SaaS startup, raised a 3m GBP seed round this month', event_date: d }],
  }
}
const storedFor = async (tenant: string) => { const db = await getDb(); const rows = await listTraces(db, tenant, 50); return { db, rows } }

test('config: OFF unless DAZL_TRACE_CAPTURE=1; retention defaults to 14 days; an invalid retention never captures', () => {
  assert.deepEqual(traceCaptureConfig({}), { enabled: false, retentionDays: 14, reason: 'off' })
  assert.deepEqual(traceCaptureConfig({ DAZL_TRACE_CAPTURE: 'true' }), { enabled: false, retentionDays: 14, reason: 'off' })   // only "1" turns it on
  assert.deepEqual(traceCaptureConfig({ DAZL_TRACE_CAPTURE: '1' }), { enabled: true, retentionDays: DEFAULT_RETENTION_DAYS, reason: 'on' })
  assert.deepEqual(traceCaptureConfig({ DAZL_TRACE_CAPTURE: '1', DAZL_TRACE_RETENTION_DAYS: '7' }), { enabled: true, retentionDays: 7, reason: 'on' })
  for (const bad of ['0', '-1', '1.5', 'abc', '366', ' '.repeat(0) + 'NaN'])
    assert.deepEqual(traceCaptureConfig({ DAZL_TRACE_CAPTURE: '1', DAZL_TRACE_RETENTION_DAYS: bad }), { enabled: false, retentionDays: 14, reason: 'invalid_retention' }, bad)
  assert.equal(traceCaptureConfig({ DAZL_TRACE_RETENTION_DAYS: '3' }).retentionDays, 3)   // the purge follows retention even with capture off
})

test('OFF (default): beginScanTrace returns null, the run gets exactly its own deps, and nothing is stored', async () => {
  const deps = { fetchImpl: globalThis.fetch }
  assert.equal(beginScanTrace({ id: 'j', user_id: 'A', attempts: 1 }, deps, { env: {} }), null)
  const before = (await storedFor('A')).rows.length
  const x = await withEnv({ DAZL_TRACE_CAPTURE: undefined }, () => runFixture(fixture()))
  assert.equal(x.leads.find(l => l.company === 'Querix')?.review_reason, null)
  assert.equal((await storedFor('A')).rows.length, before)
})

test('ON: the real runJob is recorded, redacted and stored for its own tenant; no key or raw contact reaches the store; the run is unchanged', async () => {
  const off = await withEnv({ DAZL_TRACE_CAPTURE: undefined }, () => runFixture(fixture()))
  const before = new Set((await storedFor('A')).rows.map(r => r.id))
  const on = await withEnv({ DAZL_TRACE_CAPTURE: '1' }, () => runFixture(fixture()))
  // the run's own result does not depend on capture
  assert.deepEqual(on.leads.map(l => [l.company, l.review_reason, l.event_date]), off.leads.map(l => [l.company, l.review_reason, l.event_date]))
  assert.equal(on.r, off.r)
  const { db, rows } = await storedFor('A')
  const added = rows.filter(r => !before.has(r.id))
  assert.equal(added.length, 1)
  const t = (await getTrace(db, 'A', added[0].id))!
  assert.equal(t.synthetic, false); assert.equal(t.redacted, true); assert.equal(t.path, 'scan.discovery'); assert.equal(t.v, TRACE_VERSION)
  const kinds = t.spans.map(s => `${s.kind}:${s.name}`)
  for (const k of ['model:anthropic.completeDetailed', 'http:tinyfish.search', 'http:tinyfish.fetch', 'page:verifier.fetch']) assert.ok(kinds.includes(k), `${k} in ${kinds.join(',')}`)
  const stages = t.spans.filter(s => s.kind === 'model').map(s => (s.input as { stage: string }).stage)
  assert.ok(stages.includes('search_queries') && stages.includes('extraction'), stages.join(','))
  const json = JSON.stringify(t)
  for (const secret of ['sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', 'tf-test', 'founders@querix.example', '7946 0958', 'Dana Synthetic']) assert.ok(!json.includes(secret), secret)
  assert.match(json, /p[0-9a-f]{10}@querix\.example/)   // the contact domain is kept, the mailbox is not
  // a captured trace is a recorded World: it replays offline to the same verdict, against the redacted copy
  const world = validateWorld(worldFromTrace(t, 'captured'))
  assert.equal(world.origin, 'recorded')
  const kase: Case = { v: 1, kind: 'dazl.case', id: 'captured', title: 'captured', path: 'scan.discovery', world: '-', provenance: { from_trace: t.id, synthetic: false, why: 'test' },
    input: { request: t.input.request, icp: t.input.icp }, expect: { leads: [{ company: 'Querix', outcome: 'verified' }] } }
  const replay = await replayCase(kase, world)
  assert.equal(replay.leads.find(l => l.company === 'Querix')?.review_reason, null)
  assert.deepEqual(replay.misses, [])                    // the captured World answers every call the run makes
})

test('a failure to record or store never reaches the run: finish logs and returns null', async () => {
  const c = beginScanTrace({ id: 'j-fail', user_id: 'A', attempts: 1 }, {}, { env: { DAZL_TRACE_CAPTURE: '1' }, db: () => Promise.reject(new Error('store down')) })!
  const errs: string[] = []; const orig = console.error; console.error = (m: string) => { errs.push(m) }
  try { assert.equal(await c.finish('done'), null) } finally { console.error = orig }
  assert.equal(errs.length, 1); assert.match(errs[0], /"trace_capture":"failed"/); assert.ok(!errs[0].includes('sk-'))
  // a caller that already records (a replay) is never captured twice
  assert.equal(beginScanTrace({ id: 'j', user_id: 'A', attempts: 1 }, { trace: new TraceRecorder() }, { env: { DAZL_TRACE_CAPTURE: '1' } }), null)
})

test('bounded: a stalled response body or a hung store never keeps runJob from returning', async () => {
  // a body that never ends: the trace is still stored, with what was read, once SETTLE has passed
  const raw = new Database(':memory:'); migrateAllSqlite(raw); const db = sqliteDb(raw)
  const c = beginScanTrace({ id: 'j-stall', user_id: 'tenant-S', attempts: 1 }, { fetchImpl: (async () => new Response(new ReadableStream({ start(ctl) { ctl.enqueue(new TextEncoder().encode('partial')) } }))) as typeof fetch },
    { env: { DAZL_TRACE_CAPTURE: '1' }, db: async () => db, settleMs: 50, finishMs: 2_000 })!
  const stalled = await c.deps.fetchImpl!('https://stall.example/x')
  void stalled.body?.cancel().catch(() => {})                     // the caller is done with it; the recorder's copy never ends
  const t0 = Date.now(); const id = await c.finish('done')
  assert.ok(Date.now() - t0 < 1_500, 'finish returned after the settle bound'); assert.ok(id)
  const kept = (await getTrace(db, 'tenant-S', id!))!.spans[0]
  assert.deepEqual([kept.name, (kept.output as { body: string }).body, (kept.output as { truncated?: boolean }).truncated], ['http', 'partial', true])
  // a store that never answers: finish gives up at its bound and returns null
  const hung = beginScanTrace({ id: 'j-hang', user_id: 'tenant-S', attempts: 1 }, {}, { env: { DAZL_TRACE_CAPTURE: '1' }, db: () => new Promise<never>(() => {}), finishMs: 100 })!
  const errs: string[] = []; const orig = console.error; console.error = (m: string) => { errs.push(m) }
  try { const t1 = Date.now(); assert.equal(await hung.finish('done'), null); assert.ok(Date.now() - t1 < 1_000) } finally { console.error = orig }
  assert.match(errs.join('\n'), /"error":"timeout"/)
  await db.close()
})

// The paths #463 left unrecorded: the CSV company job and the news search (adapter sources share the news.get/source.get
// SafeGet recording and are covered by the runner hook; no fixture selects adapters).
test('ON: a CSV company job is recorded too - its model call and the verifier page fetch', async () => {
  const master = randomBytes(32); process.env.DAZL_MASTER_KEY = master.toString('base64')
  const db = new Database(':memory:'); migrateScan(db); migrateKeys(db); migratePlans(db); migrateCsv(db)
  saveKey(db, 'csv-tenant', 'anthropic', 'sk-ant-api03-CSVCSVCSVCSVCSVCSVCSVCSVCSVCSVCS', master)
  queuePendingRows(db, 'csv-tenant', createBatch(db, 'csv-tenant', ['acme.example']))
  const job = claimKeyedJob(db)!
  const recent = daysAgo(30), QUOTE = 'Acme announced it is hiring three account executives for the Toronto market'
  const lead = { name: '', company: 'Acme', contact: null, signal: 'Hiring AEs', source_url: 'https://news.example/acme', score: 80, excerpt: QUOTE, event_date: recent }
  const providers = { anthropic: { research: async () => ({ text: JSON.stringify([lead]), citedUrls: ['https://news.example/acme'] }) }, openai: { research: async () => ({ text: '', citedUrls: [] }) } } as never
  const r = await withEnv({ DAZL_TRACE_CAPTURE: '1' }, () => runJob(db, job, { providers, master, fetchPage: async () => ({ text: `News ${recent.slice(0, 4)}. ${QUOTE}. More text.`, title: 'Acme news', retrievedAt: 1_700_000_000 }) }))
  assert.equal(r, 'done')
  const { db: store, rows } = await storedFor('csv-tenant')
  assert.equal(rows.length, 1); assert.equal(rows[0].job_id, job.id)
  const t = (await getTrace(store, 'csv-tenant', rows[0].id))!
  assert.deepEqual(t.spans.slice(0, 2).map(s => `${s.kind}:${s.name}`), ['model:anthropic.research', 'page:verifier.fetch'])
  // after them, the post-scan enrichment's own fetches are recorded as well; under the test fence they fail, never egress
  for (const s of t.spans.slice(2)) { assert.equal(`${s.kind}:${s.name}`, 'http:http'); assert.match(s.error ?? '', /net fence/) }
  assert.ok(!JSON.stringify(t).includes('CSVCSVCSV'))
})

test('ON: a run that searched news records it, and its World replays with news on and no world miss', async () => {
  const d = daysAgo(10); const page = { title: 'Querix raises seed', text: PAGE_TEXT(d) }
  const gdelt = JSON.stringify({ articles: [{ url: URL_, title: 'Querix raises seed', seendate: `${d.replace(/-/g, '')}T100000Z` }] })
  const f: Fixture = { ...fixture(), deps: { newsHttp: async () => ({ status: 200, body: gdelt }) } }
  const before = new Set((await storedFor('A')).rows.map(r => r.id))
  await withEnv({ DAZL_TRACE_CAPTURE: '1' }, () => runFixture({ ...f, own: { [URL_]: page }, tfPages: { [URL_]: page } }))
  const { db, rows } = await storedFor('A')
  const t = (await getTrace(db, 'A', rows.find(r => !before.has(r.id))!.id))!
  const news = t.spans.filter(s => s.kind === 'source_http' && s.name === 'news.get')
  assert.ok(news.length >= 1, t.spans.map(s => s.name).join(','))
  assert.match(String((news[0].input as { url: string }).url), /^https:\/\/api\.gdeltproject\.org\//)
  const world = validateWorld(worldFromTrace(t, 'captured-news'))
  assert.equal(world.news, true)
  const kase: Case = { v: 1, kind: 'dazl.case', id: 'captured-news', title: 'n', path: 'scan.discovery', world: '-', provenance: { from_trace: t.id, synthetic: false, why: 'test' },
    input: { request: t.input.request, icp: t.input.icp }, expect: { leads: [{ company: 'Querix', outcome: 'verified' }] } }
  const replay = await replayCase(kase, world)
  assert.deepEqual(replay.misses, [])
  assert.ok(replay.trace.spans.some(s => s.name === 'news.get'), 'the replay searched news too, from the World')
  assert.equal(replay.leads.find(l => l.company === 'Querix')?.review_reason, null)
})

test('ON: adapter sources the job selected are recorded through the same SafeGet (RSS feed)', async () => {
  const feed = 'https://feeds.example/startups.xml'
  const seen: string[] = []
  const sourceHttp = async (url: string) => { seen.push(url); return { status: 200, body: '<?xml version="1.0"?><rss><channel><title>t</title></channel></rss>' } }
  const before = new Set((await storedFor('A')).rows.map(r => r.id))
  await withEnv({ DAZL_TRACE_CAPTURE: '1' }, () => runFixture({ ...fixture(), sources: { adapters: ['rss'], feeds: [feed] }, deps: { sourceHttp } }))
  assert.ok(seen.includes(feed), `the adapter ran: ${seen.join(',')}`)
  const { db, rows } = await storedFor('A')
  const t = (await getTrace(db, 'A', rows.find(r => !before.has(r.id))!.id))!
  const src = t.spans.filter(s => s.kind === 'source_http' && s.name === 'source.get')
  assert.ok(src.some(s => (s.input as { url: string }).url === feed), t.spans.map(s => s.name).join(','))
  assert.equal((src.find(s => (s.input as { url: string }).url === feed)!.output as { status: number }).status, 200)
})

const synth = (over: Partial<Trace> = {}): Trace => ({ v: TRACE_VERSION, kind: 'dazl.trace', id: 't', path: 'scan.discovery', synthetic: false, redacted: false, started_at: '2026-10-20T00:00:00Z',
  agent: { commit: null }, input: { request: 'r', as_of: '2026-10-20T00:00:00Z' }, spans: [], ...over })

test('redaction removes secrets wherever they appear: keys, bearer tokens, JWTs, credential URL parameters; ordinary text survives', () => {
  const t = redactTrace(synth({ spans: [{ id: 's0', seq: 0, kind: 'http', name: 'http', start_ms: 0, duration_ms: 1,
    input: { url: 'https://api.example/x?api_key=AbC123SecretValue&page=2', body: '{"token":"tok_live_123456","access_token": "zzz-999-yyy","max_tokens":300}', prompt: 'use sk-ant-api03-REALLOOKINGKEYVALUE1234 and sk-proj-abcdefghijklmnopqrstuvwx and ghp_abcdefghijklmnopqrstuvwxyz0123 then Authorization: Bearer abc.def-ghi' },
    output: { text: 'jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.c2lnbmF0dXJlLXZhbHVl and AKIAABCDEFGHIJKLMNOP; design: tidy; tokens: 5; password=hunter2' } }] }), Buffer.alloc(16, 1))
  const j = JSON.stringify(t)
  for (const s of ['AbC123SecretValue', 'tok_live_123456', 'zzz-999-yyy', 'REALLOOKINGKEYVALUE1234', 'sk-proj-abcdefghijklmnopqrstuvwx', 'ghp_abcdefghijklmnopqrstuvwxyz0123', 'abc.def-ghi', 'eyJhbGciOiJIUzI1NiJ9', 'AKIAABCDEFGHIJKLMNOP', 'hunter2']) assert.ok(!j.includes(s), s)
  for (const s of ['page=2', '\\"max_tokens\\":300', 'design: tidy', 'tokens: 5']) assert.ok(j.includes(s), s)
})

test('size caps: long strings are cut and counted; a trace still too large keeps only span metadata, and says so', () => {
  const big = 'x'.repeat(MAX_STRING_CHARS + 10)
  const c = capTrace(synth({ spans: [{ id: 's0', seq: 0, kind: 'page', name: 'verifier.fetch', start_ms: 0, duration_ms: 1, input: { url: 'https://p.example/a' }, output: { text: big } }] }))
  assert.equal((c.spans[0].output as { text: string }).text.length, MAX_STRING_CHARS + '…[truncated]'.length)
  assert.equal(c.capture?.truncated_strings, 1); assert.equal(c.capture?.spans_metadata_only, undefined)
  const many = Array.from({ length: 60 }, (_, i) => ({ id: `s${i}`, seq: i, kind: 'page' as const, name: 'verifier.fetch', start_ms: 0, duration_ms: 1, input: { url: `https://p.example/${i}` }, output: { text: big } }))
  const huge = capTrace(synth({ spans: many }))
  assert.equal(huge.capture?.spans_metadata_only, true)
  assert.deepEqual(huge.spans[3], { ...many[3], input: { url: 'https://p.example/3', stage: null }, output: null })
})

// All marker values below are invented: none is a credential or a real address.
const MARK_TOKEN = 'SYNTHETIC_PRIVATE_TOKEN', MARK_MAIL = 'alice@example.test'
const memDb = () => { const raw = new Database(':memory:'); migrateAllSqlite(raw); return sqliteDb(raw) }

test('redaction covers every persisted string: a recorded call\'s error text, through the real recorder and capture store', async () => {
  const db = memDb()
  const inner = (async () => { throw new Error(`token=${MARK_TOKEN} recipient=${MARK_MAIL}`) }) as unknown as typeof fetch
  const c = beginScanTrace({ id: 'j-err', user_id: 'A', attempts: 1, query: `find ${MARK_MAIL}` }, { fetchImpl: inner }, { env: { DAZL_TRACE_CAPTURE: '1' }, db: async () => db })!
  await assert.rejects(c.deps.fetchImpl!('https://api.example/x'), /recipient/) // the run still sees the original error
  assert.match(c.recorder.spans[0].error!, new RegExp(MARK_TOKEN))           // and the in-memory span holds it, unredacted
  const id = (await c.finish('failed'))!
  const row = (await db.get<{ trace: string }>('SELECT trace FROM scan_traces WHERE id = ?', [id]))!
  for (const m of [MARK_TOKEN, MARK_MAIL, 'alice']) assert.ok(!row.trace.includes(m), `stored trace holds ${m}`)
  const t = JSON.parse(row.trace) as Trace
  assert.match(t.spans[0].error!, /^token=\[secret\] recipient=p[0-9a-f]{10}@example\.test$/)
  assert.equal(t.redacted, true); assert.equal(t.spans[0].id, 's0'); assert.equal(t.spans[0].kind, 'http')
  // every other free-text field too, not only input/output
  const r = redactTrace(synth({ agent: { commit: null, label: `run for ${MARK_MAIL}` }, capture: { truncated_strings: 0 }, spans: [{ id: 's0', seq: 0, kind: 'page', name: `fetch ${MARK_MAIL}`, start_ms: 0, duration_ms: 1, input: {}, output: null, error: `secret=${MARK_TOKEN}` }] }))
  const j = JSON.stringify(r)
  for (const m of [MARK_TOKEN, MARK_MAIL]) assert.ok(!j.includes(m), m)
  await db.close()
})

test('a store failure logs its class only, never its message (which can quote the refused row)', async () => {
  const err = Object.assign(new Error(`insert refused: ${MARK_MAIL} token=${MARK_TOKEN}`), { code: 'SQLITE_CONSTRAINT' })
  const c = beginScanTrace({ id: 'j-log', user_id: 'A', attempts: 1 }, {}, { env: { DAZL_TRACE_CAPTURE: '1' }, db: () => Promise.reject(err) })!
  const errs: string[] = []; const orig = console.error; console.error = (m: string) => { errs.push(m) }
  try { assert.equal(await c.finish('done'), null) } finally { console.error = orig }
  assert.deepEqual(errs.map(e => JSON.parse(e)), [{ trace_capture: 'failed', job: 'j-log', error: 'Error:SQLITE_CONSTRAINT' }])
})

const lead = (i: number, big: string) => ({ company: big, name: `n${i}`, contact: null, source_url: `https://p.example/${i}`, excerpt: big, event_date: null, review_reason: null, confidence: null })
const bytes = (t: Trace) => Buffer.byteLength(JSON.stringify(t))

test('the byte cap bounds the WHOLE trace: lead output, many short spans, multibyte text; drops are recorded and refuse replay', () => {
  // 100 leads with 49,000-char company and excerpt, no spans (was 9.8 MB under a 2 MB cap)
  const leads = capTrace(synth({ output: { status: 'done', leads: Array.from({ length: 100 }, (_, i) => lead(i, 'c'.repeat(49_000))) } }))
  assert.ok(bytes(leads) <= MAX_TRACE_BYTES, String(bytes(leads)))
  assert.deepEqual([leads.output?.leads.length, leads.capture?.leads_omitted, leads.capture?.complete], [0, 100, false])
  // many short spans: metadata alone is over, so spans go too (count kept)
  const short = Array.from({ length: 40_000 }, (_, i) => ({ id: `s${i}`, seq: i, kind: 'http' as const, name: 'http', start_ms: 0, duration_ms: 1, input: { url: `https://p.example/${i}/${'p'.repeat(40)}` }, output: { status: 200 } }))
  const many = capTrace(synth({ spans: short }))
  assert.ok(bytes(many) <= MAX_TRACE_BYTES, String(bytes(many)))
  assert.deepEqual([many.spans.length, many.capture?.spans_omitted, many.capture?.complete], [0, 40_000, false])
  // multibyte: 4-byte emoji and 2-byte letters count as bytes, not characters; a cut never splits a surrogate pair
  const emoji = '😀'.repeat(30_000), accents = 'é'.repeat(60_000)
  for (const max of [MAX_TRACE_BYTES, 300_000, 20_000]) {
    const u = capTrace(synth({ input: { request: 'x' + emoji, as_of: '2026-10-20T00:00:00Z' }, spans: [{ id: 's0', seq: 0, kind: 'page', name: 'verifier.fetch', start_ms: 0, duration_ms: 1, input: { url: 'https://p.example/u' }, output: { text: accents, [emoji]: 1 } }], output: { status: 'done', leads: [lead(0, emoji)] } }), max)
    assert.ok(bytes(u) <= max, `${bytes(u)} > ${max}`)
    assert.ok(!/\\ud[89a-f][0-9a-f]{2}/i.test(JSON.stringify(u)), 'lone surrogate') // JSON.stringify escapes an unpaired one as \\udXXX
    assert.equal(u.capture?.complete, false); assert.equal(u.capture?.max_bytes, max)
  }
  // a bound too small for even the header stores nothing rather than overflow
  assert.throws(() => capTrace(synth(), 50), /over the byte bound/)
  // a trace that fit untouched says it is complete; any drop makes worldFromTrace refuse it
  const whole = capTrace(redactTrace(synth()))
  assert.equal(whole.capture?.complete, true); assert.doesNotThrow(() => worldFromTrace(whole))
  for (const cut of [leads, many]) assert.throws(() => worldFromTrace({ ...cut, redacted: true }), (e: unknown) => e instanceof WorldError && /incomplete capture/.test((e as Error).message))
})

test('the exact bytes the capture store inserts never exceed MAX_TRACE_BYTES', async () => {
  const db = memDb()
  const c = beginScanTrace({ id: 'j-big', user_id: 'A', attempts: 1, query: 'q' }, {}, { env: { DAZL_TRACE_CAPTURE: '1' }, db: async () => db })!
  for (let i = 0; i < 60; i++) c.recorder.spans.push({ id: `s${i}`, seq: i, kind: 'page', name: 'verifier.fetch', start_ms: 0, duration_ms: 1, input: { url: `https://p.example/${i}` }, output: { text: '😀é'.repeat(24_000) } })
  const id = (await c.finish('done'))!
  const row = (await db.get<{ trace: string; bytes: number }>('SELECT trace, bytes FROM scan_traces WHERE id = ?', [id]))!
  assert.equal(Buffer.byteLength(row.trace), row.bytes)
  assert.ok(row.bytes <= MAX_TRACE_BYTES, String(row.bytes))
  assert.equal((JSON.parse(row.trace) as Trace).capture?.complete, false)
  await db.close()
})

test('recorder: the caller gets the response before its body is read; bodies are capped; a model provider API records no body', async () => {
  const rec = new TraceRecorder()
  let pulled = 0
  const stream = () => new ReadableStream({ pull(c) { pulled++; if (pulled > 50) c.close(); else c.enqueue(new TextEncoder().encode('y'.repeat(10_000))) } })
  const f = rec.fetch((async () => new Response(stream(), { status: 200 })) as typeof fetch, () => 25_000)
  const res = await f('https://data.example/big')
  assert.equal(res.status, 200)
  assert.equal((await res.text()).length, 500_000)       // the caller still reads the whole, unread body
  await rec.settled()
  assert.deepEqual([(rec.spans[0].output as { body: string }).body.length, (rec.spans[0].output as { truncated?: boolean }).truncated], [25_000, true])
  const p = rec.fetch((async () => new Response('{"content":"reply"}', { status: 200 })) as typeof fetch)
  await p('https://api.anthropic.com/v1/messages', { method: 'POST', body: '{"prompt":"secret prompt"}' })
  await rec.settled()
  assert.deepEqual([rec.spans[1].input.body, (rec.spans[1].output as { body: unknown }).body], [null, null])
})

// Tenant isolation and retention, on both stores.
const capture = async (db: Db, tenant: string, job: string, atSec: number, env: Record<string, string> = { DAZL_TRACE_CAPTURE: '1' }) =>
  beginScanTrace({ id: job, user_id: tenant, attempts: 1, query: `q ${tenant}` }, {}, { env, db: async () => db, now: () => atSec * 1000 })!.finish('done')
const DAY = 86_400
const NOW = 1_800_000_000

bothEngines('tenant isolation: a tenant lists and reads only its own traces; another tenant\'s id answers like an unknown one', async ({ db }) => {
  const a = (await capture(db, 'tenant-A', 'job-a', NOW))!
  const b = (await capture(db, 'tenant-B', 'job-b', NOW))!
  assert.deepEqual((await listTraces(db, 'tenant-A')).map(r => [r.id, r.job_id]), [[a, 'job-a']])
  assert.deepEqual((await listTraces(db, 'tenant-B')).map(r => [r.id, r.job_id]), [[b, 'job-b']])
  assert.equal(await getTrace(db, 'tenant-B', a), null)
  assert.equal(await getTrace(db, 'tenant-A', b), null)
  assert.equal((await getTrace(db, 'tenant-A', a))?.input.request, 'q tenant-A')
  assert.deepEqual(await listTraces(db, 'tenant-C'), [])
})

bothEngines('retention: a capture deletes only its own tenant\'s expired rows; the scheduled purge deletes everyone\'s, capture on or off', async ({ db }) => {
  await capture(db, 'tenant-A', 'old-a', NOW - 20 * DAY)
  await capture(db, 'tenant-B', 'old-b', NOW - 20 * DAY)
  await capture(db, 'tenant-B', 'edge-b', NOW - 13 * DAY)
  await capture(db, 'tenant-A', 'new-a', NOW)                                   // purges A's expired rows only
  assert.deepEqual((await listTraces(db, 'tenant-A')).map(r => r.job_id), ['new-a'])
  assert.deepEqual((await listTraces(db, 'tenant-B')).map(r => r.job_id).sort(), ['edge-b', 'old-b'])
  assert.equal(await purgeExpiredTraces(db, {}, NOW * 1000), 1)                // capture OFF: default 14 days still applies
  assert.deepEqual((await listTraces(db, 'tenant-B')).map(r => r.job_id), ['edge-b'])
  assert.equal(await purgeExpiredTraces(db, { DAZL_TRACE_RETENTION_DAYS: '7' }, NOW * 1000), 1)   // shorter retention takes effect at once
  assert.deepEqual(await listTraces(db, 'tenant-B'), [])
  assert.deepEqual((await listTraces(db, 'tenant-A')).map(r => r.job_id), ['new-a'])
  assert.equal(await purgeExpiredTraces(db, { DAZL_TRACE_RETENTION_DAYS: 'nonsense' }, NOW * 1000), 0) // invalid: the default, never "keep forever"
})
