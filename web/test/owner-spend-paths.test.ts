// The owner's workspace spend pool on every paid model call outside the scan runner (lib/llm/owner-guard.ts, #363):
// briefs (both engines), draft polish, follow-up text and reply-intent grading. Synthetic tenant and key; the provider's
// HTTP call is a stub that counts calls, so a refused reservation provably makes no call. Nothing is billed or sent.
import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import Database from 'better-sqlite3'
import { bothEngines } from './helpers/engines.ts'
import { generateBrief } from '../lib/seo/brief.ts'
import { saveKey, writeKey } from '../lib/llm/key-store.ts'
import { sharedPool, poolRows } from '../lib/llm/spend-pool.ts'
import { ownerGuarded } from '../lib/llm/owner-guard.ts'
import { anthropicProvider } from '../lib/llm/provider.ts'
import { migrateAllSqlite } from '../lib/db/sqlite-migrations.ts'
import { sqliteDb, type Db } from '../lib/db/client.ts'
import { saveSettings, createDraft } from '../lib/outreach/service.ts'
import { saveMemory } from '../lib/memory.ts'
import { polishDraft, llmFollowupText } from '../lib/outreach/draft-llm.ts'
import { gradeBuyerIntent } from '../lib/replies/threads.ts'

const master = randomBytes(32)
const KEY = 'sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
const BRIEF = 'TITLE OPTIONS\n1. a\n2. b\n3. c\nTARGET AUDIENCE\nfounders\nSEARCH INTENT\nlearn\nOUTLINE\n- one\n- two\n- three\n- four\n- five\nMETA DESCRIPTION\na description\nFAQS\nq1 q2 q3'
const calls: string[] = []
const answering = (text: string) => (async (u: unknown) => { calls.push(String(u)); return new Response(JSON.stringify({ id: 'msg_1', model: 'claude-sonnet-4-5', content: [{ type: 'text', text }], usage: { input_tokens: 10, output_tokens: 10 } }), { status: 200 }) }) as unknown as typeof fetch

// Each test sets the operator's per-owner limits the way production does (environment), and restores them after.
async function withEnv<T>(vars: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const before = Object.fromEntries(Object.keys(vars).map(k => [k, process.env[k]]))
  for (const [k, v] of Object.entries(vars)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
  try { return await fn() } finally { for (const [k, v] of Object.entries(before)) { if (v === undefined) delete process.env[k]; else process.env[k] = v } }
}
const NONE = { DAZL_RUN_MAX_USD_USERS: undefined, DAZL_OWNER_MONTH_MAX_USD_USERS: undefined, DAZL_ANTHROPIC_MODEL: undefined }
const reserved = async (db: Db, owner: string) => (await poolRows(db, owner)).map(r => [r.period.slice(0, 2), Math.round(r.reserved_usd * 1e6) / 1e6, r.reported_usd, r.calls])

bothEngines('SEO brief: no limit set -> unchanged; a limit -> reserved first in the shared pool; past it -> refused with no call', async ({ db }) => {
  await writeKey(db, 'T', 'anthropic', KEY, master)
  calls.length = 0
  await withEnv(NONE, async () => {
    assert.ok(!('error' in await generateBrief(db, 'T', 'lead generation', { fetchImpl: answering(BRIEF), master })))
    assert.equal(calls.length, 1)
    assert.deepEqual(await reserved(db, 'T'), [], 'no limit: no pool row')
  })
  await withEnv({ ...NONE, DAZL_RUN_MAX_USD_USERS: 'T:0.001' }, async () => {
    assert.deepEqual(await generateBrief(db, 'T', 'lead generation', { fetchImpl: answering(BRIEF), master }), { error: 'spend_limit' })
    assert.equal(calls.length, 1, 'refused: no provider call')
    assert.deepEqual(await reserved(db, 'T'), [], 'a refused reservation writes nothing')
  })
  await withEnv({ ...NONE, DAZL_RUN_MAX_USD_USERS: 'T:5', DAZL_OWNER_MONTH_MAX_USD_USERS: 'T:20' }, async () => {
    assert.ok(!('error' in await generateBrief(db, 'T', 'lead generation', { fetchImpl: answering(BRIEF), master })))
    assert.equal(calls.length, 2)
    const rows = await reserved(db, 'T')
    // Reserved at the worst case, then settled to what the stub reported: 10 in + 10 out at $3/$15 per million.
    assert.deepEqual(rows, [['d:', 0.00018, 0.00018, 1], ['m:', 0.00018, 0.00018, 1]], 'day and month each hold the settled cost; no pending marker is left')
    // Another paid path (the scan runner, another instance) has used the rest of the day: the next brief is refused.
    await sharedPool(db, 'T', { day: 5 }).reserve(5 - (rows[0][1] as number) - 0.001)
    assert.deepEqual(await generateBrief(db, 'T', 'lead generation', { fetchImpl: answering(BRIEF), master }), { error: 'spend_limit' })
    assert.equal(calls.length, 2)
  })
  // A model without a listed price: refused when a dollar limit is set (fails closed), allowed when none is.
  await withEnv({ ...NONE, DAZL_RUN_MAX_USD_USERS: 'U:5', DAZL_ANTHROPIC_MODEL: 'claude-unlisted-model' }, async () => {
    await writeKey(db, 'U', 'anthropic', KEY, master)
    assert.deepEqual(await generateBrief(db, 'U', 'lead generation', { fetchImpl: answering(BRIEF), master }), { error: 'spend_limit' })
    assert.equal(calls.length, 2)
  })
  await withEnv({ ...NONE, DAZL_ANTHROPIC_MODEL: 'claude-unlisted-model' }, async () => {
    assert.ok(!('error' in await generateBrief(db, 'U', 'lead generation', { fetchImpl: answering(BRIEF), master })))
    assert.equal(calls.length, 3)
  })
  // Tenant scope: U's limit and T's pool are separate.
  assert.deepEqual(await reserved(db, 'U'), [])
})

bothEngines('ownerGuarded: unchanged without a limit; with one, every completion reserves and the store failing refuses', async ({ db }) => {
  assert.equal(ownerGuarded(db, 'T', anthropicProvider, {}), anthropicProvider)
  const g = ownerGuarded(db, 'T', anthropicProvider, { DAZL_RUN_MAX_USD_USERS: 'T:5' })
  assert.notEqual(g, anthropicProvider)
  calls.length = 0
  assert.equal(await g.complete!(KEY, 'hello', answering('ok'), 50), 'ok')
  assert.equal((await reserved(db, 'T')).length, 1)
  await db.run('ALTER TABLE tenant_spend_pools RENAME TO tenant_spend_pools_unavailable')
  try {
    await assert.rejects(g.complete!(KEY, 'hello', answering('ok'), 50), /spend_refused:reservation_not_saved/)
    assert.equal(calls.length, 1, 'the store did not answer: no call')
  } finally { await db.run('ALTER TABLE tenant_spend_pools_unavailable RENAME TO tenant_spend_pools') }
})

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
const POLISHED = 'Subject: A quick idea for Acme\n\nHi Pat, saw you are hiring AEs. We help new sales hires ramp faster. Worth a short call next week?\n\nThanks,'

test('draft polish, follow-up text and reply-intent grading: past the limit no call is made and the fallback stands', async () => {
  const db = outreachDb()
  const id = createDraft(db, 'A', 'l1', 'Acme')
  const before = (db.prepare('SELECT subject, body FROM outreach_messages WHERE id = ?').get(id) as { subject: string; body: string })
  calls.length = 0
  await withEnv({ ...NONE, DAZL_RUN_MAX_USD_USERS: 'A:0.0001' }, async () => {
    assert.deepEqual(await polishDraft(db, 'A', id, 'Acme', { fetchImpl: answering(POLISHED), master }), { rewritten: false, reason: 'spend_limit' })
    assert.deepEqual(db.prepare('SELECT subject, body FROM outreach_messages WHERE id = ?').get(id), before, 'the template draft is unchanged')
    assert.equal((db.prepare("SELECT outcome FROM outreach_llm_usage WHERE message_id = ? ORDER BY id DESC").get(id) as { outcome: string }).outcome, 'spend_limit', 'recorded as refused by the limit')
    assert.equal(await llmFollowupText(db, 'A', 0, { company: 'Acme', name: 'Pat', signal: 'hiring AEs', source_url: 'https://n.example/a' }, 'Acme', null, { fetchImpl: answering('Hi Pat, a quick nudge about the AE hiring. Worth a call?'), master }), null, 'the template follow-up is used')
    assert.equal(await gradeBuyerIntent(db, 'A', { title: 'Need help ramping AEs', quote: 'we are hiring' }, { fetchImpl: answering('yes'), master }), null, 'left ungraded')
    assert.equal(calls.length, 0, 'no provider call on any of the three')
    assert.deepEqual(await reserved(sqliteDb(db), 'A'), [])
  })
  await withEnv({ ...NONE, DAZL_RUN_MAX_USD_USERS: 'A:5' }, async () => {
    assert.equal((await polishDraft(db, 'A', id, 'Acme', { fetchImpl: answering(POLISHED), master })).rewritten, true)
    assert.equal(await gradeBuyerIntent(db, 'A', { title: 'Need help ramping AEs', quote: 'we are hiring' }, { fetchImpl: answering('yes'), master }), 'yes')
    assert.equal(calls.length, 2)
    assert.deepEqual((await reserved(sqliteDb(db), 'A')).map(r => [r[0], r[3]]), [['d:', 2]], 'both calls reserved in the same pool')
  })
})
