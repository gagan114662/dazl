// #365: the REAL /api/crm POST handler, two tenants, a fixture SQLite store. Only the session lookup is replaced
// (tenant-route-db.ts) and fetch is a per-case mock: no CRM request leaves the process.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { NextRequest } from 'next/server'
import { setScanDb, setUser } from './tenant-route-db.ts'
import { migrateAllSqlite } from '../../lib/db/sqlite-migrations.ts'
import { saveCrmConfig } from '../../lib/crm/index.ts'

process.env.DB_PATH ??= path.join(mkdtempSync(path.join(tmpdir(), 'dazl-crm-')), 'app.db')
process.env.DAZL_MASTER_KEY = randomBytes(32).toString('base64')
const crm = await import('../../app/api/crm/route.ts')

const calls: string[] = []
let answer: (u: string) => Response | Promise<Response> = () => { throw new Error('Unexpected network call') }
globalThis.fetch = (async (u: unknown) => { calls.push(String(u)); return answer(String(u)) }) as typeof fetch

const db = new Database(':memory:'); migrateAllSqlite(db); setScanDb(db)
for (const [t, provider] of [['A', 'hubspot'], ['B', 'hubspot'], ['C', 'pipedrive']] as const) {
  saveCrmConfig(db, t, { provider, key: `synthetic-key-${t}` })
  db.prepare("INSERT INTO scan_jobs (id, user_id, business_name, industry, location, status) VALUES (?, ?, 'b', 'i', 'l', 'running')").run(`job-${t}`, t)
  // the same company and email in every tenant: nothing of one tenant's push state may reach another
  db.prepare("INSERT INTO leads (id, scan_job_id, company, name, contact, signal, source_url, evidence_excerpt, confidence) VALUES (?, ?, 'Synthetic Co', 'Pat Example', 'pat@synthetic.example', 's', 'https://news.example/a', 'q', 80)").run(`lead-${t}`, `job-${t}`)
}
// each test starts under the route's per-tenant rate limit (20 a minute), which the whole file would exceed
const as = (id: string) => { db.prepare('DELETE FROM rate_limits').run(); setUser({ id, business_name: id }) }
const post = async (body: unknown) => {
  const r = (await crm.POST(new NextRequest('http://localhost/api/crm', { method: 'POST', headers: { 'content-type': 'application/json', host: 'localhost' }, body: JSON.stringify(body) })))!
  return { status: r.status, json: await r.json() as Record<string, unknown> }
}
const push = (t: string) => post({ action: 'push', lead_id: `lead-${t}` })
const claimOf = (t: string) => db.prepare('SELECT status, external_id FROM crm_push_claims WHERE tenant_id = ?').all(t)
const auditOf = (t: string) => (db.prepare('SELECT connector, scan_job_id, lookup, status, results FROM connector_audit WHERE tenant_id = ? ORDER BY created_at, insert_seq').all(t) as { status: string }[])
const reply = (body: string | null, status = 200) => () => new Response(body, { status })

test('HubSpot 200 with no contact id is unknown, recorded as uncertain, and blocks a blind retry until the user resolves it', async () => {
  as('A'); answer = reply('{}')
  let r = await push('A')
  assert.equal(r.status, 502); assert.equal(r.json.outcome, 'unknown'); assert.equal(r.json.ok, undefined)
  assert.match(String(r.json.error), /may or may not have been created/)
  assert.deepEqual(auditOf('A'), [{ connector: 'crm:hubspot', scan_job_id: 'job-A', lookup: 'Synthetic Co', status: 'uncertain', results: 0 }])
  // a retry is refused before any request: no duplicate create
  calls.length = 0
  r = await push('A')
  assert.deepEqual([r.status, r.json.outcome, calls.length], [409, 'unknown', 0])
  // tenant B, same company and email, is not blocked by A's unknown push; B cannot resolve A's lead
  as('B'); answer = reply(JSON.stringify({ id: '9001' }), 201)
  r = await push('B')
  assert.deepEqual([r.status, r.json.ok, r.json.external_id], [200, true, '9001'])
  assert.equal((await post({ action: 'resolve', lead_id: 'lead-A', created: false })).status, 404)
  assert.equal(auditOf('A').length, 1, 'B wrote nothing on A')
  // A checks HubSpot: not there. The push may run again and now succeeds with a real id.
  as('A')
  assert.equal((await post({ action: 'resolve', lead_id: 'lead-A' })).status, 400, 'must say what was found')
  assert.equal((await post({ action: 'resolve', lead_id: 'lead-A', created: false })).status, 200)
  assert.equal((await post({ action: 'resolve', lead_id: 'lead-A', created: false })).status, 409, 'nothing left to resolve')
  answer = reply(JSON.stringify({ id: '1234' }), 201)
  r = await push('A')
  assert.deepEqual([r.status, r.json.ok, r.json.message, r.json.external_id], [200, true, 'Contact created in HubSpot', '1234'])
  assert.deepEqual(auditOf('A').map(a => [a.status, (a as unknown as { results: number }).results]), [['uncertain', 0], ['resolved_not_created', 0], ['ok', 1]])
})

test('every malformed or wrong-type HubSpot success is unknown through the route; resolving "it is there" ends the block without pushing', async () => {
  for (const [why, body] of [['empty body', ''], ['malformed', '{"id":'], ['null', 'null'], ['numeric id', '{"id":1234}'], ['empty id', '{"id":""}']] as const) {
    db.prepare("DELETE FROM connector_audit WHERE tenant_id = 'A'").run()
    as('A'); answer = reply(body)
    const r = await push('A')
    assert.deepEqual([r.status, r.json.outcome], [502, 'unknown'], why)
    assert.deepEqual(auditOf('A').map(a => a.status), ['uncertain'], why)
    assert.equal((await post({ action: 'resolve', lead_id: 'lead-A', created: true })).status, 200)
    assert.deepEqual(auditOf('A').map(a => a.status), ['uncertain', 'resolved_created'], why)
  }
})

test('HubSpot 409 for another person\'s contact is a refusal (failed, not "already there"); the lead\'s own contact is found', async () => {
  db.prepare("DELETE FROM connector_audit WHERE tenant_id = 'A'").run()
  as('A')
  const conflict = (email: string) => (u: string) => u.endsWith('/contacts')
    ? new Response(JSON.stringify({ message: 'Contact already exists. Existing ID: 77' }), { status: 409 })
    : new Response(JSON.stringify({ id: '77', properties: { email } }), { status: 200 })
  answer = conflict('someone@else.example')
  let r = await push('A')
  assert.deepEqual([r.status, r.json.outcome, r.json.ok], [502, 'failed', undefined])
  assert.match(String(r.json.error), /not this lead/)
  assert.deepEqual(auditOf('A').map(a => a.status), ['worker_error'])
  // failed is not a block: nothing was created, so trying again is allowed
  answer = conflict('PAT@synthetic.example')
  r = await push('A')
  assert.deepEqual([r.status, r.json.message, r.json.external_id], [200, 'Already in HubSpot (matching contact exists)', '77'])
  assert.deepEqual(auditOf('A').map(a => a.status), ['worker_error', 'ok'])
})

test('Pipedrive through the route: string id is unknown, success:false is failed, a real person id is ok', async () => {
  as('C')
  answer = reply(JSON.stringify({ success: true, data: { id: '5' } }))
  let r = await push('C')
  assert.deepEqual([r.status, r.json.outcome], [502, 'unknown'])
  assert.equal((await post({ action: 'resolve', lead_id: 'lead-C', created: false })).status, 200)
  answer = reply(JSON.stringify({ success: false, error: 'invalid' }))
  r = await push('C')
  assert.deepEqual([r.status, r.json.outcome], [502, 'failed'])
  answer = reply(JSON.stringify({ success: true, data: { id: 5 } }), 201)
  r = await push('C')
  assert.deepEqual([r.status, r.json.message, r.json.external_id], [200, 'Person created in Pipedrive', '5'])
  assert.deepEqual(auditOf('C').map(a => a.status), ['uncertain', 'resolved_not_created', 'worker_error', 'ok'])
  assert.ok(calls.every(u => /^https:\/\/api\.(hubapi|pipedrive)\.com\//.test(u)), 'only the mocked CRM endpoints were addressed')
})

// Instinct's HOLD on 9ff1eb0: the claim is taken atomically before the create is sent, follows the lead id (not its
// company text), survives a crash as unknown, and a result that cannot be recorded never makes a retry safe.
test('two concurrent pushes of one lead send ONE create; the other is refused as in progress', async () => {
  db.prepare("DELETE FROM crm_push_claims").run(); calls.length = 0
  as('A')
  let release!: () => void
  const gate = new Promise<void>(r => { release = r })
  answer = async () => { await gate; return new Response('{}', { status: 200 }) }
  const both = Promise.all([push('A'), push('A')])
  await new Promise(r => setTimeout(r, 20))
  release()
  const rs = await both
  assert.equal(calls.length, 1, 'exactly one create left the handler')
  assert.deepEqual(rs.map(r => [r.status, r.json.outcome]).sort(), [[409, 'in_progress'], [502, 'unknown']])
  assert.deepEqual(claimOf('A'), [{ status: 'uncertain', external_id: null }])
})

test('the hold follows the lead, not its company text: a rename in the same scan keeps the unknown push blocked', async () => {
  as('A'); calls.length = 0
  db.prepare("UPDATE leads SET company = 'Synthetic Co (renamed)' WHERE id = 'lead-A'").run()
  const r = await push('A')
  assert.deepEqual([r.status, r.json.outcome, calls.length], [409, 'unknown', 0])
  assert.equal((await post({ action: 'resolve', lead_id: 'lead-A', created: false })).status, 200)
  db.prepare("UPDATE leads SET company = 'Synthetic Co' WHERE id = 'lead-A'").run()
})

test('a crashed request (claim left pending) blocks as in progress, then as unknown once stale; only then can it be resolved', async () => {
  as('A'); calls.length = 0
  const now = Math.floor(Date.now() / 1000)
  db.prepare("UPDATE crm_push_claims SET status = 'pending', claimed_at = ? WHERE tenant_id = 'A'").run(now - 10)
  let r = await push('A')
  assert.deepEqual([r.status, r.json.outcome, calls.length], [409, 'in_progress', 0])
  assert.equal((await post({ action: 'resolve', lead_id: 'lead-A', created: false })).status, 409, 'a live claim cannot be resolved')
  db.prepare("UPDATE crm_push_claims SET claimed_at = ? WHERE tenant_id = 'A'").run(now - 301)
  r = await push('A')
  assert.deepEqual([r.status, r.json.outcome, calls.length], [409, 'unknown', 0])
  assert.equal((await post({ action: 'resolve', lead_id: 'lead-A', created: true })).status, 200)
  assert.deepEqual(claimOf('A'), [{ status: 'resolved_created', external_id: null }])
})

test('a result that cannot be recorded after the create answers ok: reported unknown, and the retry stays blocked', async () => {
  as('A'); calls.length = 0
  db.exec("CREATE TRIGGER crm_claim_write_fails BEFORE UPDATE ON crm_push_claims WHEN NEW.status <> 'pending' BEGIN SELECT RAISE(ABORT, 'disk full'); END")
  try {
    answer = reply(JSON.stringify({ id: '555' }), 201)
    const r = await push('A')
    assert.deepEqual([r.status, r.json.outcome, calls.length], [502, 'unknown', 1])
  } finally { db.exec('DROP TRIGGER crm_claim_write_fails') }
  assert.deepEqual(claimOf('A'), [{ status: 'pending', external_id: null }])
  const again = await push('A')
  assert.deepEqual([again.status, again.json.outcome, calls.length], [409, 'in_progress', 1], 'no second create')
})

test('disconnect and reconnect with a new key, same CRM: the unknown push stays blocked until resolved', async () => {
  db.prepare("DELETE FROM crm_push_claims").run(); calls.length = 0
  as('A'); answer = reply('{}')
  let r = await push('A')
  assert.deepEqual([r.status, r.json.outcome, calls.length], [502, 'unknown', 1])
  assert.equal((await post({ action: 'disconnect' })).status, 200)
  saveCrmConfig(db, 'A', { provider: 'hubspot', key: 'synthetic-key-A-rotated' })
  r = await push('A')
  assert.deepEqual([r.status, r.json.outcome, calls.length], [409, 'unknown', 1], 'no create with the new key')
  assert.equal((await post({ action: 'resolve', lead_id: 'lead-A', created: false })).status, 200)
  answer = reply(JSON.stringify({ id: '777' }), 201)
  r = await push('A')
  assert.deepEqual([r.status, r.json.external_id, calls.length], [200, '777', 2])
})

test('status is read-only: none, in_progress, unknown and done from the durable claim; never sends; tenant-scoped', async () => {
  db.prepare("DELETE FROM crm_push_claims").run(); calls.length = 0
  as('A')
  const status = async () => (await post({ action: 'status', lead_id: 'lead-A' })).json
  assert.deepEqual(await status(), { state: 'none', external_id: null })
  const now = Math.floor(Date.now() / 1000)
  db.prepare("INSERT INTO crm_push_claims (tenant_id, destination, lead_id, status, attempt_id, claimed_at, updated_at) VALUES ('A', 'hubspot', 'lead-A', 'pending', 'x', ?, ?)").run(now, now)
  assert.deepEqual(await status(), { state: 'in_progress', external_id: null })
  db.prepare("UPDATE crm_push_claims SET claimed_at = ? WHERE tenant_id = 'A'").run(now - 301)
  assert.deepEqual(await status(), { state: 'unknown', external_id: null })
  db.prepare("UPDATE crm_push_claims SET status = 'uncertain' WHERE tenant_id = 'A'").run()
  assert.deepEqual(await status(), { state: 'unknown', external_id: null })
  db.prepare("UPDATE crm_push_claims SET status = 'ok', external_id = '42' WHERE tenant_id = 'A'").run()
  assert.deepEqual(await status(), { state: 'done', external_id: '42' })
  db.prepare("UPDATE crm_push_claims SET status = 'failed', external_id = NULL WHERE tenant_id = 'A'").run()
  assert.deepEqual(await status(), { state: 'none', external_id: null })
  assert.equal(calls.length, 0, 'status never sends')
  as('B')
  assert.equal((await post({ action: 'status', lead_id: 'lead-A' })).status, 404)
})
