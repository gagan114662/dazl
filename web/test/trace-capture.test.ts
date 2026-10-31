// Production trace capture (lib/evals/capture.ts): OFF by default; when on, the real runJob's external calls are recorded,
// redacted, size-capped and stored tenant-scoped in the app's own store, and purged after the configured retention.
// Every page, company, address and key here is SYNTHETIC.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runFixture, daysAgo, type Fixture } from './helpers/acceptance-harness.ts'
import { bothEngines } from './helpers/engines.ts'
import Database from 'better-sqlite3'
import { getDb, setDb, sqliteDb, type Db } from '../lib/db/client.ts'
import { migrateAllSqlite } from '../lib/db/sqlite-migrations.ts'
import { beginScanTrace, capTrace, cutStrings, getTrace, listTraces, purgeExpiredTraces, traceCaptureConfig, DEFAULT_RETENTION_DAYS, MAX_STRING_CHARS, MAX_TRACE_BYTES, PURGE_LIMIT } from '../lib/evals/capture.ts'
import { StaleLeaseWrite, tryLease } from '../lib/shared/lease.ts'
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
// The event day sits in the evidence sentence itself, bound to the company (#460 event-date binding on main: a day elsewhere on
// the page, or a publication stamp, no longer dates the event).
const PAGE_TEXT = (d: string) => `Querix raised a seed round on ${d}: Querix, a London B2B SaaS startup, raised a 3m GBP seed round this month. Press: founders@querix.example or +44 20 7946 0958. ${'The company sells workflow software to finance teams in London. '.repeat(12)}`
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
  assert.deepEqual(traceCaptureConfig({}), { enabled: false, retentionDays: 14, reason: 'off', purge: false })
  assert.deepEqual(traceCaptureConfig({ DAZL_TRACE_CAPTURE: 'true' }), { enabled: false, retentionDays: 14, reason: 'off', purge: false })   // only "1" turns it on
  assert.deepEqual(traceCaptureConfig({ DAZL_TRACE_CAPTURE: '1' }), { enabled: true, retentionDays: DEFAULT_RETENTION_DAYS, reason: 'on', purge: true })
  assert.deepEqual(traceCaptureConfig({ DAZL_TRACE_CAPTURE: '1', DAZL_TRACE_RETENTION_DAYS: '7' }), { enabled: true, retentionDays: 7, reason: 'on', purge: true })
  // a retention is a plain decimal whole number of days: forms Number() would read (hex, exponent, sign, decimal point) are invalid
  for (const bad of ['0', '-1', '1.5', 'abc', '366', ' '.repeat(0) + 'NaN', '0x10', '1e1', '+7', '7.0', '-7', '1_0', '14 days', '7,', 'Infinity'])
    assert.deepEqual(traceCaptureConfig({ DAZL_TRACE_CAPTURE: '1', DAZL_TRACE_RETENTION_DAYS: bad }), { enabled: false, retentionDays: 14, reason: 'invalid_retention', purge: false }, bad)
  for (const [ok, days] of [['7', 7], ['007', 7], [' 14 ', 14], ['365', 365], ['1', 1]] as const)
    assert.deepEqual(traceCaptureConfig({ DAZL_TRACE_CAPTURE: '1', DAZL_TRACE_RETENTION_DAYS: ok }), { enabled: true, retentionDays: days, reason: 'on', purge: true }, ok)
  for (const bad of ['0x10', '1e1', '+7'])
    assert.deepEqual(traceCaptureConfig({ DAZL_TRACE_RETENTION_DAYS: bad }), { enabled: false, retentionDays: 14, reason: 'off', purge: false }, bad)
  // The purge runs only under a retention somebody chose: capture on (its retention, 14 by default), or an explicit valid
  // DAZL_TRACE_RETENTION_DAYS with capture off. Unset, off, or invalid: no retention policy, nothing is deleted.
  assert.deepEqual(traceCaptureConfig({ DAZL_TRACE_RETENTION_DAYS: '3' }), { enabled: false, retentionDays: 3, reason: 'off', purge: true })
  assert.deepEqual(traceCaptureConfig({ DAZL_TRACE_CAPTURE: '0', DAZL_TRACE_RETENTION_DAYS: 'abc' }), { enabled: false, retentionDays: 14, reason: 'off', purge: false })
})

// The scan itself runs on the harness's own SQLite (as the app does before cutover); the trace store is the shared Db
// layer, pointed at each engine in turn (setDb), as the tick harness does.
const withStore = async (db: Db, fn: () => Promise<void>) => { setDb(db); try { await fn() } finally { setDb(null) } }
bothEngines('OFF (default): beginScanTrace returns null, the run gets exactly its own deps, and nothing is stored', async ({ db }) => withStore(db, async () => {
  const deps = { fetchImpl: globalThis.fetch }
  assert.equal(beginScanTrace({ id: 'j', user_id: 'A', attempts: 1 }, deps, { env: {} }), null)
  const before = (await storedFor('A')).rows.length
  const x = await withEnv({ DAZL_TRACE_CAPTURE: undefined }, () => runFixture(fixture()))
  assert.equal(x.leads.find(l => l.company === 'Querix')?.review_reason, null)
  assert.equal((await storedFor('A')).rows.length, before)
}))

bothEngines('ON: the real runJob is recorded, redacted and stored for its own tenant; no key or raw contact reaches the store; the run is unchanged; the replay reaches the run\'s verdicts', async ({ db }) => withStore(db, async () => {
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
  // the same verdicts as the original run, lead for lead (R3-12): not just "Querix was not held"
  const verdicts = (ls: { company: string; review_reason: string | null; event_date: string | null }[]) => ls.map(l => [l.company, l.review_reason, l.event_date]).sort()
  assert.ok(on.leads.length > 0); assert.deepEqual(verdicts(replay.leads), verdicts(on.leads))
  assert.deepEqual(replay.misses, [])                    // the captured World answers every call the run makes
}))

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

// Bodies the RECORDER cut (before capTrace ever runs) make the stored capture incomplete too, through the real
// beginScanTrace -> store -> getTrace path; worldFromTrace refuses the stored result. A small complete answer is the control.
test('a body cut while recording (cap, failed read, settle timeout) marks the stored capture incomplete and refuses replay', async () => {
  const db = memDb()
  const stored = async (job: string, body: () => BodyInit, settleMs = 2_000) => {
    const c = beginScanTrace({ id: job, user_id: 'A', attempts: 1, query: 'q' }, { fetchImpl: (async () => new Response(body())) as typeof fetch }, { env: { DAZL_TRACE_CAPTURE: '1' }, db: async () => db, settleMs, finishMs: 5_000 })!
    const res = await c.deps.fetchImpl!('https://synthetic.example/x')
    void res.body?.cancel().catch(() => {})                          // the caller is done with its copy
    return (await getTrace(db, 'A', (await c.finish('done'))!))!
  }
  const paths = {
    over_cap: await stored('j-cap', () => 'y'.repeat(200_010)),                                                          // the recorder's 200k body cap
    read_failed: await stored('j-err', () => new ReadableStream({ start(ctl) { ctl.enqueue(new TextEncoder().encode('par')); ctl.error(new Error('reset')) } })),
    settle_timeout: await stored('j-stall', () => new ReadableStream({ start(ctl) { ctl.enqueue(new TextEncoder().encode('partial')) } }), 10), // never closes
  }
  for (const [path, t] of Object.entries(paths)) {
    assert.equal((t.spans[0].output as { truncated?: boolean }).truncated, true, path)
    assert.deepEqual([t.capture?.complete, t.capture?.bodies_truncated], [false, 1], path)
    assert.throws(() => worldFromTrace(t), (e: unknown) => e instanceof WorldError && /response bodies cut while recording/.test((e as Error).message), path)
    // even with the capture marker stripped, the span's own marker refuses it
    assert.throws(() => worldFromTrace({ ...t, capture: undefined }), /response bodies cut while recording \(s0\)/, path)
  }
  assert.equal((paths.settle_timeout.spans[0].output as { body: string }).body, 'partial')
  // control: a small answer read to its end is complete and replays
  const whole = await stored('j-ok', () => 'a complete small answer')
  assert.deepEqual([(whole.spans[0].output as { body: string }).body, (whole.spans[0].output as { truncated?: boolean }).truncated, whole.capture?.complete, whole.capture?.bodies_truncated], ['a complete small answer', undefined, true, undefined])
  assert.deepEqual(validateWorld(worldFromTrace(whole)).http['https://synthetic.example/x'], { status: 200, body: 'a complete small answer' })
  await db.close()
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

bothEngines('retention: a capture deletes only its own tenant\'s expired rows; the scheduled purge deletes nothing unless capture is on or a retention was set explicitly', async ({ db }) => {
  await capture(db, 'tenant-A', 'old-a', NOW - 20 * DAY)
  await capture(db, 'tenant-B', 'old-b', NOW - 20 * DAY)
  await capture(db, 'tenant-B', 'edge-b', NOW - 13 * DAY)
  await capture(db, 'tenant-A', 'new-a', NOW)                                   // purges A's expired rows only
  assert.deepEqual((await listTraces(db, 'tenant-A')).map(r => r.job_id), ['new-a'])
  assert.deepEqual((await listTraces(db, 'tenant-B')).map(r => r.job_id).sort(), ['edge-b', 'old-b'])
  // no retention policy anybody chose (PR #463 review): unset, off, on with an invalid retention, an invalid retention alone
  for (const env of [{}, { DAZL_TRACE_CAPTURE: '0' }, { DAZL_TRACE_CAPTURE: 'true' }, { DAZL_TRACE_CAPTURE: '1', DAZL_TRACE_RETENTION_DAYS: 'nonsense' }, { DAZL_TRACE_CAPTURE: '1', DAZL_TRACE_RETENTION_DAYS: '0' }, { DAZL_TRACE_RETENTION_DAYS: 'nonsense' }])
    assert.equal(await purgeExpiredTraces(db, { env, now: NOW * 1000 }), 0, JSON.stringify(env))
  assert.deepEqual((await listTraces(db, 'tenant-B')).map(r => r.job_id).sort(), ['edge-b', 'old-b'])
  assert.equal(await purgeExpiredTraces(db, { env: { DAZL_TRACE_CAPTURE: '1' }, now: NOW * 1000 }), 1)   // capture ON: its retention (14 by default) applies to everyone
  assert.deepEqual((await listTraces(db, 'tenant-B')).map(r => r.job_id), ['edge-b'])
  assert.equal(await purgeExpiredTraces(db, { env: { DAZL_TRACE_RETENTION_DAYS: '7' }, now: NOW * 1000 }), 1)   // an explicit retention with capture off: the stated policy, at once
  assert.deepEqual(await listTraces(db, 'tenant-B'), [])
  assert.deepEqual((await listTraces(db, 'tenant-A')).map(r => r.job_id), ['new-a'])
  assert.equal(await purgeExpiredTraces(db, { env: { DAZL_TRACE_CAPTURE: '1', DAZL_TRACE_RETENTION_DAYS: '7' }, now: NOW * 1000 }), 0)   // nothing left to expire: idempotent
})

// Bounded and fenced like the session reap (council review of #463): at most PURGE_LIMIT rows per scheduled purge, oldest
// first, inside one transaction that takes the lease fence first.
bothEngines('retention purge is bounded (1200 expired rows go 500/500/200/0 across ticks, oldest first) and fenced (a lost lease deletes nothing)', async ({ db }) => {
  assert.equal(PURGE_LIMIT, 500)
  await db.tx(function* (t) {
    for (let i = 0; i < 1200; i++) yield* t.run('INSERT INTO scan_traces (id, tenant_id, job_id, attempt, created_at, bytes, trace) VALUES (?, ?, ?, 1, ?, 2, ?)', [`e${i}`, `tenant-${i % 3}`, `job-${i}`, NOW - 20 * DAY - i, '{}'])
    yield* t.run('INSERT INTO scan_traces (id, tenant_id, job_id, attempt, created_at, bytes, trace) VALUES (?, ?, ?, 1, ?, 2, ?)', ['fresh', 'tenant-0', 'fresh', NOW, '{}'])
  })
  const env = { DAZL_TRACE_CAPTURE: '1' }
  const count = async () => Number((await db.get<{ n: number | string }>('SELECT count(*) AS n FROM scan_traces'))!.n)
  const oldest = async () => (await db.get<{ created_at: number | string }>('SELECT min(created_at) AS created_at FROM scan_traces'))!.created_at
  assert.equal(await purgeExpiredTraces(db, { env, now: NOW * 1000 }), 500); assert.equal(await count(), 701)
  assert.equal(Number(await oldest()), NOW - 20 * DAY - 699, 'the 500 oldest went first')
  assert.equal(await purgeExpiredTraces(db, { env, now: NOW * 1000 }), 500); assert.equal(await count(), 201)
  assert.equal(await purgeExpiredTraces(db, { env, now: NOW * 1000 }), 200); assert.equal(await count(), 1)
  assert.equal(await purgeExpiredTraces(db, { env, now: NOW * 1000 }), 0); assert.equal(await count(), 1)
  assert.equal((await db.get<{ id: string }>('SELECT id FROM scan_traces'))!.id, 'fresh')
  // a smaller bound is honoured; a silly one is clamped to at least 1
  await db.run('INSERT INTO scan_traces (id, tenant_id, job_id, attempt, created_at, bytes, trace) VALUES (?, ?, ?, 1, ?, 2, ?)', ['e-a', 't', 'j', NOW - 30 * DAY, '{}'])
  await db.run('INSERT INTO scan_traces (id, tenant_id, job_id, attempt, created_at, bytes, trace) VALUES (?, ?, ?, 1, ?, 2, ?)', ['e-b', 't', 'j', NOW - 30 * DAY, '{}'])
  assert.equal(await purgeExpiredTraces(db, { env, now: NOW * 1000, limit: 0 }), 1)
  // fenced: a tick that lost its lease deletes nothing - a fence that refuses (StaleLeaseWrite) and a real lease that was released
  await db.run('INSERT INTO scan_traces (id, tenant_id, job_id, attempt, created_at, bytes, trace) VALUES (?, ?, ?, 1, ?, 2, ?)', ['e-c', 't', 'j', NOW - 30 * DAY, '{}'])
  const before = await count()
  await assert.rejects(purgeExpiredTraces(db, { env, now: NOW * 1000, fence: function* () { throw new StaleLeaseWrite('internal-tick', 1) } }), StaleLeaseWrite)
  assert.equal(await count(), before)
  const lease = (await tryLease(db, 'internal-tick', { ttlMs: 60_000, stepBudgetMs: 1_000, heartbeat: false }))!
  await lease.release()
  await assert.rejects(purgeExpiredTraces(db, { env, now: NOW * 1000, fence: t => lease.fence(t) }), StaleLeaseWrite)
  assert.equal(await count(), before)
  // a live lease's fence lets the purge through
  const live = (await tryLease(db, 'internal-tick', { ttlMs: 60_000, stepBudgetMs: 1_000, heartbeat: false }))!
  try { assert.equal(await purgeExpiredTraces(db, { env, now: NOW * 1000, fence: t => live.fence(t) }), 2) } finally { await live.release() }
  assert.equal(await count(), 1)
})

// ---- Credential redaction as a CLASS (PR #463 review): credential-NAMED fields wherever they sit (nested objects, arrays,
// JSON in a string, URL query parameters, object keys, `k: v` / `k=v` in prose and errors) and known token FAMILIES.
// Every value below is an invented alphabetic marker: not one is a credential, key, cookie or real token.
const CRED = {
  url_refresh: 'syntheticurlrefreshtokenmarker', body_secret: 'syntheticrequestbodysecretmarker',
  refresh: 'syntheticrefreshtokenmarker', access: 'syntheticaccesstokenmarker', client_secret: 'syntheticclientsecretmarker', api_key: 'syntheticapikeymarker',
  apiKey: 'syntheticcamelapikeymarker', password: 'syntheticpasswordmarker', authz: 'syntheticauthorizationmarker', cookie: 'syntheticcookiemarker',
  set_cookie: 'syntheticsetcookiemarker', private_key: 'syntheticprivatekeymarker', nested: 'syntheticnestedsessionmarker', in_array: 'syntheticarraycredentialmarker',
  in_json_string: 'syntheticjsoninstringmarker', in_key: 'syntheticobjectkeycredentialmarker', prompt: 'syntheticpromptcredentialmarker', prompt2: 'syntheticpromptsecondmarker',
  reply: 'syntheticmodelreplykeymarker', error: 'syntheticerrorcredentialmarker', lead: 'syntheticleadexcerptmarker',
  // assigned VALUES (PR #463 review): a quoted value with spaces, and numeric strings under an explicitly credential name
  quoted: 'synthetic credential remainder marker', quoted2: 'synthetic second quoted marker', numeric: '493827', numeric2: '715904',
  // families (shape only; the characters are invented)
  pat: 'github_pat_syntheticfinegrainedmarkervalue', sk_ant: 'sk-ant-syntheticanthropicmarker', sk: 'sk-syntheticopenaimarkervaluexyz', sk_live: 'sk_live_syntheticstripemarker',
  bearer: 'syntheticbearermarkervalue', jwt: 'eyJsyntheticheader.eyJsyntheticpayload.syntheticsignaturepart', ghp: 'ghp_syntheticgithubclassicmarker', gho: 'gho_syntheticgithuboauthmarker',
  slack: 'xoxb-synthetic-slack-marker', aws: 'AKIASYNTHETICMARKERA',
}
const ORDINARY = ['Querix', 'raised a 3m GBP seed round', '2026-10-10', 'page=2', 'q=london+saas', '\\"max_tokens\\":300', '\\"input_tokens\\":12', '\\"expires_in\\":3600', 'keywords', 'press office', 'london']
const RESPONSE = {
  company: 'Querix', excerpt: 'Querix, a London B2B SaaS startup, raised a 3m GBP seed round', event_date: '2026-10-10', page: 2, max_tokens: 300, expires_in: 3600,
  usage: { input_tokens: 12, output_tokens: 3 }, keywords: ['london', 'saas'], author: 'press office',
  refresh_token: CRED.refresh, access_token: CRED.access, client_secret: CRED.client_secret, api_key: CRED.api_key, apiKey: CRED.apiKey, password: CRED.password,
  authorization: `Bearer ${CRED.authz}`, cookie: `sid=${CRED.cookie}; Path=/`, 'set-cookie': `sid=${CRED.set_cookie}; HttpOnly`,
  private_key: `-----BEGIN PRIVATE KEY-----\n${CRED.private_key}\n-----END PRIVATE KEY-----`,
  auth: { session: { id: CRED.nested, expires_in: 3600 } },                    // nested under a credential-named key
  credentials: [{ user: 'bob', token: CRED.in_array }],                         // inside an array
  payload: JSON.stringify({ clientSecret: CRED.in_json_string, company: 'Querix' }), // JSON carried in a string
  [`https://x.example/u?token=${CRED.in_key}`]: 1,                              // an object KEY carrying a credential
  notes: `use ${CRED.pat} or ${CRED.sk_ant} or ${CRED.sk} or ${CRED.sk_live} or Bearer ${CRED.bearer} or ${CRED.jwt} or ${CRED.ghp} or ${CRED.gho} or ${CRED.slack} or ${CRED.aws}`,
  note: `password: "${CRED.quoted}"; otp=${CRED.numeric}; max_tokens=300`,      // prose inside an ordinary field: whole quoted value, numeric credential; the count stays
  token: Number(CRED.numeric2),                                                 // a NUMBER under an explicitly credential name is a secret too
}
const noCredential = (json: string, where: string) => { for (const [k, v] of Object.entries(CRED)) assert.ok(!json.includes(v), `${where}: ${k} survives`) }

bothEngines('credential redaction: no credential-named field or known token family survives in any persisted field (URL, bodies, prompt, reply, error, keys, leads); ordinary output and replay survive', async ({ db }) => {
  await db.run("INSERT INTO scan_jobs (id, user_id, status, business_name, industry, location, attempts) VALUES ('job-red', 'tenant-R', 'running', 'b', 'i', 'l', 1)")
  await db.run("INSERT INTO leads (id, scan_job_id, name, company, signal, source_url, evidence_excerpt, event_date, confidence) VALUES ('L1', 'job-red', 'Dana Synthetic', 'Querix', 'raised a seed round', ?, ?, '2026-10-10', 80)",
    [`https://news.example/q?api_key=${CRED.lead}`, `Querix raised a 3m GBP seed round (token=${CRED.lead})`])
  const inner = (async (input: RequestInfo | URL) => {
    if (String(input).includes('/fail')) throw new Error(`refresh_token=${CRED.error} ${CRED.pat} Authorization: Bearer ${CRED.bearer} password: "${CRED.quoted}" otp=${CRED.numeric}`)
    return new Response(JSON.stringify(RESPONSE), { status: 200 })
  }) as typeof fetch
  const c = beginScanTrace({ id: 'job-red', user_id: 'tenant-R', attempts: 1, query: `find london saas; refresh_token=${CRED.prompt}; password: "${CRED.quoted}"; password=${CRED.numeric}`, icp: JSON.stringify({ who: ['Founder'], api_key: CRED.in_json_string, passcode: CRED.numeric }) }, { fetchImpl: inner }, { env: { DAZL_TRACE_CAPTURE: '1' }, db: async () => db, finishMs: 10_000 })!
  const url = `https://api.synthetic.example/v1/items?refresh_token=${CRED.url_refresh}&page=2&q=london+saas&otp=${CRED.numeric2}&max_tokens=300`
  const res = await c.deps.fetchImpl!(url, { method: 'POST', body: JSON.stringify({ q: 'london saas', client_secret: CRED.body_secret, password: CRED.numeric, token: Number(CRED.numeric2), max_tokens: 300 }) })
  assert.equal((await res.json() as { refresh_token: string }).refresh_token, CRED.refresh)      // the run itself sees the real answer
  await assert.rejects(c.deps.fetchImpl!('https://api.synthetic.example/v1/fail'), /refresh_token/)
  const stub = { complete: async () => JSON.stringify([{ name: 'Dana Synthetic', company: 'Querix', api_key: CRED.reply, excerpt: 'raised a 3m GBP seed round' }]) }
  const p = c.recorder.providers({ anthropic: stub as never }).anthropic as { complete: (k: string, p: string, f?: unknown, m?: number) => Promise<string> }
  await p.complete('sk-ant-syntheticproviderkey', `Write up to 6 web search queries. refresh_token=${CRED.prompt} client_secret: ${CRED.prompt2} max_tokens: 5 password: '${CRED.quoted2}' "api_key": "${CRED.quoted}" otp: ${CRED.numeric} tokens: 5`, undefined, 300)
  const id = (await c.finish('done'))!
  const row = (await db.get<{ trace: string }>('SELECT trace FROM scan_traces WHERE tenant_id = ? AND id = ?', ['tenant-R', id]))!
  noCredential(row.trace, 'stored row')
  const t = (await getTrace(db, 'tenant-R', id))!
  assert.equal(t.redacted, true); assert.equal(t.capture?.complete, true); assert.equal(t.spans.length, 3)
  for (const s of ORDINARY) assert.ok(row.trace.includes(s), `ordinary content lost: ${s}`)
  // field by field: the URL keeps its ordinary parameters, the bodies keep their shape, the error keeps its words
  const http = t.spans[0].input as { url: string; body: string }
  assert.equal(http.url, 'https://api.synthetic.example/v1/items?refresh_token=[secret]&page=2&q=london+saas&otp=[secret]&max_tokens=300')
  assert.deepEqual(JSON.parse(http.body), { q: 'london saas', client_secret: '[secret]', password: '[secret]', token: '[secret]', max_tokens: 300 })
  const out = JSON.parse((t.spans[0].output as { body: string }).body) as Record<string, unknown>
  assert.deepEqual([out.company, out.page, out.max_tokens, out.usage, out.keywords, out.auth, out.credentials], ['Querix', 2, 300, { input_tokens: 12, output_tokens: 3 }, ['london', 'saas'], '[secret]', '[secret]'])   // whole values under auth / credentials
  for (const k of ['refresh_token', 'access_token', 'client_secret', 'api_key', 'apiKey', 'password', 'authorization', 'cookie', 'set-cookie', 'private_key', 'token']) assert.equal(out[k], '[secret]', k)
  assert.equal(out.note, 'password: "[secret]"; otp=[secret]; max_tokens=300')
  assert.deepEqual(JSON.parse(out.payload as string), { clientSecret: '[secret]', company: 'Querix' })
  assert.ok(Object.keys(out).includes('https://x.example/u?token=[secret]'), Object.keys(out).join(','))
  assert.equal(t.spans[1].error, 'refresh_token=[secret] [secret] Authorization: Bearer [secret] password: "[secret]" otp=[secret]')
  assert.equal((t.spans[2].input as { prompt: string }).prompt, 'Write up to 6 web search queries. refresh_token=[secret] client_secret: [secret] max_tokens: 5 password: \'[secret]\' "api_key": "[secret]" otp: [secret] tokens: 5')
  const reply = JSON.parse((t.spans[2].output as { text: string }).text) as { name: string }[]
  assert.match(reply[0].name, /^Person-[0-9a-f]{6}$/)                                               // the extracted person name, as before
  assert.deepEqual(reply, [{ name: reply[0].name, company: 'Querix', api_key: '[secret]', excerpt: 'raised a 3m GBP seed round' }])
  assert.deepEqual(t.input, { request: 'find london saas; refresh_token=[secret]; password: "[secret]"; password=[secret]', icp: { who: ['Founder'], api_key: '[secret]', passcode: '[secret]' }, as_of: t.input.as_of })
  assert.deepEqual(t.output?.leads.map(l => [l.company, l.source_url, l.excerpt, l.event_date, l.confidence]), [['Querix', 'https://news.example/q?api_key=[secret]', 'Querix raised a 3m GBP seed round (token=[secret])', '2026-10-10', 80]])
  // replay semantics: the stored trace is still a complete, redacted World that answers the (redacted) URL with the (redacted) body
  const w = validateWorld(worldFromTrace(t))
  assert.equal(w.origin, 'recorded'); assert.equal(w.redacted, true)
  assert.equal(JSON.parse(w.http[http.url]!.body as string).company, 'Querix')
  assert.equal(w.http['https://api.synthetic.example/v1/fail'], null)
  assert.match(w.model.search_queries[0].text, /Querix/)
  // the existing cut controls still hold on a cut body carrying a credential: the credential is gone AND replay is refused
  const big = beginScanTrace({ id: 'job-cut', user_id: 'tenant-R', attempts: 1, query: 'q' }, { fetchImpl: (async () => new Response(`refresh_token=${CRED.refresh} ${'y'.repeat(200_010)}`)) as typeof fetch }, { env: { DAZL_TRACE_CAPTURE: '1' }, db: async () => db, settleMs: 2_000, finishMs: 10_000 })!
  void (await big.deps.fetchImpl!('https://synthetic.example/big')).body?.cancel().catch(() => {})
  const cut = (await getTrace(db, 'tenant-R', (await big.finish('done'))!))!
  noCredential(JSON.stringify(cut), 'cut trace')
  assert.deepEqual([cut.capture?.complete, cut.capture?.bodies_truncated], [false, 1])
  assert.throws(() => worldFromTrace(cut), WorldError)
})

// ---- Council review of #463: one row per finding, each proven end to end through beginScanTrace -> store -> getTrace on
// both engines, as the text of a prompt, of a response body and of a recorded error. Every value is synthetic.
const COUNCIL: [string, string, string][] = [
  // R1-1: a credential-named value that opens an object/array in text that is not JSON as a whole (a cut body, NDJSON, a JS literal, truncated JSON)
  ['R1-1 object value in text', 'not json: {"credentials": {"value": "SECRETXA1"}} tail', 'not json: {"credentials": [secret]} tail'],
  ['R1-1 nested session', 'x {"session": {"id": "SECRETXA2"}} y', 'x {"session": [secret]} y'],
  ['R1-1 ndjson', '{"a":1}\n{"cookie":[{"name":"sid","value":"SECRETXA3"}]}', '{"a":1}\n{"cookie":[secret]}'],
  ['R1-1 js literal', "var cfg = {apiKey: 'SECRETXA4', session: {id: 'SECRETXA5'}}", "var cfg = {apiKey: '[secret]', session: [secret]}"],
  ['R1-1 truncated json', '{"x":"aaaa","credentials":{"value":"SECRETXA6', '{"x":"aaaa","credentials":[secret]'],
  // R1-2: a count word does not make password/otp/secret names count-shaped; token/key names with a count word stay counts
  ['R1-2 counts', 'otp_number: 493827; input_password=493827; secret_count: 12; max_tokens=300; token_count: 3; num_keys=2; tokens: 5', 'otp_number: [secret]; input_password=[secret]; secret_count: [secret]; max_tokens=300; token_count: 3; num_keys=2; tokens: 5'],
  // R1-3: an authorization value of any scheme runs to the end of the line; Bearer/Basic keep the scheme word and stop at the token
  ['R1-3 Token scheme', 'Authorization: Token SECRETXB1 9944b09199c62bcf\nnext: kept', 'Authorization: [secret]\nnext: kept'],
  ['R1-3 Digest', 'Authorization: Digest username="u", realm="r", response="SECRETXB2"', 'Authorization: [secret]'],
  ['R1-3 Bearer stays a token', 'Authorization: Bearer SECRETXB3 then page=2', 'Authorization: Bearer [secret] then page=2'],
  // R1-4: percent-encoded query values carrying assignments or JSON
  ['R1-4 encoded assignment', 'https://x.example/r?next=%2Flogin%3Fpassword%3DSECRETXC1%26a%3D1&page=2', 'https://x.example/r?next=%2Flogin%3Fpassword%3D[secret]%26a%3D1&page=2'],
  ['R1-4 encoded json', 'https://x.example/r?d=%7B%22api_key%22%3A%22SECRETXC2%22%7D', 'https://x.example/r?d=%7B%22api_key%22%3A%22[secret]%22%7D'],
  // R3-2: JSON-escaped credential inside a string that is not JSON
  ['R3-2 escaped json', 'payload: {\\"password\\": \\"two words SECRETXD1\\"} end', 'payload: {\\"password\\": \\"[secret]\\"} end'],
  ['R3-2 escaped log', 'log: {\\"api_key\\":\\"SECRETXD2\\"}', 'log: {\\"api_key\\":\\"[secret]\\"}'],
  // R3-3 / R1-5: the password in a URL's userinfo
  ['R3-3 dsn', 'connect failed postgres://admin:SECRETXE1@10.0.0.5:5432/db', 'connect failed postgres://admin:[secret]@10.0.0.5:5432/db'],
  ['R3-3 url', 'GET https://admin:p!SECRETXE2@host.example.com/x?page=2', 'GET https://admin:[secret]@host.example.com/x?page=2'],
  // R3-4: a cookie line with a quoted pair
  ['R3-4 cookie line', 'Cookie: a="xyz"; sid=SECRETXF1; b=2', 'Cookie: [secret]'],
  // R1-6: the cheap ones
  ['R1-6 html input', '<input type="hidden" name="csrf_token" value="SECRETXG1"> <input name="q" value="london">', '<input type="hidden" name="csrf_token" value="[secret]"> <input name="q" value="london">'],
  ['R1-6 html meta', '<meta name="csrf-token" content="SECRETXG2"><meta content="SECRETXG3" name="api-key">', '<meta name="csrf-token" content="[secret]"><meta content="[secret]" name="api-key">'],
  ['R1-6 unicode key', 'pässword=SECRETXG4', 'pässword=[secret]'],
  ['R1-6 short basic', 'sent Basic dXNlcjpwdw== next', 'sent Basic [secret] next'],
  ['R1-6 short jwt', 'got eyJhbGciOi.eyJzdWIi.SECRETXG5 back', 'got [secret] back'],
  ['R1-6 arrow', "password => 'SECRETXG6'; token => SECRETXG7", "password => '[secret]'; token => [secret]"],
  // probe F1: a YAML-style block under a credential name; JSON that is not JSON (trailing comma); a prose prefix before a credentials list
  ['F1 yaml block', 'credentials:\n  username: bob\n  value: SECRETXH1\nnext: kept', 'credentials:\n  [secret]\nnext: kept'],
  ['F1 trailing comma', '{"token":{"value":"SECRETXH2"},}', '{"token":[secret],}'],
  ['F1 prose + list', 'denied: {"credentials":[{"user":"bob","value":"SECRETXH3"}]} (from cache)', 'denied: {"credentials":[secret]} (from cache)'],
  // probe F2: userinfo on a bare host; a value with a #fragment tail
  ['F2 bare host', 'fetching https://user:SECRETXH4@host/path?x=1 failed', 'fetching https://user:[secret]@host/path?x=1 failed'],
  ['hash tail', 'password=SECRETXH5#tail', 'password=[secret]'],
  // R3-10 / R3-11: a name starting with a digit; percent-encoded separators and underscores; %26 ends the value
  ['R3-10 digit name', '2fa_token: 123456; 2fa_code: 123456', '2fa_token: [secret]; 2fa_code: 123456'],
  ['R3-11 encoded', 'https://x.example/cb?password%3DSECRETXH6%26a%3D1&refresh%5Ftoken=SECRETXH7&page=2', 'https://x.example/cb?password%3D[secret]%26a%3D1&refresh%5Ftoken=[secret]&page=2'],
  // round 3 (Reviewer 1 R9-R12, probe round 2 F1-F5): tolerant and repeated decoding anywhere in a string, other scheme words,
  // bare HTML attribute values and id=, digits glued to a word, userinfo passwords with @, a doubly escaped quote
  ['R9 malformed escape', 'https://x.example/r?next=%2Flogin%3Fpassword%3DSECRETXJ1%zz&page=2', 'https://x.example/r?next=%2Flogin%3Fpassword%3D[secret]&page=2'],
  ['R9 double encoded', 'https://x.example/r?u=%252Flogin%253Fpassword%253DSECRETXJ2%2526a%253D1', 'https://x.example/r?u=%252Flogin%253Fpassword%253D[secret]%2526a%253D1'],
  ['R2-F2 encoded name', 'https://x.example/r?a=1&%70assword=SECRETXJ3&page=2', 'https://x.example/r?a=1&%70assword=[secret]&page=2'],
  ['R10 path', 'https://x.example/go/https%3A%2F%2Fy.example%2F%3Ftoken%3DSECRETXJ4%26x%3D1', 'https://x.example/go/https%3A%2F%2Fy.example%2F%3Ftoken%3D[secret]%26x%3D1'],
  ['R10 fragment', 'https://x.example/cb#d=%7B%22access_token%22%3A%22SECRETXJ5%22%7D', 'https://x.example/cb#d=%7B%22access_token%22%3A%22[secret]%22%7D'],
  ['R11 other scheme', 'x-auth-token: Token SECRETXJ6 9944\naccess_token: Token SECRETXJ7\nnext: kept', 'x-auth-token: [secret]\naccess_token: [secret]\nnext: kept'],
  ['R12 bare attr and id', '<input name=csrf_token value=SECRETXJ8> <input id="csrf_token" value="SECRETXJ9"> <meta content=SECRETXK1 name=api-key>', '<input name=csrf_token value=[secret]> <input id="csrf_token" value="[secret]"> <meta content=[secret] name=api-key>'],
  ['R2-F1 glued digits', 'token2=SECRETXK2; api_key2: SECRETXK3; session2=SECRETXK4; sha256: kept', 'token2=[secret]; api_key2: [secret]; session2=[secret]; sha256: kept'],
  ['R2-F3 userinfo with @', 'GET https://user:p@SECRETXK5@host.example/path?x=1', 'GET https://user:[secret]@host.example/path?x=1'],
  ['probe apostrophe in brackets', "credentials: [Bob's SECRETXK9] tail-KEEP; session: {\"id\": \"SECRETXL1\"} tail-KEEP", "credentials: [secret] tail-KEEP; session: [secret] tail-KEEP"],
  ['R2-F3 userinfo with slash', 'https://user:ab/SECRETXL2@host/x and https://host.example:8080/path?u=a@b.example', 'https://user:[secret]@host/x and https://host.example:8080/path?u=p[0-9a-f]{10}@b.example'],
  ['R3-F1 form body', 'user=bob&password=a%26SECRETXM1%3Dc&page=2', 'user=bob&password=[secret]&page=2'],
  ['R3-F1 form body in json', '{"form":"user=bob&password=a%26SECRETXM2%3Dc&page=2","next":"%2Fl%3Fpassword%3DSECRETXM3%26a%3D1"}', '{"form":"user=bob&password=[secret]&page=2","next":"%2Fl%3Fpassword%3D[secret]%26a%3D1"}'],
  ['R2-F5 escaped backslash', 'payload: {\\"password\\":\\"abc\\\\\\"SECRETXK6\\"} tail', 'payload: {\\"password\\":\\"[secret]\\"} tail'],
  // control: ordinary text with counts, dates, a port, a plan name and a non-credential code is untouched
  ['control', 'the keynote: London; Basic plan from 2026-10-10; tokens: 5; max_tokens=300; expires_in: 3600; https://host.example:8080/p?page=2&q=a+b; verification_code=493827', 'the keynote: London; Basic plan from 2026-10-10; tokens: 5; max_tokens=300; expires_in: 3600; https://host.example:8080/p?page=2&q=a+b; verification_code=493827'],
]
bothEngines('council matrix: every reviewer case is redacted as stated in a prompt, a response body and an error, through capture -> store -> getTrace', async ({ db }) => {
  const bodies = new Map(COUNCIL.map(([label, input]) => [label, input]))
  const inner = (async (input: RequestInfo | URL) => {
    const u = new URL(String(input)); const label = u.searchParams.get('case')!
    if (u.pathname === '/fail') throw new Error(bodies.get(label)!)
    return new Response(bodies.get(label)!, { status: 200 })
  }) as typeof fetch
  const c = beginScanTrace({ id: 'job-council', user_id: 'tenant-C', attempts: 1, query: 'q' }, { fetchImpl: inner }, { env: { DAZL_TRACE_CAPTURE: '1' }, db: async () => db, finishMs: 10_000 })!
  const stub = { complete: async (_k: string, prompt: string) => `echo ${prompt.length}` }
  const p = c.recorder.providers({ anthropic: stub as never }).anthropic as { complete: (k: string, p: string) => Promise<string> }
  for (const [label] of COUNCIL) {
    await (await c.deps.fetchImpl!(`https://api.synthetic.example/body?case=${encodeURIComponent(label)}`)).text()
    await c.deps.fetchImpl!(`https://api.synthetic.example/fail?case=${encodeURIComponent(label)}`).catch(() => {})
    await p.complete('sk-ant-syntheticproviderkey', COUNCIL.find(x => x[0] === label)![1])
  }
  const t = (await getTrace(db, 'tenant-C', (await c.finish('done'))!))!
  assert.equal(t.capture?.complete, true); assert.equal(t.spans.length, COUNCIL.length * 3)
  const stored = JSON.stringify(t)
  assert.ok(!/SECRETX[A-M]\d/.test(stored), stored.match(/.{0,60}SECRETX[A-M]\d.{0,20}/)?.[0])
  for (let i = 0; i < COUNCIL.length; i++) {
    const [label, , want] = COUNCIL[i]
    const check = (got: string, where: string) => want.includes('[0-9a-f]') ? assert.match(got, new RegExp(`^${want.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/p\\\[0-9a-f\\\]\\\{10\\\}/g, 'p[0-9a-f]{10}')}$`), `${label}: ${where}`) : assert.equal(got, want, `${label}: ${where}`)
    check((t.spans[3 * i].output as { body: string }).body, 'body')
    check(t.spans[3 * i + 1].error ?? '', 'error')
    check((t.spans[3 * i + 2].input as { prompt: string }).prompt, 'prompt')
  }
})

// R3-1 (blocker): a person named in a model reply that is not JSON as a whole - fenced, with a preamble, cut short - is
// still pseudonymised everywhere in the stored trace.
bothEngines('names from a fenced, prefaced or truncated model reply are pseudonymised through capture -> store -> getTrace', async ({ db }) => {
  const replies = ['```json\n[{"name": "Priya Sample", "company": "Querix"}]\n```', 'Here you go: [{"name": "Omar Sample", "company": "Querix"}]', '[{"name": "Lee Sample", "company": "Querix"}, {"name": "Noor Sample", "compa', '{"name":"Dana Sample","note":"Dana Sample leads Querix; Priya Sample advises"}']
  let i = 0
  const stub = { complete: async () => replies[i++] }
  const c = beginScanTrace({ id: 'job-names', user_id: 'tenant-N', attempts: 1, query: 'q' }, { fetchImpl: (async () => new Response('Priya Sample and Omar Sample and Lee Sample and Noor Sample spoke; see https://linkedin.com/in/jane-synthetic-slug and https://www.linkedin.com/in/omar-synthetic-slug/', { status: 200 })) as typeof fetch }, { env: { DAZL_TRACE_CAPTURE: '1' }, db: async () => db, finishMs: 10_000 })!
  const p = c.recorder.providers({ anthropic: stub as never }).anthropic as { complete: (k: string, p: string) => Promise<string> }
  for (let k = 0; k < replies.length; k++) await p.complete('sk-ant-syntheticproviderkey', 'extract')
  await (await c.deps.fetchImpl!('https://page.synthetic.example/people')).text()
  const t = (await getTrace(db, 'tenant-N', (await c.finish('done'))!))!
  const stored = JSON.stringify(t)
  for (const n of ['Priya Sample', 'Omar Sample', 'Lee Sample', 'Noor Sample', 'Dana Sample']) assert.ok(!stored.includes(n), n)
  assert.match((t.spans[0].output as { text: string }).text, /^```json\n\[\{"name": "Person-[0-9a-f]{6}", "company": "Querix"\}\]\n```$/)
  assert.match((t.spans[1].output as { text: string }).text, /^Here you go: \[\{"name": "Person-[0-9a-f]{6}"/)
  assert.match((t.spans[2].output as { text: string }).text, /^\[\{"name": "Person-[0-9a-f]{6}", "company": "Querix"\}, \{"name": "Person-[0-9a-f]{6}", "compa$/)
  // R3-8: LinkedIn /in/ slugs become consistent redacted-<10 hex> tokens
  assert.match((t.spans[4].output as { body: string }).body, /^Person-[0-9a-f]{6} and Person-[0-9a-f]{6} and Person-[0-9a-f]{6} and Person-[0-9a-f]{6} spoke; see https:\/\/linkedin\.com\/in\/redacted-[0-9a-f]{10} and https:\/\/www\.linkedin\.com\/in\/redacted-[0-9a-f]{10}\/$/)
  assert.ok(!stored.includes('synthetic-slug'))
})

// R15: strings are cut to the stored size BEFORE redaction, so text beyond the stored prefix can never be moved into it
// by a pass that shrinks the text ahead of it (an encoded value, a pseudonym): the reviewers' exact input.
bothEngines('a credential past the stored prefix cannot slide into it: strings are cut before redaction', async ({ db }) => {
  const body = `see https://x.example/r?next=token%253D${'A'.repeat(70_000)}<input type="hidden" name="csrf_token" value="SECRETXQ1">`
  const c = beginScanTrace({ id: 'job-cut-first', user_id: 'tenant-Q', attempts: 1, query: 'q' }, { fetchImpl: (async () => new Response(body, { status: 200 })) as typeof fetch }, { env: { DAZL_TRACE_CAPTURE: '1' }, db: async () => db, finishMs: 10_000 })!
  await (await c.deps.fetchImpl!('https://page.synthetic.example/p')).text()
  const t = (await getTrace(db, 'tenant-Q', (await c.finish('done'))!))!
  const stored = (t.spans[0].output as { body: string }).body
  assert.ok(!JSON.stringify(t).includes('SECRETXQ1'))
  // the cut happened first (recorded), then the encoded assignment took its whole 50k value, cut marker included: fail closed
  assert.equal(stored, 'see https://x.example/r?next=token%253D[secret]')
  assert.deepEqual([t.capture?.complete, t.capture?.truncated_strings], [false, 1])
  assert.throws(() => worldFromTrace(t), WorldError)
})

test('cutStrings is idempotent and capTrace counts a pre-cut string once', () => {
  const long = 'z'.repeat(MAX_STRING_CHARS + 10)
  const once = cutStrings(synth({ spans: [{ id: 's0', seq: 0, kind: 'page', name: 'p', start_ms: 0, duration_ms: 1, input: {}, output: { text: long, short: 'ok' } }] }))
  const twice = cutStrings(once)
  assert.deepEqual(twice, once); assert.deepEqual(once.capture, { truncated_strings: 1, complete: false })
  const capped = capTrace(once)
  assert.equal(capped.capture?.truncated_strings, 1); assert.equal((capped.spans[0].output as { text: string }).text.length, MAX_STRING_CHARS + '…[truncated]'.length)
})

// Probe F3: non-plain values under a credential-named key in a model span - a Buffer, a typed array, a Map, a Date, a
// digit array, a byte map - go whole; ordinary fields beside them stay.
bothEngines('a Buffer, typed array, Map, Date, digit array or byte map under a credential-named key is redacted whole', async ({ db }) => {
  const bytes = Buffer.from('SECRETXI1-bytes')
  const research = async () => ({ text: '[]', citedUrls: ['https://a.example/'], max_tokens: 300, password: bytes, api_key: new Uint8Array(bytes), session: new Map([['k', 'SECRETXI2']]), token: new Date('2026-01-02T03:04:05Z'), otp: [4, 9, 3, 8, 2, 7], secret: { 0: 72, 1: 73 }, tokens: { input: 5, output: 7 } })
  const c = beginScanTrace({ id: 'job-buf', user_id: 'tenant-B', attempts: 1, query: 'q' }, {}, { env: { DAZL_TRACE_CAPTURE: '1' }, db: async () => db, finishMs: 10_000 })!
  const p = c.recorder.providers({ anthropic: { research } as never }).anthropic as { research: (k: string, p: string) => Promise<unknown> }
  await p.research('k', 'Write up to 6 web search queries. hello')
  const t = (await getTrace(db, 'tenant-B', (await c.finish('done'))!))!
  const out = t.spans[0].output as Record<string, unknown>
  const j = JSON.stringify(out)
  assert.ok(!j.includes([...bytes].slice(0, 4).join(',')) && !j.includes(`"0":${bytes[0]}`) && !j.includes('SECRETXI') && !j.includes('4,9,3,8,2,7') && !j.includes('"0":72'), j)
  assert.deepEqual([out.text, out.citedUrls, out.max_tokens, out.password, out.api_key, out.session, out.token, out.otp, out.secret, out.tokens], ['[]', ['https://a.example/'], 300, '[secret]', '[secret]', '[secret]', '[secret]', '[secret]', '[secret]', { input: 5, output: 7 }])
})

// R3-6: a failed read of the run's leads fails the store (nothing kept), never a complete zero-lead trace.
bothEngines('a failed leads read fails the store closed: no row, the failure logged by class only', async ({ db }) => {
  await db.run("INSERT INTO scan_jobs (id, user_id, status, business_name, industry, location, attempts) VALUES ('job-nl', 'tenant-L', 'running', 'b', 'i', 'l', 1)")
  await db.run('ALTER TABLE leads RENAME TO leads_gone')
  const errs: string[] = []; const orig = console.error; console.error = (m: string) => { errs.push(m) }
  try {
    const c = beginScanTrace({ id: 'job-nl', user_id: 'tenant-L', attempts: 1, query: 'q' }, {}, { env: { DAZL_TRACE_CAPTURE: '1' }, db: async () => db, finishMs: 10_000 })!
    assert.equal(await c.finish('done'), null)
  } finally { console.error = orig; await db.run('ALTER TABLE leads_gone RENAME TO leads') }
  assert.deepEqual(await listTraces(db, 'tenant-L'), [])
  assert.equal(errs.length, 1); assert.match(errs[0], /"trace_capture":"failed"/); assert.ok(!/leads_gone|no such table|does not exist/.test(errs[0]), errs[0])
  // and with the table back, the same job stores a (zero-lead) trace that is complete
  const ok = beginScanTrace({ id: 'job-nl', user_id: 'tenant-L', attempts: 1, query: 'q' }, {}, { env: { DAZL_TRACE_CAPTURE: '1' }, db: async () => db, finishMs: 10_000 })!
  const t = (await getTrace(db, 'tenant-L', (await ok.finish('done'))!))!
  assert.deepEqual([t.capture?.complete, t.output?.leads], [true, []])
})

// R1-1 through the recorder: a JSON body over the recorder's cap is no longer JSON when redacted, and a credential-named
// object inside it must still go whole (the reviewers' cut.ts).
test('a body cut by the recorder cap keeps no nested credential value: the object under a credential name goes whole', async () => {
  const body = JSON.stringify({ session: { id: 'SECRETX-sess' }, credentials: [{ value: 'SECRETY-cred' }], pad: 'a'.repeat(300_000) })
  const r = new TraceRecorder()
  const res = await r.fetch((async () => new Response(body, { status: 200 })) as typeof fetch)('https://example.synthetic/api/me')
  await res.text(); await r.settled()
  const stored = JSON.stringify(capTrace(redactTrace(synth({ spans: r.spans }))))
  assert.ok((r.spans[0].output as { truncated: boolean }).truncated)
  assert.ok(!/SECRET[XY]/.test(stored), stored.match(/.{0,40}SECRET[XY].{0,20}/)?.[0])
  assert.match(stored, /\{\\"session\\":\[secret\],\\"credentials\\":\[secret\],/)
})

// R8: the HTML attribute pass is bounded per tag, so one enormous tag (attacker-controlled page content; redaction runs
// synchronously inside finish) cannot make redaction quadratic. A pair inside the bound is still found.
test('a 1M-character single HTML tag, and a 4M-character page of repeated attributes, redact in well under a second; a credential attribute pair inside the bound is still found', () => {
  const tag = `<input name="csrf_token" value="SECRETXP1" ${'data-a="1" '.repeat(100_000)}>`
  assert.ok(tag.length > 1_000_000)
  const hostile = `<div ${'name="a" name="b" name="c" '.repeat(100)}>`.repeat(1_500)   // ~4M chars, hundreds of name= per tag
  assert.ok(hostile.length > 4_000_000)
  // each case is LINEAR: the same pattern at one tenth the size sets its unit, and the full size may take at most 15 units
  // plus slack (a quadratic pass would take ~100). A wall-clock budget alone failed once under full-suite load.
  const run = (text: string) => { const t0 = performance.now(); const out = (redactTrace(synth({ spans: [{ id: 's0', seq: 0, kind: 'page', name: 'verifier.fetch', start_ms: 0, duration_ms: 1, input: {}, output: { text } }] }), Buffer.alloc(16, 5)).spans[0].output as { text: string }).text; return { out, ms: performance.now() - t0 } }
  run('warm up '.repeat(20_000))
  const linear = (small: string, big: string, label: string) => { const unit = Math.max(run(small).ms, 5); const r = run(big); assert.ok(r.ms < 15 * unit + 300, `${label}: ${big.length} chars took ${r.ms.toFixed(0)} ms, ${small.length} chars ${unit.toFixed(1)} ms`); return r.out }
  const o = {
    text: linear(`<input name="csrf_token" value="SECRETXP1" ${'data-a="1" '.repeat(10_000)}>`, tag, '1M-char tag'),
    inner: linear(`<form ${'x '.repeat(40_000)} name="password" value="SECRETXP2">`, `<form ${'x '.repeat(400_000)} name="password" value="SECRETXP2">`, '800k-char tag'),
    hostile: linear(`<div ${'name="a" name="b" name="c" '.repeat(100)}>`.repeat(150), hostile, '4M-char hostile page'),
  }
  // R14: an encoded separator followed by an encoded & repeated 70k times stays linear (was quadratic: 1M chars took 173 s)
  const enc = linear('token%3Dabc%26'.repeat(7_200), 'token%3Dabc%26'.repeat(72_000), '1M chars of token%3Dabc%26')
  assert.ok(enc.startsWith('token%3D[secret]%26token%3D[secret]%26') && !enc.includes('abc'), enc.slice(0, 80))
  // R18: the bound is the distance between the two attributes, not from the tag start
  const longTag = `<input ${'class="c" '.repeat(300)}name="csrf_token" value="SECRETXP3">`
  assert.ok(run(longTag).out.endsWith('name="csrf_token" value="[secret]">'), 'pair adjacent after a long tag prefix')
  assert.ok(o.text.startsWith('<input name="csrf_token" value="[secret]" '), o.text.slice(0, 60))
  // the 800k tag: its pair sits past the 60,000-character read bound of the HTML pass, so it is left (documented; the
  // capture store never keeps a string past 50,000 characters). The anchoring itself is proven by the 3k-char tag below.
  assert.ok(o.inner.endsWith('name="password" value="SECRETXP2">'), o.inner.slice(-60))
})

// A "name" that is a placeholder or a role ("the", "unknown", "N/A", "Founder") is not a person: pseudonymising it would
// rewrite every such word in the trace.
test('placeholder and role "name" values from a model reply are not pseudonymised; real names still are', () => {
  const reply = '[{"name": "the", "company": "Querix"}, {"name": "unknown"}, {"name": "N/A"}, {"name": "Founder"}, {"name": "Ada Synthetic"}]'
  const page = 'the unknown founder, N/A for now; Ada Synthetic spoke'
  const r = redactTrace(synth({ spans: [{ id: 's0', seq: 0, kind: 'model', name: 'anthropic.complete', start_ms: 0, duration_ms: 1, input: { prompt: 'extract' }, output: { text: reply } }, { id: 's1', seq: 1, kind: 'page', name: 'verifier.fetch', start_ms: 0, duration_ms: 1, input: {}, output: { text: page } }] }), Buffer.alloc(16, 6))
  assert.match((r.spans[1].output as { text: string }).text, /^the unknown founder, N\/A for now; Person-[0-9a-f]{6} spoke$/)
  // (the reply parses as JSON, so it is re-serialised compactly once a name in it changed)
  assert.match((r.spans[0].output as { text: string }).text, /^\[\{"name":"the","company":"Querix"\},\{"name":"unknown"\},\{"name":"N\/A"\},\{"name":"Founder"\},\{"name":"Person-[0-9a-f]{6}"\}\]$/)
})

// Every key form the structural rule must recognise, with the ordinary keys it must leave alone. Values are all strings:
// a credential travels as a string; numbers and booleans (counts, limits, flags) are never redacted.
const CREDENTIAL_KEYS = ['refresh_token', 'refreshToken', 'REFRESH-TOKEN', 'Refresh.Token', 'refresh token', 'access_token', 'id_token', 'token', 'TOKEN', 'tokens',
  'api_key', 'apiKey', 'ApiKey', 'x-api-key', 'X-API-KEY', 'apikey', 'key', 'keys', 'private_key', 'privateKey', 'secret_key', 'secretkey', 'signing_key', 'access_key_id', 'accesskey',
  'secret', 'client_secret', 'clientSecret', 'clientsecret', 'webhook_secret', 'password', 'passwd', 'pwd', 'pass', 'passphrase', 'user_password', 'db.password',
  'credential', 'credentials', 'creds', 'auth', 'authorization', 'Authorization', 'authentication', 'auth_header', 'oauth', 'oauth_token', 'basic_auth',
  'cookie', 'cookies', 'set-cookie', 'Set-Cookie', 'session', 'session_id', 'sessionId', 'sessionid', 'session_token', 'signature', 'sig', 'jwt', 'bearer', 'pat', 'otp', 'totp', 'csrf', 'csrf_token', 'xsrf']
const ORDINARY_KEYS = ['company', 'name', 'excerpt', 'event_date', 'source_url', 'keyword', 'keywords', 'keynote', 'monkey', 'turkey', 'author', 'authors', 'authority', 'passport', 'passenger',
  'compass', 'sessions', 'tokenomics', 'tokenizer', 'secretary', 'title', 'status', 'page', 'q', 'url', 'method', 'stage', 'prompt', 'text', 'results', 'snippet', 'date', 'published']

test('credential-named keys: redacted at any nesting, in arrays, in JSON-in-string and as URL/text parameters, case- and separator-insensitive; ordinary keys and numbers are kept', () => {
  const V = 'syntheticcredentialvaluemarker', O = 'ordinary value kept'
  const obj = Object.fromEntries(CREDENTIAL_KEYS.map((k, i) => [k, `${V}${i}`]))
  const ord = Object.fromEntries(ORDINARY_KEYS.map((k, i) => [k, `${O} ${i}`]))
  const t = redactTrace(synth({ spans: [{ id: 's0', seq: 0, kind: 'http', name: 'http', start_ms: 0, duration_ms: 1, input: { url: 'https://x.example/' },
    output: { top: obj, ord, deep: { a: [{ b: { c: obj } }] }, as_json: JSON.stringify({ inner: obj, ord }), twice: JSON.stringify({ s: JSON.stringify({ x: [obj] }) }),
      counts: { max_tokens: 300, input_tokens: 12, tokens: 5, key: 7, session: true, password: null },
      holder: { credentials: { username: `${V}user`, nested: { deeper: `${V}deep` }, n: 1 } } } }] }), Buffer.alloc(16, 2))
  const j = JSON.stringify(t)
  assert.ok(!j.includes(V), j.slice(j.indexOf(V) - 80, j.indexOf(V) + 60))
  for (let i = 0; i < ORDINARY_KEYS.length; i++) assert.ok(j.includes(`${O} ${i}`), ORDINARY_KEYS[i])
  const o = t.spans[0].output as Record<string, unknown>
  for (const k of CREDENTIAL_KEYS) assert.equal((o.top as Record<string, unknown>)[k], '[secret]', k)
  assert.deepEqual(o.counts, { max_tokens: 300, input_tokens: 12, tokens: 5, key: '[secret]', session: true, password: null })   // `key: 7` is not count-shaped: it goes; booleans and null never do
  assert.deepEqual(o.holder, { credentials: "[secret]" })   // the whole object under a credential name goes (holder itself is an ordinary key)
  assert.deepEqual(JSON.parse(o.as_json as string).ord, ord)
  assert.deepEqual(JSON.parse(JSON.parse(o.twice as string).s), { x: [Object.fromEntries(CREDENTIAL_KEYS.map(k => [k, '[secret]']))] })
  // the same names as URL query parameters, `k: v`, `k=v`, quoted JSON-ish fragments and header lines in prose
  const text = CREDENTIAL_KEYS.filter(k => !/[ .]/.test(k)).flatMap((k, i) => [`https://h.example/p?${k}=${V}u${i}&page=${i}`, `${k}: ${V}c${i}`, `${k}=${V}e${i}`, `"${k}": "${V}q${i}"`, `${k}: Bearer ${V}b${i}`]).join('\n')
  const r = redactTrace(synth({ spans: [{ id: 's0', seq: 0, kind: 'page', name: 'verifier.fetch', start_ms: 0, duration_ms: 1, input: { url: 'https://x.example/' }, output: { text, keep: 'design: tidy; tokens: 5; max_tokens=300; page=2; Updated 2026-10-10 12:30; the keynote: London' } }] }), Buffer.alloc(16, 2))
  const rt = (r.spans[0].output as { text: string; keep: string }).text
  assert.ok(!rt.includes(V), rt.slice(rt.indexOf(V) - 80, rt.indexOf(V) + 40))
  for (let i = 0; i < 5; i++) assert.ok(rt.includes(`&page=${i}\n`), `page=${i}`)
  assert.ok(rt.includes('Bearer [secret]') && !rt.includes('[secret] [secret]'), rt.match(/.*Bearer.*/)?.[0])
  assert.equal((r.spans[0].output as { keep: string }).keep, 'design: tidy; tokens: 5; max_tokens=300; page=2; Updated 2026-10-10 12:30; the keynote: London')
})

// The assigned VALUE after a credential name (PR #463 review): the whole of a quoted value, spaces and all; a bare number
// under an explicitly credential name (password=493827, otp: 493827); never a count or limit (max_tokens, input_tokens,
// tokens: 5), never a number under an ordinary name. The same rule for text and for JSON-carried values.
test('credential values are redacted whole: quoted values with spaces, numeric values under a credential name; counts, limits and ordinary numbers stay', () => {
  const keep = 'the keynote: London; design: tidy; expires_in: 3600; passport: 12; page=2; Updated 2026-10-10 12:30; max_tokens: 300; input_tokens=12; tokens: 5; output_tokens: 7; token_count: 3; num_keys=2; "usage": {"input_tokens": 12}'
  const cases: [string, string][] = [
    ['password: "synthetic credential remainder marker"; password=493827', 'password: "[secret]"; password=[secret]'],   // the reviewer's exact case
    ["token='two word marker' next", "token='[secret]' next"],
    ['"client_secret": "has spaces and \\"escaped\\" quotes", "company": "Querix"', '"client_secret": "[secret]", "company": "Querix"'],
    ['api_key = 493827 and page=2', 'api_key = [secret] and page=2'],
    ['otp: 493827; secret: 12; signature=99; max_tokens: 300; tokens: 5; token_count: 3', 'otp: [secret]; secret: [secret]; signature=[secret]; max_tokens: 300; tokens: 5; token_count: 3'],
    ['https://h.example/cb?code=1&otp=493827&token=112233&page=2&max_tokens=300&q=a+b', 'https://h.example/cb?code=1&otp=[secret]&token=[secret]&page=2&max_tokens=300&q=a+b'],
    ['authorization: "Bearer 493827 with more words"; auth: Basic 112233', 'authorization: "Bearer [secret]"; auth: Basic [secret]'],
    ['password: "unterminated quoted value\nnext_line: kept', 'password: "[secret]\nnext_line: kept'],                 // no closing quote: the rest of the line
    ['password: "[secret]"; token=[secret]', 'password: "[secret]"; token=[secret]'],                                   // already redacted: stable
    [keep, keep],
  ]
  for (const [input, want] of cases) {
    const r = redactTrace(synth({ spans: [{ id: 's0', seq: 0, kind: 'page', name: 'verifier.fetch', start_ms: 0, duration_ms: 1, input: { url: 'https://x.example/', prompt: input }, output: { text: input }, error: input }] }), Buffer.alloc(16, 4))
    assert.equal((r.spans[0].output as { text: string }).text, want, input)
    assert.equal((r.spans[0].input as { prompt: string }).prompt, want, input)
    assert.equal(r.spans[0].error, want, input)
  }
  // JSON-carried: a numeric string or a number under a credential name is a secret; a count or limit, a boolean, null and a
  // number under an ordinary name are kept, at any nesting and inside JSON carried in a string
  const body = { password: '493827', otp: 493827, token: 112233, api_key: 7, max_tokens: 300, tokens: 5, usage: { input_tokens: 12, output_tokens: 3, total_tokens: 15 }, token_count: 4, key_count: 2, page: 2, expires_in: 3600, session: true, secret: null,
    auth: { session: { id: 'syntheticnestedsessionmarker', expires_in: 3600 } }, credentials: [{ pin: 1234, token: 5, max_tokens: 7 }], cookie: { name: 'sid', value: 12345 }, secrets: [493827], otp_number: 493827, input_password: 493827,
    secret2: 'syntheticglueddigitmarker', key1: 'syntheticglueddigitmarker', otp2: 493827, auth2: { time: 493827 }, keys: { count: 2, master: 99, nested: { total: 3, id: 4 } }, sha256: 'kept-hash-like', time: 493827 }
  const r = redactTrace(synth({ spans: [{ id: 's0', seq: 0, kind: 'http', name: 'http', start_ms: 0, duration_ms: 1, input: { url: 'https://x.example/' }, output: { body: JSON.stringify(body), direct: body } }] }), Buffer.alloc(16, 4))
  // numbers inside a credential-named object or array go too (cookie value, secrets list, a pin under auth), except under a count/limit/lifetime key
  const want = { password: '[secret]', otp: '[secret]', token: '[secret]', api_key: '[secret]', max_tokens: 300, tokens: 5, usage: { input_tokens: 12, output_tokens: 3, total_tokens: 15 }, token_count: 4, key_count: 2, page: 2, expires_in: 3600, session: true, secret: null,
    auth: '[secret]', credentials: '[secret]', cookie: '[secret]', secrets: '[secret]', otp_number: '[secret]', input_password: '[secret]',
    secret2: '[secret]', key1: '[secret]', otp2: '[secret]', auth2: '[secret]', keys: { count: 2, master: '[secret]', nested: { total: 3, id: '[secret]' } }, sha256: 'kept-hash-like', time: 493827 }
  assert.deepEqual(JSON.parse((r.spans[0].output as { body: string }).body), want)
  assert.deepEqual((r.spans[0].output as { direct: unknown }).direct, want)
})

test('credential families: known prefixes (github_pat_, ghp_/gho_, sk-ant-, sk-, sk_live_, xox, AKIA, JWT, Bearer/Basic, PEM blocks, cookie headers) are gone from text, keys and errors', () => {
  const fam = {
    pat: CRED.pat, ghp: CRED.ghp, gho: CRED.gho, ghs: 'ghs_syntheticgithubservermarker', ghu: 'ghu_syntheticgithubusermarker', sk_ant: CRED.sk_ant, sk: CRED.sk, sk_proj: 'sk-proj-syntheticprojectmarkervalue',
    sk_live: CRED.sk_live, pk_test: 'pk_test_syntheticstripepublishable', rk_live: 'rk_live_syntheticrestricted', slack_bot: CRED.slack, slack_app: 'xapp-1-synthetic-app-marker-value', aws: CRED.aws,
    jwt: CRED.jwt, bearer: `Bearer ${CRED.bearer}`, basic: 'Basic c3ludGhldGljOmJhc2ljbWFya2Vy', glpat: 'glpat-syntheticgitlabmarkervalue', npm: 'npm_syntheticnpmtokenmarkervalue', google: 'AIzaSyntheticGoogleApiKeyMarkerValue000',
    pem: `-----BEGIN RSA PRIVATE KEY-----\nsyntheticpemblockmarker\n-----END RSA PRIVATE KEY-----`, cookie_header: 'Set-Cookie: sid=syntheticcookieheadermarker; Path=/; HttpOnly', cookie_line: 'Cookie: a=syntheticcookielinemarker; b=two',
  }
  const markers = ['syntheticfinegrained', 'syntheticgithub', 'syntheticanthropic', 'syntheticopenai', 'syntheticproject', 'syntheticstripe', 'syntheticrestricted', 'synthetic-slack', 'synthetic-app', 'SYNTHETICMARKERA', 'syntheticpayload', 'syntheticbearer', 'c3ludGhldGlj', 'syntheticgitlab', 'syntheticnpm', 'SyntheticGoogle', 'syntheticpemblock', 'syntheticcookie']
  const prose = Object.values(fam).map((v, i) => `item ${i}: ${v}; next`).join('\n')
  const t = redactTrace(synth({ agent: { commit: null, label: `run ${fam.pat}` }, spans: [{ id: 's0', seq: 0, kind: 'http', name: 'http', start_ms: 0, duration_ms: 1, input: { url: `https://x.example/?x=${fam.ghp}`, prompt: prose }, output: { [fam.pat]: 1, [fam.jwt]: 2, body: JSON.stringify(fam) }, error: `denied for ${fam.pat} and ${fam.basic}` }] }), Buffer.alloc(16, 3))
  const j = JSON.stringify(t)
  for (const m of markers) assert.ok(!j.includes(m), `${m}: ${j.slice(Math.max(0, j.indexOf(m) - 60), j.indexOf(m) + 40)}`)
  for (const m of ['item 0: [secret]; next', 'item 15: Bearer [secret]; next', 'item 16: Basic [secret]; next', 'Set-Cookie: [secret]', 'Cookie: [secret]']) assert.ok(j.includes(m), m)
  assert.equal(t.spans[0].error, 'denied for [secret] and Basic [secret]')
  assert.deepEqual(Object.keys(t.spans[0].output as object), ['[secret]', 'body'])    // two credential keys collapse into one
  // ordinary text that merely resembles a family is kept
  const keep = 'Basic plan from 2026-10-10; skills: 12; the ghost_writer; token sale; secretary of state; AKIA is not here'
  assert.equal((redactTrace(synth({ spans: [{ id: 's0', seq: 0, kind: 'page', name: 'verifier.fetch', start_ms: 0, duration_ms: 1, input: {}, output: { text: keep } }] }), Buffer.alloc(16, 3)).spans[0].output as { text: string }).text, keep)
})
