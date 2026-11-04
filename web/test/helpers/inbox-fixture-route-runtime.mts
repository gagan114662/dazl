// POST / DELETE /api/outreach/inbox/fixture (#369) through the real handler, with the real Inbox GET reading the result:
// session, owner role, the flag and the designated tenant, an audited refusal for every other case, a forged tenant in
// the body ignored, seed -> multi-page Inbox + one bounce_review row -> cleanup. Synthetic data; fetch throws and counts.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { NextRequest } from 'next/server'
import { setScanDb, setUser } from './tenant-route-db.ts'
import { migrateAllSqlite } from '../../lib/db/sqlite-migrations.ts'
import { POST, DELETE } from '../../app/api/outreach/inbox/fixture/route.ts'
import { GET as INBOX } from '../../app/api/outreach/inbox/route.ts'
import { fixtureIds } from '../../lib/outreach/inbox-fixture.ts'

let fetches = 0
globalThis.fetch = (async () => { fetches++; throw new Error('Unexpected network call') }) as typeof fetch
const A = { id: 'A', business_name: 'Acme' }, B = { id: 'B', business_name: 'Beta' }
const json = { 'content-type': 'application/json', origin: 'http://localhost', host: 'localhost' }
const call = (method: 'POST' | 'DELETE', body: unknown = {}, headers: Record<string, string> = json) =>
  (method === 'POST' ? POST : DELETE)(new NextRequest('http://localhost/api/outreach/inbox/fixture', { method, body: JSON.stringify(body), headers }))
const inbox = async (q: string) => (await INBOX(new NextRequest(`http://localhost/api/outreach/inbox${q}`, { method: 'GET' }))).json()

function build() {
  const db = new Database(':memory:')
  migrateAllSqlite(db)
  // one real conversation of A's, and one of B's
  db.prepare("INSERT INTO scan_jobs (id, user_id, business_name, industry, location, status) VALUES (?, ?, 'Biz', 'x', 'x', 'running')").run('a'.repeat(24), 'A')
  db.prepare("INSERT INTO scan_jobs (id, user_id, business_name, industry, location, status) VALUES (?, ?, 'Biz', 'x', 'x', 'running')").run('b'.repeat(24), 'B')
  db.prepare("INSERT INTO leads (id, scan_job_id, name, company, signal, source_url) VALUES ('la', ?, 'Pat', 'Real A', 'hiring', 'https://a.example/a')").run('a'.repeat(24))
  db.prepare("INSERT INTO leads (id, scan_job_id, name, company, signal, source_url) VALUES ('lb', ?, 'Sam', 'Real B', 'hiring', 'https://b.example/a')").run('b'.repeat(24))
  const reply = db.prepare('INSERT INTO inbound_messages (gmail_id, tenant_id, thread_id, lead_id, from_email, excerpt, classification, received_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
  reply.run('ga', 'A', 'A-REAL', 'la', 'pat@a.example', 'real reply', 'other', 1_900_000_000)
  reply.run('gb', 'B', 'B-REAL', 'lb', 'sam@b.example', 'real reply', 'other', 1_900_000_000)
  setScanDb(db)
  return db
}
const audits = (db: Database.Database) => db.prepare("SELECT tenant_id, action, decision, summary FROM audit_events WHERE action LIKE 'inbox_fixture.%' ORDER BY seq").all() as { tenant_id: string; action: string; decision: string; summary: string }[]
const fixtureRows = (db: Database.Database) => (db.prepare("SELECT count(*) AS n FROM inbound_messages WHERE gmail_id LIKE 'dazl-inbox-fixture-%'").get() as { n: number }).n
function env(flag: string | undefined, tenant: string | undefined) {
  if (flag === undefined) delete process.env.OUTREACH_INBOX_FIXTURE; else process.env.OUTREACH_INBOX_FIXTURE = flag
  if (tenant === undefined) delete process.env.OUTREACH_TEST_TENANT_ID; else process.env.OUTREACH_TEST_TENANT_ID = tenant
}

test('refusals: signed out, non-owners, bad requests, flag off or not exactly 1, designation unset, another tenant, forged body tenant; each refusal past the role check is audited, nothing is written', async () => {
  const db = build()
  env('1', 'A')
  setUser(null)
  assert.equal((await call('POST')).status, 401)
  assert.equal((await call('DELETE')).status, 401)
  for (const role of ['viewer', 'operator', 'admin'] as const) {
    setUser({ ...A, role })
    for (const m of ['POST', 'DELETE'] as const) {
      const r = await call(m)
      assert.equal(r.status, 403); assert.deepEqual(await r.json(), { error: 'forbidden', needs: 'owners' })
    }
  }
  setUser(A)
  assert.equal((await call('POST', {}, { 'content-type': 'text/plain' })).status, 400)
  assert.equal((await call('POST', {}, { ...json, origin: 'https://evil.example' })).status, 400)
  assert.equal(fixtureRows(db), 0)
  assert.deepEqual(audits(db), [])

  const cases: [string | undefined, string | undefined, typeof A, string][] = [
    [undefined, 'A', A, 'fixture_disabled'], ['', 'A', A, 'fixture_disabled'], ['true', 'A', A, 'fixture_disabled'], [' 1', 'A', A, 'fixture_disabled'],
    ['1', undefined, A, 'test_tenant_unset'], ['1', '', A, 'test_tenant_unset'], ['1', '  ', A, 'test_tenant_unset'],
    ['1', 'A', B, 'test_tenant_only'],
  ]
  for (const [flag, tenant, user, reason] of cases) {
    const fresh = build() // a store per case: its own rate-limit window and audit trail
    env(flag, tenant); setUser(user)
    // the body is never read: naming the designated tenant there changes nothing
    const r = await call('POST', { tenant_id: 'A', tenantId: 'A' })
    assert.equal(r.status, 403, `${flag}/${tenant}/${user.id}`)
    assert.deepEqual(await r.json(), { error: 'fixture_unavailable' }, 'one answer for every refusal: the flag state is not disclosed')
    const d = await call('DELETE', { tenant_id: 'A' })
    assert.equal(d.status, 403)
    assert.deepEqual(audits(fresh).map(e => [e.tenant_id, e.action, e.decision, JSON.parse(e.summary).reason]),
      [[user.id, 'inbox_fixture.seed', 'denied', reason], [user.id, 'inbox_fixture.cleanup', 'denied', reason]])
    assert.equal(fixtureRows(fresh), 0)
  }
  // the rate limit bounds refusals (and their audit rows): 10 a minute per workspace
  const limited = build()
  env(undefined, 'A'); setUser(A)
  const codes: number[] = []
  for (let i = 0; i < 12; i++) codes.push((await call('POST')).status)
  assert.deepEqual(codes, [...Array(10).fill(403), 429, 429])
  assert.equal(audits(limited).length, 10)
  assert.equal(fixtureRows(db), 0)
  assert.equal(fetches, 0)
  env(undefined, undefined)
})

test('seed -> the Inbox spans several pages and shows one bounce_review conversation -> cleanup removes only the fixture; repeated calls are idempotent', async () => {
  const db = build()
  const ids = fixtureIds('A')
  env('1', 'A'); setUser(A)
  const seeded = await call('POST')
  assert.equal(seeded.status, 200)
  const s = await seeded.json()
  assert.equal(s.created, true); assert.equal(s.threads, 121); assert.equal(s.job_id, ids.jobId)
  assert.equal((await (await call('POST')).json()).created, false, 'a repeated seed writes nothing')

  // The reviewer's live check, through the real Inbox route: pages of 50 in the fixture play, then the bounce class.
  const seen: string[] = []
  let q = `?job_id=${ids.jobId}&limit=50`, pages = 0
  for (;;) {
    const p = await inbox(q)
    pages++; seen.push(...p.threads.map((t: { thread_id: string }) => t.thread_id))
    assert.deepEqual(p.counts, { threads: 121, needs_owner: 61, unread: 121, unread_needs_owner: 61 })
    if (!p.next_cursor) break
    q = `?job_id=${ids.jobId}&limit=50&cursor=${encodeURIComponent(p.next_cursor)}`
  }
  assert.equal(pages, 3); assert.equal(seen.length, 121); assert.equal(new Set(seen).size, 121)
  const review = await inbox(`?job_id=${ids.jobId}&class=bounce_review`)
  assert.deepEqual(review.threads.map((t: { thread_id: string; needs_owner: boolean; excerpt: string }) => [t.thread_id, t.needs_owner, t.excerpt]), [[ids.bounceThreadId, true, 'dsn status 5.1.1']])
  // B sees none of it
  setUser(B)
  const b = await inbox('')
  assert.deepEqual(b.threads.map((t: { thread_id: string }) => t.thread_id), ['B-REAL'])

  setUser(A)
  const del = await call('DELETE')
  assert.equal(del.status, 200)
  assert.deepEqual((await del.json()).deleted, { threads: 121, sends: 1, leads: 121, plays: 1, reads: 0 })
  assert.deepEqual((await (await call('DELETE')).json()).deleted, { threads: 0, sends: 0, leads: 0, plays: 0, reads: 0 })
  const after = await inbox('')
  assert.deepEqual(after.threads.map((t: { thread_id: string }) => t.thread_id), ['A-REAL'])
  assert.equal(fixtureRows(db), 0)
  assert.deepEqual(audits(db).map(e => [e.action, e.decision, JSON.parse(e.summary)]), [
    ['inbox_fixture.seed', 'allowed', { created: true, threads: 121 }], ['inbox_fixture.seed', 'allowed', { created: false, threads: 121 }],
    ['inbox_fixture.cleanup', 'allowed', { threads: 121, sends: 1, leads: 121, plays: 1, reads: 0 }], ['inbox_fixture.cleanup', 'allowed', { threads: 0, sends: 0, leads: 0, plays: 0, reads: 0 }],
  ])
  assert.equal(fetches, 0)
  env(undefined, undefined)
})
