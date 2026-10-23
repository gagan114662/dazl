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
  db.prepare("INSERT INTO leads (id, scan_job_id, name, company, contact, signal, source_url, evidence_excerpt, confidence) VALUES ('l2', 'j1', 'Pat', 'Acme', 'pat@acme.com', 'hiring AEs', 'https://n.com/a', 'quote', 80)").run()
  db.prepare("INSERT INTO leads (id, scan_job_id, name, company, contact, signal, source_url, evidence_excerpt, confidence) VALUES ('l3', 'j1', 'Pat', 'Acme', 'pat@acme.com', 'hiring AEs', 'https://n.com/a', 'quote', 80)").run()
  db.prepare("UPDATE scan_jobs SET status = 'done' WHERE id = 'j1'").run()
  return db
}
const usageRows = (db: Database.Database) => db.prepare('SELECT vendor, model, request_id, outcome, input_tokens, output_tokens FROM outreach_llm_usage ORDER BY id').all() as { vendor: string | null; model: string | null; request_id: string | null; outcome: string; input_tokens: number | null; output_tokens: number | null }[]

test('completeDetailed: anthropic usage + request id extracted, no content kept', async () => {
  const fetchImpl = (async () => json({ id: 'msg_123', content: [{ type: 'text', text: 'hello' }], usage: { input_tokens: 12, output_tokens: 34 } })) as unknown as typeof fetch
  const d = await anthropicProvider.completeDetailed!('k', 'p', fetchImpl, 600)
  assert.equal(d.text, 'hello')
  assert.equal(d.model, 'claude-sonnet-4-5')
  assert.equal(d.request_id, 'msg_123')
  assert.deepEqual(d.usage, { input_tokens: 12, output_tokens: 34 })
})

test('completeDetailed: openai responses-API shape extracted', async () => {
  const fetchImpl = (async () => json({ id: 'resp_9', output: [{ type: 'message', content: [{ type: 'output_text', text: 'hi' }] }], usage: { input_tokens: 5, output_tokens: 6 } })) as unknown as typeof fetch
  const d = await openaiProvider.completeDetailed!('k', 'p', fetchImpl, 600)
  assert.equal(d.text, 'hi')
  assert.equal(d.model, 'gpt-4.1')
  assert.equal(d.request_id, 'resp_9')
  assert.deepEqual(d.usage, { input_tokens: 5, output_tokens: 6 })
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
  db.prepare("UPDATE scan_jobs SET status = 'done' WHERE id = 'j2'").run()
  const id4 = createDraft(db, 'A', 'l4', 'Dazl')
  assert.deepEqual(await polishDraft(db, 'A', id4, 'Dazl', { master, providers: detailed('x') as never }), { rewritten: false, reason: 'no_profile' })
  const rows2 = usageRows(db)
  assert.equal(rows2[3].outcome, 'no_profile')
  assert.equal(rows2[3].vendor, 'anthropic')
  assert.equal(rows2[3].model, null)
})

test('template truth: the default draft attributes the signal to the source, no invented certainty', () => {
  const db = setup()
  const id = createDraft(db, 'A', 'l1', 'Dazl')
  const row = db.prepare('SELECT subject, body FROM outreach_messages WHERE id = ?').get(id) as { subject: string; body: string }
  assert.equal(row.subject, 'Quick question for Acme')
  assert.match(row.body, /I saw this reported about Acme: hiring AEs/)
  assert.doesNotMatch(row.body, /I came across this/)
  assert.doesNotMatch(row.body, /congratulat/i)
})
