// Covers the revenue pipeline routes (#366) for auth, roles, origin, validation and foreign tenant ids:
// 'GET /api/pipeline/deals', 'POST /api/pipeline/deals', 'GET /api/pipeline/deals/[id]', 'PATCH /api/pipeline/deals/[id]',
// 'GET /api/pipeline/report', 'GET /api/pipeline/rules', 'POST /api/pipeline/rules'. Tenant B calls every route with
// tenant A's deal, rule, play and member ids: nothing of A's comes back and A's rows stay byte-identical.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { NextRequest } from 'next/server'
import { setScanDb, setUser } from './tenant-route-db.ts'
import { migrateAllSqlite } from '../../lib/db/sqlite-migrations.ts'
import * as deals from '../../app/api/pipeline/deals/route.ts'
import * as deal from '../../app/api/pipeline/deals/[id]/route.ts'
import * as rules from '../../app/api/pipeline/rules/route.ts'
import * as report from '../../app/api/pipeline/report/route.ts'

const A = 'pipeA', B = 'pipeB', NOW = Math.floor(Date.now() / 1000)
const url = (p: string) => `https://dazl.test/api/pipeline/${p}`
const json = (p: string, method: string, body: unknown, extra: Record<string, string> = {}) =>
  new NextRequest(url(p), { method, headers: { 'content-type': 'application/json', host: 'dazl.test', ...extra }, body: typeof body === 'string' ? body : JSON.stringify(body) })
const get = (p: string) => new NextRequest(url(p))
const ctx = (id: string) => ({ params: Promise.resolve({ id }) })
const as = (t: string | null, role: 'owner' | 'admin' | 'operator' | 'viewer' = 'owner') => setUser(t ? { id: t, business_name: t, role } : null)

function seed(db: Database.Database, t: string) {
  for (const [id, role] of [[t, 'owner'], [`${t}op`, 'operator']]) {
    db.prepare("INSERT INTO users (id, email, password_hash, salt, name) VALUES (?, ?, 'x', 'x', ?)").run(id, `${id}@example.test`, `Name ${id}`)
    db.prepare('INSERT INTO memberships (tenant_id, member_id, role, created_at) VALUES (?, ?, ?, ?)').run(t, id, role, NOW - 100)
  }
  const job = `${t}job`
  db.prepare("INSERT INTO scan_jobs (id, user_id, business_name, industry, location, status, query) VALUES (?, ?, 'Seller', 'SaaS', 'Remote', 'running', 'q')").run(job, t)
  db.prepare("INSERT INTO leads (id, scan_job_id, name, company, signal, source_url, score, source_kind, dedup_key, created_at) VALUES (?, ?, 'Pat', ?, 'Hiring', 'https://example.test/s', 50, 'web', ?, ?)").run(`${t}lead`, job, `Co ${t}`, `${t}k`, NOW - 90)
  db.prepare("UPDATE scan_jobs SET status = 'done' WHERE id = ?").run(job)
  db.prepare("INSERT INTO inbound_messages (gmail_id, tenant_id, thread_id, lead_id, from_email, excerpt, classification, received_at) VALUES (?, ?, ?, ?, 'pat@co.example', 'synthetic', 'positive', ?)").run(`${t}g`, t, `${t}thread`, `${t}lead`, NOW - 50)
  return job
}

test('GET/POST /api/pipeline/deals, GET/PATCH /api/pipeline/deals/[id], GET /api/pipeline/report, GET/POST /api/pipeline/rules: auth, roles, origin, validation, tenant isolation', async () => {
  const db = new Database(':memory:'); migrateAllSqlite(db); setScanDb(db)
  try {
    const jobA = seed(db, A); seed(db, B)
    // signed out: every handler refuses
    as(null)
    for (const r of [await deals.GET(get('deals')), await deals.POST(json('deals', 'POST', { action: 'route' })), await deal.GET(get('deals/x'), ctx('a'.repeat(24))),
      await deal.PATCH(json('deals/x', 'PATCH', { version: 1, stage: 'qualified' }), ctx('a'.repeat(24))), await report.GET(get('report')), await rules.GET(), await rules.POST(json('rules', 'POST', { action: 'add' }))]) assert.equal(r.status, 401)
    // roles: an operator cannot add rules; a viewer cannot route or change deals
    as(A, 'operator'); assert.equal((await rules.POST(json('rules', 'POST', { action: 'add', match_kind: 'any', owner_id: A }))).status, 403)
    as(A, 'viewer'); assert.equal((await deals.POST(json('deals', 'POST', { action: 'route' }))).status, 403)
    assert.equal((await deal.PATCH(json('deals/x', 'PATCH', { version: 1, stage: 'qualified' }), ctx('a'.repeat(24)))).status, 403)
    // origin and validation
    as(A)
    assert.equal((await rules.POST(json('rules', 'POST', { action: 'add', match_kind: 'any', owner_id: A }, { origin: 'https://evil.test' }))).status, 400)
    for (const b of ['bad json', {}, { action: 'add', match_kind: 'nope', owner_id: A }, { action: 'add', match_kind: 'domain', match_value: 'x', owner_id: A }, { action: 'deactivate', id: 'zz' }]) assert.equal((await rules.POST(json('rules', 'POST', b))).status, 400, JSON.stringify(b))
    assert.equal((await deals.GET(get('deals?stage=archived'))).status, 400)
    assert.equal((await report.GET(get('report?as_of=yesterday'))).status, 400)
    // set up and route tenant A
    const added = await rules.POST(json('rules', 'POST', { action: 'add', match_kind: 'play', match_value: jobA, owner_id: `${A}op`, sla_hours: 4 }))
    assert.equal(added.status, 201)
    const ruleA = (await added.json()).rule.id as string
    const routed = await (await deals.POST(json('deals', 'POST', { action: 'route' }))).json()
    assert.deepEqual([routed.created, routed.assigned], [1, 1])
    const list = await (await deals.GET(get('deals'))).json()
    assert.equal(list.deals.length, 1); assert.equal(list.deals[0].owner_id, `${A}op`)
    assert.deepEqual(list.owners.map((o: { id: string }) => o.id).sort(), [A, `${A}op`])
    const dealA = list.deals[0].id as string
    // A moves its own deal; a stale version answers 409; a malformed body 400
    let r = await deal.PATCH(json('deals/x', 'PATCH', { version: 1, stage: 'qualified' }), ctx(dealA)); assert.equal(r.status, 200)
    assert.equal((await deal.PATCH(json('deals/x', 'PATCH', { version: 1, stage: 'meeting' }), ctx(dealA))).status, 409)
    assert.equal((await deal.PATCH(json('deals/x', 'PATCH', { version: 2, stage: 'won' }), ctx(dealA))).status, 400)
    assert.equal((await deal.PATCH(json('deals/x', 'PATCH', { stage: 'meeting' }), ctx(dealA))).status, 400, 'version required')
    r = await deal.PATCH(json('deals/x', 'PATCH', { version: 2, stage: 'won', close_reason: 'fit', amount_minor: 9900, currency: 'USD' }), ctx(dealA)); assert.equal(r.status, 200)
    const hist = await (await deal.GET(get('deals/x'), ctx(dealA))).json()
    assert.deepEqual(hist.history.map((e: { stage: string }) => e.stage), ['new', 'qualified', 'won'])
    const rep = await (await report.GET(get('report'))).json()
    assert.deepEqual([rep.deals, rep.won.amounts.USD, rep.reconciliation.mismatched], [1, 9900, 0])
    // tenant B with A's ids: nothing of A's comes back, nothing of A's changes
    const before = JSON.stringify([db.prepare('SELECT * FROM deals ORDER BY id').all(), db.prepare('SELECT * FROM deal_stage_events ORDER BY id').all(), db.prepare('SELECT * FROM deal_routing_rules ORDER BY id').all()])
    as(B)
    assert.deepEqual((await (await deals.GET(get(`deals?owner=${A}op`))).json()).deals, [])
    assert.deepEqual((await (await deals.GET(get('deals'))).json()).owners.map((o: { id: string }) => o.id).sort(), [B, `${B}op`], "A's members are never listed to B")
    assert.equal((await deal.GET(get('deals/x'), ctx(dealA))).status, 404)
    assert.equal((await deal.PATCH(json('deals/x', 'PATCH', { version: 3, stage: 'qualified' }), ctx(dealA))).status, 404)
    assert.deepEqual((await (await rules.GET()).json()).rules, [])
    assert.equal((await rules.POST(json('rules', 'POST', { action: 'deactivate', id: ruleA }))).status, 404)
    assert.equal((await rules.POST(json('rules', 'POST', { action: 'add', match_kind: 'any', owner_id: `${A}op` }))).status, 400, "B cannot route to A's member")
    assert.equal((await rules.POST(json('rules', 'POST', { action: 'add', match_kind: 'play', match_value: jobA, owner_id: B }))).status, 400, "B cannot name A's play")
    assert.deepEqual((await (await deals.POST(json('deals', 'POST', { action: 'route' }))).json()).created, 0, 'B has no rule: nothing routed')
    const repB = await (await report.GET(get('report'))).json()
    assert.equal(repB.deals, 0)
    assert.equal(JSON.stringify([db.prepare('SELECT * FROM deals ORDER BY id').all(), db.prepare('SELECT * FROM deal_stage_events ORDER BY id').all(), db.prepare('SELECT * FROM deal_routing_rules ORDER BY id').all()]), before, "A's rows unchanged")
    // every change was audited for A, as the acting member
    const acts = (db.prepare("SELECT action, actor_id FROM audit_events WHERE tenant_id = ? AND resource_type IN ('deal', 'deal_rule') ORDER BY seq, at").all(A) as { action: string; actor_id: string }[]).map(x => `${x.action}:${x.actor_id}`)
    assert.deepEqual(acts.sort(), [`deal.changed:${A}`, `deal.closed:${A}`, 'deal.routed:pipeline-router', `deal_rule.added:${A}`].sort())
  } finally { as(A); db.close() }
})
