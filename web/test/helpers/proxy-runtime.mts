// Runs the real proxy.ts (see test/request-log.test.ts): request ids, JSON request log lines, the /app redirect.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { NextRequest } from 'next/server'
import { setRequestLogWriter, isRequestId } from '../../lib/ops/request-log.ts'

const { proxy, config } = await import('../../proxy.ts')
const lines: string[] = []
setRequestLogWriter(l => lines.push(l))
const req = (path: string, headers: Record<string, string> = {}, method = 'GET') => new NextRequest(`https://dazl.test${path}`, { method, headers })

test('proxy: a fresh request id per request, forwarded to the route and returned; one scrubbed JSON log line', () => {
  assert.deepEqual(config.matcher, ['/app/:path*', '/api/:path*'])
  const res = proxy(req('/api/leads?email=jane@example.com&t=secret', { 'x-request-id': 'evil-+1 415 555 0134', cookie: 'dazl_session=tok' }))
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

  const res2 = proxy(req('/api/leads/0123456789abcdef0123456789abcdef/confirm', {}, 'POST'))
  assert.notEqual(res2.headers.get('x-request-id'), id)
  assert.equal(JSON.parse(lines[1]).path, '/api/leads/[lead]/confirm') // the route template, never the id

  // review repro through the real proxy: encoded email/phone/token, malformed and double-encoded values, unknown routes
  const before = lines.length
  for (const p of ['/api/leads/jane%40example.com/confirm', '/api/unknown/user.name%40company.example', '/api/replies/%2B1%20415%20555%200134',
    '/api/campaigns/sk_live_0123456789abcdefghij', '/api/replies/%E0%A4%A', '/api/replies/jane%2540example.com']) proxy(req(p))
  const logged = lines.slice(before)
  assert.equal(logged.length, 6)
  assert.deepEqual(logged.map(l => JSON.parse(l).path), ['/api/leads/[lead]/confirm', '/api/[unknown]', '/api/replies/[id]', '/api/campaigns/[id]', '/api/replies/[id]', '/api/replies/[id]'])
  const paths = logged.map(l => JSON.parse(l).path).join(' ') // the request ids are random UUIDs and may contain any digits
  for (const leak of ['jane', 'company', '415', 'sk_live', '%']) assert.ok(!paths.includes(leak), leak)

  proxy(req('/api/health/live')); proxy(req('/api/ready'))
  assert.equal(lines.length, 8) // probes: no log line
})

test('proxy: /app still redirects signed-out visitors and lets a session through, with a request id either way', () => {
  const out = proxy(req('/app/leads'))
  assert.equal(out.status, 307)
  assert.equal(new URL(out.headers.get('location')!).pathname, '/sign-in')
  assert.ok(isRequestId(out.headers.get('x-request-id')))
  const inn = proxy(req('/app/leads', { cookie: 'dazl_session=abc' }))
  assert.equal(inn.headers.get('location'), null)
  assert.ok(isRequestId(inn.headers.get('x-request-id')))
  console.log('PROXY_OK')
})
