// POST / DELETE /api/leads/tech-fixture (#769) through the real handlers: not there outside staging, session, operate role,
// same-origin JSON, the caller's own workspace only, then the adoption -> outage -> removal sequence and cleanup. fetch throws and counts.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { NextRequest } from 'next/server'
import { setScanDb, setUser } from './tenant-route-db.ts'
import { migrateAllSqlite } from '../../lib/db/sqlite-migrations.ts'
import { POST, DELETE } from '../../app/api/leads/tech-fixture/route.ts'

let fetches = 0
globalThis.fetch = (async () => { fetches++; throw new Error('Unexpected network call') }) as typeof fetch
const A = { id: 'A', business_name: 'Acme' }, B = { id: 'B', business_name: 'Beta' }
const json = { 'content-type': 'application/json', origin: 'http://localhost', host: 'localhost' }
const call = (method: 'POST' | 'DELETE', body: unknown = {}, headers: Record<string, string> = json) =>
  (method === 'POST' ? POST : DELETE)(new NextRequest('http://localhost/api/leads/tech-fixture', { method, body: JSON.stringify(body), headers }))
function build() { const db = new Database(':memory:'); migrateAllSqlite(db); setScanDb(db); return db }
const jobs = (db: Database.Database) => (db.prepare('SELECT count(*) AS n FROM scan_jobs').get() as { n: number }).n

test('#769 tech fixture route refusals: 404 outside staging for a signed-in owner, 401 signed out, viewer refused, cross-origin and non-JSON refused, unknown page 400, crawl off 503; nothing is written', async () => {
  const db = build()
  process.env.SITECRAWL_ENABLED = '1'
  setUser({ ...A, role: 'owner' })
  for (const v of [undefined, 'production', 'prod', 'Staging', '']) {
    if (v === undefined) delete process.env.DAZL_ENV; else process.env.DAZL_ENV = v
    assert.equal((await call('POST', { page: 'plain' })).status, 404, String(v))
    assert.equal((await call('DELETE')).status, 404, String(v))
    assert.equal((await call('POST', { page: 'plain' }, { ...json, origin: 'https://evil.example' })).status, 404, String(v))
  }
  process.env.DAZL_ENV = 'staging'
  setUser(null)
  assert.equal((await call('POST', { page: 'plain' })).status, 401)
  assert.equal((await call('DELETE')).status, 401)
  setUser({ ...A, role: 'viewer' })
  assert.equal((await call('POST', { page: 'plain' })).status, 403)
  assert.equal((await call('DELETE')).status, 403)
  setUser({ ...A, role: 'owner' })
  assert.equal((await call('POST', { page: 'plain' }, { ...json, origin: 'https://evil.example' })).status, 403)
  assert.equal((await call('POST', { page: 'plain' }, { host: 'localhost', 'content-type': 'text/plain' })).status, 403)
  const bad = await call('POST', { page: 'wordpress' })
  assert.equal(bad.status, 400)
  assert.deepEqual(await bad.json(), { error: 'unknown_page', pages: ['plain', 'hubspot', 'consent_wall', 'challenge', 'outage_503', 'home_503'] })
  assert.equal((await call('POST', {})).status, 400)
  process.env.SITECRAWL_ENABLED = '0'
  const off = await call('POST', { page: 'plain' })
  assert.equal(off.status, 503); assert.deepEqual(await off.json(), { error: 'crawl_disabled' })
  process.env.SITECRAWL_ENABLED = '1'
  assert.equal(jobs(db), 0)
  assert.equal(fetches, 0)
})

test('#769 tech fixture route on staging: plain -> hubspot adds; an outage (whole site or homepage only), consent wall and challenge change nothing; two plain pages remove; a forged tenant in the body is ignored; cleanup', async () => {
  const db = build()
  process.env.DAZL_ENV = 'staging'; process.env.SITECRAWL_ENABLED = '1'
  setUser({ ...A, role: 'operator' })
  const post = async (page: string, extra: Record<string, unknown> = {}) => { const r = await call('POST', { page, ...extra }); assert.equal(r.status, 200, `${page}: ${r.status === 200 ? '' : await r.clone().text()}`); assert.equal(r.headers.get('cache-control'), 'no-store'); return r.json() }
  const first = await post('plain', { tenant_id: 'B', tenantId: 'B' })
  assert.equal((db.prepare('SELECT user_id FROM scan_jobs WHERE id = ?').get(first.job_id) as { user_id: string }).user_id, 'A')
  assert.deepEqual(first.changes, [])
  assert.deepEqual((await post('hubspot')).crawl.new_changes, ['HubSpot added'])
  for (const page of ['outage_503', 'home_503', 'consent_wall', 'challenge']) {
    const r = await post(page)
    assert.deepEqual(r.crawl.new_changes, [], page)
    assert.deepEqual(r.changes.map((c: { value: string }) => c.value), ['HubSpot added'], page)
  }
  assert.deepEqual((await post('plain')).crawl.new_changes, [])
  const last = await post('plain')
  assert.deepEqual(last.crawl.new_changes, ['HubSpot removed'])
  assert.deepEqual(last.measured, { crawls: 8, unreadable_or_failed_crawls: 4, changes_claimed: 2, false_changes: 0, changes_claimed_on_unreadable_or_failed: 0 })
  assert.deepEqual(last.observations.map((o: { readability: string }) => o.readability), ['ok', 'ok', 'thin_page', 'blocked', 'ok', 'ok'])

  // B cannot remove A's fixture: B has none of its own.
  setUser({ ...B, role: 'owner' })
  assert.deepEqual(await (await call('DELETE')).json(), { deleted: false })
  assert.equal(jobs(db), 1)
  setUser({ ...A, role: 'operator' })
  assert.deepEqual(await (await call('DELETE')).json(), { deleted: true })
  assert.equal(jobs(db), 0)
  assert.equal((db.prepare('SELECT count(*) AS n FROM lead_enrichments').get() as { n: number }).n, 0)
  assert.equal(fetches, 0)
})
