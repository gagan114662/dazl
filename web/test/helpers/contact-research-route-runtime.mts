// POST /api/leads/contact-research (#1102, TEST-ONLY staging route) through the real handler: not there outside staging, session,
// operate role, same-origin JSON, the caller's own Anthropic key and spend account; one lookup end to end with TinyFish and the
// Anthropic API stubbed at fetch (no network). Invented company and person.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { randomBytes } from 'node:crypto'
import { NextRequest } from 'next/server'
import { setScanDb, setUser } from './tenant-route-db.ts'
import { migrateAllSqlite } from '../../lib/db/sqlite-migrations.ts'
import { saveKey } from '../../lib/llm/key-store.ts'
import { resetTinyfishState } from '../../lib/search/tinyfish.ts'
import { POST } from '../../app/api/leads/contact-research/route.ts'

process.env.DAZL_MASTER_KEY = randomBytes(32).toString('base64')
process.env.TINYFISH_API_KEY = 'tf-test'
const seen: { host: string; body: Record<string, unknown> | null; key: string | null }[] = []
let answer: unknown = { person: { name: 'Jane Roe', title: 'Owner', source: 'S1', quote: 'Jane Roe - Owner - Brightloop Dental', linkedin_source: 'S1' } }
let anthropicStatus = 200
globalThis.fetch = (async (u: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(u)); const body = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : null
  seen.push({ host: url.hostname, body, key: new Headers(init?.headers).get('x-api-key') })
  if (url.hostname === 'api.search.tinyfish.ai') return new Response(JSON.stringify({ results: [{ url: 'https://ca.linkedin.com/in/jane-roe-test', title: 'Jane Roe - Owner - Brightloop Dental | LinkedIn', snippet: 'Toronto, Ontario, Canada · Owner · Brightloop Dental · brightloopdental.example' }] }))
  if (url.hostname === 'api.anthropic.com') return anthropicStatus !== 200 ? new Response('{"error":{"type":"authentication_error"}}', { status: anthropicStatus }) : new Response(JSON.stringify({ id: 'msg_1', model: body?.model, stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: JSON.stringify(answer) }], usage: { input_tokens: 900, output_tokens: 200 } }))
  throw new Error(`Unexpected network call to ${url.hostname}`)
}) as typeof fetch
const A = { id: 'A', business_name: 'Acme' }, B = { id: 'B', business_name: 'Beta' }
const json = { 'content-type': 'application/json', origin: 'http://localhost', host: 'localhost' }
const BODY = { company: 'Brightloop Dental', domain: 'brightloopdental.example', roles: ['Owner', 'Office manager'], where: ['Toronto, Ontario'] }
const call = (body: unknown = BODY, headers: Record<string, string> = json) => POST(new NextRequest('http://localhost/api/leads/contact-research', { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body), headers }))
function build() { const db = new Database(':memory:'); migrateAllSqlite(db); setScanDb(db); resetTinyfishState(); seen.length = 0; return db }
const rows = (db: Database.Database, t: string) => (db.prepare(`SELECT count(*) AS n FROM ${t}`).get() as { n: number }).n

test('#1102 contact-research route refusals: 404 outside staging, 401 signed out, viewer refused, cross-origin and bad bodies refused, no Anthropic key 409; no request is made', async () => {
  const db = build()
  saveKey(db, 'A', 'anthropic', 'sk-ant-test-a')
  setUser({ ...A, role: 'owner' })
  for (const v of [undefined, 'production', 'prod', 'Staging', '']) {
    if (v === undefined) delete process.env.DAZL_ENV; else process.env.DAZL_ENV = v
    assert.equal((await call()).status, 404, String(v))
    assert.equal((await call(BODY, { ...json, origin: 'https://evil.example' })).status, 404, String(v))
  }
  process.env.DAZL_ENV = 'staging'
  setUser(null); assert.equal((await call()).status, 401)
  setUser({ ...A, role: 'viewer' }); assert.equal((await call()).status, 403)
  setUser({ ...A, role: 'owner' })
  assert.equal((await call(BODY, { ...json, origin: 'https://evil.example' })).status, 403)
  for (const bad of ['not json', {}, { company: 'A' }, { company: 'Acme', roles: 'Owner' }, { company: 'Acme', domain: 'http://x' }, { company: 'Acme', model: 'opus' }, { company: 'x'.repeat(3000) }]) assert.equal((await call(bad)).status, 400, JSON.stringify(bad).slice(0, 40))
  // Another workspace with no key of its own never borrows A's key.
  setUser({ ...B, role: 'owner' })
  const r = await call(); assert.equal(r.status, 409); assert.deepEqual(await r.json(), { error: 'anthropic_key_required' })
  // An OpenAI-only workspace is refused too (the lookup uses the account's Anthropic key only).
  saveKey(db, 'B', 'openai', 'sk-openai-test-b')
  assert.equal((await call()).status, 409)
  assert.equal(seen.length, 0, 'no search and no model request was made by any refused call')
  assert.equal(rows(db, 'tinyfish_usage'), 0)
})

test('#1102 contact-research route: one lookup on the caller\'s own key (Haiku asked for by name), searches counted for the tenant, nothing written to any lead', async () => {
  const db = build(); process.env.DAZL_ENV = 'staging'
  saveKey(db, 'A', 'anthropic', 'sk-ant-test-a'); saveKey(db, 'B', 'anthropic', 'sk-ant-test-b')
  setUser({ ...A, role: 'owner' })
  const leadsBefore = rows(db, 'leads'), enrBefore = rows(db, 'lead_enrichments')
  const r = await call(); assert.equal(r.status, 200); assert.equal(r.headers.get('cache-control'), 'no-store')
  const j = await r.json() as Record<string, unknown>
  assert.equal(j.status, 'found', JSON.stringify(j))
  assert.deepEqual(j.person, { name: 'Jane Roe', title: 'Owner', linkedin: 'https://ca.linkedin.com/in/jane-roe-test', source_url: 'https://ca.linkedin.com/in/jane-roe-test', quote: 'Jane Roe - Owner - Brightloop Dental', place: 'agrees' })
  assert.deepEqual(j.usage, { searches: 2, reads: 0, model: 'claude-haiku-5-5', input_tokens: 900, output_tokens: 200 })
  assert.equal(j.cost_usd_listed, (900 * 0.1 + 200 * 0.5) / 1e6)
  const model = seen.filter(s => s.host === 'api.anthropic.com')
  assert.equal(model.length, 1); assert.equal(model[0].body?.model, 'claude-haiku-5-5'); assert.equal(model[0].key, 'sk-ant-test-a', "the caller's own key")
  assert.equal(seen.filter(s => s.host === 'api.search.tinyfish.ai').length, 2)
  assert.deepEqual(db.prepare("SELECT tenant_id, kind, n FROM tinyfish_usage").all(), [{ tenant_id: 'A', kind: 'search', n: 2 }], 'the searches count against the caller\'s daily cap')
  assert.equal(rows(db, 'leads'), leadsBefore); assert.equal(rows(db, 'lead_enrichments'), enrBefore)
  // The model call was reserved and settled on the caller's own spend account, nobody else's.
  const pools = db.prepare('SELECT DISTINCT tenant_id FROM tenant_spend_pools').all() as { tenant_id: string }[]
  assert.deepEqual(pools.map(p => p.tenant_id), ['A'])
  // model: "default" asks for the deployment's model on the same key.
  seen.length = 0
  assert.equal((await call({ ...BODY, model: 'default' })).status, 200)
  assert.equal(seen.find(s => s.host === 'api.anthropic.com')?.body?.model, process.env.DAZL_ANTHROPIC_MODEL || 'claude-sonnet-4-5')
  // The second workspace uses its own key.
  setUser({ ...B, role: 'owner' }); seen.length = 0
  assert.equal((await call()).status, 200); assert.equal(seen.find(s => s.host === 'api.anthropic.com')?.key, 'sk-ant-test-b')
  // A rejected key is said so; nothing is returned as a person.
  anthropicStatus = 401
  const bad = await call(); assert.equal(bad.status, 502); assert.deepEqual(await bad.json(), { error: 'key_rejected' })
  anthropicStatus = 200
  // The model inventing a person the search did not return is refused by the grounding check, through the real route.
  answer = { person: { name: 'Maria Gomez', title: 'Owner', source: 'S1', quote: 'Maria Gomez - Owner - Brightloop Dental', linkedin_source: 'S1' } }
  const inv = await (await call()).json() as Record<string, unknown>
  assert.equal(inv.status, 'not_grounded'); assert.equal(inv.refused, 'quote_not_in_source'); assert.equal(inv.person, null)
})
