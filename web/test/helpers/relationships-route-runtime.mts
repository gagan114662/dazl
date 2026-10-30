// The customer / open-deal list route (app/api/accounts/relationships, #364) and its effect on the real draft route,
// as tenant B with tenant A's entry and account ids: 'POST /api/accounts/relationships' (B cannot list A's account),
// 'DELETE /api/accounts/relationships' (B cannot remove A's entry), 'GET /api/accounts/relationships' (B sees none).
// two tenants, run under test/helpers/tenant-route-loader.mjs. Synthetic tenants, companies and addresses; no network,
// no provider call, nothing sent.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import Database from 'better-sqlite3'
import { NextRequest } from 'next/server'
import { setScanDb, setUser } from './tenant-route-db.ts'
import { migrateAllSqlite } from '../../lib/db/sqlite-migrations.ts'
import { saveMemory } from '../../lib/memory.ts'
import { createJob } from '../../lib/scan/store.ts'
import { syncAccountGraph, leadLink } from '../../lib/accounts/graph.ts'
import { sqliteDb } from '../../lib/db/client.ts'
import { providers } from '../../lib/llm/provider.ts'
import * as route from '../../app/api/accounts/relationships/route.ts'
import { POST as draftPOST } from '../../app/api/outreach/route.ts'

process.env.DAZL_MASTER_KEY = randomBytes(32).toString('base64')
delete process.env.DATABASE_URL
const calls: string[] = []
for (const [name, p] of Object.entries(providers)) if (p.complete) p.complete = async () => { calls.push(name); throw new Error('Unexpected provider call') }
globalThis.fetch = (async (u: unknown) => { calls.push(String(u)); throw new Error('Unexpected network call') }) as typeof fetch
const req = (method: string, body?: unknown, q = '') => new NextRequest(`https://app.dazl.test/api/accounts/relationships${q}`, {
  method, headers: { 'content-type': 'application/json', host: 'app.dazl.test', origin: 'https://app.dazl.test' }, body: body === undefined ? undefined : JSON.stringify(body) })
const draft = (leadId: string) => draftPOST(new NextRequest('https://app.dazl.test/api/outreach', {
  method: 'POST', headers: { 'content-type': 'application/json', host: 'app.dazl.test', origin: 'https://app.dazl.test' }, body: JSON.stringify({ lead_id: leadId }) }))
const NOW = Math.floor(Date.now() / 1000)

function seed(db: Database.Database, tenant: string, company: string, contact: string, domain: string) {
  const job = createJob(db, tenant, { business_name: 'Synthetic', industry: 'test', location: 'test' })
  db.prepare("UPDATE scan_jobs SET status = 'running' WHERE id = ?").run(job)
  const id = randomBytes(12).toString('hex')
  db.prepare('INSERT INTO leads (id, scan_job_id, company, contact, signal, source_url, evidence_excerpt, confidence, company_domain, human_confirmed_at, human_confirmed_from) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, job, company, contact, 'Hiring five roofers (synthetic)', 'https://news.example/a', `${company} is hiring five roofers`, 85, domain, NOW, 'test_review')
  return id
}

test('list route: explicit entries, reversible, tenant-scoped, admin-only changes; the draft route holds a listed company only when exclusions are on', async () => {
  const db = new Database(':memory:'); migrateAllSqlite(db); setScanDb(db)
  for (const t of ['A', 'B']) saveMemory(db, t, { positioning: 'Software to find leads with linked public evidence.' })
  const acme = seed(db, 'A', 'Acme Roofing', 'jane@acme-roofing.example', 'acme-roofing.example')
  const birch = seed(db, 'A', 'Birch Works', 'kim@birch-works.example', 'birch-works.example')
  const cedar = seed(db, 'A', 'Cedar Works', 'sam@cedar-works.example', 'cedar-works.example')
  const bLead = seed(db, 'B', 'Acme Roofing', 'jane@acme-roofing.example', 'acme-roofing.example')
  await syncAccountGraph(sqliteDb(db), 'A'); await syncAccountGraph(sqliteDb(db), 'B')
  const acctBirch = (await leadLink(sqliteDb(db), 'A', birch))!.account_id!
  const acctB = (await leadLink(sqliteDb(db), 'B', bLead))!.account_id!

  setUser({ id: 'A', business_name: 'Acme' })
  const byDomain = await route.POST(req('POST', { domain: 'https://www.Acme-Roofing.example/', status: 'customer', note: 'signed in 2025' }))
  assert.equal(byDomain.status, 201)
  const e1 = (await byDomain.json()).entry
  assert.deepEqual([e1.match_kind, e1.match_value, e1.status, e1.source, e1.actor], ['domain', 'acme-roofing.example', 'customer', 'manual', 'member:A'])
  const byAccount = await route.POST(req('POST', { account_id: acctBirch, status: 'open_deal' }))
  assert.equal(byAccount.status, 201)
  assert.equal((await route.POST(req('POST', { domain: 'acme-roofing.example', status: 'open_deal' }))).status, 409, 'one live entry per match')
  assert.equal((await route.POST(req('POST', { domain: 'not a domain', status: 'customer' }))).status, 400)
  assert.equal((await route.POST(req('POST', { domain: 'x.example', status: 'won' }))).status, 400, 'only customer or open_deal')
  // Another tenant's account id is unknown here.
  assert.equal((await route.POST(req('POST', { account_id: acctB, status: 'customer' }))).status, 404)
  const listed = await (await route.GET(req('GET'))).json()
  assert.deepEqual([listed.entries.length, listed.exclusions_active], [2, false])

  // Exclusions off (production default): the list is kept but holds nothing.
  delete process.env.DAZL_ACCOUNT_EXCLUSIONS
  assert.equal((await draft(acme)).status, 201, 'off: drafted')
  // On: the listed company and the listed account are held with the reason; an unlisted one is drafted.
  process.env.DAZL_ACCOUNT_EXCLUSIONS = '1'
  try {
    const r2 = await draft(birch)
    assert.deepEqual([r2.status, (await r2.json()).code], [409, 'open_deal'])
    assert.equal((await draft(cedar)).status, 201)
    assert.equal(db.prepare('SELECT 1 FROM outreach_messages WHERE lead_id = ?').get(birch), undefined, 'no draft for the held lead')
    assert.ok(db.prepare('SELECT 1 FROM leads WHERE id = ?').get(birch), 'the lead and its evidence are kept')

    // Tenant B: sees none of A's entries, cannot remove them, and its own Acme lead is not held by A's list.
    setUser({ id: 'B', business_name: 'Beta' })
    assert.deepEqual((await (await route.GET(req('GET'))).json()).entries, [])
    assert.equal((await route.DELETE(req('DELETE', { id: e1.id }))).status, 404)
    assert.equal((await draft(bLead)).status, 201, "A's customer is not B's")

    // Roles: a viewer of A may read the list but not change it.
    setUser({ id: 'A', business_name: 'Acme', role: 'viewer', actorId: 'V' })
    assert.equal((await route.GET(req('GET'))).status, 200)
    assert.equal((await route.POST(req('POST', { domain: 'cedar-works.example', status: 'customer' }))).status, 403)
    assert.equal((await route.DELETE(req('DELETE', { id: e1.id }))).status, 403)

    // Removal is reversible: the entry is kept, stamped, and no longer holds.
    setUser({ id: 'A', business_name: 'Acme' })
    assert.equal((await route.DELETE(req('DELETE', { id: (await byAccount.clone().json()).entry.id }))).status, 200)
    const all = (await (await route.GET(req('GET', undefined, '?all=1'))).json()).entries as { status: string; removed_at: number | null; removed_by: string | null }[]
    assert.deepEqual(all.map(e => [e.status, e.removed_at !== null, e.removed_by]).sort(), [['customer', false, null], ['open_deal', true, 'member:A']])
    assert.equal((await draft(birch)).status, 201, 'no longer listed: drafted')
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM tenant_account_relationships WHERE tenant_id = 'A'").get() as { n: number }).n, 2, 'nothing deleted')
  } finally { delete process.env.DAZL_ACCOUNT_EXCLUSIONS }
  assert.deepEqual(calls, [])
})
