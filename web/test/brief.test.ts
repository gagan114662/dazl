import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { randomBytes } from 'node:crypto'
import { migrateBriefs, generateBrief, recentBriefs } from '../lib/seo/brief.ts'
import { migrateKeys, saveKey } from '../lib/llm/key-store.ts'
import { sqliteDb } from '../lib/db/client.ts'

const master = randomBytes(32)
const LONG = 'TITLE OPTIONS\n1. a\n2. b\n3. c\nTARGET AUDIENCE\nfounders\nSEARCH INTENT\nlearn\nOUTLINE\n- one\n- two\n- three\n- four\n- five\nMETA DESCRIPTION\na description\nFAQS\nq1 q2 q3'
function setup() { const db = new Database(':memory:'); migrateKeys(db); migrateBriefs(db); return db }
const anthropicOk = (async (..._args: unknown[]) => new Response(JSON.stringify({ content: [{ type: 'text', text: LONG }] }), { status: 200 })) as unknown as typeof fetch

test('no key -> no_key, no outbound call', async () => {
  const db = setup()
  let called = false
  const r = await generateBrief(sqliteDb(db), db, 'u1', 'lead generation', { fetchImpl: (async () => { called = true; return new Response('{}') }) as never, master })
  assert.deepEqual(r, { error: 'no_key' })
  assert.equal(called, false)
})

test('brief generated on the tenant key, stored, listed', async () => {
  const db = setup()
  saveKey(db, 'u1', 'anthropic', 'sk-ant-test-key-1234', master)
  let sentKey = ''
  const f = (async (_u: string, init: RequestInit) => { sentKey = (init.headers as Record<string, string>)['x-api-key']; return anthropicOk('https://api.anthropic.com/v1/messages', {}) }) as unknown as typeof fetch
  const r = await generateBrief(sqliteDb(db), db, 'u1', 'lead generation for agencies', { fetchImpl: f, master, now: 1_800_000_000 })
  assert.ok(!('error' in r))
  if (!('error' in r)) assert.equal(r.brief, LONG)
  assert.equal(sentKey, 'sk-ant-test-key-1234') // the tenant's own key, never the operator's
  const list = (await recentBriefs(sqliteDb(db), 'u1'))
  assert.equal(list.length, 1)
  assert.equal(list[0].topic, 'lead generation for agencies')
})

test('short topic invalid; upstream failure and thin answer are errors, nothing stored', async () => {
  const db = setup()
  saveKey(db, 'u1', 'anthropic', 'sk-ant-test-key-1234', master)
  assert.deepEqual(await generateBrief(sqliteDb(db), db, 'u1', 'ab', { fetchImpl: anthropicOk, master }), { error: 'invalid' })
  assert.deepEqual(await generateBrief(sqliteDb(db), db, 'u1', 'topic here', { fetchImpl: (async () => new Response('no', { status: 500 })) as never, master }), { error: 'upstream' })
  assert.deepEqual(await generateBrief(sqliteDb(db), db, 'u1', 'topic here', { fetchImpl: (async () => new Response(JSON.stringify({ content: [{ type: 'text', text: 'short' }] }), { status: 200 })) as never, master }), { error: 'upstream' })
  assert.equal((await recentBriefs(sqliteDb(db), 'u1')).length, 0)
})
