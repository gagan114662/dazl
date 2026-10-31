// The owner's spend pool settles every completion to what the vendor reported (lib/llm/spend-guard.ts settle mode via
// lib/llm/owner-guard.ts, #363), through the real callers: draft polish and lead qualification. Overruns (cache writes)
// are recorded and stop later calls; no usage keeps the reservation; an unknown served model spends the day; an
// accounting write that does not land leaves a pending marker that stops the owner, and qualification keeps its claim
// (the call happened). Synthetic tenants and keys; every provider HTTP call is a stub that counts calls.
import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import Database from 'better-sqlite3'
import { bothEngines } from './helpers/engines.ts'
import { saveKey } from '../lib/llm/key-store.ts'
import { sharedPool, poolRows } from '../lib/llm/spend-pool.ts'
import { ownerGuarded } from '../lib/llm/owner-guard.ts'
import { completionCost, SpendAccountingFailed } from '../lib/llm/spend-guard.ts'
import { migrateAllSqlite } from '../lib/db/sqlite-migrations.ts'
import { pgDb, sqliteDb, type Db } from '../lib/db/client.ts'
import { saveSettings, createDraft } from '../lib/outreach/service.ts'
import { saveMemory } from '../lib/memory.ts'
import { polishDraft, llmFollowupText } from '../lib/outreach/draft-llm.ts'
import { createQueryJob } from '../lib/scan/store.ts'
import { runQualification, storedQualifications } from '../lib/scan/qualify-run.ts'
import { DEFAULT_LIMITS } from '../lib/scan/lead-qualify.ts'
import { qualifyPreview } from '../lib/scan/qualify-preview.ts'
import type { DetailedCompletion, Provider } from '../lib/llm/provider.ts'

const master = randomBytes(32)
const KEY = 'sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
const MODEL = 'claude-sonnet-4-5'
const POLISHED = 'Subject: A quick idea for Acme\n\nHi Pat, saw you are hiring AEs. We help new sales hires ramp faster. Worth a short call next week?\n\nThanks,'
let calls = 0
// The Anthropic messages endpoint, stubbed: served model and usage as given.
const answering = (text: string, model: string | null, usage: Record<string, number> | null, during?: () => void) => (async () => {
  calls++; during?.()
  return new Response(JSON.stringify({ id: 'msg_1', ...(model ? { model } : {}), content: [{ type: 'text', text }], ...(usage ? { usage } : {}) }), { status: 200 })
}) as unknown as typeof fetch
const OVERRUN = { input_tokens: 1000, output_tokens: 600, cache_creation_input_tokens: 40000 }
// 1000 x $3 + 600 x $15 + 40000 cache-write tokens x $3 x 2, per million.
const OVERRUN_USD = (1000 * 3 + 600 * 15 + 40000 * 3 * 2) / 1e6

async function withEnv<T>(vars: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const before = Object.fromEntries(Object.keys(vars).map(k => [k, process.env[k]]))
  for (const [k, v] of Object.entries(vars)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
  try { return await fn() } finally { for (const [k, v] of Object.entries(before)) { if (v === undefined) delete process.env[k]; else process.env[k] = v } }
}
const NONE = { DAZL_RUN_MAX_USD_USERS: undefined, DAZL_OWNER_MONTH_MAX_USD_USERS: undefined, DAZL_ANTHROPIC_MODEL: undefined }
const rows = async (db: Db, owner: string) => (await poolRows(db, owner)).map(r => [r.period.slice(0, 2), Math.round(r.reserved_usd * 1e6) / 1e6, Math.round(r.reported_usd * 1e6) / 1e6, Number(r.calls)])

function outreachDb() {
  const db = new Database(':memory:'); migrateAllSqlite(db)
  saveKey(db, 'A', 'anthropic', KEY, master)
  saveSettings(db, 'A', { sender_name: 'G', postal_address: '1 King St W, Toronto ON, Canada', booking_url: null })
  saveMemory(db, 'A', { positioning: 'software that ramps new sales hires' })
  db.prepare("INSERT INTO scan_jobs (id, user_id, business_name, industry, location, status) VALUES ('j1', 'A', 'b', 'i', 'l', 'running')").run()
  db.prepare("INSERT INTO leads (id, scan_job_id, name, company, contact, signal, source_url, evidence_excerpt, confidence, human_confirmed_at, human_confirmed_from) VALUES ('l1', 'j1', 'Pat', 'Acme', 'pat@acme.example', 'hiring AEs', 'https://n.example/a', 'quote', 80, 1800000000, 'test_review')").run()
  db.prepare("UPDATE scan_jobs SET status = 'done' WHERE id = 'j1'").run()
  return db
}
// The same draft polished again and again, as a user clicking Polish twice.
const draftOf = (db: Database.Database) => (db.prepare("SELECT id FROM outreach_messages WHERE tenant_id = 'A' AND lead_id = 'l1'").get() as { id: string } | undefined)?.id ?? createDraft(db, 'A', 'l1', 'Acme')
const polish = (db: Database.Database, fetchImpl: typeof fetch) => polishDraft(db, 'A', draftOf(db), 'Acme', { fetchImpl, master })

test('polish: two calls under a $0.05 day cap, the first reporting a cache-write overrun -> the overrun is recorded and the second call is refused', async () => {
  for (const served of [MODEL, `${MODEL}-20250929`]) { // the served id with its release date is priced as its alias
    const db = outreachDb()
    calls = 0
    await withEnv({ ...NONE, DAZL_RUN_MAX_USD_USERS: 'A:0.05' }, async () => {
      assert.equal((await polish(db, answering(POLISHED, served, OVERRUN))).rewritten, true)
      assert.deepEqual(await rows(sqliteDb(db), 'A'), [['d:', OVERRUN_USD, OVERRUN_USD, 1]], 'settled to the reported cost, past the cap')
      assert.deepEqual(await polish(db, answering(POLISHED, served, OVERRUN)), { rewritten: false, reason: 'spend_limit' })
      assert.equal(calls, 1, `${served}: one model call, not two`)
    })
  }
})

test('polish: no usage keeps the full reservation; an unpriced served model spends the day and keeps the month at the reservation', async () => {
  const db = outreachDb()
  calls = 0
  await withEnv({ ...NONE, DAZL_RUN_MAX_USD_USERS: 'A:0.05', DAZL_OWNER_MONTH_MAX_USD_USERS: 'A:5' }, async () => {
    assert.equal((await polish(db, answering(POLISHED, MODEL, null))).rewritten, true)
    const [d, m] = await rows(sqliteDb(db), 'A')
    assert.equal(d[0], 'd:'); assert.ok((d[1] as number) > 0.005 && (d[1] as number) < 0.05, `the worst case stands: ${d[1]}`)
    assert.deepEqual([d[2], m[1], m[2]], [0, d[1], 0], 'no billed figure, no marker')
    // A later call (a new request) may still reserve what is left.
    assert.equal((await polish(db, answering(POLISHED, 'claude-unlisted-model', OVERRUN))).rewritten, true)
    const [d2, m2] = await rows(sqliteDb(db), 'A')
    assert.equal(d2[1], 0.05, 'unknown cost: the day counts as spent')
    assert.ok((m2[1] as number) < 0.05, 'the month holds the two reservations only')
    assert.deepEqual(await polish(db, answering(POLISHED, MODEL, OVERRUN)), { rewritten: false, reason: 'spend_limit' })
    assert.equal(calls, 2)
    assert.equal((await poolRows(sqliteDb(db), 'A')).filter(r => r.period.startsWith('p:')).length, 0)
  })
})

test('polish: the settle cannot be saved -> the result is withheld; the very next polish, and another paid path, are refused at once', async () => {
  const db = outreachDb()
  calls = 0
  const draftId = draftOf(db)
  const before = db.prepare('SELECT subject, body FROM outreach_messages WHERE id = ?').get(draftId)
  await withEnv({ ...NONE, DAZL_RUN_MAX_USD_USERS: 'A:5' }, async () => {
    // The store stops answering after the reservation, while the call is in flight.
    const r = await polishDraft(db, 'A', draftId, 'Acme', { fetchImpl: answering(POLISHED, MODEL, OVERRUN, () => db.exec('ALTER TABLE tenant_spend_pools RENAME TO tsp_down')), master })
    db.exec('ALTER TABLE tsp_down RENAME TO tenant_spend_pools')
    assert.deepEqual(r, { rewritten: false, reason: 'error' })
    assert.deepEqual(db.prepare('SELECT subject, body FROM outreach_messages WHERE id = ?').get(draftId), before, 'the unaccounted result is not used')
    // Immediately, with a fresh guard (a new request), the marker not aged: refused before any call.
    assert.deepEqual(await polish(db, answering(POLISHED, MODEL, OVERRUN)), { rewritten: false, reason: 'spend_limit' })
    const markers = (await poolRows(sqliteDb(db), 'A')).filter(x => x.period.startsWith('p:'))
    assert.deepEqual(markers.map(m => [m.updated_at, m.reserved_usd > 0]), [[0, true]], 'the marker is kept, marked failed, its reservation intact')
    // Another paid path of the same owner (follow-up text through ownerGuarded) is refused too.
    assert.equal(await llmFollowupText(db, 'A', 0, { company: 'Acme', name: 'Pat', signal: 'hiring AEs', source_url: 'https://n.example/a' }, 'Acme', null, { fetchImpl: answering('Hi Pat, a quick nudge about the AE hiring. Worth a call?', MODEL, OVERRUN), master }), null)
    assert.equal(calls, 1, 'one model call in all')
  })
})

bothEngines('another instance is refused at once after a known accounting failure: written immediately, or as soon as the store answers', async ({ db, kind, url, schema }) => {
  const other = kind === 'pg' ? pgDb({ connectionString: url!, searchPath: schema }) : db
  try {
    const env = { DAZL_RUN_MAX_USD_USERS: 'T:5', DAZL_OWNER_MONTH_MAX_USD_USERS: 'T:50' }
    const stub = (during: () => Promise<void>): Provider => ({ research: async () => ({ text: '', citedUrls: [] }), configuredModel: () => MODEL, completeDetailed: async () => { calls++; await during(); return { text: 'ok', model: MODEL, usage: OVERRUN } } })
    calls = 0
    // (1) The settle fails but the store answers (the day row was removed under it): the failure is written at once.
    await assert.rejects(ownerGuarded(db, 'T', stub(async () => { await db.run("DELETE FROM tenant_spend_pools WHERE tenant_id = 'T' AND period LIKE 'd:%'") }), env).completeDetailed!(KEY, 'hi', undefined, 100), SpendAccountingFailed)
    await assert.rejects(ownerGuarded(other, 'T', stub(async () => {}), env).completeDetailed!(KEY, 'hi', undefined, 100), /spend_refused:accounting_unsettled/)
    // (2) The store is down for the failure mark too (owner U): kept in this process, written when the store answers.
    await assert.rejects(ownerGuarded(db, 'U', stub(async () => { await db.run('ALTER TABLE tenant_spend_pools RENAME TO tsp_down') }), { DAZL_RUN_MAX_USD_USERS: 'U:5' }).completeDetailed!(KEY, 'hi', undefined, 100), SpendAccountingFailed)
    await db.run('ALTER TABLE tsp_down RENAME TO tenant_spend_pools')
    assert.equal(await sharedPool(db, 'U', { day: 5 }).flushFailed(), true, 'the retry (every 5 s in the background) writes it')
    await assert.rejects(ownerGuarded(other, 'U', stub(async () => {}), { DAZL_RUN_MAX_USD_USERS: 'U:5' }).completeDetailed!(KEY, 'hi', undefined, 100), /spend_refused:accounting_unsettled/)
    assert.equal(calls, 2, 'no call after either failure')
  } finally { if (other !== db) await other.close() }
})

// Lead qualification (lib/scan/qualify-run.ts) with the owner's pool on.
const L = 'a'.repeat(24)
function qualifyDb() {
  const db = new Database(':memory:'); migrateAllSqlite(db)
  const job = createQueryJob(db, 'u1', { query: 'B2B companies hiring sales roles' })
  db.prepare("UPDATE scan_jobs SET status='running' WHERE id=?").run(job)
  db.prepare('INSERT INTO leads(id,scan_job_id,company,signal,source_url,company_domain) VALUES (?,?,?,?,?,?)').run(L, job, 'Acme', 'Posted a role titled "SDR"', 'https://weworkremotely.com/remote-jobs/acme-sdr', 'acme.example')
  return db
}
const fetchPage = async (url: string) => ({ text: `Acme runs outbound sales with five SDRs. (${url})`, title: 't', retrievedAt: 1 })
const QOUT = JSON.stringify({ company_fit: { verdict: 'yes', quote: 'Acme runs outbound sales with five SDRs.', quote_url: 'https://acme.example/', note: '' }, use_case: { verdict: 'unknown' }, buying_evidence: { verdict: 'unknown' } })
function qprov(answer: () => DetailedCompletion) { let n = 0; return { calls: () => n, p: { research: async () => ({ text: '', citedUrls: [] }), configuredModel: () => MODEL, completeDetailed: async () => { n++; return answer() } } as Provider } }
async function approvalFor(db: Database.Database) {
  const pv = await qualifyPreview(db, 'u1', L, 'Sales prospecting software', fetchPage, 'anthropic', MODEL)
  return { approved_by_user: true as const, vendor: 'anthropic', model: MODEL, max_usd_estimate: pv!.cost!.usd_estimate_max!, prompt_sha256: pv!.prompt_sha256!, request_context_sha256: pv!.packing!.context_sha256, limits: DEFAULT_LIMITS }
}
const qdeps = (p: Provider) => ({ enabled: true, sellerText: 'Sales prospecting software', vendor: 'anthropic', provider: p, apiKey: 'k', fetchPage })

test('qualification: accounting that fails after the call keeps the claim as failed, so a retry is never a second paid call', async () => {
  const db = qualifyDb(), a = await approvalFor(db)
  const s = qprov(() => { db.exec('ALTER TABLE tenant_spend_pools RENAME TO tsp_down'); return { text: QOUT, model: MODEL, usage: OVERRUN } })
  await withEnv({ ...NONE, DAZL_RUN_MAX_USD_USERS: 'u1:5' }, async () => {
    const r = await runQualification(db, 'u1', L, a, qdeps(s.p))
    db.exec('ALTER TABLE tsp_down RENAME TO tenant_spend_pools')
    assert.equal(r.status, 'failed')
    assert.match((r as { error: string }).error, /spend_accounting_failed/)
    assert.equal(storedQualifications(db, 'u1', L)[0]?.status, 'failed', 'the claim stays')
    assert.equal((await runQualification(db, 'u1', L, a, qdeps(s.p))).status, 'exists')
    assert.equal(s.calls(), 1, 'one paid call in all')
  })
})

test('qualification: a refusal before the call releases the claim; a settled overrun refuses the next lead', async () => {
  const db = qualifyDb(), a = await approvalFor(db)
  const s = qprov(() => ({ text: QOUT, model: MODEL, usage: OVERRUN }))
  await withEnv({ ...NONE, DAZL_RUN_MAX_USD_USERS: 'u1:0.0001' }, async () => {
    assert.deepEqual(await runQualification(db, 'u1', L, a, qdeps(s.p)), { status: 'blocked', reason: 'spend_limit' })
    assert.equal(storedQualifications(db, 'u1', L).length, 0, 'no call was made: the claim is released')
  })
  await withEnv({ ...NONE, DAZL_RUN_MAX_USD_USERS: 'u1:0.05' }, async () => {
    assert.equal((await runQualification(db, 'u1', L, a, qdeps(s.p))).status, 'done')
    assert.deepEqual(await rows(sqliteDb(db), 'u1'), [['d:', OVERRUN_USD, OVERRUN_USD, 1]])
    // A second lead: refused before its call; its claim is released.
    db.prepare("INSERT INTO leads(id,scan_job_id,company,signal,source_url,company_domain) SELECT ?, scan_job_id, 'Birch', signal, source_url, 'birch.example' FROM leads WHERE id = ?").run('b'.repeat(24), L)
    const pv = await qualifyPreview(db, 'u1', 'b'.repeat(24), 'Sales prospecting software', fetchPage, 'anthropic', MODEL)
    const r2 = await runQualification(db, 'u1', 'b'.repeat(24), { ...a, prompt_sha256: pv!.prompt_sha256!, max_usd_estimate: pv!.cost!.usd_estimate_max! }, qdeps(s.p))
    assert.deepEqual(r2, { status: 'blocked', reason: 'spend_limit' })
    assert.equal(storedQualifications(db, 'u1', 'b'.repeat(24)).length, 0)
  })
  assert.equal(s.calls(), 1)
})

bothEngines('cross-path concurrency: racing calls on one owner pool are each settled exactly once; nothing is lost, no marker is left', async ({ db }) => {
  const reported: number[] = []
  const stub = (i: number): Provider => ({
    research: async () => ({ text: '', citedUrls: [] }), configuredModel: () => MODEL,
    completeDetailed: async () => { const u = { input_tokens: 100 + i, output_tokens: 50, cache_creation_input_tokens: 1000 * (i % 3) }; const c = completionCost(MODEL, u); reported.push('usd' in c ? c.usd : NaN); return { text: 'ok', model: MODEL, usage: u } },
  })
  const env = { DAZL_RUN_MAX_USD_USERS: 'T:0.03' } // about five worst-case reservations
  // Two paths (a detailed call and a plain complete() going through it), twelve calls at once.
  const out = await Promise.allSettled(Array.from({ length: 12 }, (_, i) => {
    const g = ownerGuarded(db, 'T', stub(i), env)
    return i % 2 ? g.completeDetailed!(KEY, 'hello there', undefined, 200) : g.complete!(KEY, 'hello there', undefined, 200).then(text => ({ text }))
  }))
  const made = reported.length
  assert.ok(made >= 1 && made < 12, `the cap admits some, not all: ${made}`)
  assert.equal(out.filter(o => o.status === 'fulfilled').length, made)
  for (const o of out) if (o.status === 'rejected') assert.match(String(o.reason), /spend_refused:over_limit/)
  const sum = Math.round(reported.reduce((x, y) => x + y, 0) * 1e6) / 1e6
  const [d] = await rows(db, 'T')
  assert.deepEqual([d[1], d[2], d[3]], [sum, sum, made], 'the pool holds exactly the reported costs of the calls made')
  assert.equal((await poolRows(db, 'T')).filter(r => r.period.startsWith('p:')).length, 0)
})

bothEngines('pool: a settle retry with the same pending id moves once; a settle on a missing row fails and writes nothing', async ({ db }) => {
  const now = 1_800_000_000
  const p = sharedPool(db, 'T', { day: 1, month: 2 }, () => now)
  await p.reserve(0.1, now, 'aaaaaaaaaa')
  await p.settle(0.05, 0.15, now, 'aaaaaaaaaa')
  await p.settle(0.05, 0.15, now, 'aaaaaaaaaa')
  assert.deepEqual((await rows(db, 'T')).map(r => r.slice(1, 3)), [[0.15, 0.15], [0.15, 0.15]])
  await db.run("DELETE FROM tenant_spend_pools WHERE period LIKE 'm:%'")
  await assert.rejects(p.settle(0.01, 0.01, now), /window row missing/)
  assert.deepEqual((await rows(db, 'T')).map(r => r.slice(1, 3)), [[0.15, 0.15]], 'the day did not move either')
  // A provider error after the reservation: the marker goes, the reservation stands.
  const g = ownerGuarded(db, 'U', { research: async () => ({ text: '', citedUrls: [] }), configuredModel: () => MODEL, completeDetailed: async () => { throw new Error('provider_500') } }, { DAZL_RUN_MAX_USD_USERS: 'U:1' })
  await assert.rejects(g.completeDetailed!(KEY, 'hi', undefined, 100), /provider_500/)
  const u = await poolRows(db, 'U')
  assert.deepEqual([u.length, u[0].period.slice(0, 2), u[0].reserved_usd > 0], [1, 'd:', true])
})
