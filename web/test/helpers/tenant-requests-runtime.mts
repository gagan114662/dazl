// #359 part 2: the real /api/settings/data routes and the operator's executeDeletion on a synthetic SQLite store with
// two tenants, a row in EVERY tenant-scoped table for each (tenant-seed-sqlite.ts). A request changes no data; only the
// operator's confirmed run deletes, and then only the requesting tenant. Run by test/tenant-requests.test.ts.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { scryptSync } from 'node:crypto'
import { NextRequest } from 'next/server'
import { setScanDb, setUser } from './tenant-route-db.ts'
import { migrateAllSqlite } from '../../lib/db/sqlite-migrations.ts'
import { sqliteDb } from '../../lib/db/client.ts'
import { seedTenantSqlite, snapshotSqlite } from './tenant-seed-sqlite.ts'
import { executeDeletion } from '../../lib/tenant/requests.ts'
import { tombstone } from '../../lib/tenant/lifecycle.ts'

const data = await import('../../app/api/settings/data/route.ts')
const del = await import('../../app/api/settings/data/deletion/route.ts')
const exp = await import('../../app/api/settings/data/export/route.ts')
const A = 'tenant-aaaa', B = 'tenant-bbbb', G = 'tenant-gggg'
const req = (url: string, method = 'GET', body?: unknown) => new NextRequest(`https://app.dazl.test${url}`, {
  method, headers: { 'content-type': 'application/json', host: 'app.dazl.test', origin: 'https://app.dazl.test', 'x-forwarded-for': '203.0.113.7' },
  body: body === undefined ? undefined : JSON.stringify(body) })
const call = async (r: Response | Promise<Response>) => { const x = await r; const text = await x.text(); let body: Record<string, unknown> = {}; try { body = JSON.parse(text) } catch { /* not json */ } return { status: x.status, body, headers: x.headers } }
const as = (id: string) => setUser({ id, business_name: 'Co' })

function fixture() {
  const db = new Database(':memory:'); migrateAllSqlite(db)
  for (const [id, email, pw] of [[A, 'a@acme.io', 'correct horse A'], [B, 'b@beta.io', 'correct horse B'], [G, 'g@gmail-only.io', 'unused']] as const) {
    const salt = `salt-${id}`
    db.prepare('INSERT INTO users (id, email, name, business_name, password_hash, salt) VALUES (?, ?, ?, ?, ?, ?)').run(id, email, 'N', 'Co', scryptSync(pw, salt, 64).toString('hex'), salt)
  }
  for (const [t, tag] of [[A, 'ta'], [B, 'tb']]) assert.deepEqual(seedTenantSqlite(db, t, tag).failed, {}, `every tenant table seeded for ${t}`)
  for (const t of [A, B, G]) {
    db.prepare("INSERT OR REPLACE INTO organizations (id, name, kind, created_by, created_at) VALUES (?, ?, 'personal', ?, 1)").run(t, `${t} ws`, t)
    db.prepare('DELETE FROM memberships WHERE tenant_id = ? OR member_id = ?').run(t, t)
    db.prepare("INSERT INTO memberships (tenant_id, member_id, role, created_at) VALUES (?, ?, 'owner', 1)").run(t, t)
  }
  db.prepare('DELETE FROM tenant_requests').run() // the seeder put a marker row in it like every table: start clean
  db.prepare("DELETE FROM oauth_identities WHERE user_id IN (?, ?)").run(A, B) // A and B are password accounts
  db.prepare("INSERT INTO oauth_identities (provider, subject, user_id) VALUES ('google', 'sub-g', ?)").run(G)
  setScanDb(db)
  return db
}
const ok = { confirm: 'delete my account', email: 'a@acme.io', password: 'correct horse A' }

test('a deletion request records the request only; wrong confirmation, email or password is refused; one pending at a time', async () => {
  const db = fixture()
  const before = { a: snapshotSqlite(db, A), b: snapshotSqlite(db, B) }
  as(A)
  assert.deepEqual((await call(data.GET())).body.pending, null)
  for (const [body, status, why] of [
    [{ ...ok, confirm: 'delete' }, 400, /Type "delete my account"/], [{ ...ok, email: 'b@beta.io' }, 400, /account email/],
    [{ ...ok, password: 'wrong' }, 403, /password/], [{ ...ok, password: undefined }, 403, /password/],
  ] as const) {
    const r = await call(del.POST(req('/api/settings/data/deletion', 'POST', body)))
    assert.equal(r.status, status, JSON.stringify(body)); assert.match(String(r.body.error), why)
  }
  const r1 = await call(del.POST(req('/api/settings/data/deletion', 'POST', { ...ok, confirm: '  Delete My Account ', email: 'A@ACME.IO' })))
  assert.equal(r1.status, 200); const id = (r1.body.request as { id: string }).id
  const r2 = await call(del.POST(req('/api/settings/data/deletion', 'POST', ok)))
  assert.equal((r2.body.request as { id: string }).id, id, 'asking again returns the same pending request')
  assert.equal((await call(data.GET())).body.pending && ((await call(data.GET())).body.pending as { id: string }).id, id)
  // nothing about the data changed: no tombstone, every tenant table byte-identical (tenant_requests aside), B untouched
  assert.equal(await tombstone(sqliteDb(db), A), undefined)
  const strip = (s: Record<string, string>) => { const { tenant_requests: _, ...rest } = s; return rest }
  assert.deepEqual(strip(snapshotSqlite(db, A)), strip(before.a)); assert.deepEqual(snapshotSqlite(db, B), before.b)
  // B sees nothing of A's and cannot withdraw it
  as(B); assert.equal((await call(data.GET())).body.pending, null)
  assert.equal((await call(del.DELETE(req('/api/settings/data/deletion', 'DELETE')))).body.ok, false)
  as(A); assert.ok((await call(data.GET())).body.pending)
  // A withdraws; a new request is a new one
  assert.equal((await call(del.DELETE(req('/api/settings/data/deletion', 'DELETE')))).body.ok, true)
  const after = (await call(data.GET())).body
  assert.equal(after.pending, null); assert.equal((after.last as { status: string }).status, 'withdrawn')
  const r3 = await call(del.POST(req('/api/settings/data/deletion', 'POST', ok)))
  assert.notEqual((r3.body.request as { id: string }).id, id)
  // signed out: refused
  setUser(null); assert.equal((await call(del.POST(req('/api/settings/data/deletion', 'POST', ok)))).status, 401)
})

test('a Google-only account confirms with its email and the phrase; a shared workspace is refused', async () => {
  const db = fixture()
  as(G)
  assert.equal((await call(del.POST(req('/api/settings/data/deletion', 'POST', { confirm: 'delete my account', email: 'someone@else.io' })))).status, 400)
  assert.equal((await call(del.POST(req('/api/settings/data/deletion', 'POST', { confirm: 'delete my account', email: 'g@gmail-only.io' })))).status, 200)
  db.prepare("INSERT INTO memberships (tenant_id, member_id, role, created_at) VALUES (?, ?, 'operator', 2)").run(A, B)
  as(A)
  const r = await call(del.POST(req('/api/settings/data/deletion', 'POST', ok)))
  assert.equal(r.status, 409); assert.match(String(r.body.error), /other members/)
})

test('export: only the caller\'s own rows, secrets redacted, a download header, recorded, at most three an hour', async () => {
  fixture()
  as(A)
  const r = await call(exp.GET())
  assert.equal(r.status, 200); assert.match(r.headers.get('content-disposition') ?? '', /attachment; filename="dazl-export-/)
  const text = JSON.stringify(r.body)
  assert.match(text, /ta~/); assert.doesNotMatch(text, /tb~/, 'no row of tenant B'); assert.doesNotMatch(text, /SECRET|correct horse/)
  assert.equal((await call(data.GET())).body.exports, 1)
  await call(exp.GET()); await call(exp.GET())
  assert.equal((await call(exp.GET())).status, 429)
  as(B); assert.equal((await call(data.GET())).body.exports, 0)
})

test('operator: a dry run changes nothing; no policy, no deletion; confirmed, only the requester is deleted and the tombstone names request and operator', async () => {
  const db = fixture(); const d = sqliteDb(db)
  as(A); const id = ((await call(del.POST(req('/api/settings/data/deletion', 'POST', ok)))).body.request as { id: string }).id
  const before = { a: snapshotSqlite(db, A), b: snapshotSqlite(db, B) }
  const dry = await executeDeletion(d, id, { operator: 'ops-alex', policy: { suppressions: 'retain' }, confirm: false })
  assert.ok('dry_run' in dry); assert.ok(Object.keys(dry.dry_run.would_delete).length > 50, 'counts for every seeded table'); assert.equal(dry.dry_run.would_delete.scan_jobs, 1)
  assert.deepEqual(snapshotSqlite(db, A), before.a, 'dry run: nothing changed'); assert.equal(await tombstone(d, A), undefined)
  await assert.rejects(executeDeletion(d, id, { operator: 'ops-alex', policy: undefined as never, confirm: true }), /explicit policy/)
  await assert.rejects(executeDeletion(d, id, { operator: ' ', policy: { suppressions: 'erase' }, confirm: true }), /operator is required/)
  const done = await executeDeletion(d, id, { operator: 'ops-alex', policy: { suppressions: 'retain' }, confirm: true })
  assert.ok('executed' in done); assert.equal(done.executed.state, 'completed')
  assert.match(done.executed.requested_by, new RegExp(`deletion request ${id} .*ops-alex`))
  assert.equal((db.prepare('SELECT count(*) AS n FROM users WHERE id = ?').get(A) as { n: number }).n, 0)
  assert.equal((db.prepare('SELECT count(*) AS n FROM scan_jobs WHERE user_id = ?').get(A) as { n: number }).n, 0)
  assert.deepEqual(snapshotSqlite(db, B), before.b, 'tenant B byte-identical')
  await assert.rejects(executeDeletion(d, id, { operator: 'ops-alex', policy: { suppressions: 'retain' }, confirm: true }), /no deletion request|not pending/)
  // a withdrawn request cannot be executed
  as(B); const idB = ((await call(del.POST(req('/api/settings/data/deletion', 'POST', { confirm: 'delete my account', email: 'b@beta.io', password: 'correct horse B' })))).body.request as { id: string }).id
  await call(del.DELETE(req('/api/settings/data/deletion', 'DELETE')))
  await assert.rejects(executeDeletion(d, idB, { operator: 'ops-alex', policy: { suppressions: 'retain' }, confirm: true }), /withdrawn, not pending/)
  assert.deepEqual(snapshotSqlite(db, B).scan_jobs, before.b.scan_jobs)
})
