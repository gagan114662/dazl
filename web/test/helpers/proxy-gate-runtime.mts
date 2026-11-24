// #1463 (PM 2026-11-22): proxy.ts let an /app request through as signed in whenever its own session lookup failed (catch -> true).
// A failed or stalled check must never pass a request as signed in; it must not destroy a good session either (a brief store hiccup
// is not a sign-out), and its answer must arrive at once (so #1546's stall recovery never sees a wait to recover from).
// Real paths: the real proxy, the real Db over a real SQLite store with a real session. The failure is a real one (a closed handle).
import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { NextRequest } from 'next/server'
import { migrateAllSqlite } from '../../lib/db/sqlite-migrations.ts'
import { sqliteDb, setDb, type Db } from '../../lib/db/client.ts'
import { createPasswordUser, createSession } from '../../lib/auth-db.ts'
import { resetStoreWarmForTest } from '../../lib/store-warm.ts'
import { proxy } from '../../proxy.ts'

afterEach(() => { setDb(null); resetStoreWarmForTest() })

async function store() {
  const raw = new Database(':memory:'); migrateAllSqlite(raw)
  const db = sqliteDb(raw)
  await createPasswordUser({ id: 'u1', email: 'a@example.com', name: 'A', business_name: 'B', password_hash: 'h', salt: 's' }, db)
  const token = await createSession('u1', db)
  return { raw, db, token }
}
const req = (path: string, token: string, headers: Record<string, string> = {}) =>
  new NextRequest(`https://dazl.test${path}`, { headers: { cookie: `dazl_session=${token}`, ...headers } })
const passed = (r: Response) => r.headers.get('x-middleware-next') === '1'
function failedClosed(r: Response, label: string) {
  assert.equal(passed(r), false, `${label}: never let through as signed in`)
  assert.equal(r.status, 503, `${label}: a retry answer, not a sign-out`)
  assert.equal(r.headers.get('retry-after') !== null, true, `${label}: says when to retry`)
  assert.ok(!(r.headers.get('set-cookie') ?? '').includes('dazl_session'), `${label}: the session cookie is kept`)
  assert.equal(r.headers.get('location'), null, `${label}: no redirect to sign-in (a hiccup is not a sign-out)`)
}

test('#1463 proxy: a normal session still passes', async () => {
  const { db, token } = await store(); setDb(db)
  const r = await proxy(req('/app/leads', token))
  assert.equal(passed(r), true)
})

test('#1463 proxy: no session still goes to sign-in', async () => {
  const { db } = await store(); setDb(db)
  const r = await proxy(req('/app/leads', 'f'.repeat(64)))
  assert.equal(passed(r), false); assert.match(r.headers.get('location') ?? '', /\/sign-in$/)
})

test('#1463 proxy: the session lookup throws (store closed): fails closed, keeps the cookie, page and RSC alike', async () => {
  const { raw, db, token } = await store(); setDb(db); raw.close()
  const page = await proxy(req('/app/leads', token))
  failedClosed(page, 'page')
  assert.match(page.headers.get('content-type') ?? '', /text\/html/)
  assert.match(await page.text(), /href="\/app\/leads"/, 'page: a retry link to the same page')
  failedClosed(await proxy(req('/app/leads', token, { rsc: '1' })), 'rsc')
})

test('#1463 proxy: opening the store throws: fails closed', async () => {
  const { token } = await store()
  // getDb() itself rejects (the store failed to open): setDb wraps it in Promise.resolve, which adopts the rejection
  setDb(Promise.reject(new Error('store failed to open')) as unknown as Db)
  failedClosed(await proxy(req('/app/settings', token)), 'open_store')
})

test('#1463 proxy: the lookup never settles: fails closed at the 8s deadline', async () => {
  const { db, token } = await store()
  setDb({ ...db, get: () => new Promise(() => {}) } as Db)
  const t0 = Date.now()
  const r = await proxy(req('/app/leads', token))
  failedClosed(r, 'deadline')
  assert.ok(Date.now() - t0 < 9500, 'answered at the deadline, not after')
})

// #1686 (review of PR #1688): the real proxy sends a page asked for on www to the site's own hostname, and leaves API calls alone.
test('#1686 proxy: a page on www is redirected to the same path on the site\'s own hostname (308); an API call on www is not', async () => {
  const { db, token } = await store(); setDb(db)
  const before = process.env.PUBLIC_BASE_URL
  process.env.PUBLIC_BASE_URL = 'https://dazl.test'
  try {
    const page = await proxy(new NextRequest('https://www.dazl.test/app/leads?job=1', { headers: { host: 'www.dazl.test', cookie: `dazl_session=${token}` } }))
    assert.equal(page.status, 308)
    assert.equal(page.headers.get('location'), 'https://dazl.test/app/leads?job=1')
    assert.ok(!(page.headers.get('set-cookie') ?? '').includes('dazl_session'), 'the session cookie is not touched')
    const api = await proxy(new NextRequest('https://www.dazl.test/api/usage', { headers: { host: 'www.dazl.test', cookie: `dazl_session=${token}` } }))
    assert.equal(api.headers.get('location'), null, 'an API call is answered where it was sent')
    const own = await proxy(new NextRequest('https://dazl.test/app/leads', { headers: { host: 'dazl.test', cookie: `dazl_session=${token}` } }))
    assert.equal(passed(own), true, 'the site\'s own hostname is served as before')
  } finally { if (before === undefined) delete process.env.PUBLIC_BASE_URL; else process.env.PUBLIC_BASE_URL = before }
})
