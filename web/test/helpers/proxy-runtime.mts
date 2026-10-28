// Runs the real proxy.ts (see test/request-log.test.ts): request ids, JSON request log lines, the /app redirect.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import Database from 'better-sqlite3'
import { NextRequest } from 'next/server'
import { setRequestLogWriter, isRequestId } from '../../lib/ops/request-log.ts'
import { setDb, sqliteDb, type Db } from '../../lib/db/client.ts'
import { migrateAuth, createSession } from '../../lib/auth-db.ts'

const { proxy, config } = await import('../../proxy.ts')
const lines: string[] = []
setRequestLogWriter(l => lines.push(l))
const req = (path: string, headers: Record<string, string> = {}, method = 'GET') => new NextRequest(`https://dazl.test${path}`, { method, headers })

test('proxy: a fresh request id per request, forwarded to the route and returned; one scrubbed JSON log line', async () => {
  assert.deepEqual(config.matcher, ['/app/:path*', '/api/:path*'])
  const res = await proxy(req('/api/leads?email=jane@example.com&t=secret', { 'x-request-id': 'evil-+1 415 555 0134', cookie: 'dazl_session=tok' }))
  const id = res.headers.get('x-request-id')!
  assert.ok(isRequestId(id), id) // never the caller's value
  assert.equal(res.headers.get('x-middleware-request-x-request-id'), id) // the route sees the same id
  assert.match(res.headers.get('x-middleware-override-headers') ?? '', /x-request-id/)
  assert.equal(lines.length, 1)
  const l = JSON.parse(lines[0])
  assert.deepEqual(Object.keys(l).sort(), ['level', 'method', 'path', 'request_id', 'ts', 'type'])
  assert.deepEqual([l.level, l.type, l.request_id, l.method, l.path], ['info', 'request', id, 'GET', '/api/leads'])
  const noId = JSON.stringify({ ...l, request_id: undefined }) // the request id is a random UUID and may contain any digits
  for (const leak of ['jane', 'secret', '555', 'evil', 'tok']) assert.ok(!noId.includes(leak), leak)

  const res2 = await proxy(req('/api/leads/0123456789abcdef0123456789abcdef/confirm', {}, 'POST'))
  assert.notEqual(res2.headers.get('x-request-id'), id)
  assert.equal(JSON.parse(lines[1]).path, '/api/leads/[lead]/confirm') // the route template, never the id

  // review repro through the real proxy: encoded email/phone/token, malformed and double-encoded values, unknown routes
  const before = lines.length
  for (const p of ['/api/leads/jane%40example.com/confirm', '/api/unknown/user.name%40company.example', '/api/replies/%2B1%20415%20555%200134',
    '/api/campaigns/sk_live_0123456789abcdefghij', '/api/replies/%E0%A4%A', '/api/replies/jane%2540example.com']) await proxy(req(p))
  const logged = lines.slice(before)
  assert.equal(logged.length, 6)
  assert.deepEqual(logged.map(l => JSON.parse(l).path), ['/api/leads/[lead]/confirm', '/api/[unknown]', '/api/replies/[id]', '/api/campaigns/[id]', '/api/replies/[id]', '/api/replies/[id]'])
  const paths = logged.map(l => JSON.parse(l).path).join(' ') // the request ids are random UUIDs and may contain any digits
  for (const leak of ['jane', 'company', '415', 'sk_live', '%']) assert.ok(!paths.includes(leak), leak)

  await proxy(req('/api/health/live')); await proxy(req('/api/ready'))
  assert.equal(lines.length, 8) // probes: no log line
})

test('proxy: /app redirects every request without a live session before any page renders; a live session goes through', async () => {
  const raw = new Database(':memory:'); migrateAuth(raw)
  const db = sqliteDb(raw); setDb(db)
  raw.prepare("INSERT INTO users (id, email, business_name, password_hash, salt) VALUES ('u1', 'owner@example.test', 'Acme', 'h', 's')").run()
  const live = await createSession('u1', db)
  const expired = await createSession('u1', db)
  raw.prepare('UPDATE sessions SET expires_at = 1 WHERE id = (SELECT id FROM sessions ORDER BY rowid DESC LIMIT 1)').run()
  const signedOut = randomBytes(32).toString('hex') // the shape of a session token, but no such session (signed out, deleted)
  const toSignIn = (r: Response) => { assert.equal(r.status, 307); assert.equal(new URL(r.headers.get('location')!).pathname, '/sign-in'); assert.ok(isRequestId(r.headers.get('x-request-id'))) }
  for (const path of ['/app', '/app/leads', '/app/settings', '/app/campaigns/0123456789abcdef0123456789abcdef']) {
    toSignIn(await proxy(req(path)))
    for (const token of [signedOut, expired, 'abc', '']) toSignIn(await proxy(req(path, { cookie: `dazl_session=${token}` })))
    const inn = await proxy(req(path, { cookie: `dazl_session=${live}` }))
    assert.equal(inn.status, 200)
    assert.equal(inn.headers.get('location'), null)
    assert.ok(isRequestId(inn.headers.get('x-request-id')))
  }
  // /api routes check the session themselves (401, not a redirect): the proxy never looks one up for them
  assert.equal((await proxy(req('/api/leads', { cookie: `dazl_session=${signedOut}` }))).headers.get('location'), null)
  // the lookup fails (store down): the request goes on and the layout's own check decides; no sign-in loop for a live user
  setDb({ get: async () => { throw new Error('store down') } } as unknown as Db)
  const down = await proxy(req('/app/leads', { cookie: `dazl_session=${live}` }))
  assert.equal(down.headers.get('location'), null)
  toSignIn(await proxy(req('/app/leads'))) // no cookie at all still never needs the store
  raw.close()
  console.log('PROXY_OK')
})
