// #366: the REAL /api/deals handlers, two workspaces. Only the session lookup is replaced (tenant-route-db.ts); no network.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { NextRequest } from 'next/server'
import { setScanDb, setUser } from './tenant-route-db.ts'
import { migrateAllSqlite } from '../../lib/db/sqlite-migrations.ts'

process.env.DB_PATH ??= path.join(mkdtempSync(path.join(tmpdir(), 'dazl-deals-')), 'app.db')
globalThis.fetch = (async () => { throw new Error('Unexpected network call') }) as typeof fetch
const route = await import('../../app/api/deals/route.ts')
const db = new Database(':memory:'); migrateAllSqlite(db); setScanDb(db)
for (const t of ['A', 'B']) {
  for (const [m, role] of [[`${t}-owner`, 'owner'], [`${t}-rep`, 'operator'], [`${t}-viewer`, 'viewer']]) db.prepare('INSERT INTO memberships (tenant_id, member_id, role, created_at) VALUES (?, ?, ?, 1)').run(t, m, role)
  db.prepare("INSERT INTO scan_jobs (id, user_id, business_name, industry, location, status) VALUES (?, ?, 'b', 'i', 'l', 'running')").run(`job-${t}`, t)
  db.prepare("INSERT INTO leads (id, scan_job_id, company, contact, signal, source_url) VALUES (?, ?, 'Buyer Co', 'p@buyer.example', 's', 'https://news.example/a')").run(`lead-${t}`, `job-${t}`)
  db.prepare("INSERT INTO inbound_messages (gmail_id, tenant_id, thread_id, lead_id, from_email, excerpt, classification, received_at) VALUES (?, ?, ?, ?, 'p@buyer.example', 'Interested', 'positive', 1)").run(`g-${t}`, t, `th-${t}`, `lead-${t}`)
}
const as = (tenant: string, member: string, role: string) => setUser({ id: member, email: `${member}@example.test`, business_name: tenant, actorId: member, tenantId: tenant, role } as never)
const post = async (body: unknown) => { db.prepare('DELETE FROM rate_limits').run(); const r = (await route.POST(new NextRequest('http://localhost/api/deals', { method: 'POST', headers: { 'content-type': 'application/json', host: 'localhost', origin: 'http://localhost' }, body: JSON.stringify(body) })))!; return { status: r.status, json: await r.json() as Record<string, unknown> } }
const get = async (q = '') => { const r = (await route.GET(new NextRequest(`http://localhost/api/deals${q}`, { headers: { host: 'localhost' } })))!; return { status: r.status, json: await r.json() as Record<string, unknown> } }

test("'POST /api/deals' and 'GET /api/deals': create, move, history, roles, and tenant B never reaches A's deal", async () => {
  as('A', 'A-rep', 'operator')
  const created = await post({ action: 'create', lead_id: 'lead-A' })
  assert.equal(created.status, 201)
  const deal = created.json.deal as { id: string; version: number; owner_id: string }
  assert.equal(deal.owner_id, 'A-rep', 'the acting member owns it by default')
  const moved = await post({ action: 'move', id: deal.id, to: 'won', version: deal.version, amount_minor: 120000, currency: 'CAD' })
  assert.equal(moved.status, 200)
  assert.equal((await post({ action: 'move', id: deal.id, to: 'lost', version: deal.version, reason: 'x' })).status, 409, 'stale')
  const list = await get()
  assert.deepEqual((list.json.report as { won: unknown[] }).won, [{ currency: 'CAD', deals: 1, amount_minor: 120000 }])
  assert.deepEqual(((await get(`?id=${deal.id}`)).json.history as { kind: string; actor: string }[]).map(e => [e.kind, e.actor]), [['created', 'A-rep'], ['moved', 'A-rep']])
  // a viewer reads but cannot change deals
  as('A', 'A-viewer', 'viewer')
  assert.equal((await get()).status, 200)
  assert.equal((await post({ action: 'create', lead_id: 'lead-A' })).status, 403)
  // tenant B: nothing of A's comes back, and A's deal and lead cannot be touched
  as('B', 'B-owner', 'owner')
  assert.deepEqual((await get()).json.deals, [])
  assert.equal((await get(`?id=${deal.id}`)).status, 404)
  assert.equal((await post({ action: 'reopen', id: deal.id, version: 2, reason: 'mine now' })).status, 404)
  assert.equal((await post({ action: 'create', lead_id: 'lead-A' })).status, 404)
  assert.equal((await post({ action: 'create', lead_id: 'lead-B', owner_id: 'A-rep' })).status, 400, "A's member cannot own B's deal")
  assert.equal((db.prepare('SELECT stage, version FROM deals WHERE id = ?').get(deal.id) as { stage: string; version: number }).stage, 'won')
})
