import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import Database from 'better-sqlite3'
import { migrateKeys, saveKey } from '../lib/llm/key-store.ts'
import { migrateScan } from '../lib/scan/store.ts'
import { migrateConnectors } from '../lib/connectors/store.ts'
import { migratePlans } from '../lib/plans.ts'
import { migrateOutreach } from '../lib/outreach/store.ts'
import { saveSettings, createDraft } from '../lib/outreach/service.ts'
import { polishDraft } from '../lib/outreach/draft-llm.ts'
import { migrateMemory, saveMemory } from '../lib/memory.ts'
import { anthropicProvider, openaiProvider, type Provider } from '../lib/llm/provider.ts'

const master = randomBytes(32)
const KEY = 'sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status })

function setup() {
  const db = new Database(':memory:')
  migrateScan(db); migrateKeys(db); migratePlans(db); migrateConnectors(db); migrateOutreach(db); migrateMemory(db)
  saveKey(db, 'A', 'anthropic', KEY, master)
  saveSettings(db, 'A', { sender_name: 'G', postal_address: '1 King St W, Toronto ON, Canada', booking_url: null })
  saveMemory(db, 'A', { positioning: 'software that ramps new sales hires' })
  db.prepare("INSERT INTO scan_jobs (id, user_id, business_name, industry, location, status) VALUES ('j1', 'A', 'b', 'i', 'l', 'running')").run()
  db.prepare("INSERT INTO leads (id, scan_job_id, name, company, contact, signal, source_url, evidence_excerpt, confidence) VALUES ('l1', 'j1', 'Pat', 'Acme', 'pat@acme.com', 'hiring AEs', 'https://n.com/a', 'quote', 80)").run()
  // Test baseline is explicitly human-reviewed; no machine timing inference.
  db.prepare("UPDATE leads SET human_confirmed_at=1800000000, human_confirmed_from='test_review' WHERE confidence IS NOT NULL AND evidence_excerpt IS NOT NULL").run()
  db.prepare("INSERT INTO leads (id, scan_job_id, name, company, contact, signal, source_url, evidence_excerpt, confidence) VALUES ('l2', 'j1', 'Pat', 'Acme', 'pat@acme.com', 'hiring AEs', 'https://n.com/a', 'quote', 80)").run()
  // Test baseline is explicitly human-reviewed; no machine timing inference.
  db.prepare("UPDATE leads SET human_confirmed_at=1800000000, human_confirmed_from='test_review' WHERE confidence IS NOT NULL AND evidence_excerpt IS NOT NULL").run()
  db.prepare("INSERT INTO leads (id, scan_job_id, name, company, contact, signal, source_url, evidence_excerpt, confidence) VALUES ('l3', 'j1', 'Pat', 'Acme', 'pat@acme.com', 'hiring AEs', 'https://n.com/a', 'quote', 80)").run()
  // Test baseline is explicitly human-reviewed; no machine timing inference.
  db.prepare("UPDATE leads SET human_confirmed_at=1800000000, human_confirmed_from='test_review' WHERE confidence IS NOT NULL AND evidence_excerpt IS NOT NULL").run()
  db.prepare("UPDATE scan_jobs SET status = 'done' WHERE id = 'j1'").run()
  return db
}
const usageRows = (db: Database.Database) => db.prepare('SELECT vendor, model, request_id, outcome, input_tokens, output_tokens FROM outreach_llm_usage ORDER BY id').all() as { vendor: string | null; model: string | null; request_id: string | null; outcome: string; input_tokens: number | null; output_tokens: number | null }[]

test('completeDetailed: anthropic served model, usage + request id extracted, no content kept', async () => {
  const fetchImpl = (async () => json({ id: 'msg_123', model: 'claude-served-x', content: [{ type: 'text', text: 'hello' }], usage: { input_tokens: 12, output_tokens: 34, cache_read_input_tokens: 9, cache_creation_input_tokens: 4 } })) as unknown as typeof fetch
  const d = await anthropicProvider.completeDetailed!('k', 'p', fetchImpl, 600)
  assert.equal(d.text, 'hello')
  assert.equal(d.model, 'claude-served-x', 'the served model comes from the response')
  assert.equal(d.request_id, 'msg_123')
  assert.deepEqual(d.usage, { input_tokens: 12, output_tokens: 34, cache_read_input_tokens: 9, cache_creation_input_tokens: 4 })
  const noModel = (async () => json({ id: 'msg_124', content: [{ type: 'text', text: 'hi' }], usage: { input_tokens: 1, output_tokens: 1 } })) as unknown as typeof fetch
  const d2 = await anthropicProvider.completeDetailed!('k', 'p', noModel, 600)
  assert.equal(d2.model, null, 'a response without a model field yields null, never the requested model mislabeled as served')
})

test('completeDetailed: openai responses-API shape extracted', async () => {
  const fetchImpl = (async () => json({ id: 'resp_9', model: 'gpt-4.1-2025-04-14', output: [{ type: 'message', content: [{ type: 'output_text', text: 'hi' }] }], usage: { input_tokens: 5, output_tokens: 6, input_tokens_details: { cached_tokens: 2 } } })) as unknown as typeof fetch
  const d = await openaiProvider.completeDetailed!('k', 'p', fetchImpl, 600)
  assert.equal(d.text, 'hi')
  assert.equal(d.model, 'gpt-4.1-2025-04-14')
  assert.equal(d.request_id, 'resp_9')
  assert.deepEqual(d.usage, { input_tokens: 5, output_tokens: 6, cache_read_input_tokens: 2 })
  const noModel = (async () => json({ id: 'resp_10', output: [], usage: { input_tokens: 1, output_tokens: 1 } })) as unknown as typeof fetch
  const d2 = await openaiProvider.completeDetailed!('k', 'p', noModel, 600)
  assert.equal(d2.model, null, 'a response without a model field yields null, never the requested model mislabeled as served')
})

test('polish records an attempt row per outcome: rewritten, blocked_claim, error, no_profile', async () => {
  const db = setup()
  const detailed = (text: string): Record<string, Provider> => ({ anthropic: { research: async () => ({ text: '', citedUrls: [] }), completeDetailed: async () => ({ text, model: 'claude-sonnet-4-5', request_id: 'msg_x', usage: { input_tokens: 100, output_tokens: 50 } }) } })
  // rewritten
  const id1 = createDraft(db, 'A', 'l1', 'Dazl')
  const r1 = await polishDraft(db, 'A', id1, 'Dazl', { master, providers: detailed('Subject: Saw the hiring\n\nHi Pat,\n\nSaw the AE hiring reported. We help teams ramp new hires. Worth a short call?\n\nThanks,') as never })
  assert.equal(r1.rewritten, true)
  assert.deepEqual(r1.usage, { model: 'claude-sonnet-4-5', input_tokens: 100, output_tokens: 50 })
  // blocked_claim: billed call, rejected output, attempt still recorded
  const id2 = createDraft(db, 'A', 'l2', 'Dazl')
  const r2 = await polishDraft(db, 'A', id2, 'Dazl', { master, providers: detailed('Subject: Congrats\n\nHi Pat,\n\nCongrats on your recent funding round! Worth a call?\n\nThanks,') as never })
  assert.deepEqual(r2, { rewritten: false, reason: 'blocked_claim', usage: { model: 'claude-sonnet-4-5', input_tokens: 100, output_tokens: 50 } })
  // provider down: bounded error code, no tokens
  const id3 = createDraft(db, 'A', 'l3', 'Dazl')
  const down: Record<string, Provider> = { anthropic: { research: async () => ({ text: '', citedUrls: [] }), completeDetailed: async () => { throw new Error('down') } } }
  assert.deepEqual(await polishDraft(db, 'A', id3, 'Dazl', { master, providers: down as never }), { rewritten: false, reason: 'error' })

  const rows = usageRows(db)
  assert.deepEqual(rows.map(r => r.outcome), ['rewritten', 'blocked_claim', 'error'])
  assert.deepEqual(rows[0], { vendor: 'anthropic', model: 'claude-sonnet-4-5', request_id: 'msg_x', outcome: 'rewritten', input_tokens: 100, output_tokens: 50 })
  assert.equal(rows[2].model, null)
  assert.equal(rows[2].input_tokens, null)
  // no_profile: refused before any provider call, still an audited attempt
  saveMemory(db, 'A', {})
  db.prepare("INSERT INTO scan_jobs (id, user_id, business_name, industry, location, status) VALUES ('j2', 'A', 'b', 'i', 'l', 'running')").run()
  db.prepare("INSERT INTO leads (id, scan_job_id, name, company, contact, signal, source_url, evidence_excerpt, confidence) VALUES ('l4', 'j2', 'Pat', 'Acme', 'pat@acme.com', 's', 'https://n.com/a', 'q', 80)").run()
  // Test baseline is explicitly human-reviewed; no machine timing inference.
  db.prepare("UPDATE leads SET human_confirmed_at=1800000000, human_confirmed_from='test_review' WHERE confidence IS NOT NULL AND evidence_excerpt IS NOT NULL").run()
  db.prepare("UPDATE scan_jobs SET status = 'done' WHERE id = 'j2'").run()
  db.exec('CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,sells TEXT,website TEXT)'); db.prepare('INSERT OR REPLACE INTO users VALUES(?,?,?)').run('A','Synthetic onboarding offer for fixtures.',null)
  const id4 = createDraft(db, 'A', 'l4', 'Dazl')
  assert.deepEqual(await polishDraft(db, 'A', id4, 'Dazl', { master, providers: detailed('x') as never }), { rewritten: false, reason: 'no_profile' })
  const rows2 = usageRows(db)
  assert.equal(rows2[3].outcome, 'no_profile')
  assert.equal(rows2[3].vendor, 'anthropic')
  assert.equal(rows2[3].model, null)
})

test('template truth: the default draft is neutral and never interpolates the signal', () => {
  const db = setup()
  const id = createDraft(db, 'A', 'l1', 'Dazl')
  const row = db.prepare('SELECT subject, body FROM outreach_messages WHERE id = ?').get(id) as { subject: string; body: string }
  assert.equal(row.subject, 'Quick question for Acme')
  assert.match(row.body, /contact address published on Acme's page/)
  assert.doesNotMatch(row.body, /hiring AEs|I saw this reported/)
  assert.doesNotMatch(row.body, /congratulat/i)
})

test('pre-insert audit failure refuses the paid call: zero provider calls, draft untouched', async () => {
  const db = setup()
  const msg = createDraft(db, 'A', 'l1', 'Dazl')
  db.exec('DROP TABLE outreach_llm_usage')
  let calls = 0
  const providers = { anthropic: { completeDetailed: async () => { calls++; return { text: 'Subject: Saw the hiring\n\nHi Pat,\n\nSaw the AE hiring reported. We help teams ramp new hires. Worth a short call?\n\nThanks,', model: 'm', usage: { input_tokens: 1, output_tokens: 1 } } } } } as unknown as Record<string, Provider>
  const r = await polishDraft(db, 'A', msg, 'Dazl', { master, providers })
  assert.equal(r.rewritten, false)
  assert.equal(r.reason, 'error')
  assert.equal(calls, 0, 'provider must not be called when the attempt record fails - no invisible spend')
  const body = db.prepare('SELECT body FROM outreach_messages WHERE id = ?').get(msg) as { body: string }
  assert.ok(!body.body.includes('Saw the AE hiring reported'), 'draft untouched')
  db.close()
})

test('finalize failure leaves the row pending, never retries, and still returns the draft', async () => {
  const db = setup()
  const msg = createDraft(db, 'A', 'l1', 'Dazl')
  db.exec("CREATE TRIGGER block_usage_update BEFORE UPDATE ON outreach_llm_usage BEGIN SELECT RAISE(ABORT, 'finalize blocked'); END")
  let calls = 0
  const providers = { anthropic: { completeDetailed: async () => { calls++; return { text: 'Subject: Saw the hiring\n\nHi Pat,\n\nSaw the AE hiring reported. We help teams ramp new hires. Worth a short call?\n\nThanks,', model: 'm', request_id: 'req_1', usage: { input_tokens: 10, output_tokens: 5 } } } } } as unknown as Record<string, Provider>
  const r = await polishDraft(db, 'A', msg, 'Dazl', { master, providers })
  assert.equal(r.rewritten, true, 'the draft result is still returned')
  assert.equal(calls, 1, 'exactly one provider call - an audit failure never triggers a retry')
  const row = db.prepare('SELECT outcome, input_tokens FROM outreach_llm_usage WHERE message_id = ?').get(msg) as { outcome: string; input_tokens: number | null }
  assert.equal(row.outcome, 'pending', 'unfinalized attempt stays pending - unknown, never missing')
  assert.equal(row.input_tokens, null)
  db.close()
})

test('race: a draft approved mid-polish is superseded with the spend still recorded', async () => {
  const db = setup()
  const msg = createDraft(db, 'A', 'l1', 'Dazl')
  let calls = 0
  const providers = { anthropic: { completeDetailed: async () => {
    calls++
    db.prepare("UPDATE outreach_messages SET status = 'approved' WHERE id = ?").run(msg)
    return { text: 'Subject: Saw the hiring\n\nHi Pat,\n\nSaw the AE hiring reported. We help teams ramp new hires. Worth a short call?\n\nThanks,', model: 'served-1', request_id: 'req_r', usage: { input_tokens: 10, output_tokens: 5 } }
  } } } as unknown as Record<string, Provider>
  const r = await polishDraft(db, 'A', msg, 'Dazl', { master, providers })
  assert.equal(r.rewritten, false)
  assert.equal(calls, 1)
  const row = db.prepare('SELECT outcome, model, request_id, input_tokens, output_tokens FROM outreach_llm_usage WHERE message_id = ?').get(msg) as { outcome: string; model: string | null; request_id: string | null; input_tokens: number | null; output_tokens: number | null }
  assert.equal(row.outcome, 'superseded', 'the tenant action won the race - not a provider error')
  assert.equal(row.model, 'served-1')
  assert.equal(row.request_id, 'req_r')
  assert.deepEqual([row.input_tokens, row.output_tokens], [10, 5], 'tokens recorded even though the rewrite lost the race')
  db.close()
})

test('requested model, served model and cache tokens are recorded as separate facts', async () => {
  const db = setup()
  const msg = createDraft(db, 'A', 'l1', 'Dazl')
  const detailed = (model: string | null): Record<string, Provider> => ({ anthropic: {
    configuredModel: () => 'cfg-requested',
    completeDetailed: async () => ({ text: 'Subject: Saw the hiring\n\nHi Pat,\n\nSaw the AE hiring reported. We help teams ramp new hires. Worth a short call?\n\nThanks,', model, request_id: 'req_c', usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 7, cache_creation_input_tokens: 3 } }),
  } as unknown as Provider })
  const r1 = await polishDraft(db, 'A', msg, 'Dazl', { master, providers: detailed('served-actual') })
  assert.equal(r1.rewritten, true)
  const row1 = db.prepare('SELECT requested_model, model, cache_read_input_tokens, cache_creation_input_tokens FROM outreach_llm_usage WHERE message_id = ?').get(msg) as { requested_model: string | null; model: string | null; cache_read_input_tokens: number | null; cache_creation_input_tokens: number | null }
  assert.equal(row1.requested_model, 'cfg-requested')
  assert.equal(row1.model, 'served-actual')
  assert.deepEqual([row1.cache_read_input_tokens, row1.cache_creation_input_tokens], [7, 3])
  const msg2 = createDraft(db, 'A', 'l2', 'Dazl')
  await polishDraft(db, 'A', msg2, 'Dazl', { master, providers: detailed(null) })
  const row2 = db.prepare('SELECT requested_model, model FROM outreach_llm_usage WHERE message_id = ?').get(msg2) as { requested_model: string | null; model: string | null }
  assert.equal(row2.requested_model, 'cfg-requested')
  assert.equal(row2.model, null, 'no served model in the response stays NULL - never relabeled')
  db.close()
})

test('a polish request for a draft that already left draft state is refused superseded with zero provider calls', async () => {
  const db = setup()
  const msg = createDraft(db, 'A', 'l1', 'Dazl')
  db.prepare("UPDATE outreach_messages SET status = 'approved' WHERE id = ?").run(msg)
  let calls = 0
  const providers = { anthropic: { completeDetailed: async () => { calls++; return { text: 'x', model: 'm', usage: {} } } } } as unknown as Record<string, Provider>
  const r = await polishDraft(db, 'A', msg, 'Dazl', { master, providers })
  assert.equal(r.rewritten, false)
  assert.equal(calls, 0)
  const row = db.prepare('SELECT outcome FROM outreach_llm_usage WHERE message_id = ?').get(msg) as { outcome: string }
  assert.equal(row.outcome, 'superseded')
  db.close()
})

test('migrating a pre-accountability usage table adds the columns and polish keeps working', async () => {
  const db = new Database(':memory:')
  migrateScan(db); migrateKeys(db); migratePlans(db); migrateConnectors(db); migrateMemory(db)
  // The shape before requested/served/cache columns existed.
  db.exec(`CREATE TABLE outreach_llm_usage (
    id INTEGER PRIMARY KEY, tenant_id TEXT NOT NULL, message_id TEXT, purpose TEXT NOT NULL,
    vendor TEXT, model TEXT, request_id TEXT, outcome TEXT NOT NULL,
    input_tokens INTEGER, output_tokens INTEGER,
    created_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER)))`)
  migrateOutreach(db) // CREATE TABLE IF NOT EXISTS alone would hide the missing columns
  saveKey(db, 'A', 'anthropic', KEY, master)
  saveSettings(db, 'A', { sender_name: 'G', postal_address: '1 King St W, Toronto ON, Canada', booking_url: null })
  saveMemory(db, 'A', { positioning: 'software that ramps new sales hires' })
  db.prepare("INSERT INTO scan_jobs (id, user_id, business_name, industry, location, status) VALUES ('j1', 'A', 'b', 'i', 'l', 'running')").run()
  db.prepare("INSERT INTO leads (id, scan_job_id, name, company, contact, signal, source_url, evidence_excerpt, confidence) VALUES ('l1', 'j1', 'Pat', 'Acme', 'pat@acme.com', 'hiring AEs', 'https://n.com/a', 'quote', 80)").run()
  // Test baseline is explicitly human-reviewed; no machine timing inference.
  db.prepare("UPDATE leads SET human_confirmed_at=1800000000, human_confirmed_from='test_review' WHERE confidence IS NOT NULL AND evidence_excerpt IS NOT NULL").run()
  db.prepare("UPDATE scan_jobs SET status = 'done' WHERE id = 'j1'").run()
  const cols = (db.prepare('PRAGMA table_info(outreach_llm_usage)').all() as { name: string }[]).map(c => c.name)
  for (const c of ['requested_model', 'cache_read_input_tokens', 'cache_creation_input_tokens']) assert.ok(cols.includes(c), `migrated column ${c}`)
  const msg = createDraft(db, 'A', 'l1', 'Dazl')
  const providers = { anthropic: { configuredModel: () => 'cfg', completeDetailed: async () => ({ text: 'Subject: Saw the hiring\n\nHi Pat,\n\nSaw the AE hiring reported. We help teams ramp new hires. Worth a short call?\n\nThanks,', model: 'served', usage: { input_tokens: 1, output_tokens: 1 } }) } } as unknown as Record<string, Provider>
  const r = await polishDraft(db, 'A', msg, 'Dazl', { master, providers })
  assert.equal(r.rewritten, true, 'polish works on a migrated old-schema database')
  db.close()
})
